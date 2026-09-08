import { isPeakHour, type Network, VEHICLE_CLASS_CODE, type VehicleClass } from "@atl/contracts";
import type { Rng } from "../rng.ts";
import type { LaneRuntime } from "../runtime/lanes.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import { headwayS, preferredLaneOfLink } from "./rules.ts";

/**
 * Static, precomputed shape of one `BusRoute` (T-14): the fixed chain of links as `RuntimeNetwork`
 * indices (topology never changes, so this is built once) and the entry lane a bus is placed on at
 * `entryNodeId` (its dedicated bus lane if the first link has one, else the rightmost lane).
 */
export interface TransitRoute {
  readonly id: string;
  readonly clsName: VehicleClass;
  readonly clsCode: number;
  readonly linkSeq: readonly number[];
  readonly entryLane: number;
  readonly headwayPeakS: number;
  readonly headwayOffpeakS: number;
}

function mustLinkIndex(rt: RuntimeNetwork, id: string, routeId: string): number {
  const idx = rt.linkIndex.get(id);
  if (idx === undefined) throw new Error(`bus route ${routeId}: unknown link ${id}`);
  return idx;
}

/**
 * Per-route spawn timing (T-14, item 1): a Poisson process would double-count the "no headway is an
 * accident" nature of a bus line, so routes instead run on the *scheduled* headway currently in force
 * (`peak`/`offpeak` by `isPeakHour`), with a uniformly random offset for the first departure so that
 * several routes sharing a link do not all arrive in lockstep.
 *
 * `nextSpawnS[r]` is only advanced once a bus for route `r` actually enters the network
 * (`SimulationImpl.spawnBuses`): if the entry lane has no room the route simply keeps trying every
 * step, which is what keeps the long-run bus count close to `3600 / headway` even under a queue.
 */
export class BusScheduleRuntime {
  readonly routes: readonly TransitRoute[];
  readonly nextSpawnS: Float64Array;

  constructor(
    net: Network,
    rt: RuntimeNetwork,
    lanes: LaneRuntime,
    rng: Rng,
    startTimeMin: number,
    peakHours: number[],
  ) {
    const routes: TransitRoute[] = [];
    for (const route of net.busRoutes) {
      const linkSeq = route.linkIds.map((id) => mustLinkIndex(rt, id, route.id));
      const firstLink = linkSeq[0] as number;
      routes.push({
        id: route.id,
        clsName: route.kind,
        clsCode: VEHICLE_CLASS_CODE[route.kind],
        linkSeq,
        entryLane: preferredLaneOfLink(rt, lanes, firstLink),
        headwayPeakS: route.headwayPeakS,
        headwayOffpeakS: route.headwayOffpeakS,
      });
    }
    this.routes = routes;
    this.nextSpawnS = new Float64Array(routes.length);
    const peakAtStart = isPeakHour({ peakHours }, startTimeMin);
    for (let r = 0; r < routes.length; r++) {
      const route = routes[r] as TransitRoute;
      this.nextSpawnS[r] = rng.float() * headwayS(route, peakAtStart);
    }
  }

  get routeCount(): number {
    return this.routes.length;
  }

  /** Schedules route `r`'s next departure, `headway` seconds (by the peak status right now) after `now`. */
  advance(r: number, now: number, peak: boolean): void {
    const route = this.routes[r] as TransitRoute;
    this.nextSpawnS[r] = now + headwayS(route, peak);
  }
}
