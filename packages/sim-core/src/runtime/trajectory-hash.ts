/**
 * Trajectory hash for regression tests and N04 (determinism).
 *
 * Per step every vehicle contributes FNV-1a of (id, round(x*100), round(y*100), round(v*100)); the
 * contributions are summed (order-independent inside a step) and the sums are folded into two
 * FNV-1a accumulators, so the result depends on every step since creation. Two 32-bit lanes with
 * different mixing give a 64-bit hex digest.
 */
const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvInt32(h: number, value: number): number {
  let x = h;
  x = Math.imul(x ^ (value & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ ((value >>> 8) & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ ((value >>> 16) & 0xff), FNV_PRIME) >>> 0;
  x = Math.imul(x ^ ((value >>> 24) & 0xff), FNV_PRIME) >>> 0;
  return x;
}

export class TrajectoryHash {
  private h1 = FNV_BASIS;
  private h2 = 0x050c5d1f;
  private sumA = 0;
  private sumB = 0;
  private count = 0;

  beginStep(): void {
    this.sumA = 0;
    this.sumB = 0;
    this.count = 0;
  }

  add(id: number, x: number, y: number, v: number): void {
    let h = FNV_BASIS;
    h = fnvInt32(h, id | 0);
    h = fnvInt32(h, Math.round(x * 100) | 0);
    h = fnvInt32(h, Math.round(y * 100) | 0);
    h = fnvInt32(h, Math.round(v * 100) | 0);
    this.sumA = (this.sumA + h) >>> 0;
    const mixed = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    this.sumB = (this.sumB + mixed) >>> 0;
    this.count++;
  }

  endStep(): void {
    this.h1 = fnvInt32(fnvInt32(this.h1, this.sumA), this.count);
    this.h2 = fnvInt32(fnvInt32(this.h2, this.sumB), this.count);
  }

  /** 16 hex characters. */
  hex(): string {
    return this.h1.toString(16).padStart(8, "0") + this.h2.toString(16).padStart(8, "0");
  }
}
