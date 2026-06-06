import { createServer } from "node:http";
import { logger } from "../logger.js";
import { getDb } from "../storage/db.js";
import { getMeta } from "../storage/engineState.js";
import { useVenue } from "../exchange/venue.js";
import { buildState } from "./state.js";

/**
 * Zero-dependency operations dashboard. Serves a single self-contained HTML page
 * that polls /api/state every few seconds. Trades/equity come from SQLite; live
 * mark prices for open positions are fetched from the venue (public). Deliberately
 * not a Next.js app — keeps the bot dependency-light.
 */
export function startDashboard(port: number): void {
  getDb(); // ensure schema exists
  // Point the public client at the venue that wrote this DB, so live mark prices
  // come from the right market (demo-fapi for testnet, mainnet for live).
  useVenue(getMeta("engine:label") === "LIVE");

  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/api/state") {
        const body = JSON.stringify(await buildState());
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      logger.error("dashboard error:", err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    }
  });

  server.listen(port, () => {
    logger.info(`dashboard → http://localhost:${port}`);
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>binance-bot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #c9d1d9; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #1c2230; position: sticky; top: 0; background: #0b0e14; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .3px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .online { background: #3fb950; } .stale { background: #d29922; } .idle { background: #6e7681; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .kpi { background: #11161f; border: 1px solid #1c2230; border-radius: 10px; padding: 12px 14px; }
  .kpi .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .kpi .val { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .pos { color: #3fb950; } .neg { color: #f85149; } .muted { color: #8b949e; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #8b949e; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid #161b24; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #8b949e; font-weight: 500; }
  .card { background: #11161f; border: 1px solid #1c2230; border-radius: 10px; padding: 14px; }
  svg { width: 100%; height: 160px; display: block; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #1c2230; color: #8b949e; }
  .hint { font-size: 12px; color: #8b949e; margin: -4px 0 8px; }
  .long { color: #3fb950; } .short { color: #f85149; }
  .ctx { padding: 8px 20px; border-bottom: 1px solid #1c2230; color: #8b949e; font-size: 12px;
         display: flex; gap: 16px; flex-wrap: wrap; }
  .ctx b { color: #c9d1d9; font-weight: 600; }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot idle"></span>
  <h1>binance-bot</h1>
  <span id="venue" class="tag"></span>
  <span id="status" class="muted"></span>
  <span style="flex:1"></span>
  <span id="updated" class="muted"></span>
</header>
<div class="ctx" id="ctx"></div>
<main>
  <div class="kpis" id="kpis"></div>
  <section><h2>Equity</h2><div class="card"><svg id="chart" viewBox="0 0 1000 160" preserveAspectRatio="none"></svg></div></section>
  <section><h2>Open positions</h2>
    <div class="hint">Max loss = PnL if the current Stop hits (≈0 once it moves to breakeven) · Target = +2R goal (bot takes ½ there, trails the rest) · R now = current profit in risk-multiples</div>
    <div class="card"><table id="open"></table></div></section>
  <section><h2>By playbook</h2><div class="card"><table id="pb"></table></div></section>
  <section><h2>Recent closed</h2><div class="card"><table id="closed"></table></div></section>
</main>
<script>
const usd = (x) => (x>=0?'+':'') + (x??0).toFixed(2);
const pct = (x) => ((x??0)*100).toFixed(1) + '%';
const sign = (x) => x>=0 ? 'pos' : 'neg';
const ago = (ms) => { if(ms==null) return '—'; const s=Math.round(ms/1000); if(s<90) return s+'s ago'; const m=Math.round(s/60); if(m<90) return m+'m ago'; return Math.round(m/60)+'h ago'; };
const tdate = (ts) => ts ? new Date(ts).toISOString().slice(5,16).replace('T',' ') : '—';

function kpi(label, val, cls) { return '<div class="kpi"><div class="label">'+label+'</div><div class="val '+(cls||'')+'">'+val+'</div></div>'; }

function chart(curve) {
  const svg = document.getElementById('chart');
  if (!curve.length) { svg.innerHTML = '<text x="500" y="80" fill="#6e7681" text-anchor="middle">no data yet</text>'; return; }
  const xs = curve.map(c=>c.equity);
  const min = Math.min(...xs), max = Math.max(...xs), range = (max-min)||1;
  const n = curve.length;
  const pts = curve.map((c,i) => [ (n===1?0:(i/(n-1))*1000), 160 - ((c.equity-min)/range)*150 - 5 ]);
  const d = pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const last = xs[xs.length-1], first = xs[0];
  const col = last>=first ? '#3fb950' : '#f85149';
  svg.innerHTML = '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2"/>'
    + '<text x="6" y="14" fill="#6e7681" font-size="11">'+max.toFixed(0)+'</text>'
    + '<text x="6" y="156" fill="#6e7681" font-size="11">'+min.toFixed(0)+'</text>';
}

function table(el, head, rows) {
  document.getElementById(el).innerHTML =
    '<tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr>' +
    (rows.length ? rows.join('') : '<tr><td colspan="'+head.length+'" class="muted">none</td></tr>');
}

// Render the bot-config strip (risk, leverage, universe, playbooks…).
function ctxStrip(c) {
  return [
    ['risk', c.risk], ['leverage', c.leverage+'x'], ['max open', c.maxOpen],
    ['kill switch', (c.killSwitchPct*100).toFixed(0)+'%'], ['timeframe', c.timeframe],
    ['universe', c.universe], ['playbooks', c.playbooks],
  ].map(([k,v]) => '<span>'+k+' <b>'+v+'</b></span>').join('');
}

async function tick() {
  let s; try { s = await (await fetch('/api/state')).json(); } catch(e){ return; }
  const m = s.metrics;
  document.getElementById('dot').className = 'dot ' + s.health.status;
  document.getElementById('venue').textContent = s.venue;
  document.getElementById('status').textContent = s.health.status + ' · last tick ' + ago(s.health.ageMs) + ' · ' + s.timeframe;
  document.getElementById('updated').textContent = 'refreshed ' + new Date(s.now).toLocaleTimeString();
  document.getElementById('ctx').innerHTML = ctxStrip(s.context);

  document.getElementById('kpis').innerHTML = [
    kpi('Equity', m.endEquity.toFixed(2)),
    kpi('Unrealized (live)', usd(s.unrealizedPnl), sign(s.unrealizedPnl)),
    kpi('Net PnL (closed)', usd(m.netPnl), sign(m.netPnl)),
    kpi('Today', usd(s.today.netPnl)+'  ('+s.today.trades+')', sign(s.today.netPnl)),
    kpi('Return', pct(m.returnPct), sign(m.returnPct)),
    kpi('Win rate', pct(m.winRate)),
    kpi('Expectancy', m.expectancyR.toFixed(3)+'R', sign(m.expectancyR)),
    kpi('Profit factor', m.profitFactor===null?'∞':(isFinite(m.profitFactor)?m.profitFactor.toFixed(2):'∞'), sign(m.profitFactor-1)),
    kpi('Max DD', pct(m.maxDrawdownPct), 'neg'),
    kpi('Trades', m.trades + ' ('+m.wins+'W/'+m.losses+'L)'),
    kpi('Fees', usd(-m.commission), 'neg'),
    kpi('Funding', usd(m.funding), sign(m.funding)),
  ].join('');

  chart(s.equityCurve);

  table('open', ['Symbol','Side','Entry','Mark','Stop','Max loss','Target (+2R)','uPnL (live)','R now','TP','Age'],
    s.open.map(p => {
      const risk = p.riskUsdt;
      const rNow = (risk && p.unrealizedPnl!=null) ? p.unrealizedPnl/risk : null;
      // PnL if the CURRENT stop hits: negative = loss, ~0 = breakeven, positive = locked profit.
      const sgn = p.side==='long' ? 1 : -1;
      const atStop = sgn*(p.stop - p.entry)*p.qtyRemaining;
      const atStopCls = atStop < -0.01 ? 'neg' : atStop > 0.01 ? 'pos' : 'muted';
      return '<tr><td>'+p.symbol+'</td><td class="'+p.side+'">'+p.side+'</td>'
        +'<td>'+p.entry+'</td>'
        +'<td>'+(p.markPrice!=null?p.markPrice:'—')+'</td>'
        +'<td>'+p.stop+'</td>'
        +'<td class="'+atStopCls+'">'+usd(atStop)+'</td>'
        +'<td class="pos">'+(risk!=null?'+'+(2*risk).toFixed(2):'—')+'</td>'
        +'<td class="'+(p.unrealizedPnl==null?'muted':sign(p.unrealizedPnl))+'">'+(p.unrealizedPnl==null?'—':usd(p.unrealizedPnl))+'</td>'
        +'<td class="'+(rNow==null?'muted':sign(rNow))+'">'+(rNow==null?'—':(rNow>=0?'+':'')+rNow.toFixed(2)+'R')+'</td>'
        +'<td>'+(p.tp2Hit?'TP2':p.tp1Hit?'TP1✓':'—')+'</td>'
        +'<td class="muted">'+ago(s.now-p.openedAt)+'</td></tr>';
    }));

  table('pb', ['Playbook','Trades','Win rate','Net PnL'],
    s.byPlaybook.map(p => '<tr><td>'+p.playbook+'</td><td>'+p.trades+'</td><td>'+pct(p.winRate)+'</td>'
      +'<td class="'+sign(p.netPnl)+'">'+usd(p.netPnl)+'</td></tr>'));

  table('closed', ['Symbol','Side','Playbook','Reason','R','Net PnL','Closed'],
    s.recentClosed.map(t => '<tr><td>'+t.symbol+'</td><td>'+t.side+'</td><td><span class="tag">'+t.playbook+'</span></td>'
      +'<td class="muted">'+(t.closeReason||'—')+'</td><td class="'+sign(t.rRealized||0)+'">'+(t.rRealized==null?'—':t.rRealized.toFixed(2)+'R')+'</td>'
      +'<td class="'+sign(t.netPnl||0)+'">'+usd(t.netPnl)+'</td><td class="muted">'+tdate(t.closedAt)+'</td></tr>'));
}
tick(); setInterval(tick, 5000);
</script>
</body>
</html>`;
