/* Static self-check for the recycling app: parses every file and confirms the
   dashboard script and markup agree on element ids and handler names. */
'use strict';
const fs = require('fs'), path = require('path');
const APP = process.argv[2];
const p = f => path.join(APP, f);
let fail = 0;
const ok = m => console.log('  OK   ' + m);
const bad = m => { fail++; console.log('  FAIL ' + m); };

try { new Function(fs.readFileSync(p('public/dashboard.js'), 'utf8') + '\n;void 0'); ok('dashboard.js parses'); }
catch (e) { bad('dashboard.js: ' + e.message); }

for (const f of ['public/count.html', 'public/dashboard.html']) {
  const h = fs.readFileSync(p(f), 'utf8');
  const m = h.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { ok(f + ' has no inline script'); continue; }
  try { new Function(m[1] + '\n;void 0'); ok(f + ' inline script parses'); }
  catch (e) { bad(f + ': ' + e.message); }
}

const html = fs.readFileSync(p('public/dashboard.html'), 'utf8');
const js = fs.readFileSync(p('public/dashboard.js'), 'utf8');

if (/<script[^>]+src=["']\/?dashboard\.js/.test(html)) {
  ok('dashboard.html loads dashboard.js');
  if (/p === '\/dashboard\.js'/.test(fs.readFileSync(p('server.js'), 'utf8'))) ok('server.js serves /dashboard.js');
  else bad('server.js has no route for /dashboard.js — the dashboard will load blank');
} else bad('dashboard.html does NOT load dashboard.js');

const ids = new Set([...html.matchAll(/id=["']([A-Za-z0-9_]+)["']/g)].map(m => m[1]));
const want = new Set();
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) want.add(m[1]);
for (const n of ['stAwait','stCrates','stCounted','stInv','stCredit','stDrop','stMonthly',
                 'pillAwait','pillCounted','pillInv','pillNoso','pillArch',
                 'awaitEmpty','countedEmpty','invEmpty','nosoEmpty','archEmpty']) want.add(n);
for (const t of ['Await','Counted','Inv','Noso','Arch','Reports','Admin']) { want.add('view'+t); want.add('tab'+t); }
const missing = [...want].filter(x => !ids.has(x));
missing.length ? bad('missing ids in dashboard.html: ' + missing.join(', '))
               : ok('all ' + want.size + ' element ids present');

/* every onclick="name(" in either file must resolve to a function in dashboard.js */
const handlers = new Set();
for (const src of [html, js])
  for (const m of src.matchAll(/on(?:click|change|input|keydown)=["'`]?(?:if\([^)]*\))?\s*([A-Za-z_][A-Za-z0-9_]*)\(/g))
    handlers.add(m[1]);
const defined = new Set([...js.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]));
const builtins = new Set(['event','this','window','alert','confirm','prompt','fetch','Array','String','Number','esc']);
const undef = [...handlers].filter(h => !defined.has(h) && !builtins.has(h));
undef.length ? bad('handlers with no function: ' + undef.join(', '))
             : ok('all ' + handlers.size + ' inline handlers resolve');

const server = fs.readFileSync(p('server.js'), 'utf8');
const called = new Set([...js.matchAll(/fetch\('(\/api\/[a-z-]+)'/g)].map(m => m[1]));
const served = new Set([...server.matchAll(/p === '(\/api\/[a-z-]+)'/g)].map(m => m[1]));
const orphan = [...called].filter(e => !served.has(e));
orphan.length ? bad('dashboard calls endpoints the server does not serve: ' + orphan.join(', '))
              : ok('all ' + called.size + ' dashboard endpoints exist on the server');

const cfg = JSON.parse(fs.readFileSync(p('config.json'), 'utf8'));
console.log(`  INFO maxCrates=${cfg.maxCrates} products=${cfg.products.length} monthlyCustomers=${(cfg.monthlyCustomers||[]).length}`);
for (const f of ['Reports','Amendments','dropoff','set-so','keep-open'])
  (html + js + server).includes(f) ? ok(f + ' present') : bad(f + ' MISSING');

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
