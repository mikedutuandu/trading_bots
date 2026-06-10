import type { Trade } from "../types.js";
import type { BacktestResult } from "./runner.js";

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnl: number;
  commission: number;
  funding: number;
  netPnl: number;
  expectancyR: number; // avg net R per trade
  avgWinR: number;
  avgLossR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
}

function computeMaxDrawdown(curve: Array<{ equity: number }>): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export function computeMetrics(result: BacktestResult): Metrics {
  return metricsFromTrades(result.trades, result.equityCurve, result.startEquity, result.endEquity);
}

/**
 * Compute metrics from a raw trade list + equity curve. Reused by the backtest
 * (full result) and the live dashboard (closed trades + equity snapshots).
 */
export function metricsFromTrades(
  ts: Trade[],
  equityCurve: Array<{ equity: number }>,
  startEquity: number,
  endEquity: number,
): Metrics {
  const wins = ts.filter((t) => (t.netPnl ?? 0) > 0);
  const losses = ts.filter((t) => (t.netPnl ?? 0) <= 0);
  const grossPnl = sum(ts.map((t) => t.grossPnl ?? 0));
  const commission = sum(ts.map((t) => t.commission ?? 0));
  const funding = sum(ts.map((t) => t.funding ?? 0));
  const netPnl = sum(ts.map((t) => t.netPnl ?? 0));
  const rValues = ts.map((t) => t.rRealized ?? 0);
  const winR = wins.map((t) => t.rRealized ?? 0);
  const lossR = losses.map((t) => t.rRealized ?? 0);
  const grossWin = sum(wins.map((t) => t.netPnl ?? 0));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl ?? 0)));

  return {
    trades: ts.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ts.length ? wins.length / ts.length : 0,
    grossPnl,
    commission,
    funding,
    netPnl,
    expectancyR: avg(rValues),
    avgWinR: avg(winR),
    avgLossR: avg(lossR),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDrawdownPct: computeMaxDrawdown(equityCurve),
    startEquity,
    endEquity,
    returnPct: startEquity ? (endEquity - startEquity) / startEquity : 0,
  };
}

export function groupBy<K extends string>(
  trades: Trade[],
  key: (t: Trade) => K,
): Map<K, { trades: number; wins: number; netPnl: number }> {
  const m = new Map<K, { trades: number; wins: number; netPnl: number }>();
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) ?? { trades: 0, wins: 0, netPnl: 0 };
    g.trades++;
    if ((t.netPnl ?? 0) > 0) g.wins++;
    g.netPnl += t.netPnl ?? 0;
    m.set(k, g);
  }
  return m;
}

function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0);
}
function avg(a: number[]): number {
  return a.length ? sum(a) / a.length : 0;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

export function formatReport(result: BacktestResult, label: string): string {
  const m = computeMetrics(result);
  const lines: string[] = [];
  lines.push(`\n══════════ Backtest: ${label} ══════════`);
  lines.push(`Trades:        ${m.trades}  (${m.wins}W / ${m.losses}L)`);
  lines.push(`Win rate:      ${pct(m.winRate)}`);
  lines.push(`Expectancy:    ${m.expectancyR.toFixed(3)} R/trade   (avg win ${m.avgWinR.toFixed(2)}R, avg loss ${m.avgLossR.toFixed(2)}R)`);
  lines.push(`Profit factor: ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`);
  lines.push(`Gross PnL:     ${usd(m.grossPnl)} USDT`);
  lines.push(`Commission:    ${usd(-m.commission)} USDT`);
  lines.push(`Funding:       ${usd(m.funding)} USDT   (negative = paid to counterparty)`);
  lines.push(`Net PnL:       ${usd(m.netPnl)} USDT   (after fees + funding)`);
  lines.push(`Equity:        ${m.startEquity.toFixed(2)} → ${m.endEquity.toFixed(2)}  (${usd(m.returnPct * 100)}%)`);
  lines.push(`Max drawdown:  ${pct(m.maxDrawdownPct)}`);

  // Per-playbook
  const byPb = groupBy(result.trades, (t) => t.playbook);
  lines.push(`\nBy playbook:`);
  for (const [k, g] of byPb) {
    lines.push(`  ${k.padEnd(16)} ${String(g.trades).padStart(4)} trades  ${pct(g.wins / g.trades).padStart(6)} win  ${usd(g.netPnl).padStart(10)} USDT`);
  }

  // Per close reason — the live↔backtest parity lens (e.g. REVERSAL_CLOSE only exists
  // with LIVE_SIM; its share should roughly match the live journal's).
  const byReason = groupBy(result.trades, (t) => t.closeReason ?? "?");
  lines.push(`\nBy close reason:`);
  for (const [k, g] of [...byReason.entries()].sort((a, b) => b[1].trades - a[1].trades)) {
    lines.push(`  ${k.padEnd(16)} ${String(g.trades).padStart(4)} trades  ${pct(g.wins / g.trades).padStart(6)} win  ${usd(g.netPnl).padStart(10)} USDT`);
  }

  // Per-month
  const byMonth = groupBy(result.trades, (t) => new Date(t.closedAt ?? t.openedAt).toISOString().slice(0, 7) as string);
  lines.push(`\nBy month:`);
  for (const k of [...byMonth.keys()].sort()) {
    const g = byMonth.get(k)!;
    lines.push(`  ${k}  ${String(g.trades).padStart(4)} trades  ${pct(g.wins / g.trades).padStart(6)} win  ${usd(g.netPnl).padStart(10)} USDT`);
  }

  lines.push(`════════════════════════════════════════\n`);
  return lines.join("\n");
}
