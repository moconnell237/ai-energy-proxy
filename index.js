const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PDFDocument = require('pdfkit');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, APCA-API-KEY-ID, APCA-API-SECRET-KEY');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '4mb' }));

// CONFIG
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL   = 'moconnell237@gmail.com';
const REPORT_TO    = 'moconnell237@gmail.com';
const ALPACA_KEY  = 'PKS4GQ5KF4O4TVM6QCMNK2XRHA';
const ALPACA_SEC  = 'DqbVvYukgJMXQtHY2AFx96P1qo2Sbo3jgkpbkwdytbMZ';
const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2';

const HOLDINGS = [
  { ticker:'CEG',  name:'Constellation Energy',     alloc:0.11, bucket:'Nuclear'     },
  { ticker:'VST',  name:'Vistra Corp',              alloc:0.08, bucket:'Nuclear'     },
  { ticker:'TLN',  name:'Talen Energy',             alloc:0.05, bucket:'Nuclear'     },
  { ticker:'KMI',  name:'Kinder Morgan',            alloc:0.08, bucket:'Nat Gas'     },
  { ticker:'ET',   name:'Energy Transfer LP',       alloc:0.07, bucket:'Nat Gas'     },
  { ticker:'BE',   name:'Bloom Energy',             alloc:0.02, bucket:'Nat Gas'     },
  { ticker:'VRT',  name:'Vertiv Holdings',          alloc:0.10, bucket:'Cooling'     },
  { ticker:'TT',   name:'Trane Technologies',       alloc:0.04, bucket:'Cooling'     },
  { ticker:'GEV',  name:'GE Vernova',               alloc:0.08, bucket:'Grid'        },
  { ticker:'ETN',  name:'Eaton Corp',               alloc:0.06, bucket:'Grid'        },
  { ticker:'PWR',  name:'Quanta Services',          alloc:0.04, bucket:'Grid'        },
  { ticker:'IRM',  name:'Iron Mountain',            alloc:0.08, bucket:'REIT'        },
  { ticker:'CCJ',  name:'Cameco Corp',              alloc:0.06, bucket:'SMR/Uranium' },
  { ticker:'OKLO', name:'Oklo Inc',                 alloc:0.03, bucket:'SMR/Uranium' },
  { ticker:'AIPO', name:'Defiance AI & Power ETF',  alloc:0.05, bucket:'ETF'         },
  { ticker:'ENFR', name:'Alerian Energy Infra ETF', alloc:0.03, bucket:'ETF'         },
  { ticker:'XLU',  name:'Utilities Select SPDR',    alloc:0.02, bucket:'ETF'         },
];

const CATALYSTS = [
  { date:'Jun 15, 2026',  ticker:'IRM',  label:'Dividend record date $0.864/sh',  urgency:'high'     },
  { date:'Jul 4, 2026',   ticker:'OKLO', label:'Groves Reactor Criticality',       urgency:'critical' },
  { date:'Jul 30, 2026',  ticker:'CCJ',  label:'Q2 2026 Earnings',                urgency:'medium'   },
  { date:'Aug 5, 2026',   ticker:'VRT',  label:'Q2 2026 Earnings',                urgency:'medium'   },
  { date:'Aug 12, 2026',  ticker:'VST',  label:'Q2 2026 Earnings',                urgency:'medium'   },
  { date:'H2 2026',       ticker:'VST',  label:'Cogentrix Acquisition Close',      urgency:'high'     },
  { date:'Dec 2026',      ticker:'GEV',  label:'110 GW Turbine Backlog Target',    urgency:'medium'   },
];

const aHeaders = () => ({
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SEC,
  'Content-Type': 'application/json',
});



// SCAN ONE TICKER
async function scanTicker(holding) {
  const prompt = `You are an AI trading assistant. Use web_search to find latest news on ${holding.ticker} (${holding.name}) in the ${holding.bucket} sector. Search: "${holding.ticker} stock news 2026" and "${holding.ticker} earnings analyst". Respond ONLY with raw JSON no markdown: {"ticker":"${holding.ticker}","signal":"BUY or HOLD or TRIM or WATCH","impact":"HIGH or MEDIUM or LOW","headline":"one sentence","action":"1-2 sentence recommendation","sentiment":"BULLISH or NEUTRAL or BEARISH","confidence":8}`;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:1000, tools:[{ type:'web_search_20250305', name:'web_search' }], messages:[{ role:'user', content:prompt }] }),
    });
    const data = await resp.json();
    let text = '';
    for (const block of (data.content || [])) { if (block.type === 'text') text += block.text; }
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (result) { result.bucket = holding.bucket; result.name = holding.name; }
    return result || { ticker:holding.ticker, name:holding.name, bucket:holding.bucket, signal:'HOLD', impact:'LOW', headline:'No major developments.', action:'Maintain position.', sentiment:'NEUTRAL', confidence:5 };
  } catch(e) {
    return { ticker:holding.ticker, name:holding.name, bucket:holding.bucket, signal:'HOLD', impact:'LOW', headline:'Scan error.', action:'Manual review.', sentiment:'NEUTRAL', confidence:0 };
  }
}

// ALPACA FETCHERS
async function fetchAlpacaAccount() {
  const r = await fetch(`${ALPACA_BASE}/account`, { headers: aHeaders() });
  return r.json();
}
async function fetchAlpacaPositions() {
  const r = await fetch(`${ALPACA_BASE}/positions`, { headers: aHeaders() });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}
async function fetchAlpacaOrders() {
  const r = await fetch(`${ALPACA_BASE}/orders?status=all&limit=20`, { headers: aHeaders() });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

// GENERATE PDF
function generatePDF(title, sections) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin:50, size:'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.rect(0, 0, doc.page.width, 80).fill('#050A14');
    doc.fillColor('#00E5FF').font('Helvetica-Bold').fontSize(20).text('AI ENERGY TRADER', 50, 22);
    doc.fillColor('#69F0AE').font('Helvetica').fontSize(11).text(title, 50, 48);
    doc.fillColor('#5A7090').fontSize(9).text(`Generated: ${new Date().toLocaleString('en-US', { timeZone:'America/New_York' })} ET`, 50, 62);
    doc.moveDown(3);

    sections.forEach(section => {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.fillColor('#1A2A40').rect(50, doc.y, doc.page.width - 100, 24).fill();
      doc.fillColor('#00E5FF').font('Helvetica-Bold').fontSize(11).text(section.title, 58, doc.y - 19);
      doc.moveDown(1.2);

      section.rows.forEach(row => {
        if (doc.y > doc.page.height - 100) doc.addPage();
        if (row.type === 'signal') {
          const sc = row.signal==='BUY'?'#69F0AE':row.signal==='TRIM'?'#FF6B6B':row.signal==='WATCH'?'#FFD700':'#5A7090';
          doc.fillColor('#0D1525').rect(50, doc.y, doc.page.width - 100, 55).fill();
          doc.fillColor(sc).font('Helvetica-Bold').fontSize(12).text(row.ticker, 58, doc.y - 50);
          doc.fillColor('#6A8AAA').font('Helvetica').fontSize(9).text(row.bucket, 58, doc.y - 36);
          doc.fillColor(sc).font('Helvetica-Bold').fontSize(10).text(row.signal, doc.page.width - 120, doc.y - 50, { width:70, align:'right' });
          doc.fillColor('#A0B8D0').font('Helvetica').fontSize(9).text(row.headline, 58, doc.y - 22, { width:doc.page.width - 130 });
          doc.fillColor('#5A7090').fontSize(8).text(`Action: ${row.action}`, 58, doc.y - 6, { width:doc.page.width - 130 });
          doc.moveDown(0.8);
        } else if (row.type === 'position') {
          const pc = row.pnl >= 0 ? '#69F0AE' : '#FF6B6B';
          doc.fillColor('#0D1525').rect(50, doc.y, doc.page.width - 100, 36).fill();
          doc.fillColor('#C0D0E0').font('Helvetica-Bold').fontSize(11).text(row.symbol, 58, doc.y - 31);
          doc.fillColor('#6A8AAA').font('Helvetica').fontSize(9).text(`${row.qty} shares @ $${row.avgEntry}`, 58, doc.y - 17);
          doc.fillColor('#D0DFF0').fontSize(10).text(`$${row.marketValue}`, doc.page.width - 200, doc.y - 31, { width:80, align:'right' });
          doc.fillColor(pc).font('Helvetica-Bold').fontSize(10).text(`${row.pnl>=0?'+':''}$${row.pnlVal} (${row.pnlPct}%)`, doc.page.width - 120, doc.y - 31, { width:70, align:'right' });
          doc.moveDown(0.6);
        } else if (row.type === 'stat') {
          doc.fillColor('#6A8AAA').font('Helvetica').fontSize(10).text(`${row.label}:`, 58, doc.y, { continued:true });
          doc.fillColor('#D0DFF0').font('Helvetica-Bold').text(`  ${row.value}`);
          doc.moveDown(0.4);
        } else if (row.type === 'catalyst') {
          const uc = row.urgency==='critical'?'#FF6B6B':row.urgency==='high'?'#FFB347':'#69F0AE';
          doc.fillColor(uc).font('Helvetica-Bold').fontSize(9).text(`${row.date} — ${row.ticker}`, 58, doc.y, { continued:true });
          doc.fillColor('#A0B8D0').font('Helvetica').text(`  ${row.label}`);
          doc.moveDown(0.4);
        } else if (row.type === 'text') {
          doc.fillColor('#A0B8D0').font('Helvetica').fontSize(10).text(row.content, 58, doc.y, { width:doc.page.width - 116 });
          doc.moveDown(0.5);
        }
      });
      doc.moveDown(0.8);
    });

    doc.fillColor('#1A2A40').fontSize(8).text('AI Energy Trader — Paper Trading System — Not financial advice', 50, doc.page.height - 40, { align:'center' });
    doc.end();
  });
}

// BUILD MORNING REPORT
async function buildMorningReport() {
  console.log('Building morning report...');
  const results = [];
  for (let i = 0; i < HOLDINGS.length; i++) {
    results.push(await scanTicker(HOLDINGS[i]));
    if (i < HOLDINGS.length - 1) await new Promise(r => setTimeout(r, 4000));
  }

  const buys    = results.filter(r => r.signal === 'BUY');
  const trims   = results.filter(r => r.signal === 'TRIM');
  const watches = results.filter(r => r.signal === 'WATCH');
  const high    = results.filter(r => r.impact === 'HIGH');
  const date    = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'America/New_York' });

  const signalRows = results.map(r => {
    const sc = r.signal==='BUY'?'#69F0AE':r.signal==='TRIM'?'#FF6B6B':r.signal==='WATCH'?'#FFD700':'#5A7090';
    const ic = r.impact==='HIGH'?'#FF6B6B':r.impact==='MEDIUM'?'#FFB347':'#5A7090';
    return `<tr style="border-bottom:1px solid #1A2A40">
      <td style="padding:9px 8px;color:#00E5FF;font-weight:bold;font-size:13px">${r.ticker}</td>
      <td style="padding:9px 8px;color:#6A8AAA;font-size:11px">${r.bucket}</td>
      <td style="padding:9px 8px"><span style="background:${sc}22;color:${sc};border:1px solid ${sc}44;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:bold">${r.signal}</span></td>
      <td style="padding:9px 8px;color:${ic};font-size:11px">${r.impact}</td>
      <td style="padding:9px 8px;color:#A0B8D0;font-size:11px">${r.headline}</td>
      <td style="padding:9px 8px;color:#69F0AE;font-size:10px">${r.confidence}/10</td>
    </tr>`;
  }).join('');

  const actionSection = (buys.length > 0 || trims.length > 0) ? `
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#FF6B6B;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">⚠ Action Required Today</div>
    ${[...buys, ...trims].map(r => {
      const sc = r.signal==='BUY'?'#69F0AE':'#FF6B6B';
      return `<div style="padding:10px 14px;background:${sc}0D;border:1px solid ${sc}33;border-left:3px solid ${sc};border-radius:6px;margin-bottom:8px">
        <span style="color:${sc};font-weight:bold">${r.ticker} — ${r.signal}</span>
        <span style="color:#5A7090;font-size:10px;margin-left:8px">${r.bucket} · Confidence ${r.confidence}/10</span>
        <div style="color:#A0B8D0;font-size:11px;margin-top:4px">${r.headline}</div>
        <div style="color:#5A7090;font-size:11px;margin-top:3px">→ ${r.action}</div>
      </div>`;
    }).join('')}
  </div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#050A14;color:#D0DFF0;font-family:'Courier New',monospace;margin:0;padding:0">
<div style="max-width:800px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#0D1B35,#050A14);padding:28px 32px;border-bottom:2px solid #00E5FF">
    <div style="font-size:22px;font-weight:bold;color:#00E5FF">⚡ AI ENERGY TRADER</div>
    <div style="font-size:13px;color:#69F0AE;margin-top:4px">☀️ Morning Briefing — ${date}</div>
    <div style="font-size:11px;color:#3A5070;margin-top:2px">17 positions scanned · AI data center energy infrastructure</div>
  </div>
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      ${[['BUY Signals',buys.length,'#69F0AE'],['TRIM Signals',trims.length,'#FF6B6B'],['Watch',watches.length,'#FFD700'],['High Impact',high.length,'#FF6B6B']].map(([l,v,c])=>`
      <div style="text-align:center;padding:12px 20px;background:#0D1525;border-radius:8px;border:1px solid #1A2A40">
        <div style="font-size:24px;font-weight:bold;color:${c}">${v}</div>
        <div style="font-size:10px;color:#3A5070;text-transform:uppercase;letter-spacing:0.1em">${l}</div>
      </div>`).join('')}
    </div>
  </div>
  ${actionSection}
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#3A5070;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Full Portfolio Scan</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #1A2A40">
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Ticker</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Sector</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Signal</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Impact</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Headline</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Conf</th>
      </tr></thead>
      <tbody>${signalRows}</tbody>
    </table>
  </div>
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#3A5070;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">🎯 Upcoming Catalysts</div>
    ${CATALYSTS.slice(0,5).map(c=>{const uc=c.urgency==='critical'?'#FF6B6B':c.urgency==='high'?'#FFB347':'#69F0AE';return`<div style="padding:6px 0;border-bottom:1px solid #1A2A40"><span style="color:${uc};font-size:11px;font-weight:bold">${c.date}</span> <span style="color:#00E5FF;font-size:11px;margin:0 8px">${c.ticker}</span><span style="color:#A0B8D0;font-size:11px">${c.label}</span></div>`;}).join('')}
  </div>
  <div style="padding:14px 32px;background:#050A14;text-align:center">
    <div style="font-size:10px;color:#2A3A50">AI Energy Trader · Paper Trading · Not financial advice · Evening P&L at 5:00 PM ET</div>
  </div>
</div></body></html>`;

  const pdf = await generatePDF(`Morning Briefing — ${date}`, [
    { title:'Signal Summary', rows:[{type:'stat',label:'BUY Signals',value:buys.length},{type:'stat',label:'TRIM Signals',value:trims.length},{type:'stat',label:'Watch',value:watches.length},{type:'stat',label:'High Impact',value:high.length}] },
    { title:'Full Portfolio Scan', rows:results.map(r=>({type:'signal',ticker:r.ticker,bucket:r.bucket,signal:r.signal,headline:r.headline,action:r.action,confidence:r.confidence})) },
    { title:'Upcoming Catalysts', rows:CATALYSTS.map(c=>({type:'catalyst',date:c.date,ticker:c.ticker,label:c.label,urgency:c.urgency})) },
  ]);

  return { html, pdf, date };
}

// BUILD EVENING REPORT
async function buildEveningReport() {
  console.log('Building evening report...');
  const [acct, positions, orders] = await Promise.all([fetchAlpacaAccount(), fetchAlpacaPositions(), fetchAlpacaOrders()]);

  const pv   = parseFloat(acct.portfolio_value || 100000);
  const cash = parseFloat(acct.cash || 0);
  const pnl  = pv - 100000;
  const pnlPct = ((pnl / 100000) * 100).toFixed(2);
  const date = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'America/New_York' });

  const sorted  = [...positions].sort((a,b) => parseFloat(b.unrealized_pl) - parseFloat(a.unrealized_pl));
  const winners = sorted.filter(p => parseFloat(p.unrealized_pl) > 0);
  const losers  = sorted.filter(p => parseFloat(p.unrealized_pl) < 0);
  const todayOrders = orders.filter(o => new Date(o.submitted_at).toDateString() === new Date().toDateString());

  const posRows = sorted.map(p => {
    const pv2 = parseFloat(p.unrealized_pl);
    const pp  = (parseFloat(p.unrealized_plpc)*100).toFixed(2);
    const pc  = pv2 >= 0 ? '#69F0AE' : '#FF6B6B';
    return `<tr style="border-bottom:1px solid #1A2A40">
      <td style="padding:9px 8px;color:#00E5FF;font-weight:bold">${p.symbol}</td>
      <td style="padding:9px 8px;color:#6A8AAA;font-size:11px">${p.qty} sh</td>
      <td style="padding:9px 8px;color:#A0B8D0;font-size:11px">$${parseFloat(p.avg_entry_price).toFixed(2)}</td>
      <td style="padding:9px 8px;color:#D0DFF0;font-size:11px">$${parseFloat(p.current_price).toFixed(2)}</td>
      <td style="padding:9px 8px;color:#D0DFF0;font-size:11px">$${parseFloat(p.market_value).toFixed(2)}</td>
      <td style="padding:9px 8px;color:${pc};font-weight:bold">${pv2>=0?'+':''}$${pv2.toFixed(2)}</td>
      <td style="padding:9px 8px;color:${pc};font-size:11px">${pp}%</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#050A14;color:#D0DFF0;font-family:'Courier New',monospace;margin:0;padding:0">
<div style="max-width:800px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#0D1B35,#050A14);padding:28px 32px;border-bottom:2px solid #B388FF">
    <div style="font-size:22px;font-weight:bold;color:#B388FF">⚡ AI ENERGY TRADER</div>
    <div style="font-size:13px;color:#69F0AE;margin-top:4px">🌙 Evening P&L Summary — ${date}</div>
    <div style="font-size:11px;color:#3A5070;margin-top:2px">Market close · Paper trading account</div>
  </div>
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      ${[['Portfolio Value',`$${pv.toLocaleString(undefined,{maximumFractionDigits:2})}`,'#D0DFF0'],[`Total P&L`,`${pnl>=0?'+':''}$${pnl.toFixed(2)}`,pnl>=0?'#69F0AE':'#FF6B6B'],[`Return`,`${pnl>=0?'+':''}${pnlPct}%`,pnl>=0?'#69F0AE':'#FF6B6B'],['Positions',positions.length,'#D0DFF0']].map(([l,v,c])=>`
      <div style="text-align:center;padding:14px 22px;background:#0D1525;border-radius:8px;border:1px solid #1A2A40">
        <div style="font-size:20px;font-weight:bold;color:${c}">${v}</div>
        <div style="font-size:10px;color:#3A5070;text-transform:uppercase;letter-spacing:0.1em;margin-top:2px">${l}</div>
      </div>`).join('')}
    </div>
  </div>
  ${winners.length > 0 ? `
  <div style="padding:16px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#69F0AE;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px">🏆 Top Winners</div>
    ${winners.slice(0,3).map(p=>`<div style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(105,240,174,0.05);border:1px solid rgba(105,240,174,0.15);border-radius:6px;margin-bottom:6px"><span style="color:#00E5FF;font-weight:bold">${p.symbol}</span><span style="color:#69F0AE;font-weight:bold">+$${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc)*100).toFixed(2)}%)</span></div>`).join('')}
  </div>` : ''}
  ${losers.length > 0 ? `
  <div style="padding:16px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#FF6B6B;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px">📉 Watch List</div>
    ${losers.slice(0,3).map(p=>`<div style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(255,107,107,0.05);border:1px solid rgba(255,107,107,0.15);border-radius:6px;margin-bottom:6px"><span style="color:#00E5FF;font-weight:bold">${p.symbol}</span><span style="color:#FF6B6B;font-weight:bold">$${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc)*100).toFixed(2)}%)</span></div>`).join('')}
  </div>` : ''}
  ${positions.length > 0 ? `
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#3A5070;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Full Position Summary</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #1A2A40">
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Symbol</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Qty</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Entry</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Current</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">Value</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">P&L</th>
        <th style="padding:8px;text-align:left;color:#3A5070;font-size:9px;text-transform:uppercase">%</th>
      </tr></thead>
      <tbody>${posRows}</tbody>
    </table>
  </div>` : '<div style="padding:20px 32px;color:#3A5070;font-size:12px">No open positions yet.</div>'}
  <div style="padding:20px 32px;background:#080F1C;border-bottom:1px solid #1A2A40">
    <div style="font-size:10px;color:#3A5070;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">Today's Trades</div>
    ${todayOrders.length > 0 ? todayOrders.map(o=>`<div style="padding:7px 0;border-bottom:1px solid #1A2A40;font-size:11px"><span style="color:${o.side==='buy'?'#69F0AE':'#FF6B6B'};font-weight:bold">${o.side.toUpperCase()}</span> <span style="color:#00E5FF;margin:0 6px">${o.symbol}</span> <span style="color:#A0B8D0">×${o.qty}</span> <span style="color:#FFD700;margin-left:8px">${o.status}</span> <span style="color:#3A5070;margin-left:8px">${new Date(o.submitted_at).toLocaleTimeString('en-US',{timeZone:'America/New_York'})}</span></div>`).join('') : '<div style="color:#3A5070;font-size:11px">No trades executed today.</div>'}
  </div>
  <div style="padding:14px 32px;background:#050A14;text-align:center">
    <div style="font-size:10px;color:#2A3A50">AI Energy Trader · Paper Trading · Not financial advice · Morning briefing at 8:00 AM ET</div>
  </div>
</div></body></html>`;

  const pdf = await generatePDF(`Evening Summary — ${date}`, [
    { title:'Portfolio Summary', rows:[{type:'stat',label:'Portfolio Value',value:`$${pv.toLocaleString(undefined,{maximumFractionDigits:2})}`},{type:'stat',label:'Total P&L',value:`${pnl>=0?'+':''}$${pnl.toFixed(2)} (${pnlPct}%)`},{type:'stat',label:'Cash',value:`$${cash.toLocaleString(undefined,{maximumFractionDigits:2})}`},{type:'stat',label:'Open Positions',value:positions.length}] },
    { title:'Position P&L', rows: sorted.map(p=>({type:'position',symbol:p.symbol,qty:p.qty,avgEntry:parseFloat(p.avg_entry_price).toFixed(2),marketValue:parseFloat(p.market_value).toFixed(2),pnl:parseFloat(p.unrealized_pl),pnlVal:parseFloat(p.unrealized_pl).toFixed(2),pnlPct:(parseFloat(p.unrealized_plpc)*100).toFixed(2)})) },
    { title:"Today's Orders", rows: todayOrders.length>0 ? todayOrders.map(o=>({type:'text',content:`${o.side.toUpperCase()} ${o.qty} ${o.symbol} — ${o.status} @ ${new Date(o.submitted_at).toLocaleTimeString('en-US',{timeZone:'America/New_York'})}`})) : [{type:'text',content:'No trades today.'}] },
  ]);

  return { html, pdf, date };
}

// SEND EMAIL via SendGrid HTTP API
async function sendEmail(subject, html, pdf, filename) {
  const body = {
    personalizations: [{ to: [{ email: REPORT_TO }] }],
    from: { email: FROM_EMAIL, name: 'AI Energy Trader' },
    subject,
    content: [{ type: 'text/html', value: html }],
    attachments: [{
      content: pdf.toString('base64'),
      filename,
      type: 'application/pdf',
      disposition: 'attachment',
    }],
  };
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (resp.status >= 400) {
    const err = await resp.text();
    throw new Error(`SendGrid error ${resp.status}: ${err}`);
  }
  console.log(`Email sent: ${subject}`);
}

// SCHEDULER
function getETTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const et  = new Date(utc + (3600000 * -5));
  return { hour:et.getHours(), minute:et.getMinutes(), day:et.getDay() };
}

function startScheduler() {
  setInterval(async () => {
    const { hour, minute, day } = getETTime();
    if (day === 0 || day === 6) return;
    if (hour === 8 && minute === 0) {
      try { const { html, pdf, date } = await buildMorningReport(); await sendEmail(`☀️ Morning Briefing — ${date}`, html, pdf, `morning-${Date.now()}.pdf`); } catch(e) { console.error('Morning error:', e); }
    }
    if (hour === 17 && minute === 0) {
      try { const { html, pdf, date } = await buildEveningReport(); await sendEmail(`🌙 Evening P&L — ${date}`, html, pdf, `evening-${Date.now()}.pdf`); } catch(e) { console.error('Evening error:', e); }
    }
  }, 60000);
  console.log('Scheduler running — 8AM and 5PM ET weekdays');
}

// ROUTES
app.get('/health', (req, res) => res.json({ status:'ok', time:new Date().toISOString() }));

app.post('/scan', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/alpaca-prices', async (req, res) => {
  try {
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${req.query.symbols}`, {
      headers: { 'APCA-API-KEY-ID':req.headers['apca-api-key-id'], 'APCA-API-SECRET-KEY':req.headers['apca-api-secret-key'] }
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/send-morning', async (req, res) => {
  try {
    const { html, pdf, date } = await buildMorningReport();
    await sendEmail(`☀️ Morning Briefing — ${date}`, html, pdf, `morning-${Date.now()}.pdf`);
    res.json({ success:true, message:'Morning report sent to ' + REPORT_TO });
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
});

app.get('/send-evening', async (req, res) => {
  try {
    const { html, pdf, date } = await buildEveningReport();
    await sendEmail(`🌙 Evening P&L — ${date}`, html, pdf, `evening-${Date.now()}.pdf`);
    res.json({ success:true, message:'Evening report sent to ' + REPORT_TO });
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy live on port ${PORT}`);
  startScheduler();
});
