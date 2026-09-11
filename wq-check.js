/* Diagnostic: fetch the NetSuite web query and report exactly what the app
   would take from it. Parsing logic mirrors server.js upsertRows() verbatim.
   Read-only — touches no data.json, writes nothing. Prints no URL or email. */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');

const APP = process.argv[2];
const CONFIG = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
const LOCAL = JSON.parse(fs.readFileSync(path.join(APP, 'config.local.json'), 'utf8'));
const URL_ = LOCAL.netsuite.webQueryUrl.replace('[EMAIL]', encodeURIComponent(LOCAL.netsuite.email));
const MAX = CONFIG.maxCrates;

function fetchUrl(u, redirects, cb) {
  if (typeof redirects === 'function') { cb = redirects; redirects = 5; }
  const lib = u.startsWith('https') ? https : http;
  lib.get(u, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Excel/16.0 WebQuery',
    'Accept': 'text/html,application/xhtml+xml,*/*'
  }}, res => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
      res.resume(); return fetchUrl(new URL(res.headers.location, u).href, redirects - 1, cb);
    }
    let b = ''; res.setEncoding('utf8');
    res.on('data', d => b += d); res.on('end', () => cb(null, res.statusCode, b));
  }).on('error', e => cb(e));
}
function parseHtmlTable(html) {
  const rows = []; const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = []; const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi; let td;
    while ((td = tdRe.exec(tr[1])) !== null)
      cells.push(td[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}
function normaliseSO(s) {
  s = String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (!s) return '';
  if (/^\d+C?$/.test(s)) s = 'SO' + s;
  if (!s.endsWith('C')) s += 'C';
  return s;
}
const cleanNum = v => parseInt(String(v==null?'':v).replace(/[^\d-]/g,''), 10);
const isoDate = uk => { const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(uk||''); return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:(uk||''); };

fetchUrl(URL_, (err, status, body) => {
  if (err) return console.log('CONNECTION FAILED:', err.message);
  console.log('HTTP', status, '· payload', body.length, 'chars');
  if (status !== 200) return console.log('Sync would abort here — NetSuite returned HTTP ' + status);
  if (/<form[^>]*login|Please enter your email|password/i.test(body))
    return console.log('!! Looks like a LOGIN PAGE, not the report — the email token in the URL is not being accepted.');

  const rows = parseHtmlTable(body);
  console.log('Table rows parsed:', rows.length);
  const hIdx = rows.findIndex(r => r.some(c => /document\s*number/i.test(c)));
  if (hIdx < 0) return console.log('!! NO "Document Number" COLUMN — the whole sync aborts with an error.');

  const head = rows[hIdx].map(h => h.toLowerCase());
  const ix = re => head.findIndex(h => re.test(h));
  const cols = { so:ix(/document\s*number/), cust:ix(/company\s*name/), date:ix(/date\s*created/), by:ix(/created\s*by/), qty:ix(/quantity\s*billed/) };
  console.log('\nHEADER ROW:', JSON.stringify(rows[hIdx]));
  console.log('COLUMN MATCHES:');
  for (const [k,v] of Object.entries(cols))
    console.log(`  ${k.padEnd(5)} -> ${v > -1 ? 'col ' + v + ' "' + rows[hIdx][v] + '"' : '*** NOT FOUND ***'}`);

  const kept = [], skipped = [];
  rows.slice(hIdx + 1).forEach((r, i) => {
    const raw = r[cols.so];
    if (!raw) return skipped.push({ line: hIdx+2+i, raw: '(blank)', why: 'no Document Number' });
    if (!/^so/i.test(String(raw).trim())) return skipped.push({ line: hIdx+2+i, raw, why: 'does not start with "SO"' });
    const qty = cleanNum(r[cols.qty]);
    kept.push({
      raw, so: normaliseSO(raw),
      cust: cols.cust > -1 ? r[cols.cust] : 'Unknown',
      date: isoDate(cols.date > -1 ? r[cols.date] : ''),
      rawQty: cols.qty > -1 ? r[cols.qty] : '(no column)',
      crates: Math.min(MAX, Math.max(1, isNaN(qty) ? 1 : qty)),
      qtyBad: isNaN(qty), capped: !isNaN(qty) && qty > MAX
    });
  });

  console.log(`\nACCEPTED ${kept.length} · SKIPPED ${skipped.length} (maxCrates = ${MAX})`);
  if (skipped.length) { console.log('\nSKIPPED ROWS — these silently never reach the tablet:');
    skipped.slice(0,40).forEach(s => console.log(`  line ${s.line}: "${s.raw}" — ${s.why}`)); }

  const dupes = {}; kept.forEach(k => (dupes[k.so] = (dupes[k.so]||[]).concat(k.raw)));
  const collide = Object.entries(dupes).filter(([,v]) => v.length > 1);
  if (collide.length) { console.log('\n!! DIFFERENT SOs NORMALISING TO THE SAME REF:');
    collide.forEach(([n,v]) => console.log(`  ${n} <- ${v.join(' , ')}`)); }

  const noQty = kept.filter(k => k.qtyBad), capped = kept.filter(k => k.capped);
  if (noQty.length) { console.log(`\n!! ${noQty.length} row(s) with no readable Quantity Billed — these default to 1 crate and complete after one count:`);
    noQty.slice(0,20).forEach(k => console.log(`  ${k.so} — ${k.cust} — qty cell "${k.rawQty}"`)); }
  if (capped.length) { console.log(`\n!! ${capped.length} row(s) capped at ${MAX} crates:`);
    capped.slice(0,20).forEach(k => console.log(`  ${k.so} — ${k.cust} — query says ${k.rawQty}`)); }

  console.log('\nFIRST 15 ACCEPTED (as the tablet will see them):');
  kept.slice(0,15).forEach(k => console.log(`  ${k.raw.padEnd(12)} -> ${k.so.padEnd(12)} | ${String(k.cust).slice(0,32).padEnd(32)} | ${k.date} | ${k.crates} crate(s)`));
});
