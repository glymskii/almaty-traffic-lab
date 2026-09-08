import type { DemandConfig } from "@atl/contracts";

/**
 * Trips per second the whole network generates right now: the peak rate scaled by the hour-of-day
 * profile and by the runtime-safe global multiplier (docs/tasks/T-12, "профиль часа и multiplier").
 * The per-origin share is applied by the spawner.
 */
export function tripRatePerS(
  baseTripsPerHour: number,
  demand: Pick<DemandConfig, "hourlyProfile" | "multiplier">,
  hourOfDay: number,
): number {
  const profile = demand.hourlyProfile[hourOfDay] ?? 0;
  return (baseTripsPerHour * profile * demand.multiplier) / 3600;
}
