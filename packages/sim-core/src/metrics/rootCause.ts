import { causeCode } from "@atl/contracts";
import { CLASS_COUNT, type RuntimeNetwork } from "../runtime/network.ts";
import type { VehiclePool } from "../runtime/vehicles.ts";

const CAUSE_LEADER = causeCode("leader");

/** Longest chain of "blames the vehicle in front" inheritance; beyond it a vehicle keeps its own cause. */
export const MAX_ROOT_DEPTH = 200;
/** The leader is holding the follower up when it is slower than this fraction of its own desired speed. */
const SLOW_LEADER_RATIO = 0.5;
/** Tracks the head of a track may look across for its leader; mirrors the kernel's obstacle lookahead. */
const LEADER_LOOKAHEAD_TRACKS = 3;

/** Track resolution state while the sweep walks the downstream chain. */
const NOT_STARTED = 0;
const IN_PROGRESS = 1;
const DONE = 2;

/**
 * Root-cause propagation (docs/ARCHITECTURE.md, "Причины и распространение корневой причины").
 *
 * Every vehicle carries an immediate binding constraint `pool.cause`. A vehicle that simply blames
 * the car in front tells us nothing about the network, so metrics aggregate the **root** cause:
 * while `cause == leader` and the leader is stopped or crawling, the follower inherits the leader's
 * root cause. A queue behind a full turn pocket then puts its delay on `pocket_spillback`, and a
 * queue behind a car held at the stop line by `downstream_spillback` puts it there -- which is what
 * makes the detector's cause breakdown (T-19) mean anything.
 *
 * Cost. Walking one track list from head to tail resolves every vehicle in O(1): its leader is
 * already resolved. Only the *head* of a list has its leader on another track (lane -> connector ->
 * lane), so the sweep first orders tracks so that the downstream one is always resolved first
 * (`resolve`), then walks each list once. Total cost is O(vehicles + tracks) per call.
 */
export class RootCauseResolver {
  private readonly rt: RuntimeNetwork;
  /** Per track: NOT_STARTED / IN_PROGRESS / DONE for the current call. */
  private readonly state: Uint8Array;
  /** Per track: the leader of its head vehicle when that leader is on another track, else -1. */
  private readonly headLeader: Int32Array;
  /** Explicit stack of the downstream chain, so a long jam never recurses. */
  private readonly stack: Int32Array;
  /** Per vehicle slot: length of the inheritance chain behind it, capped at MAX_ROOT_DEPTH. */
  private readonly depth: Uint16Array;

  constructor(rt: RuntimeNetwork, capacity: number) {
    this.rt = rt;
    this.state = new Uint8Array(rt.trackCount);
    this.headLeader = new Int32Array(rt.trackCount);
    this.stack = new Int32Array(rt.trackCount);
    this.depth = new Uint16Array(capacity);
  }

  /** Fills `pool.rootCause` for every active vehicle from `pool.cause`. */
  resolve(pool: VehiclePool, stoppedSpeedMps: number): void {
    const state = this.state;
    state.fill(NOT_STARTED);
    const trackCount = this.rt.trackCount;
    const stack = this.stack;
    for (let t = 0; t < trackCount; t++) {
      if (state[t] !== NOT_STARTED) continue;
      // Walk downstream while every head keeps blaming a leader on the next track, then resolve the
      // chain back to front so that a list is always processed after the one its head depends on.
      let sp = 0;
      let cur = t;
      while (state[cur] === NOT_STARTED) {
        state[cur] = IN_PROGRESS;
        stack[sp++] = cur;
        const next = this.dependencyOf(cur, pool, stoppedSpeedMps);
        if (next < 0) break;
        cur = next;
      }
      while (sp > 0) {
        const track = stack[--sp] as number;
        this.resolveList(track, pool, stoppedSpeedMps);
        state[track] = DONE;
      }
    }
  }

  /**
   * Track carrying the leader of `t`'s head vehicle, or -1 when the head does not inherit at all.
   * Records that leader in `headLeader[t]` for `resolveList`.
   */
  private dependencyOf(t: number, pool: VehiclePool, stoppedSpeedMps: number): number {
    this.headLeader[t] = -1;
    const head = pool.trackHead[t] as number;
    if (head < 0) return -1;
    if ((pool.cause[head] as number) !== CAUSE_LEADER) return -1;
    const leader = this.leaderAhead(head, pool);
    if (leader < 0) return -1;
    if (!this.isHeldUp(leader, pool, stoppedSpeedMps)) return -1;
    this.headLeader[t] = leader;
    return pool.track[leader] as number;
  }

  /**
   * First vehicle on the tracks the head of `t` is about to enter (its own `nextTrack`, then the
   * class continuation), or -1. Mirrors the kernel's obstacle lookahead, minus the distance horizon:
   * the cause is already known to be `leader`, so the kernel did find one within the horizon.
   */
  private leaderAhead(head: number, pool: VehiclePool): number {
    const rt = this.rt;
    let next = pool.nextTrack[head] as number;
    const cls = pool.cls[head] as number;
    for (let hop = 0; hop < LEADER_LOOKAHEAD_TRACKS && next >= 0; hop++) {
      const candidate = pool.trackTail[next] as number;
      if (candidate >= 0) return candidate;
      next = rt.trackNextByClass[next * CLASS_COUNT + cls] as number;
    }
    return -1;
  }

  /** The leader is what holds the follower up: it is stopped, or crawling well below its own speed. */
  private isHeldUp(leader: number, pool: VehiclePool, stoppedSpeedMps: number): boolean {
    const v = pool.v[leader] as number;
    if (v <= stoppedSpeedMps) return true;
    const track = pool.track[leader] as number;
    if (track < 0) return false;
    const v0 = (this.rt.trackSpeedMps[track] as number) * (pool.speedFactor[leader] as number);
    return v < SLOW_LEADER_RATIO * v0;
  }

  /** One pass over the ordered list of `track`, head to tail. */
  private resolveList(track: number, pool: VehiclePool, stoppedSpeedMps: number): void {
    const cause = pool.cause;
    const root = pool.rootCause;
    const depth = this.depth;
    const behind = pool.behind;
    let i = pool.trackHead[track] as number;
    if (i < 0) return;

    // The head: its leader, if any, lives on a downstream track resolved earlier in this sweep. The
    // one exception is a ring of jammed tracks (a locked block of streets), where the chain closes
    // on a track still IN_PROGRESS: there the head simply keeps its own cause.
    const leaderOfHead = this.headLeader[track] as number;
    const leaderTrack = leaderOfHead >= 0 ? (pool.track[leaderOfHead] as number) : -1;
    if (leaderTrack >= 0 && this.state[leaderTrack] === DONE) {
      const d = (depth[leaderOfHead] as number) + 1;
      if (d <= MAX_ROOT_DEPTH) {
        root[i] = root[leaderOfHead] as number;
        depth[i] = d;
      } else {
        root[i] = cause[i] as number;
        depth[i] = 0;
      }
    } else {
      root[i] = cause[i] as number;
      depth[i] = 0;
    }

    let leader = i;
    i = behind[i] as number;
    while (i >= 0) {
      const d = (depth[leader] as number) + 1;
      if (
        (cause[i] as number) === CAUSE_LEADER &&
        d <= MAX_ROOT_DEPTH &&
        this.isHeldUp(leader, pool, stoppedSpeedMps)
      ) {
        root[i] = root[leader] as number;
        depth[i] = d;
      } else {
        root[i] = cause[i] as number;
        depth[i] = 0;
      }
      leader = i;
      i = behind[i] as number;
    }
  }
}
