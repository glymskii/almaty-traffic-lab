import type { DriverParams, VehicleClass, VehicleClassParams } from "@atl/contracts";
import { VEHICLE_CLASS_CODE } from "@atl/contracts";
import type { Rng } from "../rng.ts";
import type { VehiclePool } from "../runtime/vehicles.ts";

/**
 * Samples one driver into pool slot `i` from the config distributions and the vehicle class.
 * The draw order below is part of the deterministic contract: every driver consumes the same
 * sequence of samples from the driver stream, so adding a vehicle never shifts another driver's values.
 */
export function sampleDriverInto(
  pool: VehiclePool,
  i: number,
  rng: Rng,
  driver: DriverParams,
  cls: VehicleClass,
  clsParams: VehicleClassParams,
  occupancy: number,
): void {
  pool.cls[i] = VEHICLE_CLASS_CODE[cls];
  pool.length[i] = clsParams.lengthM;
  pool.maxAccel[i] = clsParams.maxAccelMps2;
  pool.comfortDecel[i] = clsParams.comfortDecelMps2;
  pool.speedFactor[i] = rng.sample(driver.desiredSpeedFactor) * clsParams.desiredSpeedFactor;
  pool.timeHeadway[i] = rng.sample(driver.timeHeadwayS);
  pool.minGap[i] = rng.sample(driver.minGapM);
  pool.politeness[i] = rng.sample(driver.politeness);
  pool.laneChangeThreshold[i] = rng.sample(driver.laneChangeThresholdMps2);
  pool.gapLeftTurn[i] = rng.sample(driver.criticalGapLeftTurnS);
  pool.gapMerge[i] = rng.sample(driver.criticalGapMergeS);
  pool.gapPedestrian[i] = rng.sample(driver.criticalGapPedestrianS);
  pool.occupancy[i] = occupancy;
}
