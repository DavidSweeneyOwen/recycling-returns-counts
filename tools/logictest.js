/* Logic tests for the recycling app. Three parts:
   1. pipeline rules (public/pipeline.js) — stage derivation, roll-up inclusion and
      exclusion, revert, admin key, drop-off matching. Pure, no server needed.
   2. end to end — starts its OWN server on a throwaway data folder (never the live
      store: GH_DATA_REPO/GH_TOKEN are blanked) and drives the real endpoints.
   3. the original classification checks against a running instance's /api/state,
      using the classic dashboard's own classifiers, plus "one stage per order".
      Skipped (not failed) when nothing is listening on the port.
   Usage: node tools/logictest.js <app path> [port of a running instance, default 8123] */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn } = require('child_process');
const APP = path.resolve(process.argv[2] || '.');
const PORT = process.argv[3] || 8123;
const P = require(path.join(APP, 'public/pipeline.js'));
const bad = [];
let passed = 0;
const t = (name, cond) => { if (cond) passed++; else bad.push(name); };
const DAY = 86400000, now = Date.now();
const iso = daysAgo => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);

/* ---------------- 1. pipeline rules ---------------- */
console.log('\n  1. pipeline rules');
const O = (x) => Object.assign({ id: 1, so: 'SO1C', status: 'done', counts: [], date: iso(1) }, x);
t('open -> awaiting', P.stageOf(O({ status: 'open' })) === 'awaiting');
t('open 91 days -> archive', P.stageOf(O({ status: 'open', date: iso(91) })) === 'archive');
t('open 91 days kept open -> awaiting', P.stageOf(O({ status: 'open', date: iso(91), keepOpen: 'x' })) === 'awaiting');
t('done placeholder -> noso', P.stageOf(O({ so: 'DROP-2026-0001' })) === 'noso');
t('done MANUAL- -> noso', P.stageOf(O({ so: 'MANUAL-7' })) === 'noso');
t('needs review, no SO -> noso', P.stageOf(O({ so: 'DROP-2026-0002', needsReview: true })) === 'noso');
t('needs review, SO attached -> counted', P.stageOf(O({ so: 'SO824039C', dropRef: 'DROP-2026-0002', needsReview: true })) === 'counted');
t('drop-only customer skips noso', P.stageOf(O({ so: 'DROP-2026-0003', noSoExpected: '01/10/2026' })) === 'counted');
t('done -> counted', P.stageOf(O({})) === 'counted');
t('wtnSentAt -> wtn', P.stageOf(O({ wtnSentAt: '20/10/2026' })) === 'wtn');
t('invoicedAt -> processed', P.stageOf(O({ wtnSentAt: '20/10/2026', invoicedAt: '21/10/2026' })) === 'processed');
t('invoiced without wtn sent -> processed', P.stageOf(O({ invoicedAt: '21/10/2026' })) === 'processed');
t('open drop-off -> awaiting (not noso)', P.stageOf(O({ status: 'open', so: 'DROP-2026-0004' })) === 'awaiting');
// roll-ups
const picked = O({ so: 'DROP-2026-0010', rollCode: 'CNI0222', custMatch: 'picked' });
const alias = O({ id: 2, so: 'DROP-2026-0011', rollCode: 'CNI0222', custMatch: 'alias' });
t('picked monthly visit is a member', P.rollState(picked) === 'member' && P.stageOf(picked) === 'monthly');
t('alias visit is pending, not a member', P.rollState(alias) === 'pending' && P.stageOf(alias) === 'monthly');
t('confirmed alias becomes a member', P.rollState(Object.assign({}, alias, { rollConfirmedAt: 'x' })) === 'member');
t('rejected alias leaves to noso', P.stageOf(Object.assign({}, alias, { rollOutAt: 'x' })) === 'noso');
t('reverted visit back to its own stage', P.stageOf(Object.assign({}, picked, { rollOutAt: 'x' })) === 'noso');
t('reverted open visit -> awaiting', P.stageOf(Object.assign({}, picked, { status: 'open', rollOutAt: 'x' })) === 'awaiting');
t('visit on a season WTN -> rolled', P.stageOf(Object.assign({}, picked, { rollupId: 1 })) === 'rolled');
const ors = [picked, alias, O({ id: 3, so: 'DROP-2026-0012', rollCode: 'CNI0222', custMatch: 'picked', status: 'open' }),
  O({ id: 4, so: 'DROP-2026-0013', rollCode: 'CNI0222', custMatch: 'picked', rollupId: 9 }), O({ id: 5, so: 'DROP-2026-0014', rollCode: 'FP704', custMatch: 'picked' })];
const R = P.openRollup(ors, 'CNI0222');
t('roll-up: members exclude pending, rolled and other accounts', R.members.map(o => o.id).join() === '1,3');
t('roll-up: pending listed separately', R.pending.map(o => o.id).join() === '2');
t('roll-up: Process takes only fully counted members', R.ready.map(o => o.id).join() === '1');
t('rollupStage', P.rollupStage({}) === 'pack' && P.rollupStage({ sentAt: 'x' }) === 'wtn' && P.rollupStage({ sentAt: 'x', processedAt: 'y' }) === 'processed' && P.rollupStage({ voidedAt: 'x' }) === 'void');
// customers + matching
const cs = P.seedCustomers(JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8')));
const chubb = P.findCustomer(cs, 'cni0222');
t('seed: Chubb monthly with aliases', chubb && chubb.billing === 'monthly' && chubb.aliases.join() === 'chubb,chubb fire' && chubb.name === 'Chubb Fire and Security Ltd');
t('seed: config monthly customers imported as per-order with note', cs.length > 1 && cs.slice(1).every(c => c.billing === 'per-order' && /previously tagged monthly/.test(c.note)));
t('picked code is trusted', P.classifyDropoff(cs, 'CNI0222', 'anything').match === 'picked');
t('typed alias needs confirm', (k => k.match === 'alias' && k.roll)(P.classifyDropoff(cs, null, '  Chubb Fire ')));
t('typed near-miss does not match', P.classifyDropoff(cs, null, 'chubb fire alarms ltd').customer === null);
t('unknown name -> no account', P.classifyDropoff(cs, null, 'Severn Fire').customer === null);
t('typed per-order account name does not roll', P.classifyDropoff(cs, null, 'firemark').roll === false);
t('suggest by code, name and alias', P.suggest(cs, 'cni').length === 1 && P.suggest(cs, 'chub')[0].code === 'CNI0222' && P.suggest(cs, 'security').length >= 1);
// admin key
t('admin: unset key refuses with the Render message', (r => !r.ok && r.error === 'Set ADMIN_KEY on Render to enable changes')(P.adminCheck('', 'x')));
t('admin: wrong key refused', !P.adminCheck('k1', 'k2').ok);
t('admin: blank key refused', !P.adminCheck('k1', '').ok);
t('admin: right key accepted', P.adminCheck('k1', 'k1').ok);
console.log('     ' + passed + ' rule checks run');

/* ---------------- 2. end to end on a throwaway store ---------------- */
function req(port, method, p, body, headers) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, s => {
      let b = ''; s.on('data', d => b += d); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: s.statusCode, json: j, text: b }); });
    });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function boot(port, adminKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-logic-'));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ orders: [], seq: 0, wtnSeq: {}, lastSync: null }));
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, ADMIN_KEY: adminKey || '', GH_DATA_REPO: '', GH_TOKEN: '',
    ACCESS_KEY: '', RENDER_EXTERNAL_URL: '', KEEP_ALIVE_URL: '', NETSUITE_WEBQUERY_URL: 'http://127.0.0.1:9/unreachable' });
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await req(port, 'GET', '/api/state'); if (r.json && r.json.store && r.json.store.ready) return { child, dir }; } catch (e) {}
    await new Promise(s => setTimeout(s, 150));
  }
  child.kill(); throw new Error('test server did not start');
}
async function e2e() {
  console.log('  2. end to end (own server, throwaway store)');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const { child, dir } = await boot(port, 'test-admin-key');
  try {
    const st0 = (await req(port, 'GET', '/api/state')).json;
    t('e2e: customers seeded on a store that had none', st0.customers.length >= 2 && st0.customers[0].code === 'CNI0222' && st0.adminEnabled === true);
    const drop = async (b) => (await req(port, 'POST', '/api/dropoff', Object.assign({ by: 'Tester', crates: 1 }, b))).json.order;
    const count = async (o) => (await req(port, 'POST', '/api/count', { orderId: o.id, by: 'Tester', crates: 1, lines: [{ p: 'Water 6L', q: 5 }, { p: 'Powder 2KG', q: 3 }] })).json;
    const a = await drop({ cust: 'whatever typed', custCode: 'CNI0222' }); await count(a);
    const b = await drop({ cust: 'Chubb' }); await count(b);
    const c = await drop({ cust: 'Severn Fire Services' }); await count(c);
    const d = await drop({ cust: 'chubb fire', custCode: 'CNI0222' });   // picked, still counting
    let st = (await req(port, 'GET', '/api/state')).json;
    const by = id => st.orders.find(o => o.id === id);
    t('e2e: picked drop-off takes the account name and joins the roll-up', by(a.id).cust === 'Chubb Fire and Security Ltd' && P.rollState(by(a.id)) === 'member');
    t('e2e: alias-typed drop-off waits for Confirm', P.rollState(by(b.id)) === 'pending' && by(b.id).custCode === 'CNI0222');
    t('e2e: unknown name goes to No SO yet', P.stageOf(by(c.id)) === 'noso' && !by(c.id).rollCode);
    t('e2e: a counted visit still gets its own WTN (live behaviour)', /^WTN-\d{4}-\d{4}$/.test(by(a.id).wtn || ''));
    t('e2e: confirm', (await req(port, 'POST', '/api/roll-confirm', { orderId: b.id, confirm: true, by: 'Tester' })).json.ok);
    const pr = (await req(port, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'Tester' })).json;
    t('e2e: Process takes the confirmed, counted visits only', pr.ok && pr.rollup.visitIds.slice().sort().join() === [a.id, b.id].sort().join() && pr.left === 1);
    t('e2e: season WTN numbered in sequence', /^WTN-\d{4}-\d{4}$/.test(pr.rollup.wtn) && pr.rollup.wtn !== by(a.id).wtn);
    const wtnPage = await req(port, 'GET', '/wtn/rollup/' + pr.rollup.id);
    t('e2e: season WTN page renders with the visit list', wtnPage.status === 200 && wtnPage.text.includes(pr.rollup.wtn) && wtnPage.text.includes('Visits covered'));
    const batch = await req(port, 'GET', `/wtn-batch?ids=${a.id},${c.id}&r=${pr.rollup.id}&print=1`);
    t('e2e: batch WTN page holds every selected WTN and auto-prints', batch.status === 200 && (batch.text.match(/class="wtn"/g) || []).length >= 4 && batch.text.includes('window.print()'));
    t('e2e: sent', (await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'sent', value: true })).json.ok);
    t('e2e: processed needs a NetSuite number', !!(await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'processed', value: true })).json.error);
    t('e2e: processed', (await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'processed', value: true, nsRef: 'so48300' })).json.ok);
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: visits carry wtnSentAt/invoicedAt/nsRef so /classic reads them as invoiced', [a.id, b.id].every(id => { const o = by(id); return o.wtnSentAt && o.invoicedAt && o.nsRef === 'SO48300' && P.stageOf(o) === 'rolled'; }));
    t('e2e: roll-up is Processed', P.rollupStage(st.rollups[0]) === 'processed');
    await req(port, 'POST', '/api/set-so', { orderId: c.id, so: 'SO900001' });
    await req(port, 'POST', '/api/mark', { orderId: c.id, field: 'wtnSent', value: true });
    const po = (await req(port, 'POST', '/api/process', { orderId: c.id, nsRef: 'inv-190300', by: 'Tester' })).json;
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: per-order Processed on NetSuite records nsRef and invoicedAt', po.ok && by(c.id).nsRef === 'INV-190300' && by(c.id).invoicedAt && P.stageOf(by(c.id)) === 'processed');
    const e = await drop({ cust: 'x', custCode: 'CNI0222' }); await count(e);
    const f = await drop({ cust: 'Chubb' });
    const bill = (h) => req(port, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'Tester' }, h);
    t('e2e: billing change without the admin key is refused', (await bill()).status === 403);
    t('e2e: billing change with a wrong key is refused', (await bill({ 'X-Admin-Key': 'nope' })).status === 403);
    const rv = await bill({ 'X-Admin-Key': 'test-admin-key' });
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: revert with the key splits the OPEN roll-up (d, e, f)', rv.json.ok && rv.json.split === 3);
    t('e2e: reverted visits go back to their own stages', P.stageOf(by(e.id)) === 'noso' && P.stageOf(by(d.id)) === 'awaiting' && P.stageOf(by(f.id)) === 'awaiting');
    t('e2e: processed roll-up untouched by revert', by(a.id).rollupId === pr.rollup.id && P.rollupStage(st.rollups[0]) === 'processed');
    t('e2e: change history recorded', st.customers[0].billing === 'per-order' && st.customers[0].history[0].from === 'monthly' && st.customers[0].history[0].by === 'Tester');
    const g = await drop({ cust: 'x', custCode: 'CNI0222' });
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: after revert a picked Chubb drop-off is per order', !by(g.id).rollCode && P.stageOf(by(g.id)) === 'awaiting');
    t('e2e: /classic is served', (await req(port, 'GET', '/classic')).text.includes('/classic.js'));
    t('e2e: classic fields intact on every order', st.orders.every(o => 'status' in o && 'finalSo' in o && 'wtn' in o));
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }

  const port2 = port + 1;
  const s2 = await boot(port2, '');
  try {
    const st = (await req(port2, 'GET', '/api/state')).json;
    const r = await req(port2, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'x' }, { 'X-Admin-Key': '' });
    t('e2e: no ADMIN_KEY -> read-only, with the Render message', st.adminEnabled === false && r.status === 403 && r.json.error === 'Set ADMIN_KEY on Render to enable changes');
  } finally { s2.child.kill(); fs.rmSync(s2.dir, { recursive: true, force: true }); }
  console.log('     done');
}

/* ---------------- 3. live-instance classification ---------------- */
function liveCheck() {
  return new Promise(done => {
    const src = fs.readFileSync(path.join(APP, 'public/classic.js'), 'utf8');
    const grab = name => {
      const i = src.indexOf('function ' + name + '(');
      if (i < 0) throw new Error('not found in classic.js: ' + name);
      let d = 0, j = src.indexOf('{', i);
      for (let k = j; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
      }
    };
    const AGED = /const AGED_DAYS\s*=\s*(\d+)/.exec(src);
    const code = ['ageDays','lastCountDate','noSo','dmy','likelyDuplicate','openDropSiblings'].map(grab).join('\n')
      + `\nconst AGED_DAYS=${AGED ? AGED[1] : 90};`
      + `\nfunction isAged(o){return o.status==='open'&&!o.keepOpen&&ageDays(o.date)>AGED_DAYS;}`
      + `\nreturn {
           noso:    STATE.orders.filter(noSo).map(o=>o.so),
           aged:    STATE.orders.filter(isAged).map(o=>o.so),
           awaiting:STATE.orders.filter(o=>o.status==='open'&&!isAged(o)).map(o=>o.so),
           counted: STATE.orders.filter(o=>o.status==='done'&&!o.invoicedAt).map(o=>o.so),
           inv:     STATE.orders.filter(o=>o.status==='done'&&o.invoicedAt).map(o=>o.so),
           mergeable:STATE.orders.filter(o=>{const s=openDropSiblings(o);return s.length>1&&s[0].id===o.id;}).map(o=>o.so+' ('+openDropSiblings(o).length+')'),
           dupes:   STATE.orders.filter(noSo).map(o=>{const d=likelyDuplicate(o);return d?o.so+' ~ '+d.so:null;}).filter(Boolean)
         };`;
    http.get(`http://localhost:${PORT}/api/state`, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => {
        console.log('  3. live instance on port ' + PORT);
        const state = JSON.parse(b);
        const f = new Function('STATE', code)(state);
        const by = so => state.orders.find(o => o.so === so) || {};
        const show = (label, list) => console.log('     ' + label.padEnd(14) + ': ' + list.length + (list.length ? '  e.g. ' + list.slice(0, 3).join(', ') : ''));
        show('Awaiting', f.awaiting); show('Counted', f.counted); show('Invoiced', f.inv);
        show('No SO Yet', f.noso); show('Archive', f.aged); show('Mergeable', f.mergeable); show('Duplicates', f.dupes);
        const before = bad.length;
        f.noso.filter(so => by(so).noSoExpected).forEach(so => bad.push(so + ' is marked drop-off only but still sits in No SO Yet'));
        f.noso.filter(so => !/^(DROP|MANUAL)-/.test(so)).forEach(so => bad.push(so + ' has a real SO but still sits in No SO Yet'));
        f.counted.filter(so => by(so).invoicedAt).forEach(so => bad.push(so + ' is invoiced but still sits on Counted'));
        state.orders.filter(o => o.status === 'done' && o.invoicedAt).forEach(o => f.inv.includes(o.so) || bad.push(o.so + ' is invoiced but missing from the Invoiced tab'));
        f.aged.filter(so => by(so).keepOpen).forEach(so => bad.push(so + ' was kept open but is still being archived'));
        f.aged.filter(so => by(so).status !== 'open').forEach(so => bad.push(so + ' is counted but sits in Archive'));
        f.awaiting.concat(f.aged).filter(so => by(so).status !== 'open').forEach(so => bad.push(so + ' is not open but shows as awaiting'));
        const seen = {};
        for (const tab of ['awaiting','counted','inv','aged']) f[tab].forEach(so => { (seen[so] = seen[so] || []).push(tab); });
        Object.entries(seen).filter(([, x]) => x.length > 1).forEach(([so, x]) => bad.push(so + ' appears on more than one tab: ' + x.join(' + ')));
        /* the new pipeline must agree with the classic tabs, one stage per order */
        const counts = {};
        state.orders.forEach(o => {
          const s = P.stageOf(o); counts[s] = (counts[s] || 0) + 1;
          if (!['awaiting','noso','counted','wtn','processed','archive','monthly','rolled'].includes(s)) bad.push(o.so + ' has no stage');
          if (s === 'processed' && !(o.status === 'done' && o.invoicedAt)) bad.push(o.so + ' Processed but not invoiced in classic');
          if ((s === 'counted' || s === 'wtn') && !(o.status === 'done' && !o.invoicedAt)) bad.push(o.so + ' on ' + s + ' but not on classic Counted');
          if (s === 'noso' && !P.noSo(o)) bad.push(o.so + ' on No SO yet but has an SO');
          if ((s === 'awaiting' || s === 'archive') && o.status !== 'open') bad.push(o.so + ' awaiting but not open');
        });
        console.log('     new stages    : ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · ') + ' = ' + state.orders.length + ' orders');
        console.log('     customers     : ' + (state.customers || []).map(c => c.code + ' ' + c.billing).join(', '));
        if (bad.length === before) passed++;
        done();
      });
    }).on('error', () => { console.log('  3. live instance: skipped — nothing listening on ' + PORT); done(); });
  });
}

(async () => {
  try { await e2e(); } catch (e) { bad.push('end-to-end run failed: ' + e.message); }
  await liveCheck();
  console.log(bad.length ? '\n  FAILED:\n   - ' + bad.join('\n   - ') : `\n  ALL ${passed} LOGIC CHECKS PASSED`);
  process.exit(bad.length ? 1 : 0);
})();
