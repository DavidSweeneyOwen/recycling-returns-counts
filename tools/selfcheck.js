/* Static self-check for the recycling app: parses every file and confirms each
   dashboard's script and markup agree on element ids, handler names and endpoints.
   Checks the new pipeline dashboard (/) and the classic fail-safe (/classic).
   Usage: node tools/selfcheck.js <app path> */
'use strict';
const fs = require('fs'), path = require('path');
const APP = process.argv[2] || '.';
const p = f => path.join(APP, f);
let fail = 0;
const ok = m => console.log('  OK   ' + m);
const bad = m => { fail++; console.log('  FAIL ' + m); };
const server = fs.readFileSync(p('server.js'), 'utf8');

for (const f of ['public/dashboard.js', 'public/classic.js', 'public/pipeline.js']) {
  try { new Function(fs.readFileSync(p(f), 'utf8') + '\n;void 0'); ok(f + ' parses'); }
  catch (e) { bad(f + ': ' + e.message); }
}
for (const f of ['public/count.html', 'public/dashboard.html', 'public/classic.html']) {
  const h = fs.readFileSync(p(f), 'utf8');
  const m = h.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { ok(f + ' has no inline script'); continue; }
  try { new Function(m[1] + '\n;void 0'); ok(f + ' inline script parses'); }
  catch (e) { bad(f + ': ' + e.message); }
}

function checkPage(label, htmlFile, jsFile, route, extraIds, jsIdsCount) {
  console.log('\n  -- ' + label + ' --');
  const html = fs.readFileSync(p('public/' + htmlFile), 'utf8');
  const js = fs.readFileSync(p('public/' + jsFile), 'utf8');
  if (new RegExp(`<script[^>]+src=["']/?${jsFile.replace('.', '\\.')}`).test(html)) {
    ok(htmlFile + ' loads ' + jsFile);
    if (server.includes(`p === '/${jsFile}'`)) ok('server.js serves /' + jsFile);
    else bad('server.js has no route for /' + jsFile + ' — the page will load blank');
  } else bad(htmlFile + ' does NOT load ' + jsFile);
  if (route === '/' || server.includes(`p === '${route}'`)) ok('server.js serves ' + route);
  else bad('no route for ' + route);

  /* ids the script looks up must exist in the markup (or in the script's own templates) */
  const ids = new Set([...html.matchAll(/id=["']([A-Za-z0-9_]+)["']/g)].map(m => m[1]));
  if (jsIdsCount) for (const m of js.matchAll(/id="([A-Za-z0-9_]+)"/g)) ids.add(m[1]);
  const want = new Set(extraIds);
  for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) want.add(m[1]);
  const missing = [...want].filter(x => !ids.has(x));
  missing.length ? bad('missing ids in ' + htmlFile + ': ' + missing.join(', ')) : ok('all ' + want.size + ' element ids present');

  /* every onclick="name(" in either file must resolve to a function */
  const handlers = new Set();
  for (const src of [html, js])
    for (const m of src.matchAll(/on(?:click|change|input|keydown)=["'`]?(?:if\([^)]*\))?\s*([A-Za-z_][A-Za-z0-9_]*)\(/g))
      handlers.add(m[1]);
  const defined = new Set([...js.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]));
  const builtins = new Set(['event','this','window','alert','confirm','prompt','fetch','Array','String','Number','esc']);
  const undef = [...handlers].filter(h => !defined.has(h) && !builtins.has(h));
  undef.length ? bad('handlers with no function: ' + undef.join(', ')) : ok('all ' + handlers.size + ' inline handlers resolve');

  const called = new Set([...js.matchAll(/(?:fetch|api)\('(\/api\/[a-z-]+)'/g)].map(m => m[1]));
  const served = new Set([...server.matchAll(/(?:p === |post\()'(\/api\/[a-z-]+)'/g)].map(m => m[1]));
  const orphan = [...called].filter(e => !served.has(e));
  orphan.length ? bad('page calls endpoints the server does not serve: ' + orphan.join(', '))
                : ok('all ' + called.size + ' endpoints the page calls exist on the server');
  for (const f of ['Reports', 'Amendments', 'set-so', 'keep-open', 'receipt-of-waste', 'close-short', 'consolidate', 'move-crate', 'photo'])
    (html + js).includes(f) ? ok(f + ' present') : bad(f + ' MISSING');
}

checkPage('classic dashboard (/classic)', 'classic.html', 'classic.js', '/classic',
  ['stAwait','stCrates','stCounted','stInv','stCredit','stDrop','stMonthly','pillAwait','pillCounted','pillInv','pillNoso','pillArch',
   'awaitEmpty','countedEmpty','invEmpty','nosoEmpty','archEmpty',
   ...['Await','Counted','Inv','Noso','Arch','Reports','Admin'].flatMap(t => ['view' + t, 'tab' + t])], false);
checkPage('pipeline dashboard (/)', 'dashboard.html', 'dashboard.js', '/',
  ['viewPipe','viewReports','viewAdmin','storeWarn','syncMsg','syncDot','nav','scrim','dialog','toast','rowPanel','tblRecon','tblBilling'], true);

/* the new dashboard must keep every live feature, by name */
console.log('\n  -- live features kept --');
const dj = fs.readFileSync(p('public/dashboard.js'), 'utf8'), dh = fs.readFileSync(p('public/dashboard.html'), 'utf8');
for (const f of ['View photo','Needs review','consolidatePicked','attachSo','closeShort','CO2 credit','saveAmend','Reprint','Auto-sync',
                 'Data store unavailable','rowDownload','exportXlsx','exportPptx','Counted vs billed','Billing view','Classic view','Download selected',
                 'Mark processed on NetSuite','Revert to per order','Confirm','Process '])
  (dj + dh).includes(f) ? ok('keeps: ' + f) : bad('new dashboard is missing: ' + f);
const cnt = fs.readFileSync(p('public/count.html'), 'utf8');
/pipeline\.js/.test(cnt) && /custCode/.test(cnt) ? ok('/count drop-off has the customer picker') : bad('/count customer picker missing');
/photoInput/.test(cnt) && /uploadPhoto/.test(cnt) ? ok('/count photo step intact') : bad('/count photo step changed');

console.log('');
const cfg = JSON.parse(fs.readFileSync(p('config.json'), 'utf8'));
console.log(`  INFO maxCrates=${cfg.maxCrates} products=${cfg.products.length} monthlyCustomers=${(cfg.monthlyCustomers||[]).length}`);
for (const f of ['dropoff','set-so','keep-open','ADMIN_KEY','/classic'])
  server.includes(f) ? ok('server: ' + f + ' present') : bad('server: ' + f + ' MISSING');

/* The Defra receipt of waste export needs its module and Defra's template uploaded too. */
for (const f of ['receipt-of-waste.js', (cfg.receiptOfWaste || {}).template || 'assets/receipt-of-waste-template.xlsx'])
  fs.existsSync(p(f)) ? ok(f + ' present') : bad(f + ' MISSING — the receipt of waste download will fail');

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
