/* =========================================================================
   CheckFire Recycling Returns — Server
   Zero-dependency Node.js app. Run with:  node server.js
   Serves:
     /            office dashboard (read-only data dash)
     /count       Rec team counter form (PIN login + collection number match)
     /wtn/:id     printable Duty of Care Waste Transfer Note
   Data:    data.json (created automatically next to this file)
   Config:  config.json (products, codes, WTN settings)
            config.local.json (secrets: web query URL, email, counters, tokens)
   ========================================================================= */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
/* Secrets (web query URL, email, counters, API tokens) live in config.local.json —
   gitignored, never committed. Copy config.local.example.json to start. */
const LOCAL_CONF = path.join(__dirname, 'config.local.json');
if (fs.existsSync(LOCAL_CONF)) deepMerge(CONFIG, JSON.parse(fs.readFileSync(LOCAL_CONF, 'utf8')));

const DATA_FILE = path.join(__dirname, 'data.json');
const LOGO_B64 = fs.existsSync(path.join(__dirname, 'assets', 'logo.jpg'))
  ? fs.readFileSync(path.join(__dirname, 'assets', 'logo.jpg')).toString('base64') : '';

/* ---------------- storage ---------------- */
let db = loadDb();
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { orders: [], seq: 0, wtnSeq: {}, lastSync: null }; }
}
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

/* ---------------- helpers ---------------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normaliseSO(s) {
  s = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (/^\d+C?$/.test(s)) s = 'SO' + s;            // digits only → assume SO prefix
  if (!s.endsWith('C')) s += 'C';                  // collection SOs carry a C suffix
  return s;
}
function cleanNum(v) { return parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10); } // strips =, quotes, commas
function ukDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); }
function isoDate(uk) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(uk || ''); return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : (uk || ''); }
function nowStamp() { return new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }

function countedCrates(o) {
  return o.counts.reduce((a, c) => a + (c.crateTo ? (c.crateTo - c.crateFrom + 1) : 1), 0);
}
function aggregate(o) {
  const m = {};
  o.counts.forEach(c => c.lines.forEach(l => { m[l.p] = (m[l.p] || 0) + Number(l.q); }));
  return Object.keys(m).sort().map(p => ({ p, q: m[p] }));
}
function nsLines(o) {
  const m = {};
  o.counts.forEach(c => c.lines.forEach(l => {
    const prod = CONFIG.products.find(x => x.p === l.p);
    const code = l.other ? CONFIG.otherCode : (prod ? prod.code : 'UNMAPPED');
    m[code] = (m[code] || 0) + Number(l.q);
  }));
  return Object.keys(m).sort().map(code => ({ code, q: m[code] }));
}
function nextWTN() {
  const yr = String(new Date().getFullYear());
  db.wtnSeq[yr] = (db.wtnSeq[yr] || 0) + 1;
  return `${CONFIG.wtn.prefix}-${yr}-${String(db.wtnSeq[yr]).padStart(4, '0')}`;
}

/* ---------------- NetSuite web query sync ---------------- */
function fetchUrl(u, redirects, cb) {
  if (typeof redirects === 'function') { cb = redirects; redirects = 5; }
  const lib = u.startsWith('https') ? https : http;
  const opts = { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Excel/16.0 WebQuery',
    'Accept': 'text/html,application/xhtml+xml,*/*'
  } };
  lib.get(u, opts, res => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
      res.resume();
      return fetchUrl(new URL(res.headers.location, u).href, redirects - 1, cb);
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => body += d);
    res.on('end', () => cb(null, res.statusCode, body));
  }).on('error', err => cb(err));
}

function parseHtmlTable(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) {
      cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim());
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/* Upsert: adds new SOs AND updates header fields on existing open orders
   (NetSuite is the source of truth for crates expected, customer, etc.) */
function upsertRows(rows) {
  const hIdx = rows.findIndex(r => r.some(c => /document\s*number/i.test(c)));
  if (hIdx < 0) return { error: 'No "Document Number" column found', added: 0, updated: 0, skipped: 0 };
  const head = rows[hIdx].map(h => h.toLowerCase());
  const ix = re => head.findIndex(h => re.test(h));
  const iSo = ix(/document\s*number/), iCu = ix(/company\s*name/), iDa = ix(/date\s*created/),
        iBy = ix(/created\s*by/), iQt = ix(/quantity\s*billed/);
  let added = 0, updated = 0, skipped = 0;
  rows.slice(hIdx + 1).forEach(r => {
    const raw = r[iSo];
    if (!raw || !/^so/i.test(String(raw).trim())) return;
    const so = normaliseSO(raw);
    const qty = cleanNum(r[iQt]);
    const crates = Math.min(CONFIG.maxCrates, Math.max(1, isNaN(qty) ? 1 : qty));
    const cust = iCu > -1 ? r[iCu] : 'Unknown';
    const date = isoDate(iDa > -1 ? r[iDa] : '') || new Date().toISOString().slice(0, 10);
    const by = iBy > -1 ? r[iBy] : '';
    const existing = db.orders.find(o => o.so === so);
    if (existing) {
      if (existing.status === 'open') {
        // never set crates below what's already been counted
        const newCrates = Math.max(crates, countedCrates(existing) || 1);
        if (existing.crates !== newCrates || existing.cust !== cust || existing.by !== by || existing.date !== date) {
          existing.crates = newCrates; existing.cust = cust; existing.by = by; existing.date = date;
          updated++;
        } else skipped++;
      } else skipped++;
      return;
    }
    db.orders.unshift({
      id: ++db.seq, so, cust, date, by,
      crates, counts: [], status: 'open', wtn: null, finalSo: null, source: 'netsuite'
    });
    added++;
  });
  return { added, updated, skipped };
}

function syncFromNetSuite(cb) {
  const u = CONFIG.netsuite.webQueryUrl.replace('[EMAIL]', encodeURIComponent(CONFIG.netsuite.email));
  fetchUrl(u, (err, status, body) => {
    if (err) { db.lastSync = { when: nowStamp(), ok: false, msg: 'Connection failed: ' + err.message }; saveDb(); return cb(db.lastSync); }
    if (status !== 200) { db.lastSync = { when: nowStamp(), ok: false, msg: 'NetSuite returned HTTP ' + status }; saveDb(); return cb(db.lastSync); }
    const res = upsertRows(parseHtmlTable(body));
    db.lastSync = { when: nowStamp(), ok: !res.error, msg: res.error || `${res.added} new, ${res.updated} updated, ${res.skipped} unchanged`, ...res };
    saveDb(); cb(db.lastSync);
  });
}

if (CONFIG.netsuite.autoSyncMinutes > 0) {
  setInterval(() => syncFromNetSuite(() => {}), CONFIG.netsuite.autoSyncMinutes * 60 * 1000);
  // sync shortly after startup too
  setTimeout(() => syncFromNetSuite(() => {}), 5000);
}

/* ---------------- counting / completion ---------------- */
function addCount(orderId, by, lines, crates) {
  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o) return { error: 'Order not found' };
  if (o.status !== 'open') return { error: 'Order already completed' };
  if (!by || !lines || !lines.length) return { error: 'Missing counter name or counts' };
  const already = countedCrates(o);
  const remaining = o.crates - already;
  if (remaining < 1) return { error: 'All crates already counted' };
  const n = Math.max(1, Math.min(parseInt(crates, 10) || 1, remaining));
  o.counts.push({ crateFrom: already + 1, crateTo: already + n, by, when: nowStamp(), lines });
  let completed = false;
  if (countedCrates(o) >= o.crates) {
    o.status = 'done';
    o.wtn = nextWTN();
    completed = true;
    createNetSuiteSalesOrder(o);   // Phase 3 — no-op until enabled in config
  }
  saveDb();
  return { ok: true, completed, wtn: o.wtn, counted: countedCrates(o), of: o.crates };
}

/* ---------------- Phase 3: NetSuite SO creation (stub) ----------------
   When CONFIG.netsuite.api.enabled is true, create a sales order against
   the counted quantities via SuiteTalk REST:
     POST https://<account>.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder
     Auth: OAuth 1.0a (TBA) — keys live in config.local.json
     Lines: nsLines(order) → map code → NetSuite item id
   On success write the returned tranId to order.finalSo and saveDb().    */
function createNetSuiteSalesOrder(order) {
  if (!CONFIG.netsuite.api.enabled) return;
  console.log('[Phase3] Would create NetSuite SO for', order.so, nsLines(order));
}

/* ---------------- WTN HTML ---------------- */
function wtnTotals(o) {
  const t = { water: 0, powder: 0, foam: 0, co2alu5: 0, co2tall: 0, co2squat: 0, co2steel2: 0, co2steel5: 0 };
  const others = [];
  o.counts.forEach(c => c.lines.forEach(l => {
    if (l.other) { others.push(`${String(l.p).replace(/^Other:\s*/, '')} x${l.q}`); return; }
    const prod = CONFIG.products.find(x => x.p === l.p);
    if (prod && t[prod.wtnBox] !== undefined) t[prod.wtnBox] += Number(l.q);
    else others.push(`${l.p} x${l.q}`);
  }));
  return { t, others };
}

function wtnHtml(o) {
  const { t, others } = wtnTotals(o);
  const collDate = o.counts.length ? o.counts[o.counts.length - 1].when.split(',')[0] : ukDate(o.date);
  const v = n => n > 0 ? n : '';
  const W = CONFIG.wtn;
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><title>${esc(o.wtn || 'WTN')} — ${esc(o.cust)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#000;margin:0;background:#fff}
  .wtn{max-width:780px;margin:0 auto;padding:24px;font-size:11.5px;line-height:1.35}
  .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
  .addr b{font-size:12px}
  .logo img{height:52px}
  h2{text-align:center;font-size:19px;margin:6px 0 16px}
  table{width:100%;border-collapse:collapse}
  td{border:1px solid #000;padding:4px 7px;vertical-align:top;text-align:left}
  .sec{font-weight:bold;font-size:12.5px}
  .lbl{font-weight:bold}
  .yn{width:64px;text-align:center}
  .small{font-size:10.5px}
  .sig{height:56px}
  .bar{position:sticky;top:0;background:#1c1f23;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;font-size:13px}
  .bar button{background:#d63420;color:#fff;border:none;padding:8px 18px;font-weight:bold;cursor:pointer;font-size:13px}
  @media print{.bar{display:none}}
</style></head><body>
<div class="bar"><span>${esc(o.wtn || '')} — ${esc(o.cust)} — ${esc(o.so)}</span><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="wtn">
  <div class="top">
    <div class="addr"><b>Checkfire Ltd</b><br>Pontygwindy Industrial Estate<br>Caerphilly<br>CF83 3HU<br>Telephone: 029 2086 8333<br>Website: www.checkfire.co.uk</div>
    <div class="logo">${LOGO_B64 ? `<img src="data:image/jpeg;base64,${LOGO_B64}" alt="CheckFire Group">` : '<b style="color:#d63420;font-size:24px">CheckFire.</b>'}</div>
  </div>
  <h2>DUTY OF CARE: Waste Transfer Note</h2>
  <table>
    <tr><td colspan="4" class="sec">Section A - Description of Waste</td></tr>
    <tr>
      <td colspan="2" style="width:50%"><span class="lbl">A1&nbsp; Description of the waste being transferred:</span><br>EWC Code ${esc(W.ewcCode)}</td>
      <td colspan="2"><span class="lbl">A2&nbsp; How is the waste contained?</span><br>${o.crates} plastic crate(s)</td>
    </tr>
    <tr><td colspan="4" class="sec">Section B - Current holder of the waste (Customer)</td></tr>
    <tr><td colspan="4" class="small">By signing Section D below I confirm that I have fulfilled my duty to apply the waste hierarchy as required by Regulation 12 of the Waste (England and Wales) Regulations 2011.</td></tr>
    <tr>
      <td colspan="2" rowspan="4">
        <span class="lbl">B1</span><br><br>
        <span class="lbl">Name of Contact:</span><br><br><br>
        <span class="lbl">Company Name / SO Number:</span><br>${esc(o.cust)} / ${esc(o.so)}<br><br>
        <span class="lbl">Date of Collection:</span><br>${esc(collDate)}<br><br>
        <span class="lbl">WTN number:</span> ${esc(o.wtn || '')}
      </td>
      <td><span class="lbl">B2&nbsp; Are you:</span><br>The producer of the waste?<br>The importer of the waste?<br>The local authority?<br>The holder of an environmental permit?</td>
      <td class="yn"><b>Yes&nbsp;/&nbsp;No</b><br>x&nbsp;/&nbsp;&nbsp;<br>&nbsp;/&nbsp;x<br>&nbsp;/&nbsp;x<br>&nbsp;/&nbsp;x</td>
    </tr>
    <tr><td>Permit Number:</td><td class="yn"></td></tr>
    <tr><td>Issued By:<br>Registered waste exemption?</td><td class="yn"><br>&nbsp;/&nbsp;x</td></tr>
    <tr><td>Details, inc registration number</td><td class="yn"></td></tr>
    <tr><td colspan="4" class="sec">Section C - Carrier of the waste (Checkfire)</td></tr>
    <tr>
      <td colspan="2">Checkfire Ltd<br>Pontygwindy Industrial Estate<br>Caerphilly, CF83 3HU</td>
      <td colspan="2">Registration Number: <b>${esc(W.carrierRegistration)}</b><br>Issued by: ${esc(W.carrierIssuedBy)}</td>
    </tr>
    <tr><td colspan="4" class="sec">Section D - Transfer</td></tr>
    <tr>
      <td colspan="2"><span class="lbl">D1&nbsp; Address of transfer or collection point</span><br><br><br><br></td>
      <td colspan="2"><span class="lbl">D2&nbsp; Carrier's name / transfer point:</span><br>Checkfire Ltd<br>Pontygwindy Industrial Estate<br>Caerphilly, CF83 3HU<br>Tel: 029 2086 8333</td>
    </tr>
    <tr><td colspan="4" class="sec">Section E - Details of Items</td></tr>
    <tr>
      <td style="width:25%">Water Extinguishers&nbsp; <b>${v(t.water)}</b><br>Powder Extinguishers&nbsp; <b>${v(t.powder)}</b><br>Foam Extinguishers&nbsp; <b>${v(t.foam)}</b><br>5KG C02 Aluminium&nbsp; <b>${v(t.co2alu5)}</b></td>
      <td style="width:25%">2KG CO2 Tall&nbsp; <b>${v(t.co2tall)}</b><br>2KG CO2 Squat&nbsp; <b>${v(t.co2squat)}</b><br>2KG CO2 Steel&nbsp; <b>${v(t.co2steel2)}</b><br>5KG CO2 Steel&nbsp; <b>${v(t.co2steel5)}</b></td>
      <td colspan="2"><span class="lbl">Other:</span><br>${others.map(esc).join('<br>')}</td>
    </tr>
    <tr><td colspan="4" class="sec">Signatures</td></tr>
    <tr>
      <td colspan="2"><span class="lbl">Customer Signature:</span><div class="sig"></div><span class="lbl">Customer Name:</span></td>
      <td colspan="2"><span class="lbl">Checkfire Signature:</span><div class="sig"></div><span class="lbl">Checkfire Name:</span></td>
    </tr>
  </table>
</div></body></html>`;
}

/* ---------------- HTTP server ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => cb(b));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* pages */
  if (req.method === 'GET' && (p === '/' || p === '/dashboard')) return sendFile(res, 'dashboard.html');
  if (req.method === 'GET' && p === '/count') return sendFile(res, 'count.html');
  if (req.method === 'GET' && /^\/wtn\/\d+$/.test(p)) {
    const o = db.orders.find(x => x.id === Number(p.split('/')[2]));
    if (!o) return json(res, 404, { error: 'Order not found' });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(wtnHtml(o));
  }

  /* api */
  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, {
      orders: db.orders.map(o => ({ ...o, counted: countedCrates(o), totals: aggregate(o), nsLines: o.status === 'done' ? nsLines(o) : undefined })),
      lastSync: db.lastSync,
      products: CONFIG.products,
      maxCrates: CONFIG.maxCrates,
      apiEnabled: CONFIG.netsuite.api.enabled
    });
  }
  if (req.method === 'POST' && p === '/api/find-order') {
    return readBody(req, body => {
      try {
        const { number } = JSON.parse(body);
        const so = normaliseSO(number);
        if (!so) return json(res, 200, { error: 'Enter the collection number from the paperwork' });
        const o = db.orders.find(x => x.so === so);
        if (!o) return json(res, 200, { error: `No collection found for ${so} — check the number on the paperwork`, tried: so });
        if (o.status === 'done') return json(res, 200, { error: `${so} is already fully counted (${o.crates} of ${o.crates} crates)`, tried: so });
        json(res, 200, { ok: true, order: { id: o.id, so: o.so, cust: o.cust, date: o.date, by: o.by, crates: o.crates, counted: countedCrates(o) } });
      } catch (e) { json(res, 400, { error: 'Bad request' }); }
    });
  }
  if (req.method === 'POST' && p === '/api/sync') return syncFromNetSuite(r => json(res, 200, r));
  if (req.method === 'POST' && p === '/api/count') {
    return readBody(req, body => {
      try { const { orderId, by, lines, crates } = JSON.parse(body); json(res, 200, addCount(orderId, by, lines, crates)); }
      catch (e) { json(res, 400, { error: 'Bad request' }); }
    });
  }
  if (req.method === 'POST' && p === '/api/mark') {
    return readBody(req, body => {
      try {
        const { orderId, field, value } = JSON.parse(body);
        const o = db.orders.find(x => x.id === Number(orderId));
        if (!o) return json(res, 404, { error: 'Order not found' });
        if (o.status !== 'done') return json(res, 400, { error: 'Order not counted yet' });
        const stamp = value ? nowStamp().split(',')[0] : null;
        if (field === 'wtnSent') o.wtnSentAt = stamp;
        else if (field === 'invoiced') o.invoicedAt = stamp;
        else return json(res, 400, { error: 'Unknown field' });
        saveDb(); json(res, 200, { ok: true, stamp });
      } catch (e) { json(res, 400, { error: 'Bad request' }); }
    });
  }
  if (req.method === 'POST' && p === '/api/final-so') {
    return readBody(req, body => {
      try {
        const { orderId, finalSo } = JSON.parse(body);
        const o = db.orders.find(x => x.id === Number(orderId));
        if (!o) return json(res, 404, { error: 'Order not found' });
        o.finalSo = String(finalSo || '').trim() || null;
        saveDb(); json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: 'Bad request' }); }
    });
  }

  json(res, 404, { error: 'Not found' });
});

function sendFile(res, name) {
  const f = path.join(__dirname, 'public', name);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Missing ' + name); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'text/plain' });
    res.end(data);
  });
}

server.listen(process.env.PORT || CONFIG.port, () => {
  console.log(`CheckFire Recycling Returns running:`);
  console.log(`  Dashboard:    http://localhost:${CONFIG.port}/`);
  console.log(`  Counter form: http://localhost:${CONFIG.port}/count`);
  console.log(`  Auto-sync every ${CONFIG.netsuite.autoSyncMinutes} min from NetSuite web query`);
});
