import type { Network } from "@atl/contracts";
import { VEHICLE_CLASS_CODE } from "@atl/contracts";
import { CLASS_COUNT, type RuntimeNetwork } from "./network.ts";
import { TurnCode, turnBit } from "./turns.ts";

const TAXI_CODE = VEHICLE_CLASS_CODE.taxi;
const TURN_RIGHT = TurnCode.right;
/** A whole day: `activeFromMin = 0, activeToMin = 1440` means the bus lane never switches off. */
const DAY_MIN = 1440;

/**
 * Lane-level knowledge the lane-change stage needs (T-10): which movements a lane actually serves
 * for a vehicle class, which classes it admits (bus lanes with their time window, the right-turn
 * entry window and violators), and where the nearest lane serving a given movement is.
 *
 * Built once next to `RuntimeNetwork`, never mutated. Everything is indexed by lane track index,
 * so it shares the index space of `RuntimeNetwork` ([0, laneCount) are lanes).
 */
export class LaneRuntime {
  private readonly rt: RuntimeNetwork;

  /** [lane * CLASS_COUNT + cls] -> bit mask of turns this class can perform from the lane. */
  readonly turnMaskByClass: Uint8Array;
  /** [link * CLASS_COUNT + cls] -> union of the turn masks of the link's lanes. */
  readonly linkTurnMaskByClass: Uint8Array;

  /** 1 for `kind: "bus"` lanes carrying a `busLane` rule. */
  readonly isBusLane: Uint8Array;
  /** 1 for `kind: "turn_pocket"` lanes (they open at `startS > 0`). */
  readonly isPocket: Uint8Array;
  readonly busActiveFromMin: Float64Array;
  readonly busActiveToMin: Float64Array;
  /** `busLane.carsMayEnterForRightTurnWithinM`. */
  readonly busRightWindowM: Float64Array;

  /** Scenario toggle `behavior.taxisAllowedInBusLanes` (not runtime-safe, so it is read once). */
  private readonly taxisInBusLanes: boolean;

  constructor(net: Network, rt: RuntimeNetwork, taxisAllowedInBusLanes: boolean) {
    this.rt = rt;
    this.taxisInBusLanes = taxisAllowedInBusLanes;
    const laneCount = rt.laneCount;
    this.turnMaskByClass = new Uint8Array(laneCount * CLASS_COUNT);
    this.linkTurnMaskByClass = new Uint8Array(rt.linkCount * CLASS_COUNT);
    this.isBusLane = new Uint8Array(laneCount);
    this.isPocket = new Uint8Array(laneCount);
    this.busActiveFromMin = new Float64Array(laneCount);
    this.busActiveToMin = new Float64Array(laneCount).fill(DAY_MIN);
    this.busRightWindowM = new Float64Array(laneCount);

    for (let i = 0; i < laneCount; i++) {
      const lane = net.lanes[i];
      if (!lane) continue;
      this.isPocket[i] = lane.kind === "turn_pocket" ? 1 : 0;
      const rule = lane.busLane;
      if (lane.kind === "bus" && rule) {
        this.isBusLane[i] = 1;
        this.busActiveFromMin[i] = rule.activeFromMin;
        this.busActiveToMin[i] = rule.activeToMin;
        this.busRightWindowM[i] = rule.carsMayEnterForRightTurnWithinM;
      }
    }

    // A lane serves a movement when it has an outgoing connector with that turn whose target lane
    // admits the class. This is stricter and more honest than `lane.turns`: the compiler may have
    // dropped a movement (prohibited left, bus-only exit) without touching the lane's tag.
    for (let i = 0; i < laneCount; i++) {
      const start = rt.laneConnStart[i] as number;
      const count = rt.laneConnCount[i] as number;
      for (let cls = 0; cls < CLASS_COUNT; cls++) {
        const bit = 1 << cls;
        let mask = 0;
        for (let k = 0; k < count; k++) {
          const t = rt.laneConnList[start + k] as number;
          if (((rt.trackAllowedMask[t] as number) & bit) === 0) continue;
          mask |= turnBit(rt.connTurn[t] as number);
        }
        this.turnMaskByClass[i * CLASS_COUNT + cls] = mask;
        const link = rt.trackLink[i] as number;
        if (link >= 0) {
          const slot = link * CLASS_COUNT + cls;
          this.linkTurnMaskByClass[slot] = (this.linkTurnMaskByClass[slot] as number) | mask;
        }
      }
    }
  }

  /** True while the bus-lane restriction of `lane` is in force; outside it the lane is general. */
  busLaneActive(lane: number, timeOfDayMin: number): boolean {
    if (this.isBusLane[lane] !== 1) return false;
    const from = this.busActiveFromMin[lane] as number;
    const to = this.busActiveToMin[lane] as number;
    if (from <= 0 && to >= DAY_MIN) return true;
    if (from <= to) return timeOfDayMin >= from && timeOfDayMin < to;
    return timeOfDayMin >= from || timeOfDayMin < to;
  }

  /**
   * Access without the position-dependent part: true when the class may ever be on this lane
   * (used when picking a target lane, before the vehicle is close enough for the right-turn window).
   */
  mayAdmit(
    lane: number,
    clsCode: number,
    violator: boolean,
    turnCode: number,
    timeOfDayMin: number,
  ): boolean {
    if (((this.rt.trackAllowedMask[lane] as number) & (1 << clsCode)) !== 0) return true;
    if (this.busLaneException(lane, clsCode, violator, timeOfDayMin)) return true;
    return this.rightTurnLane(turnCode, lane, timeOfDayMin);
  }

  /**
   * Access of a vehicle at coordinate `s`: `lane.allowed`, plus the bus-lane exceptions
   * (outside the active hours, taxis when the scenario allows them, `BUS_LANE_VIOLATOR`, and a car
   * that turns right within `carsMayEnterForRightTurnWithinM` of the end of the lane).
   */
  admitsAt(
    lane: number,
    clsCode: number,
    violator: boolean,
    turnCode: number,
    s: number,
    timeOfDayMin: number,
  ): boolean {
    if (((this.rt.trackAllowedMask[lane] as number) & (1 << clsCode)) !== 0) return true;
    if (this.busLaneException(lane, clsCode, violator, timeOfDayMin)) return true;
    if (!this.rightTurnLane(turnCode, lane, timeOfDayMin)) return false;
    return (this.rt.trackEndS[lane] as number) - s <= (this.busRightWindowM[lane] as number);
  }

  /** Bus-lane exceptions that do not depend on the vehicle's position. */
  private busLaneException(
    lane: number,
    clsCode: number,
    violator: boolean,
    timeOfDayMin: number,
  ): boolean {
    if (this.isBusLane[lane] !== 1) return false;
    if (!this.busLaneActive(lane, timeOfDayMin)) return true; // outside its hours it is a general lane
    if (violator) return true;
    return clsCode === TAXI_CODE && this.taxisInBusLanes;
  }

  /** The right-turn window applies only to a bus lane that is currently in force. */
  private rightTurnLane(turnCode: number, lane: number, timeOfDayMin: number): boolean {
    return (
      turnCode === TURN_RIGHT &&
      this.isBusLane[lane] === 1 &&
      this.busLaneActive(lane, timeOfDayMin)
    );
  }

  /**
   * True when a vehicle of `cls` can finish its trip from `lane`: either the lane leaves the network
   * (gate or dead end) or it has a connector performing `turnCode` for that class.
   */
  serves(lane: number, clsCode: number, turnCode: number): boolean {
    if (this.rt.trackIsExit[lane] === 1) return true;
    return (
      ((this.turnMaskByClass[lane * CLASS_COUNT + clsCode] as number) & turnBit(turnCode)) !== 0
    );
  }

  /** Outgoing connector of `lane` performing `turnCode` for the class, or the class default (-1 if none). */
  connectorFor(lane: number, clsCode: number, turnCode: number): number {
    const rt = this.rt;
    const start = rt.laneConnStart[lane] as number;
    const count = rt.laneConnCount[lane] as number;
    const bit = 1 << clsCode;
    for (let k = 0; k < count; k++) {
      const t = rt.laneConnList[start + k] as number;
      if (((rt.trackAllowedMask[t] as number) & bit) === 0) continue;
      if ((rt.connTurn[t] as number) === turnCode) return t;
    }
    return rt.trackNextByClass[lane * CLASS_COUNT + clsCode] as number;
  }

  /**
   * Lane the vehicle must reach on its current link, or -1 when the lane it is on already works.
   * Candidates are the lanes of the link that serve the intended movement, admit the class and are
   * still ahead of the vehicle (a pocket that opens later counts); the nearest one by lane index wins,
   * ties go to the left (the lower index), so the choice is deterministic.
   */
  targetLane(
    lane: number,
    clsCode: number,
    violator: boolean,
    turnCode: number,
    s: number,
    timeOfDayMin: number,
  ): number {
    const rt = this.rt;
    if (
      this.serves(lane, clsCode, turnCode) &&
      this.admitsAt(lane, clsCode, violator, turnCode, s, timeOfDayMin)
    ) {
      return -1;
    }
    const link = rt.trackLink[lane] as number;
    if (link < 0) return -1;
    const start = rt.linkLaneStart[link] as number;
    const count = rt.linkLaneCount[link] as number;
    const here = rt.lanePos[lane] as number;
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let k = 0; k < count; k++) {
      const c = rt.linkLanes[start + k] as number;
      if (c === lane) continue;
      if ((rt.trackEndS[c] as number) <= s) continue; // that lane is already behind the vehicle
      if (!this.serves(c, clsCode, turnCode)) continue;
      if (!this.mayAdmit(c, clsCode, violator, turnCode, timeOfDayMin)) continue;
      const d = Math.abs((rt.lanePos[c] as number) - here);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }
}
