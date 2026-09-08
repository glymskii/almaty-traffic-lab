/**
 * Vehicle pool: structure-of-arrays storage of fixed capacity (`demand.vehicleBudget`).
 *
 * Every array is allocated once in the constructor; `step()` never allocates. A slot is free when
 * `track[i] < 0`. Free slots live on a LIFO stack so that slots stay compact; processing order is
 * always the slot index (0..highWater).
 *
 * Per-track ordered lists. Each track (lane or connector, see RuntimeNetwork) keeps a doubly linked
 * list of its vehicles ordered by `s`: `trackHead` is the vehicle furthest along (largest `s`),
 * `trackTail` the one closest to the start. `ahead[i]` is the leader of `i` on the same track,
 * `behind[i]` its follower; -1 when there is none. Leader and follower lookups are O(1).
 *
 * Conventions: `s` is the position of the front bumper; the vehicle occupies [s - length, s].
 * Speeds in m/s, accelerations in m/s^2, times in simulation seconds.
 */
export class VehiclePool {
  readonly capacity: number;

  // ---- identity and placement ----
  /** Stable id for the life of the vehicle (starts at 1, never reused). */
  readonly id: Uint32Array;
  /** Current track, -1 = free slot. */
  readonly track: Int32Array;
  /** Track the vehicle will enter after the current one, -1 = leaves the network at the end. */
  readonly nextTrack: Int32Array;
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly a: Float64Array;
  /** World position and heading, refreshed at the end of every step (used by frames and the trajectory hash). */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly heading: Float64Array;
  /** Cached polyline segment for position lookup (relative to the track's polyline). */
  readonly geomSeg: Int32Array;

  // ---- vehicle and driver ----
  readonly cls: Uint8Array;
  readonly length: Float32Array;
  /** Desired speed = trackSpeed * speedFactor (driver factor x class factor). */
  readonly speedFactor: Float32Array;
  readonly timeHeadway: Float32Array;
  readonly minGap: Float32Array;
  readonly maxAccel: Float32Array;
  readonly comfortDecel: Float32Array;
  readonly politeness: Float32Array;
  readonly laneChangeThreshold: Float32Array;
  readonly gapLeftTurn: Float32Array;
  readonly gapMerge: Float32Array;
  readonly gapPedestrian: Float32Array;
  /** Persons on board, fixed at spawn from the class occupancy (peak/off-peak). */
  readonly occupancy: Float32Array;

  // ---- state ----
  /** Frame flags: `persistentFlags | per-step flags` (BRAKING, STOPPED, IN_INTERSECTION), rebuilt every step. */
  readonly flags: Uint8Array;
  /** Flags owned by other subsystems (BUS_LANE_VIOLATOR, NAVIGATOR, DWELLING, BLINKER_*); the kernel never clears them. */
  readonly persistentFlags: Uint8Array;
  readonly cause: Uint8Array;
  readonly rootCause: Uint8Array;
  readonly spawnTimeS: Float64Array;
  /** Free-flow travel time of the tracks traversed so far (denominator of trip delay). */
  readonly freeFlowTimeS: Float64Array;
  readonly stops: Uint16Array;
  /** 1 when the trip started after warm-up and counts for tripStats. */
  readonly countsInStats: Uint8Array;

  // ---- per-track ordered lists ----
  readonly ahead: Int32Array;
  readonly behind: Int32Array;
  readonly trackHead: Int32Array;
  readonly trackTail: Int32Array;

  // ---- free slots ----
  private readonly freeStack: Int32Array;
  private freeTop: number;
  /** Slots [0, highWater) may be occupied; slots beyond are known to be free. */
  highWater = 0;
  activeCount = 0;
  private nextId = 1;

  constructor(capacity: number, trackCount: number) {
    if (!(capacity > 0)) throw new Error(`vehicle pool capacity must be positive, got ${capacity}`);
    this.capacity = capacity;
    this.id = new Uint32Array(capacity);
    this.track = new Int32Array(capacity).fill(-1);
    this.nextTrack = new Int32Array(capacity).fill(-1);
    this.s = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.a = new Float64Array(capacity);
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.heading = new Float64Array(capacity);
    this.geomSeg = new Int32Array(capacity);
    this.cls = new Uint8Array(capacity);
    this.length = new Float32Array(capacity);
    this.speedFactor = new Float32Array(capacity);
    this.timeHeadway = new Float32Array(capacity);
    this.minGap = new Float32Array(capacity);
    this.maxAccel = new Float32Array(capacity);
    this.comfortDecel = new Float32Array(capacity);
    this.politeness = new Float32Array(capacity);
    this.laneChangeThreshold = new Float32Array(capacity);
    this.gapLeftTurn = new Float32Array(capacity);
    this.gapMerge = new Float32Array(capacity);
    this.gapPedestrian = new Float32Array(capacity);
    this.occupancy = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.persistentFlags = new Uint8Array(capacity);
    this.cause = new Uint8Array(capacity);
    this.rootCause = new Uint8Array(capacity);
    this.spawnTimeS = new Float64Array(capacity);
    this.freeFlowTimeS = new Float64Array(capacity);
    this.stops = new Uint16Array(capacity);
    this.countsInStats = new Uint8Array(capacity);
    this.ahead = new Int32Array(capacity).fill(-1);
    this.behind = new Int32Array(capacity).fill(-1);
    this.trackHead = new Int32Array(trackCount).fill(-1);
    this.trackTail = new Int32Array(trackCount).fill(-1);
    this.freeStack = new Int32Array(capacity);
    // Pop order: slot 0 first.
    for (let i = 0; i < capacity; i++) this.freeStack[i] = capacity - 1 - i;
    this.freeTop = capacity;
  }

  get freeCount(): number {
    return this.freeTop;
  }

  /** Takes a free slot (not yet on any track) and assigns a fresh id; -1 when the pool is full. */
  alloc(): number {
    if (this.freeTop === 0) return -1;
    this.freeTop--;
    const i = this.freeStack[this.freeTop] as number;
    this.id[i] = this.nextId++;
    this.ahead[i] = -1;
    this.behind[i] = -1;
    this.activeCount++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    return i;
  }

  /** Returns a slot to the free stack. The slot must already be unlinked from its track list. */
  release(i: number): void {
    this.track[i] = -1;
    this.nextTrack[i] = -1;
    this.freeStack[this.freeTop++] = i;
    this.activeCount--;
  }

  /**
   * Links vehicle `i` (with `s[i]` already set) into the ordered list of `track`, searching from the
   * tail: O(1) for vehicles entering at the start of a track, O(k) when k vehicles are behind it.
   */
  insert(track: number, i: number): void {
    const s = this.s;
    const si = s[i] as number;
    let cur = this.trackTail[track] as number;
    while (cur >= 0 && (s[cur] as number) < si) cur = this.ahead[cur] as number;
    // `cur` is the first vehicle with s >= si (i goes right behind it), or -1 (i becomes the head).
    const newBehind = cur >= 0 ? (this.behind[cur] as number) : (this.trackHead[track] as number);
    this.track[i] = track;
    this.ahead[i] = cur;
    this.behind[i] = newBehind;
    if (cur >= 0) this.behind[cur] = i;
    else this.trackHead[track] = i;
    if (newBehind >= 0) this.ahead[newBehind] = i;
    else this.trackTail[track] = i;
  }

  /** Unlinks vehicle `i` from its track list (keeps `track[i]` so callers can still read it). */
  remove(i: number): void {
    const t = this.track[i] as number;
    const a = this.ahead[i] as number;
    const b = this.behind[i] as number;
    if (a >= 0) this.behind[a] = b;
    else this.trackHead[t] = b;
    if (b >= 0) this.ahead[b] = a;
    else this.trackTail[t] = a;
    this.ahead[i] = -1;
    this.behind[i] = -1;
  }

  /** Swaps `i` with its leader in the list (used to repair the order after integration). */
  swapWithAhead(i: number): void {
    const j = this.ahead[i] as number;
    if (j < 0) return;
    const t = this.track[i] as number;
    const jj = this.ahead[j] as number;
    const b = this.behind[i] as number;
    this.ahead[i] = jj;
    this.behind[i] = j;
    this.ahead[j] = i;
    this.behind[j] = b;
    if (jj >= 0) this.behind[jj] = i;
    else this.trackHead[t] = i;
    if (b >= 0) this.ahead[b] = j;
    else this.trackTail[t] = j;
  }

  /**
   * Insertion sort of one track list from tail to head: repairs the rare case where a follower was
   * integrated past its leader. O(n) per track when already sorted (the usual case).
   */
  sortTrack(track: number): void {
    const s = this.s;
    let i = this.trackTail[track] as number;
    while (i >= 0) {
      const next = this.ahead[i] as number;
      let b = this.behind[i] as number;
      while (b >= 0 && (s[b] as number) > (s[i] as number)) {
        this.swapWithAhead(b);
        b = this.behind[i] as number;
      }
      i = next;
    }
  }
}
