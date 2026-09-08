import type {
  CauseKey,
  MetricsFrame,
  Network,
  NetworkOverride,
  Recommendation,
  SignalController,
  SignalGroup,
  SimConfig,
} from "@atl/contracts";
import type { SegmentIndex } from "../metrics/segments.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import type { CandidateGroup, GroupStats } from "./candidates.ts";

/** D11: rules, not free text. Three is what the panel shows without turning into a wall. */
export const MAX_RECOMMENDATIONS = 3;

/** Extra green handed to an approach or an arrow section by `rebalance_green`, seconds. */
const GREEN_STEP_S = 10;
/** Extra metres a `extend_left_pocket` adds to whatever pocket the approach has today. */
const POCKET_STEP_M = 60;
/** `signal_red` only earns extra green once the approach is actually loaded. */
const REBALANCE_MIN_VC = 0.9;
/**
 * Buses per hour below which a dedicated lane is hard to defend against a queue of cars next to it.
 * One bus every three minutes is 20 veh/h; anything under that is "почти пустая выделенка".
 */
const LOW_BUS_LANE_FLOW_VEH_H = 20;

/** Everything the rule table needs about the network, resolved once per simulation. */
export class RecommendationContext {
  private readonly net: Network;
  private readonly controllerByNode: Map<string, SignalController>;
  /** Link id -> the bus-lane segments of that link, for the "выделенка почти пуста" rule. */
  private readonly busLaneSegments: Map<string, Int32Array>;

  constructor(net: Network, rt: RuntimeNetwork, seg: SegmentIndex) {
    this.net = net;
    this.controllerByNode = new Map(net.signalControllers.map((c) => [c.nodeId, c]));
    this.busLaneSegments = new Map();
    const busLaneIds = new Set(net.lanes.filter((l) => l.kind === "bus").map((l) => l.id));
    for (let link = 0; link < rt.linkCount; link++) {
      const out: number[] = [];
      const start = rt.linkLaneStart[link] as number;
      const count = rt.linkLaneCount[link] as number;
      for (let k = start; k < start + count; k++) {
        const lane = rt.linkLanes[k] as number;
        if (!busLaneIds.has(rt.laneIds[lane] as string)) continue;
        for (let s = seg.firstSegmentOfLane(lane); s <= seg.lastSegmentOfLane(lane); s++)
          out.push(s);
      }
      if (out.length > 0)
        this.busLaneSegments.set(rt.linkIds[link] as string, Int32Array.from(out));
    }
  }

  controllerAt(nodeId: string | undefined): SignalController | undefined {
    return nodeId === undefined ? undefined : this.controllerByNode.get(nodeId);
  }

  /** The vehicle group of `linkId` at that controller: the main lights, or its arrow section. */
  groupFor(ctrl: SignalController, linkId: string, arrow: boolean): SignalGroup | undefined {
    return ctrl.groups.find(
      (g) =>
        g.kind === "vehicle" &&
        g.approachLinkId === linkId &&
        (arrow ? g.section !== "main" : g.section === "main"),
    );
  }

  /** Green seconds the group gets over the whole cycle (yellow excluded: it is not usable green). */
  greenSecondsOf(ctrl: SignalController, groupId: string): number {
    let green = 0;
    for (const p of ctrl.phases) if (p.greenGroupIds.includes(groupId)) green += p.greenS;
    return green;
  }

  /** Length of the longest left-turn pocket on the link, 0 when it has none. */
  leftPocketLengthM(linkId: string): number {
    let best = 0;
    for (const lane of this.net.lanes) {
      if (lane.linkId !== linkId || lane.kind !== "turn_pocket") continue;
      if (!lane.turns.includes("left")) continue;
      const len = lane.endS - lane.startS;
      if (len > best) best = len;
    }
    return best;
  }

  /** First in-lane bus stop on the link: the one a bay would take out of the running lane. */
  inLaneStopId(linkId: string): string | undefined {
    return this.net.busStops.find((s) => s.linkId === linkId && s.kind === "in_lane")?.id;
  }

  /** Buses per hour on the link's dedicated lane over the window; undefined when there is no bus lane. */
  busLaneFlowVehH(frame: MetricsFrame, linkId: string): number | undefined {
    const segments = this.busLaneSegments.get(linkId);
    if (segments === undefined) return undefined;
    let best = 0;
    for (const i of segments) {
      const f = frame.flow[i] as number;
      if (f > best) best = f;
    }
    return best;
  }

  /** Peak window of the run, minutes from midnight: when a bus lane is easiest to justify. */
  peakWindowMin(cfg: SimConfig): { fromMin: number; toMin: number } {
    const hours = cfg.peakHours.length > 0 ? cfg.peakHours : [7, 8, 9];
    let from = 24;
    let to = 0;
    for (const h of hours) {
      if (h < from) from = h;
      if (h + 1 > to) to = h + 1;
    }
    return { fromMin: from * 60, toMin: Math.min(1440, to * 60) };
  }
}

export interface RecommendInput {
  group: CandidateGroup;
  stats: GroupStats;
  cause: CauseKey | undefined;
  frame: MetricsFrame;
  cfg: SimConfig;
  /** Link the group drains into (the busiest exit), for `downstream_spillback`. */
  downstreamLinkId: string | undefined;
  /** Rank of the best-ranked item on a link, to point `downstream_spillback` at it. */
  rankByLinkId: ReadonlyMap<string, number>;
}

/**
 * The "dominant cause -> scenario" table of D11. Every entry either carries overrides that the
 * scenario editor can apply as-is (`NetworkOverrideSchema`) or is a label-only hint for a change the
 * override surface cannot express (ramp metering, driver discipline).
 */
export function recommendFor(ctx: RecommendationContext, input: RecommendInput): Recommendation[] {
  const out: Recommendation[] = [];
  const { group, stats, cause, frame, cfg } = input;
  const linkId = group.linkId;
  const ctrl = ctx.controllerAt(group.nodeId);

  switch (cause) {
    case "gap_left_turn": {
      if (ctrl !== undefined) {
        out.push({
          kind: "add_left_arrow",
          label: "Дать левому повороту отдельную фазу (доп. секция вместо просачивания)",
          overrides: [signalOverride(ctrl.nodeId, { leftTurnModes: { [linkId]: "protected" } })],
        });
        out.push({
          kind: "prohibit_left_turn",
          label: "Запретить левый поворот с этого подхода, отправив его в объезд",
          overrides: [signalOverride(ctrl.nodeId, { leftTurnModes: { [linkId]: "prohibited" } })],
        });
      }
      break;
    }
    case "pocket_spillback": {
      const current = ctx.leftPocketLengthM(linkId);
      const target = Math.round(current + POCKET_STEP_M);
      out.push({
        kind: "extend_left_pocket",
        label: `Удлинить левый карман до ${target} м, чтобы очередь поворотных не вставала в прямую полосу`,
        overrides: [linkOverride(linkId, { leftPocketLengthM: target })],
      });
      break;
    }
    case "signal_red": {
      if (ctrl !== undefined && stats.vcRatio > REBALANCE_MIN_VC) {
        const green = greenOverride(ctx, ctrl, linkId, false);
        if (green !== undefined) out.push(green);
      }
      const busFlow = ctx.busLaneFlowVehH(frame, linkId);
      if (busFlow !== undefined && busFlow < LOW_BUS_LANE_FLOW_VEH_H) {
        const { fromMin, toMin } = ctx.peakWindowMin(cfg);
        out.push({
          kind: "bus_lane_hours",
          label: `Оставить выделенку только в пик (${hhmm(fromMin)}–${hhmm(toMin)}): автобусов на ней ${Math.round(busFlow)} в час`,
          overrides: [
            linkOverride(linkId, { busLane: { activeFromMin: fromMin, activeToMin: toMin } }),
          ],
        });
      }
      break;
    }
    case "arrow_off": {
      if (ctrl !== undefined) {
        const green = greenOverride(ctx, ctrl, linkId, true);
        if (green !== undefined) out.push(green);
      }
      break;
    }
    case "behind_stopped_bus": {
      const stopId = ctx.inLaneStopId(linkId);
      if (stopId !== undefined) {
        out.push({
          kind: "bus_stop_bay",
          label: "Вынести остановку в карман, чтобы автобус не держал полосу",
          overrides: [{ kind: "bus_stop", stopId, set: { kind: "bay" } }],
        });
      }
      break;
    }
    case "pedestrian_yield": {
      if (ctrl !== undefined) {
        const green = greenOverride(ctx, ctrl, linkId, false);
        if (green !== undefined) out.push(green);
      }
      break;
    }
    case "gridlock": {
      // `behavior.gridlockDiscipline: 1` is a SimConfig parameter, and `Recommendation` (frozen)
      // carries only network overrides, so the value lives in the label.
      out.push({
        kind: "discipline_enforcement",
        label:
          "Не въезжать на занятый перекрёсток: дисциплина «вафельницы» (behavior.gridlockDiscipline = 1)",
        overrides: [],
      });
      break;
    }
    case "merge_yield": {
      out.push({
        kind: "ramp_metering",
        label:
          "Дозировать въезд на слиянии (светофор на съезде); в текущих сценариях не выражается",
        overrides: [],
      });
      break;
    }
    case "downstream_spillback": {
      const rank =
        input.downstreamLinkId === undefined
          ? undefined
          : input.rankByLinkId.get(input.downstreamLinkId);
      out.push({
        kind: "none",
        label:
          rank === undefined
            ? "Причина ниже по потоку: здесь лечить нечего"
            : `Причина ниже по потоку: см. #${rank}`,
        overrides: [],
      });
      break;
    }
    default:
      break;
  }
  return out.slice(0, MAX_RECOMMENDATIONS);
}

function greenOverride(
  ctx: RecommendationContext,
  ctrl: SignalController,
  linkId: string,
  arrow: boolean,
): Recommendation | undefined {
  const group = ctx.groupFor(ctrl, linkId, arrow);
  if (group === undefined) return undefined;
  const green = ctx.greenSecondsOf(ctrl, group.id) + GREEN_STEP_S;
  return {
    kind: "rebalance_green",
    label: arrow
      ? `Добавить ${GREEN_STEP_S} с доп. секции этого подхода (до ${Math.round(green)} с)`
      : `Добавить ${GREEN_STEP_S} с зелёного этому подходу (до ${Math.round(green)} с)`,
    overrides: [signalOverride(ctrl.nodeId, { greenS: { [group.id]: green } })],
  };
}

function signalOverride(
  nodeId: string,
  set: Extract<NetworkOverride, { kind: "signal" }>["set"],
): NetworkOverride {
  return { kind: "signal", nodeId, set };
}

function linkOverride(
  linkId: string,
  set: Extract<NetworkOverride, { kind: "link" }>["set"],
): NetworkOverride {
  return { kind: "link", linkId, set };
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
