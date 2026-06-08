import { createServer } from "node:http";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

/**
 * Zero-dependency dashboard for the FUNDING-CARRY forward-tracker. Reads the paper
 * tracker DB (equity curve, funding collected, per-period returns, current 5L/5S book)
 * and serves a single self-contained HTML page that polls /api/state. Read-only.
 *
 *   npm run xsmom-dashboard                  # http://localhost:8789 (reads ./data/xsmom-paper.sqlite)
 *   XSMOM_DASH_PORT=9001 npm run xsmom-dashboard
 *
 * Visualises the PAPER forward-tracker (it has the per-period PnL + funding history).
 * The live executor's DB has a simpler schema — monitor live via `npm run account:live` + Telegram.
 */

const DB_PATH = process.env.XSMOM_DB ?? "./data/xsmom-paper.sqlite";
const PORT = Number(process.env.XSMOM_DASH_PORT ?? 8789);

interface Period {
  ts: number;
  ret: number;
  fund: number;
  equity: number;
  longs: string;
  shorts: string;
}

function buildState(): object {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name));
    const meta = (k: string): string | null => (db.prepare(`SELECT value FROM meta WHERE key=?`).get(k) as { value: string } | undefined)?.value ?? null;
    const params = JSON.parse(meta("params") ?? "{}");

    // Two sources, auto-detected: the PAPER tracker (`periods` table — equity is a 1.0-based
    // index, funding tracked) or the EXECUTOR (`rebalances` table — equity is real account USDT,
    // funding not tracked; per-period return derived from consecutive equity snapshots).
    let curve: Array<{ ts: number; equity: number }>;
    let periodsOut: Period[];
    let longs: string[] = [];
    let shorts: string[] = [];
    let totalFunding = 0;
    let fundingTracked = true;
    let unit: "x" | "USDT" = "x";
    let count = 0; // number of rebalance/period records (for the header + KPI)
    let legs: Record<string, { qty: number; notional: number }> = {}; // per-leg sizes (executor only)

    if (tables.has("periods")) {
      const periods = db.prepare(`SELECT ts, ret, fund, equity, longs, shorts FROM periods ORDER BY ts ASC`).all() as Period[];
      const book = db.prepare(`SELECT symbol, weight FROM book ORDER BY weight DESC`).all() as Array<{ symbol: string; weight: number }>;
      longs = book.filter((b) => b.weight > 0).map((b) => b.symbol);
      shorts = book.filter((b) => b.weight < 0).map((b) => b.symbol);
      totalFunding = periods.reduce((a, p) => a + p.fund, 0);
      curve = [{ ts: periods[0]?.ts ?? 0, equity: 1 }, ...periods.map((p) => ({ ts: p.ts, equity: p.equity }))];
      count = periods.length;
      periodsOut = periods.slice(-30).reverse();
    } else {
      const rebs = db.prepare(`SELECT ts, longs, shorts, equity FROM rebalances ORDER BY ts ASC`).all() as Array<{ ts: number; longs: string; shorts: string; equity: number }>;
      unit = "USDT";
      fundingTracked = false;
      count = rebs.length;
      if (tables.has("book_legs")) {
        for (const l of db.prepare(`SELECT symbol, qty, notional FROM book_legs`).all() as Array<{ symbol: string; qty: number; notional: number }>) {
          legs[l.symbol] = { qty: l.qty, notional: l.notional };
        }
      }
      curve = rebs.map((r) => ({ ts: r.ts, equity: r.equity }));
      const latest = rebs[rebs.length - 1];
      longs = latest ? latest.longs.split(",").filter(Boolean) : [];
      shorts = latest ? latest.shorts.split(",").filter(Boolean) : [];
      periodsOut = rebs
        .map((r, i) => ({ ts: r.ts, ret: i > 0 ? r.equity / rebs[i - 1]!.equity - 1 : 0, fund: 0, equity: r.equity, longs: r.longs, shorts: r.shorts }))
        .slice(-30)
        .reverse();
    }

    const rets: number[] = [];
    for (let i = 1; i < curve.length; i++) rets.push(curve[i]!.equity / curve[i - 1]!.equity - 1);
    const n = rets.length;
    const wins = rets.filter((r) => r > 0).length;
    const mean = n ? rets.reduce((a, r) => a + r, 0) / n : 0;
    const std = n ? Math.sqrt(Math.max(0, rets.reduce((a, r) => a + r * r, 0) / n - mean * mean)) : 0;
    let peak = curve[0]?.equity ?? 1;
    let maxDD = 0;
    for (const c of curve) {
      peak = Math.max(peak, c.equity);
      if (peak > 0) maxDD = Math.max(maxDD, (peak - c.equity) / peak);
    }
    const startEq = curve[0]?.equity ?? 1;
    const equity = curve[curve.length - 1]?.equity ?? startEq;

    return {
      dbPath: DB_PATH,
      signal: params.SIGNAL ?? "funding",
      params,
      unit,
      fundingTracked,
      equity,
      totalReturnPct: startEq > 0 ? (equity / startEq - 1) * 100 : 0,
      nPeriods: n,
      count,
      winRatePct: n ? (wins / n) * 100 : 0,
      sharpe: std > 0 ? mean / std : 0,
      totalFundingPct: totalFunding * 100,
      maxDDPct: maxDD * 100,
      lastRebalance: meta("last_rebalance_ts") ? Number(meta("last_rebalance_ts")) : curve[curve.length - 1]?.ts ?? null,
      curve,
      longs,
      shorts,
      legs,
      periods: periodsOut,
    };
  } finally {
    db.close();
  }
}

const server = createServer((req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/api/state") {
      let body: string;
      try {
        body = JSON.stringify(buildState());
      } catch (err) {
        body = JSON.stringify({ error: `cannot read ${DB_PATH} — has the tracker run yet? (${String(err)})` });
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    logger.error("xsmom-dashboard error:", err);
    res.writeHead(500);
    res.end("error");
  }
});

server.listen(PORT, () => logger.info(`xsmom-dashboard → http://localhost:${PORT}  (db: ${DB_PATH})`));

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>funding-carry</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #c9d1d9; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #1c2230; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .3px; }
  header .sub { color: #8b949e; font-size: 12px; }
  main { padding: 20px; max-width: 1000px; margin: 0 auto; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .kpi { background: #11161f; border: 1px solid #1c2230; border-radius: 10px; padding: 12px 14px; }
  .kpi .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .kpi .val { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .pos { color: #3fb950; } .neg { color: #f85149; } .muted { color: #8b949e; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #8b949e; margin: 0 0 8px; }
  .book { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .leg { background: #11161f; border: 1px solid #1c2230; border-radius: 10px; padding: 12px 14px; }
  .leg .ttl { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
  .tag { display: inline-block; background: #1c2230; border-radius: 6px; padding: 2px 7px; margin: 2px 4px 2px 0; font-size: 12px; }
  .tag b { color: #58a6ff; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid #1c2230; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #8b949e; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  svg { width: 100%; height: 200px; background: #11161f; border: 1px solid #1c2230; border-radius: 10px; }
</style></head>
<body>
<header><h1>⚖️ Funding-Carry Forward-Test</h1><span class="sub" id="sub">…</span></header>
<main>
  <div class="kpis" id="kpis"></div>
  <section><h2 id="chartTitle">Equity curve</h2><svg id="chart" viewBox="0 0 800 200" preserveAspectRatio="none"></svg></section>
  <section><h2>Current book</h2><div class="book"><div class="leg"><div class="ttl pos">LONG (low funding)</div><div id="longs"></div></div><div class="leg"><div class="ttl neg">SHORT (high funding)</div><div id="shorts"></div></div></div></section>
  <section><h2>Recent rebalances</h2><table><thead><tr><th>Time (UTC)</th><th>Return</th><th>Funding</th><th>Equity</th><th>Longs</th><th>Shorts</th></tr></thead><tbody id="rows"></tbody></table></section>
</main>
<script>
const pct = (x) => (x>=0?"+":"") + x.toFixed(2) + "%";
const cls = (x) => x>=0 ? "pos" : "neg";
const fmtTs = (t) => t ? new Date(t).toISOString().slice(0,16).replace("T"," ") : "—";
function kpi(label, val, klass){ return '<div class="kpi"><div class="label">'+label+'</div><div class="val '+(klass||'')+'">'+val+'</div></div>'; }
function chart(curve){
  const svg = document.getElementById('chart');
  if(!curve || curve.length<2){ svg.innerHTML=''; return; }
  const eq = curve.map(c=>c.equity); const min=Math.min(...eq,1), max=Math.max(...eq,1);
  const W=800,H=200,pad=8; const sx=(i)=> pad + i*(W-2*pad)/(curve.length-1);
  const sy=(v)=> max===min ? H/2 : pad + (1-(v-min)/(max-min))*(H-2*pad);
  const pts = curve.map((c,i)=> sx(i)+','+sy(c.equity)).join(' ');
  const base = sy(1);
  svg.innerHTML = '<line x1="0" x2="800" y1="'+base+'" y2="'+base+'" stroke="#2a3340" stroke-dasharray="4 4"/>' +
    '<polyline points="'+pts+'" fill="none" stroke="'+(eq[eq.length-1]>=1?'#3fb950':'#f85149')+'" stroke-width="2"/>';
}
async function tick(){
  try{
    const s = await (await fetch('/api/state')).json();
    if(s.error){ document.getElementById('sub').textContent = s.error; return; }
    const p = s.params||{};
    document.getElementById('sub').textContent = s.signal+' · L'+p.L+' H'+p.H+' K'+p.K+' · '+s.count+' rebalances · last '+fmtTs(s.lastRebalance)+' · '+s.dbPath;
    document.getElementById('chartTitle').textContent = s.unit==='USDT' ? 'Equity curve (account USDT)' : 'Equity curve (paper index, start 1.0)';
    document.getElementById('kpis').innerHTML =
      kpi('Equity', s.unit==='USDT' ? s.equity.toFixed(2)+' USDT' : s.equity.toFixed(4)+'×') +
      kpi('Total return', pct(s.totalReturnPct), cls(s.totalReturnPct)) +
      kpi('Total funding', s.fundingTracked ? pct(s.totalFundingPct) : '—', s.fundingTracked ? cls(s.totalFundingPct) : 'muted') +
      kpi('Per-period Sharpe', s.sharpe.toFixed(2), cls(s.sharpe)) +
      kpi('Win rate', s.winRatePct.toFixed(0)+'%') +
      kpi('Max drawdown', s.maxDDPct.toFixed(1)+'%', 'neg') +
      kpi('Rebalances', String(s.count));
    chart(s.curve);
    const tag = (x)=>'<span class="tag">'+x+(s.legs&&s.legs[x]?' <b>$'+Math.round(s.legs[x].notional)+'</b>':'')+'</span>';
    document.getElementById('longs').innerHTML = (s.longs||[]).map(tag).join('') || '<span class="muted">none</span>';
    document.getElementById('shorts').innerHTML = (s.shorts||[]).map(tag).join('') || '<span class="muted">none</span>';
    document.getElementById('rows').innerHTML = (s.periods||[]).map(r=>
      '<tr><td>'+fmtTs(r.ts)+'</td><td class="'+cls(r.ret)+'">'+pct(r.ret*100)+'</td>'+(s.fundingTracked?'<td class="'+cls(r.fund)+'">'+pct(r.fund*100)+'</td>':'<td class="muted">—</td>')+'<td>'+(s.unit==='USDT'?r.equity.toFixed(2):r.equity.toFixed(4))+'</td>'+
      '<td class="muted">'+(r.longs||'').replaceAll(',',' ')+'</td><td class="muted">'+(r.shorts||'').replaceAll(',',' ')+'</td></tr>').join('') ||
      '<tr><td colspan="6" class="muted">no realized periods yet — first book is open</td></tr>';
  }catch(e){ document.getElementById('sub').textContent = String(e); }
}
tick(); setInterval(tick, 5000);
</script>
</body></html>`;
