/**
 * Deterministic checks for the exit engine (manageOnCandle) — the shared TP-ladder /
 * stop / trailing logic used by BOTH the backtest and the live engine. Proves the two
 * goals of the feature: SAFE (loss bounded at 1R; breakeven after TP1; runner locks
 * +1R) and TAKE-PROFIT (TP1/TP2 fire at the right levels & fractions; runner trails).
 *
 * No test runner in this repo — run directly:  npx tsx src/scripts/check-manage.ts
 */
import { manageOnCandle, type RuntimePosition, type ManageCtx, type Fill } from "../risk/manage.js";
import { splitTranches } from "../risk/sizing.js";
import type { Candle, Side } from "../types.js";

let failures = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// A position with R = entry∓1.5×ATR(2) = ∓3, TP1 +1R, TP2 +2R, tranches 0.3/0.3, runner 0.4.
function makePos(side: Side): RuntimePosition {
  const long = side === "long";
  const entry = 100;
  const r = 3; // 1.5 × ATR(2)
  const sgn = long ? 1 : -1;
  const { qtyTp1, qtyTp2 } = splitTranches(1, 0.3, 0.3, 0.001);
  return {
    side, entry,
    stop: entry - sgn * r,
    tp1: entry + sgn * r, tp2: entry + sgn * 2 * r, tp3: entry + sgn * 3 * r,
    qtyTotal: 1, qtyRemaining: 1, qtyTp1, qtyTp2,
    tp1Hit: false, tp2Hit: false, trailActive: false, trailExtreme: entry, openedAtBar: 0,
  };
}
const candle = (high: number, low: number, close: number): Candle => ({
  symbol: "T", interval: "1h", openTime: 0, open: (high + low) / 2, high, low, close, volume: 0, closeTime: 0,
});
const ctx = (bar: number, trendUp: boolean): ManageCtx => ({
  bar, trendUp, atr: 2, trailMult: 3, maxHoldBars: 0, stallBars: 0, maxTotalBars: 0,
});
// Run a sequence of candles; collect all fills + whether/where it closed.
function run(pos: RuntimePosition, steps: Array<{ c: Candle; trendUp?: boolean }>): { fills: Fill[]; closed: boolean } {
  const fills: Fill[] = [];
  let closed = false;
  const withTrend = pos.side === "long"; // a healthy trend is UP for a long, DOWN for a short
  steps.forEach((s, i) => {
    if (closed) return;
    const res = manageOnCandle(pos, s.c, ctx(i, s.trendUp ?? withTrend));
    fills.push(...res.fills);
    if (res.closed) closed = true;
  });
  return { fills, closed };
}
// Realized R = Σ signed (exit−entry)×qty / riskPerUnit, riskPerUnit = |entry−initialStop| = 3.
function realizedR(side: Side, entry: number, fills: Fill[]): number {
  const sgn = side === "long" ? 1 : -1;
  const gross = fills.reduce((s, f) => s + sgn * (f.price - entry) * f.qty, 0);
  return gross / 3;
}

console.log("manageOnCandle — safety + profit invariants\n");

// ── SAFE-1: stopped before TP1 → exactly −1R, full qty ──
{
  const p = makePos("long");
  const { fills, closed } = run(p, [{ c: candle(101, 96, 96.5) }]); // low 96 ≤ stop 97
  ok(closed && fills.length === 1 && fills[0]!.kind === "STOP", "SAFE-1 long stop → STOP fill, closed");
  ok(fills[0] !== undefined && near(fills[0].qty, 1) && near(fills[0].price, 97), "SAFE-1 full qty @ stop", `qty=${fills[0]?.qty} px=${fills[0]?.price}`);
  ok(near(realizedR("long", 100, fills), -1), "SAFE-1 realized = −1R", `${realizedR("long", 100, fills).toFixed(3)}R`);
}
// ── SAFE-4 / PROFIT-3: TP1 then fade to breakeven → +0.3R banked (NOT 0), stop=breakeven ──
{
  const p = makePos("long");
  const r1 = run(p, [{ c: candle(104, 100, 104) }]); // hits TP1 (+1R)
  ok(r1.fills[0]?.kind === "TP1" && near(r1.fills[0]?.qty ?? -1, 0.3) && near(r1.fills[0]?.price ?? -1, 103), "PROFIT-3 TP1 sells 0.3 @ +1R");
  ok(near(p.stop, 100), "SAFE-4 stop → breakeven after TP1", `stop=${p.stop}`);
  const r2 = run(p, [{ c: candle(101, 99, 100) }]); // fade back to entry → breakeven stop
  ok(r2.closed && r2.fills.at(-1)?.kind === "MANAGED_STOP", "SAFE-4 rest exits at breakeven");
  ok(near(realizedR("long", 100, [...r1.fills, ...r2.fills]), 0.3), "PROFIT-3 nets +0.3R, not 0", `${realizedR("long", 100, [...r1.fills, ...r2.fills]).toFixed(3)}R`);
}
// ── PROFIT-1/2 + the worked example: TP1+TP2 then trail out at +4R → +2.5R total ──
{
  const p = makePos("long");
  const { fills, closed } = run(p, [
    { c: candle(107, 101, 107) }, // TP1@103 + TP2@106 (same candle), stop→103, trail armed, extreme→107
    { c: candle(112, 108, 111) }, // extreme→112 (trail=106)
    { c: candle(118, 114, 117) }, // extreme→118 (trail=112)
    { c: candle(118, 111, 112) }, // low 111 ≤ trail 112 → runner exits @112
  ]);
  const kinds = fills.map((f) => f.kind).join(",");
  ok(fills.some((f) => f.kind === "TP1" && near(f.qty, 0.3) && near(f.price, 103)), "PROFIT-1 TP1 0.3 @ +1R");
  ok(fills.some((f) => f.kind === "TP2" && near(f.qty, 0.3) && near(f.price, 106)), "PROFIT-1 TP2 0.3 @ +2R");
  ok(closed && fills.at(-1)?.kind === "MANAGED_STOP" && near(fills.at(-1)?.qty ?? -1, 0.4) && near(fills.at(-1)?.price ?? -1, 112), "PROFIT-2 runner 0.4 trails out @112 (+4R)", kinds);
  ok(near(realizedR("long", 100, fills), 2.5), "PROFIT total = +2.5R", `${realizedR("long", 100, fills).toFixed(3)}R`);
}
// ── SAFE-5: after TP2 the runner cannot give back below +1R ──
{
  const p = makePos("long");
  const { fills } = run(p, [
    { c: candle(107, 101, 107) }, // TP1+TP2, stop→103 (+1R)
    { c: candle(105, 103, 103) }, // immediately back to +1R stop
  ]);
  ok(fills.at(-1)?.kind === "MANAGED_STOP" && near(fills.at(-1)?.price ?? -1, 103), "SAFE-5 runner floor = +1R (103)");
  ok(realizedR("long", 100, fills) >= 1.3 - 1e-6, "SAFE-5 total ≥ +1.3R once TP2 hit", `${realizedR("long", 100, fills).toFixed(3)}R`);
}
// ── SAFE-4b: a crater candle + trend flip AFTER TP1 exits at the breakeven STOP, never
//    below it (stop check uses c.low and fires before the health-close on c.close). ──
{
  const p = makePos("long");
  run(p, [{ c: candle(104, 100, 104) }]);                       // TP1 → stop = breakeven (100)
  const r = run(p, [{ c: candle(100.5, 94, 95), trendUp: false }]); // craters AND trend flips
  ok(r.closed && r.fills.at(-1)?.kind === "MANAGED_STOP" && near(r.fills.at(-1)?.price ?? -1, 100), "SAFE-4 crater+flip after TP1 → exits at breakeven, not below", `px=${r.fills.at(-1)?.price}`);
  ok(realizedR("long", 100, r.fills) >= 0 - 1e-9, "SAFE-4 net ≥ 0 after TP1 (never a loss)");
}
// ── SAFE-5b: a crater candle + trend flip AFTER TP2 exits at the +1R lock, never below. ──
{
  const p = makePos("long");
  run(p, [{ c: candle(107, 101, 107) }]);                       // TP1+TP2 → stop = +1R (103)
  const r = run(p, [{ c: candle(104, 90, 92), trendUp: false }]); // craters AND trend flips
  ok(r.closed && near(r.fills.at(-1)?.price ?? -1, 103), "SAFE-5 crater+flip after TP2 → exits at +1R lock, not below", `px=${r.fills.at(-1)?.price}`);
}
// ── Trend-flip HEALTH_CLOSE (pre-TP1) ──
{
  const p = makePos("long");
  const { fills, closed } = run(p, [{ c: candle(101, 99, 100.5), trendUp: false }]); // trend flips against long
  ok(closed && fills[0]?.kind === "HEALTH_CLOSE" && near(fills[0]?.qty ?? -1, 1), "HEALTH_CLOSE on trend flip");
}
// ── SHORT mirror: stop = −1R, and TP1+TP2+trail = +2.5R ──
{
  const s1 = makePos("short");
  const r = run(s1, [{ c: candle(104, 99, 103.5) }]); // high 104 ≥ stop 103
  ok(r.closed && r.fills[0]?.kind === "STOP" && near(realizedR("short", 100, r.fills), -1), "SAFE-1 short stop = −1R");

  const s2 = makePos("short");
  const r2 = run(s2, [
    { c: candle(99, 93, 93) },  // TP1@97 + TP2@94, stop→97 (+1R), extreme→93
    { c: candle(92, 88, 89) },  // extreme→88
    { c: candle(86, 82, 83) },  // extreme→82
    { c: candle(89, 82, 88) },  // high 89 ≥ trail 88 → runner exits @88
  ]);
  ok(r2.closed && near(realizedR("short", 100, r2.fills), 2.5), "PROFIT short total = +2.5R", `${realizedR("short", 100, r2.fills).toFixed(3)}R`);
}
// ── splitTranches: fractions step-rounded, sum ≤ total, runner is the residual ──
{
  const a = splitTranches(1, 0.3, 0.3, 0.001);
  ok(near(a.qtyTp1, 0.3) && near(a.qtyTp2, 0.3) && near(1 - a.qtyTp1 - a.qtyTp2, 0.4), "splitTranches 0.3/0.3 → runner 0.4");
  const b = splitTranches(10, 1.5, 0.3, 1); // misconfig: never negative, never exceed total
  ok(b.qtyTp1 + b.qtyTp2 <= 10 + 1e-9 && b.qtyTp1 >= 0 && b.qtyTp2 >= 0, "splitTranches clamps misconfig (no negative runner)");
}

console.log(`\n${failures === 0 ? "ALL PASS ✓" : `${failures} FAILED ✗`}`);
process.exit(failures === 0 ? 0 : 1);
