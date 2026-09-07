/**
 * Simulation clock. Time is an integer number of steps times `dtS`, so `simTimeS` never drifts.
 * Time of day wraps at midnight (minutes since midnight, 0..1440).
 */
export class SimClock {
  readonly dtS: number;
  readonly startTimeMin: number;
  stepIndex = 0;

  constructor(dtS: number, startTimeMin: number) {
    if (!(dtS > 0)) throw new Error(`dtS must be positive, got ${dtS}`);
    this.dtS = dtS;
    this.startTimeMin = startTimeMin;
  }

  get simTimeS(): number {
    return this.stepIndex * this.dtS;
  }

  get timeOfDayMin(): number {
    return (this.startTimeMin + this.simTimeS / 60) % 1440;
  }

  /** Hour of day 0..23 for hourly profiles. */
  get hourOfDay(): number {
    return Math.floor(this.timeOfDayMin / 60) % 24;
  }

  advance(): void {
    this.stepIndex++;
  }
}
