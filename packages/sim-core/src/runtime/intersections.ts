import type { Network } from "@atl/contracts";
import { SignalState } from "@atl/contracts";
import { ConflictTable, PriorityCode } from "./conflicts.ts";
import { NodeKindCode, type RuntimeNetwork } from "./network.ts";
import { TURN_COUNT, TurnCode } from "./turns.ts";
import type { VehiclePool } from "./vehicles.ts";

/**
 * Half-length of the occupancy zone around a conflict point, metres. A vehicle whose body reaches
 * into `[point - CONFLICT_ZONE_M, point + length + CONFLICT_ZONE_M]` sits on the point.
 */
const CONFLICT_ZONE_M = 2;
/**
 * Divisor floor when turning a distance into an arrival time. A vehicle standing at the stop line of
 * a green movement is about to accelerate away, so treating it as crawling at 1 m/s would let the
 * yielding driver take a gap that closes long before it has crossed.
 */
const MIN_APPROACH_SPEED_MPS = 3;
/** How far back on the feeding lane, and over how many vehicles, an approaching threat is looked for. */
const APPROACH_SCAN_M = 40;
const APPROACH_SCAN_DEPTH = 4;

/**
 * Precedence of a movement when the controller releases two conflicting ones together (`priority:
 * "signal"` plus two permissive connectors, which is what T-08 produces for a permissive left and
 * the opposing through). Lower wins; equal ranks are broken by track index so the pair can never
 * deadlock waiting for each other.
 */
const TURN_RANK = new Uint8Array(TURN_COUNT);
TURN_RANK[TurnCode.through] = 0;
TURN_RANK[TurnCode.right] = 1;
TURN_RANK[TurnCode.merge] = 1;
TURN_RANK[TurnCode.diverge] = 1;
TURN_RANK[TurnCode.left] = 2;
TURN_RANK[TurnCode.uturn] = 3;

/** True while the group's state lets its movements run (a stale green counts: they are still going). */
function released(state: number): boolean {
  return (
    state === SignalState.GREEN ||
    state === SignalState.FLASHING_GREEN ||
    state === SignalState.YELLOW
  );
}

/**
 * Junction runtime (T-11): who may cross which conflict point right now, and how much room the exit
 * of every movement has left. Rebuilt once per step, before the longitudinal model; the per-driver
 * part of the decision (critical gap, gridlock discipline) stays in `computeAccelerations`, because
 * it depends on the vehicle, not on the junction.
 *
 * Per conflict point of a connector this holds
 *  - `mustYield`: 1 when this movement gives way there under the current signal state,
 *  - `threatTimeS`: seconds until the nearest vehicle of the other movement reaches the point,
 *  - `pointOccupied`: 1 when a vehicle of the other movement stands on the point,
 *  - `pointJammed`: 1 when that vehicle is stopped *and cannot leave the junction*, because its own
 *    exit lane has no room: the junction is locked and the crossing traffic reports `gridlock`.
 *
 * The distinction matters. `pointOccupied` binds only a movement that has to give way, so a vehicle
 * that is merely crossing never steals right of way from the movement it is yielding to. `pointJammed`
 * binds every movement, protected ones included, because a car that cannot get out of the box
 * physically blocks the crossing traffic whatever its signal says -- and it is not circular: whether
 * it can leave depends on its exit lane, never on another conflict point.
 */
export class IntersectionRuntime {
  readonly conflicts: ConflictTable;
  /**
   * 1 for a movement at a signalized node that has no signal group: the generator marks a prohibited
   * left this way (T-08), and no phase ever releases it, so it is impassable rather than unsignalized.
   */
  readonly connProhibited: Uint8Array;
  readonly mustYield: Uint8Array;
  readonly threatTimeS: Float64Array;
  readonly pointOccupied: Uint8Array;
  readonly pointJammed: Uint8Array;
  /** Per connector track: metres free at the start of its exit lane (Infinity when the lane is empty). */
  readonly exitFreeM: Float64Array;

  private readonly rt: RuntimeNetwork;

  constructor(net: Network, rt: RuntimeNetwork) {
    this.rt = rt;
    this.conflicts = new ConflictTable(net, rt);
    const pairs = this.conflicts.pairCount;
    this.mustYield = new Uint8Array(pairs);
    this.threatTimeS = new Float64Array(pairs).fill(Number.POSITIVE_INFINITY);
    this.pointOccupied = new Uint8Array(pairs);
    this.pointJammed = new Uint8Array(pairs);
    this.exitFreeM = new Float64Array(rt.trackCount).fill(Number.POSITIVE_INFINITY);
    this.connProhibited = new Uint8Array(rt.trackCount);
    for (let t = rt.laneCount; t < rt.trackCount; t++) {
      const node = rt.connViaNode[t - rt.laneCount] as number;
      if (
        (rt.nodeKind[node] as number) === NodeKindCode.signalized &&
        (rt.connSignalGroup[t] as number) < 0
      ) {
        this.connProhibited[t] = 1;
      }
    }
  }

  /**
   * Refreshes the whole table from the current vehicle positions and signal states. Connector tracks
   * are walked in index order and, inside one, its conflict points in `conflictSThis` order, so the
   * result never depends on the order vehicles happen to sit in the pool.
   */
  update(pool: VehiclePool, groupState: Uint8Array, stoppedSpeedMps: number): void {
    const rt = this.rt;
    const cf = this.conflicts;
    const laneCount = rt.laneCount;
    // Exit room first: the conflict scan below reads it to tell a car that is merely crossing from
    // one that is stuck inside the junction.
    for (let t = laneCount; t < rt.trackCount; t++) {
      this.exitFreeM[t] = this.freeRoomOn(
        pool,
        rt.connToLane[t - laneCount] as number,
        stoppedSpeedMps,
      );
    }
    for (let t = laneCount; t < rt.trackCount; t++) {
      const start = cf.conflictStart[t] as number;
      const count = cf.conflictCount[t] as number;
      for (let k = start; k < start + count; k++) {
        const other = cf.conflictOther[k] as number;
        this.mustYield[k] = this.yieldsAt(t, other, cf.conflictPriority[k] as number, groupState)
          ? 1
          : 0;
        this.scanPoint(pool, k, other, cf.conflictSOther[k] as number, stoppedSpeedMps);
      }
    }
  }

  /**
   * Metres between the start of `lane` and the rear bumper of the last vehicle on it -- but only
   * while that vehicle is standing: a moving exit is discharging and will have made room by the time
   * anyone reaches it, so it must not throttle an ordinary saturation flow. What the gridlock rule
   * is about is an exit that has stopped (N19).
   */
  private freeRoomOn(pool: VehiclePool, lane: number, stoppedSpeedMps: number): number {
    if (lane < 0) return Number.POSITIVE_INFINITY;
    const last = pool.trackTail[lane] as number;
    if (last < 0) return Number.POSITIVE_INFINITY;
    if ((pool.v[last] as number) > stoppedSpeedMps) return Number.POSITIVE_INFINITY;
    return (
      (pool.s[last] as number) -
      (pool.length[last] as number) -
      (this.rt.trackStartS[lane] as number)
    );
  }

  /**
   * Whether movement `t` gives way to movement `other` at a point with this `priority`.
   *
   * Right of way comes from the point alone, never from `Connector.protection` (docs/CONTRACTS.md,
   * "Право проезда"). A protected movement normally ends up not yielding anywhere by itself --
   * everything it crosses is held at red, so the `signal` branch below finds no threat -- and
   * reading `protection` on top of that would only add a way to lose: where a plan does release two
   * conflicting movements together, exempting them both makes them drive through each other, while
   * the rank order below still lets exactly one of the two go.
   */
  private yieldsAt(t: number, other: number, priority: number, groupState: Uint8Array): boolean {
    const rt = this.rt;
    if (priority === PriorityCode.this) return false;
    if (priority === PriorityCode.other) return true;
    // `signal`: the controller decides. Only a movement it is releasing right now can be a threat.
    const group = rt.connSignalGroup[other] as number;
    if (group >= 0 && !released(groupState[group] as number)) return false;
    if (this.connProhibited[other] === 1) return false;
    const mine = TURN_RANK[rt.connTurn[t] as number] as number;
    const theirs = TURN_RANK[rt.connTurn[other] as number] as number;
    return theirs !== mine ? theirs < mine : other < t;
  }

  /** Fills entry `k` from the vehicles of movement `other` around its coordinate `sOther`. */
  private scanPoint(
    pool: VehiclePool,
    k: number,
    other: number,
    sOther: number,
    stoppedSpeedMps: number,
  ): void {
    let threat = Number.POSITIVE_INFINITY;
    let occupied = 0;
    let jammed = 0;
    // Vehicles already inside the junction on the other movement.
    for (let j = pool.trackTail[other] as number; j >= 0; j = pool.ahead[j] as number) {
      const s = pool.s[j] as number;
      const rear = s - (pool.length[j] as number);
      if (s >= sOther - CONFLICT_ZONE_M && rear <= sOther + CONFLICT_ZONE_M) {
        occupied = 1;
        // Stopped on the point *and* with nowhere to go: this movement is locking the junction.
        if (
          (pool.v[j] as number) <= stoppedSpeedMps &&
          (this.exitFreeM[other] as number) < (pool.length[j] as number)
        ) {
          jammed = 1;
        }
      }
      if (s < sOther) {
        const dt = (sOther - s) / Math.max(pool.v[j] as number, MIN_APPROACH_SPEED_MPS);
        if (dt < threat) threat = dt;
      }
    }
    // Vehicles still on the feeding lane are a threat too: without them a yielding driver would take
    // a gap that a priority driver is already committed to. Only the first few matter -- the head of
    // the lane may well be turning somewhere else, so the walk does not stop at it.
    const rt = this.rt;
    const feed = rt.connFromLane[other - rt.laneCount] as number;
    const laneEnd = feed >= 0 ? (rt.trackEndS[feed] as number) : 0;
    let lead = feed >= 0 ? (pool.trackHead[feed] as number) : -1;
    for (let seen = 0; lead >= 0 && seen < APPROACH_SCAN_DEPTH; seen++) {
      const toLine = laneEnd - (pool.s[lead] as number);
      if (toLine > APPROACH_SCAN_M) break;
      if (toLine >= 0 && (pool.nextTrack[lead] as number) === other) {
        const dt = (toLine + sOther) / Math.max(pool.v[lead] as number, MIN_APPROACH_SPEED_MPS);
        if (dt < threat) threat = dt;
      }
      lead = pool.behind[lead] as number;
    }
    this.threatTimeS[k] = threat;
    this.pointOccupied[k] = occupied;
    this.pointJammed[k] = jammed;
  }
}
