const MINUTES_PER_YEAR = 525_600;

export class RollingRealizedVol {
  private readonly windowMinutes: number;
  private minuteCloses: { minute: number; close: number }[] = [];
  private cached: { len: number; returns: number[]; mean: number } | null = null;

  constructor(windowMinutes = 30) {
    this.windowMinutes = windowMinutes;
  }

  push(tsMs: number, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const minute = Math.floor(tsMs / 60_000);
    const last = this.minuteCloses.at(-1);
    if (last && last.minute === minute) {
      if (last.close !== price) {
        last.close = price;
        this.cached = null;
      }
      return;
    }
    this.minuteCloses.push({ minute, close: price });
    this.cached = null;
    while (this.minuteCloses.length > this.windowMinutes + 1) this.minuteCloses.shift();
  }

  annualizedVol(): number | null {
    const c = this.compute();
    if (!c) return null;
    const variance = c.returns.reduce((s, x) => s + (x - c.mean) ** 2, 0) / (c.returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(MINUTES_PER_YEAR);
  }

  annualizedDrift(): number | null {
    const c = this.compute();
    return c ? c.mean * MINUTES_PER_YEAR : null;
  }

  horizonStdev(horizonMinutes: number): number | null {
    const ann = this.annualizedVol();
    return ann === null ? null : ann * Math.sqrt(horizonMinutes / MINUTES_PER_YEAR);
  }

  private compute(): { returns: number[]; mean: number } | null {
    if (this.cached && this.cached.len === this.minuteCloses.length) return this.cached;
    if (this.minuteCloses.length < 3) return null;
    const returns: number[] = [];
    for (let i = 1; i < this.minuteCloses.length; i++) {
      const prev = this.minuteCloses[i - 1]!;
      const cur = this.minuteCloses[i]!;
      // Only use returns between CONSECUTIVE minutes. A feed gap (WS reconnect, missed
      // minutes) otherwise collapses a multi-minute move into a single "1-minute" return
      // which annualizedVol() then scales by sqrt(525600) as if it spanned one minute —
      // spiking vol ~sqrt(gap)x. High sigma widens the fair-value distribution and pulls
      // pUp toward 0.5, manufacturing a fake edge. Skip non-contiguous pairs.
      if (cur.minute - prev.minute !== 1) continue;
      if (prev.close > 0 && cur.close > 0) returns.push(Math.log(cur.close / prev.close));
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
    this.cached = { len: this.minuteCloses.length, returns, mean };
    return this.cached;
  }
}
