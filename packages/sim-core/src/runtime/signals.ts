import { SignalState, type SignalStateCode, type SignalTiming } from "@atl/contracts";

/** Tolerance for dtS-grid boundary lookups (in dtS units), guards against float error at exact boundaries. */
const EPS = 1e-6;

/**
 * The slice of `SignalController` (packages/contracts/src/network.ts) that the state machine needs.
 * Deliberately narrower than the full contracts type: it lets test fixtures build controllers without
 * the schema's other required fields (`id`, `nodeId`, `provenance`, ...), and a real `Network`'s
 * `signalControllers` satisfies it structurally with no cast.
 */
export interface SignalControllerTiming {
  readonly offsetS: number;
  readonly groups: readonly { readonly id: string; readonly section: string }[];
  readonly phases: readonly {
    readonly greenGroupIds: readonly string[];
    readonly greenS: number;
    readonly yellowS: number;
    readonly allRedS: number;
  }[];
}

/** Sum of green + yellow + allRed over every phase, in execution order (see contracts' `cycleLengthS`). */
function cycleLengthOf(controller: Pick<SignalControllerTiming, "phases">): number {
  let total = 0;
  for (const p of controller.phases) total += p.greenS + p.yellowS + p.allRedS;
  return total;
}

/** Proper modulo: always in [0, m). */
function properMod(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + m : r;
}

/**
 * Precomputed per-controller state machine (docs/tasks/T-09-signals-runtime.md). For every signal
 * group, in the same order as `RuntimeNetwork.signalGroupIds` (both iterate `net.signalControllers`
 * top to bottom, then `ctrl.groups` in order, so the indices coincide by construction), a table maps
 * "time within the controller's cycle, sampled every `dtS`" to a `SignalStateCode`. `stateAt` is then
 * an O(1) lookup and `computeStates` an O(groupCount) pass over all of them: with 400 controllers this
 * costs far less than the 0.3 ms/step acceptance budget, at the price of one table per controller
 * (cycleSteps x groupsInController bytes -- acceptable, see the task card).
 *
 * State machine (docs/ARCHITECTURE.md, "Светофоры"):
 *  - `main` groups: GREEN for their own phase's green minus the last `flashingGreenS` seconds
 *    (FLASHING_GREEN), then that phase's YELLOW, then RED for the rest of the cycle -- except the
 *    last `redYellowS` seconds before their own next GREEN, which are RED_YELLOW.
 *  - `arrow_*` groups (a доп. секция): GREEN/FLASHING_GREEN during their own phase, OFF everywhere
 *    else. No YELLOW, no RED_YELLOW, no plain RED -- the additional section simply goes dark.
 */
export class SignalRuntime {
  readonly groupCount: number;
  /** Latest state per group (network order), filled by `computeStates`. */
  readonly groupState: Uint8Array;

  private readonly dtS: number;
  private readonly controllerOffsetS: Float64Array;
  private readonly controllerCycleS: Float64Array;
  private readonly controllerCycleSteps: Int32Array;
  private readonly controllerGroupStart: Int32Array;
  private readonly controllerGroupCount: Int32Array;
  private readonly controllerTableStart: Int32Array;
  /** Global group index -> owning controller index. */
  private readonly groupController: Int32Array;
  /** Concatenated per-controller tables, row-major [step * groupsInController + localGroupIndex]. */
  private readonly table: Uint8Array;

  constructor(
    controllers: readonly SignalControllerTiming[],
    dtS: number,
    timing: Pick<SignalTiming, "flashingGreenS" | "redYellowS">,
  ) {
    this.dtS = dtS;
    const controllerCount = controllers.length;
    this.controllerOffsetS = new Float64Array(controllerCount);
    this.controllerCycleS = new Float64Array(controllerCount);
    this.controllerCycleSteps = new Int32Array(controllerCount);
    this.controllerGroupStart = new Int32Array(controllerCount);
    this.controllerGroupCount = new Int32Array(controllerCount);
    this.controllerTableStart = new Int32Array(controllerCount);

    let groupCursor = 0;
    let tableCursor = 0;
    for (let ci = 0; ci < controllerCount; ci++) {
      const ctrl = controllers[ci];
      if (!ctrl) continue;
      const groupsInCtrl = ctrl.groups.length;
      const cycleS = cycleLengthOf(ctrl);
      const cycleSteps = Math.max(1, Math.round(cycleS / dtS));
      this.controllerOffsetS[ci] = ctrl.offsetS;
      this.controllerCycleS[ci] = cycleS;
      this.controllerCycleSteps[ci] = cycleSteps;
      this.controllerGroupStart[ci] = groupCursor;
      this.controllerGroupCount[ci] = groupsInCtrl;
      this.controllerTableStart[ci] = tableCursor;
      groupCursor += groupsInCtrl;
      tableCursor += cycleSteps * groupsInCtrl;
    }
    this.groupCount = groupCursor;
    this.groupState = new Uint8Array(groupCursor);
    this.groupController = new Int32Array(groupCursor);
    this.table = new Uint8Array(tableCursor);

    for (let ci = 0; ci < controllerCount; ci++) {
      const ctrl = controllers[ci];
      if (!ctrl) continue;
      const groupStart = this.controllerGroupStart[ci] as number;
      const groupsInCtrl = this.controllerGroupCount[ci] as number;
      for (let k = 0; k < groupsInCtrl; k++) this.groupController[groupStart + k] = ci;
      this.buildControllerTable(ci, ctrl, timing);
    }
  }

  private buildControllerTable(
    ci: number,
    ctrl: SignalControllerTiming,
    timing: Pick<SignalTiming, "flashingGreenS" | "redYellowS">,
  ): void {
    const groupsInCtrl = this.controllerGroupCount[ci] as number;
    const cycleS = this.controllerCycleS[ci] as number;
    const cycleSteps = this.controllerCycleSteps[ci] as number;
    const tableStart = this.controllerTableStart[ci] as number;
    const table = this.table;
    const dtS = this.dtS;

    const localIndex = new Map<string, number>();
    const isArrow: boolean[] = [];
    ctrl.groups.forEach((g, k) => {
      localIndex.set(g.id, k);
      isArrow.push(g.section !== "main");
    });

    // Default: RED for main sections, OFF for arrow sections.
    for (let step = 0; step < cycleSteps; step++) {
      const rowStart = tableStart + step * groupsInCtrl;
      for (let k = 0; k < groupsInCtrl; k++) {
        table[rowStart + k] = isArrow[k] ? SignalState.OFF : SignalState.RED;
      }
    }

    const fill = (col: number, startSec: number, lengthSec: number, state: number): void => {
      if (lengthSec <= 0) return;
      const startIdx = Math.floor(properMod(startSec, cycleS) / dtS + EPS);
      const count = Math.min(cycleSteps, Math.round(lengthSec / dtS));
      for (let k = 0; k < count; k++) {
        const idx = (startIdx + k) % cycleSteps;
        table[tableStart + idx * groupsInCtrl + col] = state;
      }
    };

    // Own-green start times per local group, for the RED_YELLOW pass below (main groups only).
    const ownGreenStarts: number[][] = ctrl.groups.map(() => []);
    let phaseStart = 0;
    for (const phase of ctrl.phases) {
      for (const gid of phase.greenGroupIds) {
        const col = localIndex.get(gid);
        if (col === undefined) continue; // defensive: schema allows only valid ids in practice
        const flashS = Math.min(phase.greenS, timing.flashingGreenS);
        const plainGreenS = phase.greenS - flashS;
        fill(col, phaseStart, plainGreenS, SignalState.GREEN);
        fill(col, phaseStart + plainGreenS, flashS, SignalState.FLASHING_GREEN);
        if (!isArrow[col]) {
          fill(col, phaseStart + phase.greenS, phase.yellowS, SignalState.YELLOW);
          (ownGreenStarts[col] as number[]).push(phaseStart);
        }
      }
      phaseStart += phase.greenS + phase.yellowS + phase.allRedS;
    }

    for (let col = 0; col < groupsInCtrl; col++) {
      if (isArrow[col]) continue;
      for (const start of ownGreenStarts[col] as number[]) {
        fill(col, start - timing.redYellowS, timing.redYellowS, SignalState.RED_YELLOW);
      }
    }
  }

  /** State of global group `g` at `simTimeS`, sampled at `dtS` resolution. */
  stateAt(g: number, simTimeS: number): SignalStateCode {
    const ci = this.groupController[g] as number;
    const groupStart = this.controllerGroupStart[ci] as number;
    const groupsInCtrl = this.controllerGroupCount[ci] as number;
    const cycleS = this.controllerCycleS[ci] as number;
    const cycleSteps = this.controllerCycleSteps[ci] as number;
    const tIn = properMod(simTimeS - (this.controllerOffsetS[ci] as number), cycleS);
    let stepIdx = Math.floor(tIn / this.dtS + EPS);
    if (stepIdx >= cycleSteps) stepIdx = cycleSteps - 1;
    if (stepIdx < 0) stepIdx = 0;
    const tableStart = this.controllerTableStart[ci] as number;
    const col = g - groupStart;
    return this.table[tableStart + stepIdx * groupsInCtrl + col] as SignalStateCode;
  }

  /** Fills and returns `groupState` (network order) for every group at `simTimeS`. */
  computeStates(simTimeS: number): Uint8Array {
    for (let g = 0; g < this.groupCount; g++) this.groupState[g] = this.stateAt(g, simTimeS);
    return this.groupState;
  }
}
