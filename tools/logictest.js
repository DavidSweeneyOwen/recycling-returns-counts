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
// roll-ups: membership is derived from the customer list
const CM = [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire'], billing: 'monthly' },
            { code: 'FP704', name: 'Firemark Limited', aliases: ['firemark'], billing: 'per-order' }];
const CP = CM.map(c => Object.assign({}, c, { billing: 'per-order' }));
const cnt = (q) => [{ crateFrom: 1, crateTo: 1, by: 'T', when: '01/10/2026, 10:00', lines: [{ p: 'Water 6L', q }] }];
const nsDone = O({ id: 10, so: 'SO850001C', cust: 'CHUBB FIRE & SECURITY LIMITED', source: 'netsuite', counts: cnt(7), crates: 1 });
const nsSame = O({ id: 11, so: 'SO850002C', cust: 'Chubb Fire and Security Ltd.', source: 'netsuite', counts: cnt(5), crates: 1 });
const nsOpen = O({ id: 12, so: 'SO850003C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', status: 'open', crates: 3 });
const nsPart = O({ id: 13, so: 'SO850004C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', status: 'open', crates: 3, counts: cnt(4) });
const dropName = O({ id: 14, so: 'DROP-2026-0020', cust: 'Chubb fire and security LTD', dropOff: true, counts: cnt(9), crates: 1 });
const dropAlias = O({ id: 15, so: 'DROP-2026-0021', cust: 'Chubb', dropOff: true, counts: cnt(3), crates: 1 });
const dropPick = O({ id: 16, so: 'DROP-2026-0022', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', dropOff: true, counts: cnt(6), crates: 1 });
const nsAlias = O({ id: 17, so: 'SO850005C', cust: 'chubb fire', source: 'netsuite', counts: cnt(2), crates: 1 });
const typo = O({ id: 18, so: 'DROP-2026-0023', cust: 'Chubby fire and security ltd', dropOff: true, counts: cnt(1), crates: 1 });
const other = O({ id: 19, so: 'SO850006C', cust: 'Firemark Limited', source: 'netsuite', counts: cnt(1), crates: 1 });
const sent = O({ id: 20, so: 'SO850007C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', wtnSentAt: '20/10/2026', counts: cnt(1), crates: 1 });
const aged = O({ id: 21, so: 'SO850008C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', status: 'open', date: iso(120), crates: 1 });
const ALL = [nsDone, nsSame, nsOpen, nsPart, dropName, dropAlias, dropPick, nsAlias, typo, other, sent, aged];
t('strict: NetSuite SO with the exact company name (Ltd/Limited, &, punctuation) is trusted', P.rollState(nsDone, CM) === 'member' && P.rollState(nsSame, CM) === 'member');
t('strict: a drop-off typed with the exact name still needs Confirm', P.rollState(dropName, CM) === 'pending');
t('strict: alias match needs Confirm (drop-off and SO)', P.rollState(dropAlias, CM) === 'pending' && P.rollState(nsAlias, CM) === 'pending');
t('strict: picked from the list is trusted', P.rollState(dropPick, CM) === 'member');
t('strict: near-miss spelling stays per order', P.rollState(typo, CM) === null && P.stageOf(typo, undefined, CM) === 'noso');
const CS = P.seedCustomers({ monthlyCustomers: [] }), CL = [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire'], billing: 'monthly' }];
t('alias added: "Chubby fire and security ltd" joins CNI0222 as needs Confirm, never trusted', P.rollState(typo, CS) === 'pending' && P.rollMatch(typo, CS).code === 'CNI0222'
  && P.rollState(Object.assign({}, typo, { source: 'netsuite', dropOff: false }), CS) === 'pending');
t('alias added to an existing live record once, additively', P.addAliases(CL) === 1 && P.addAliases(CL) === 0 && CL[0].aliases.length === 3 && CL[0].aliasLog.length === 1);
t('strict: per-order account never rolls', P.rollState(other, CM) === null);
t('not members: WTN sent, archived, on a pack', P.rollState(sent, CM) === null && P.stageOf(aged, undefined, CM) === 'archive' && P.rollState(Object.assign({}, nsDone, { rollupId: 3 }), CM) === null);
t('pull-in: Counted, Awaiting and No SO yet orders all move to monthly', [nsDone, nsOpen, dropName].every(o => P.stageOf(o, undefined, CM) === 'monthly')
  && P.stageOf(nsDone, undefined, CP) === 'counted' && P.stageOf(nsOpen, undefined, CP) === 'awaiting' && P.stageOf(dropName, undefined, CP) === 'noso');
const mv = P.movesOnToggle(ALL, CP, 'CNI0222', 'monthly');
t('pull-in: toggle reports what moves, by stage', mv.total === 8 && mv.by.counted === 3 && mv.by.awaiting === 2 && mv.by.noso === 3);
const back = P.movesOnToggle(ALL, CM, 'CNI0222', 'per-order');
t('revert: every member goes back to its own stage', back.total === 8 && back.by.counted === 3 && back.by.awaiting === 2 && back.by.noso === 3);
t('confirmed alias becomes a member', P.rollState(Object.assign({}, dropAlias, { rollConfirmedAt: 'x', rollConfirmCode: 'CNI0222' }), CM) === 'member');
t('rejected ("Not CNI0222") leaves for good', P.stageOf(Object.assign({}, dropAlias, { rollRejectCode: 'CNI0222' }), undefined, CM) === 'noso');
t('385cc58 rejected visit still rejected', P.rollState(Object.assign({}, dropAlias, { rollCode: 'CNI0222', rollOutAt: 'x', rollOutWhy: 'rejected by T' }), CM) === null);
t('385cc58 roll-stamped noSoExpected does not hide a reverted drop-off from No SO yet', P.stageOf(Object.assign({}, dropName, { rollCode: 'CNI0222', noSoExpected: '24/10/2026' }), undefined, CP) === 'noso');
t('visit on a season WTN -> rolled', P.stageOf(Object.assign({}, nsDone, { rollupId: 1 }), undefined, CM) === 'rolled');
const R = P.openRollup(ALL, 'CNI0222', CM);
t('roll-up: members by state', R.members.map(o => o.id).sort().join() === '10,11,12,13,16' && R.pending.map(o => o.id).sort().join() === '14,15,17'
  && R.empty.map(o => o.id).join() === '12' && R.billedOpen.length === 0);
t('roll-up: Process takes every confirmed member with a counted crate, part-counted too', R.ready.map(o => o.id).sort().join() === '10,11,13,16');
t('roll-up: crates and units totals', R.members.reduce((a, o) => a + P.orderUnits(o), 0) === 22 && R.members.reduce((a, o) => a + P.countedCrates(o), 0) === 4
  && R.pending.reduce((a, o) => a + P.orderUnits(o), 0) === 14 && R.ready.reduce((a, o) => a + P.orderUnits(o), 0) === 22);
// per-crate billing and the Defra mapping: every entry exactly once
const e = (q, packId) => Object.assign({ crateFrom: 1, crateTo: 1, by: 'T', when: '01/10/2026, 10:00', lines: [{ p: 'Water 6L', q }] }, packId ? { packId } : {});
const part = O({ id: 30, so: 'DROP-2026-0030', cust: 'x', status: 'open', crates: 10, counts: [e(4, 1), e(5, 1), e(6)] });
t('per crate: billed entries are not billed again', P.unbilled(part).length === 1 && P.entriesUnits(P.unbilled(part)) === 6 && P.billedOn(part, 1).length === 2 && P.hasBilled(part));
const ew = (q, when, packId) => Object.assign({ crateFrom: 1, crateTo: 1, by: 'T', when, lines: [{ p: 'Water 6L', q }] }, packId ? { packId } : {});
const multi = O({ id: 31, so: 'DROP-2026-0031', cust: 'Chubb', wtn: 'WTN-31', status: 'open', crates: 10,
  counts: [ew(4, '20/09/2026, 10:00', 1), ew(5, '20/09/2026, 15:00'), ew(6, '02/10/2026, 09:00', 2)] });
const plain = O({ id: 33, so: 'SO3C', cust: 'z', wtn: 'WTN-3', counts: [ew(1, '05/10/2026, 09:00')] });
const nowtn = O({ id: 34, so: 'SO4C', cust: 'z', status: 'open', counts: [ew(1, '05/10/2026, 09:00')] });
const RU = [{ id: 1, wtn: 'WTN-S1', code: 'C', name: 'C' }, { id: 2, wtn: 'WTN-S2', code: 'C', name: 'C' }];
const DF = P.defraOrders([multi, plain, nowtn], RU), last = o => o.counts[o.counts.length - 1].when.split(',')[0];
t('Defra: one row per order per count day, under the order\'s own WTN', DF.length === 3 && DF.filter(o => o.wtn === 'WTN-31').map(last).sort().join() === '02/10/2026,20/09/2026');
t('Defra: every counted entry with a WTN appears exactly once', DF.reduce((n, o) => n + o.counts.length, 0) === 4);
t('Defra: the season WTN only rides along as a reference', DF.find(o => last(o) === '20/09/2026').seasonWtn === 'WTN-S1' && DF.every(o => !/^WTN-S/.test(o.wtn)));
t('Defra: billing does not change the rows (same rows before and after Process)', JSON.stringify(P.defraOrders([Object.assign({}, multi, { counts: multi.counts.map(c => Object.assign({}, c, { packId: undefined })) })], []).map(o => [o.wtn, last(o), o.counts.length]))
  === JSON.stringify(P.defraOrders([multi], RU).map(o => [o.wtn, last(o), o.counts.length])));
t('companyNorm: Ltd and Limited match, Plc / LLP / Inc do not', P.companyNorm('Acme Ltd') === P.companyNorm('ACME LIMITED') && P.companyNorm('Acme Plc') !== P.companyNorm('Acme') && P.companyNorm('Acme LLP') !== P.companyNorm('Acme Inc'));
const agedBilled = O({ id: 35, so: 'SO850035C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', status: 'open', date: iso(120), crates: 5, counts: [ew(3, '01/07/2026, 10:00', 1)] });
t('blocker 1: a part-billed order never ages out into Archive', P.stageOf(agedBilled, undefined, CM) === 'monthly');
t('removed drop-off sits in no stage', P.stageOf(O({ status: 'open', rollVoidAt: 'x' }), undefined, CM) === 'removed');
t('rollupStage', P.rollupStage({}) === 'pack' && P.rollupStage({ sentAt: 'x' }) === 'wtn' && P.rollupStage({ sentAt: 'x', processedAt: 'y' }) === 'processed' && P.rollupStage({ voidedAt: 'x' }) === 'void');
// customers + matching
const cs = P.seedCustomers(JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8')));
const chubb = P.findCustomer(cs, 'cni0222');
t('seed: Chubb monthly with aliases', chubb && chubb.billing === 'monthly' && chubb.aliases.join() === 'chubb,chubb fire,chubby fire and security ltd' && chubb.name === 'Chubb Fire and Security Ltd');
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
/* The test servers run with ACCESS_KEY set, like Render: every office call carries the
   access cookie, and one check below proves the gate still refuses without it. */
const ACC = 'acc-test-key';
function req(port, method, p, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json', Cookie: 'appkey=' + ACC }, headers || {});
  if (h.Cookie === null) delete h.Cookie;
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, s => {
      let b = ''; s.on('data', d => b += d); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: s.statusCode, json: j, text: b }); });
    });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function boot(port, adminKey, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-logic-'));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(seed || { orders: [], seq: 0, wtnSeq: {}, lastSync: null }));
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, ADMIN_KEY: adminKey || '', GH_DATA_REPO: '', GH_TOKEN: '',
    ACCESS_KEY: ACC, RENDER_EXTERNAL_URL: '', KEEP_ALIVE_URL: '', NETSUITE_WEBQUERY_URL: 'http://127.0.0.1:9/unreachable' });
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], { env, stdio: process.env.LOGIC_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 150; i++) {   // up to ~20s: this machine's file scanning slows a cold start
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
    t('e2e: /count picker is open and lists only monthly accounts, without billing data', (j => j.customers.length === 1 && j.customers[0].code === 'CNI0222' && !('billing' in j.customers[0]))((await req(port, 'GET', '/api/count-customers', null, { Cookie: null })).json));
    t('e2e: seeded Chubb carries the Chubby alias', st0.customers[0].aliases.includes('chubby fire and security ltd'));
    t('e2e: customers seeded on a store that had none', st0.customers.length >= 2 && st0.customers[0].code === 'CNI0222' && st0.adminEnabled === true);
    const drop = async (b) => (await req(port, 'POST', '/api/dropoff', Object.assign({ by: 'Tester', crates: 1 }, b))).json.order;
    const count = async (o) => (await req(port, 'POST', '/api/count', { orderId: o.id, by: 'Tester', crates: 1, lines: [{ p: 'Water 6L', q: 5 }, { p: 'Powder 2KG', q: 3 }] })).json;
    const a = await drop({ cust: 'whatever typed', custCode: 'CNI0222' }); await count(a);
    const b = await drop({ cust: 'Chubb' }); await count(b);
    const c = await drop({ cust: 'Severn Fire Services' }); await count(c);
    const d = await drop({ cust: 'chubb fire', custCode: 'CNI0222' });   // picked, still counting
    let st = (await req(port, 'GET', '/api/state')).json;
    const by = id => st.orders.find(o => o.id === id);
    t('e2e: picked drop-off takes the account name and joins the roll-up', by(a.id).cust === 'Chubb Fire and Security Ltd' && P.rollState(by(a.id), st.customers) === 'member');
    t('e2e: alias-typed drop-off waits for Confirm', P.rollState(by(b.id), st.customers) === 'pending' && by(b.id).custCode === 'CNI0222');
    t('e2e: unknown name goes to No SO yet', P.stageOf(by(c.id), undefined, st.customers) === 'noso' && !by(c.id).rollCode);
    t('e2e: a counted visit still gets its own WTN (live behaviour)', /^WTN-\d{4}-\d{4}$/.test(by(a.id).wtn || ''));
    t('e2e: confirm', (await req(port, 'POST', '/api/roll-confirm', { orderId: b.id, confirm: true, by: 'Tester' })).json.ok);
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: confirm keeps what was typed', by(b.id).typedCust === 'Chubb' && by(b.id).cust === 'Chubb Fire and Security Ltd');
    t('e2e: roll-up members are flagged for /classic (rollMember) so it keeps them off its billable tabs', [a.id, b.id, d.id].every(id => by(id).rollMember === 'CNI0222') && !by(c.id).rollMember);
    t('e2e: office APIs still refuse without the access key', (await req(port, 'POST', '/api/rollup-process', { code: 'CNI0222' }, { Cookie: null })).status === 401);
    const h = await drop({ cust: 'chubb' }); await count(h);   // alias, left waiting for Confirm
    const pr = (await req(port, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'Tester' })).json;
    /* ---- blocking path 1: a visit on a season pack cannot be billed on its own ---- */
    const r409 = async (p, body) => (await req(port, 'POST', p, body)).status === 409;
    t('guard 1: classic Invoiced tick refused on a packed visit', await r409('/api/mark', { orderId: a.id, field: 'invoiced', value: true }));
    t('guard 1: classic WTN-sent tick refused on a packed visit', await r409('/api/mark', { orderId: a.id, field: 'wtnSent', value: true }));
    t('guard 1: per-order Processed refused on a packed visit', await r409('/api/process', { orderId: b.id, nsRef: 'SO1' }));
    /* ---- blocking path 2: no real SO on a packed or pending visit ---- */
    t('guard 2: set-so refused on a packed visit', await r409('/api/set-so', { orderId: b.id, so: 'SO12345' }));
    t('guard 2: set-so refused on a visit waiting for Confirm', await r409('/api/set-so', { orderId: h.id, so: 'SO99999' }));
    /* ---- blocking path 3: never folded away or moved while a pack holds it ---- */
    t('guard 3: consolidate refuses a packed visit as a source', await r409('/api/consolidate', { targetId: c.id, sourceIds: [a.id] }));
    t('guard 3: consolidate refuses a packed visit as the target', await r409('/api/consolidate', { targetId: a.id, sourceIds: [c.id] }));
    t('guard 3: move-crate refuses a packed visit', await r409('/api/move-crate', { orderId: a.id, countIndex: 0, so: 'SO777777' }));
    t('guard 3: merge-drops refuses an open roll-up visit', await r409('/api/merge-drops', { orderId: d.id }));
    t('guard 3: amend refused once a visit is on a pack', await r409('/api/amend', { orderId: a.id, reason: 'x', crates: 1 }));
    st = (await req(port, 'GET', '/api/state')).json;
    t('guard 3: every packed visit still exists and is unbilled', pr.rollup.visitIds.every(id => by(id) && !by(id).invoicedAt && by(id).so.startsWith('DROP-')));
    /* ---- blocking path 4: revert cannot strand an unsent pack ---- */
    const rv0 = await req(port, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'Tester' }, { 'X-Admin-Key': 'test-admin-key' });
    t('guard 4: revert refused while a pack is unsent', rv0.status === 400 && rv0.json.error === 'Mark the pack sent or void it first');
    t('e2e: reject the alias visit -> No SO yet', (await req(port, 'POST', '/api/roll-confirm', { orderId: h.id, confirm: false })).json.ok);
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: rejected visit shows on No SO yet again', P.stageOf(by(h.id), undefined, st.customers) === 'noso' && !by(h.id).noSoExpected);
    t('e2e: Process takes the confirmed, counted visits only', pr.ok && pr.rollup.visitIds.slice().sort().join() === [a.id, b.id].sort().join() && pr.left === 2);
    t('e2e: season WTN numbered in sequence', /^WTN-\d{4}-\d{4}$/.test(pr.rollup.wtn) && pr.rollup.wtn !== by(a.id).wtn);
    const wtnPage = await req(port, 'GET', '/wtn/rollup/' + pr.rollup.id);
    t('e2e: season WTN page renders with the visit list', wtnPage.status === 200 && wtnPage.text.includes(pr.rollup.wtn) && wtnPage.text.includes('Visits covered'));
    const batch = await req(port, 'GET', `/wtn-batch?ids=${a.id},${c.id}&r=${pr.rollup.id}&print=1`);
    t('e2e: batch WTN page holds every selected WTN and auto-prints', batch.status === 200 && (batch.text.match(/class="wtn"/g) || []).length >= 4 && batch.text.includes('window.print()'));
    t('e2e: sent', (await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'sent', value: true })).json.ok);
    t('e2e: processed needs a NetSuite number', !!(await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'processed', value: true })).json.error);
    t('e2e: processed', (await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'processed', value: true, nsRef: 'so48300' })).json.ok);
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: visits carry wtnSentAt/invoicedAt/nsRef so /classic reads them as invoiced', [a.id, b.id].every(id => { const o = by(id); return o.wtnSentAt && o.invoicedAt && o.nsRef === 'SO48300' && P.stageOf(o, undefined, st.customers) === 'rolled'; }));
    t('e2e: roll-up is Processed', P.rollupStage(st.rollups[0]) === 'processed');
    t('guard: a processed pack cannot be voided', (await req(port, 'POST', '/api/rollup-undo', { id: pr.rollup.id })).status === 400);
    t('guard: a processed pack cannot be un-sent', (await req(port, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'sent', value: false })).status === 400);
    await req(port, 'POST', '/api/set-so', { orderId: c.id, so: 'SO900001' });
    await req(port, 'POST', '/api/mark', { orderId: c.id, field: 'wtnSent', value: true });
    const po = (await req(port, 'POST', '/api/process', { orderId: c.id, nsRef: 'inv-190300', by: 'Tester' })).json;
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: per-order Processed on NetSuite records nsRef and invoicedAt', po.ok && by(c.id).nsRef === 'INV-190300' && by(c.id).invoicedAt && P.stageOf(by(c.id), undefined, st.customers) === 'processed');
    const e = await drop({ cust: 'x', custCode: 'CNI0222' }); await count(e);
    const f = await drop({ cust: 'Chubb' });
    const bill = (h) => req(port, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'Tester' }, h);
    t('e2e: billing change without the admin key is refused', (await bill()).status === 403);
    t('e2e: billing change with a wrong key is refused', (await bill({ 'X-Admin-Key': 'nope' })).status === 403);
    const rv = await bill({ 'X-Admin-Key': 'test-admin-key' });
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: revert with the key splits the OPEN roll-up (d, e, f)', rv.json.ok && rv.json.split === 3);
    t('e2e: reverted visits go back to their own stages', P.stageOf(by(e.id), undefined, st.customers) === 'noso' && P.stageOf(by(d.id), undefined, st.customers) === 'awaiting' && P.stageOf(by(f.id), undefined, st.customers) === 'awaiting');
    t('e2e: processed roll-up untouched by revert', by(a.id).rollupId === pr.rollup.id && P.rollupStage(st.rollups[0]) === 'processed');
    const rp2 = await req(port, 'POST', '/api/rollup-process', { code: 'CNI0222' });
    t('guard 4: Process refused once the account is per order', rp2.status === 400 && /per order/.test(rp2.json.error));
    t('e2e: /count picker lists monthly accounts only', (await req(port, 'GET', '/api/count-customers', null, { Cookie: null })).json.customers.length === 0);
    t('e2e: change history recorded', st.customers[0].billing === 'per-order' && st.customers[0].history[0].from === 'monthly' && st.customers[0].history[0].by === 'Tester');
    const g = await drop({ cust: 'x', custCode: 'CNI0222' });
    st = (await req(port, 'GET', '/api/state')).json;
    t('e2e: after revert a picked Chubb drop-off is per order', !by(g.id).rollCode && P.stageOf(by(g.id), undefined, st.customers) === 'awaiting');
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

  /* ---- pull-in on toggle: NetSuite SOs and drop-offs, Counted / Awaiting / No SO yet ---- */
  const port3 = port + 2;
  const cl = q => [{ crateFrom: 1, crateTo: 1, by: 'T', when: '20/10/2026, 10:00', lines: [{ p: 'Water 6L', q }, { p: 'Foam 6L', q: 1 }] }];
  const seed = { seq: 5, wtnSeq: {}, lastSync: null, rollups: [],
    customers: [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire'], billing: 'per-order', history: [], note: '' }],
    orders: [
      { id: 1, so: 'SO860001C', cust: 'Chubb Fire & Security Limited', date: iso(5), by: 'NS', crates: 1, counts: cl(8), status: 'done', wtn: 'WTN-2026-0901', finalSo: null, source: 'netsuite' },
      { id: 2, so: 'SO860002C', cust: 'Chubb Fire and Security Ltd', date: iso(3), by: 'NS', crates: 2, counts: [], status: 'open', wtn: null, finalSo: null, source: 'netsuite' },
      { id: 3, so: 'DROP-2026-0901', cust: 'Chubb fire and security ltd', date: iso(2), by: 'T', crates: 1, counts: cl(4), status: 'done', wtn: 'WTN-2026-0902', finalSo: null, source: 'dropoff', dropOff: true },
      { id: 4, so: 'SO860003C', cust: 'Griffin Fire', date: iso(2), by: 'NS', crates: 1, counts: cl(2), status: 'done', wtn: 'WTN-2026-0903', finalSo: null, source: 'netsuite' },
      { id: 5, so: 'SO860004C', cust: 'Chubb Fire and Security Ltd', date: iso(2), by: 'NS', crates: 1, counts: cl(3), status: 'done', wtn: 'WTN-2026-0904', finalSo: null, source: 'netsuite', wtnSentAt: '22/10/2026' }] };
  const s3 = await boot(port3, 'k3', seed);
  try {
    const K = { 'X-Admin-Key': 'k3' };
    let st = (await req(port3, 'GET', '/api/state')).json;
    t('live record without the alias gets it on boot', st.customers[0].aliases.includes('chubby fire and security ltd') && st.customers[0].aliases.length === 3);
    const by = id => st.orders.find(o => o.id === id), stg = id => P.stageOf(by(id), undefined, st.customers);
    t('pull-in: before the toggle the orders sit in Counted / Awaiting / No SO yet', stg(1) === 'counted' && stg(2) === 'awaiting' && stg(3) === 'noso');
    const on = (await req(port3, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'monthly', by: 'T' }, K)).json;
    st = (await req(port3, 'GET', '/api/state')).json;
    t('pull-in: switching to monthly moves all three open orders, and says so', on.ok && on.moved.total === 3 && on.moved.by.counted === 1 && on.moved.by.awaiting === 1 && on.moved.by.noso === 1);
    t('pull-in: each order is in exactly one place (monthly), others untouched', [1, 2, 3].every(i => stg(i) === 'monthly') && stg(4) === 'counted' && stg(5) === 'wtn');
    t('pull-in: NetSuite SO trusted, typed drop-off needs Confirm', P.rollState(by(1), st.customers) === 'member' && P.rollState(by(3), st.customers) === 'pending');
    t('pull-in: /classic flag set on the members only', by(1).rollMember === 'CNI0222' && by(3).rollMember === 'CNI0222' && !by(4).rollMember && !by(5).rollMember);
    const r409 = async (p, body) => (await req(port3, 'POST', p, body)).status === 409;
    t('guard on a pulled-in SO: Invoiced tick refused', await r409('/api/mark', { orderId: 1, field: 'invoiced', value: true }));
    t('guard on a pulled-in SO: per-order Processed refused', await r409('/api/process', { orderId: 1, nsRef: 'INV-1' }));
    t('guard on a pulled-in SO: set-so refused', await r409('/api/set-so', { orderId: 1, so: 'SO999999' }));
    t('guard on a pulled-in SO: consolidate refused', await r409('/api/consolidate', { targetId: 4, sourceIds: [1] }));
    t('guard on a pulled-in SO: move-crate refused', await r409('/api/move-crate', { orderId: 1, countIndex: 0, so: 'SO888888' }));
    t('guard on a pending drop-off: set-so refused', await r409('/api/set-so', { orderId: 3, so: 'SO777777' }));
    const pr = (await req(port3, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    t('Process: only the confirmed, fully counted order (not the open SO, not the unconfirmed drop-off)', pr.ok && pr.rollup.visitIds.join() === '1' && pr.left === 2);   // open SO 2 has nothing counted
    t('Process: season pack lists the SO number', (await req(port3, 'GET', '/wtn/rollup/' + pr.rollup.id)).text.includes('SO860001C'));
    t('revert refused while the pack is unsent', (await req(port3, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'T' }, K)).status === 400);
    await req(port3, 'POST', '/api/rollup-mark', { id: pr.rollup.id, field: 'sent', value: true });
    t('confirm moves the drop-off into the roll-up', (await req(port3, 'POST', '/api/roll-confirm', { orderIds: [3], confirm: true, by: 'T' })).json.ok);
    st = (await req(port3, 'GET', '/api/state')).json;
    t('confirmed drop-off is ready for the next Process', P.openRollup(st.orders, 'CNI0222', st.customers).ready.map(o => o.id).join() === '3');
    const off = (await req(port3, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'T' }, K)).json;
    st = (await req(port3, 'GET', '/api/state')).json;
    t('revert: members go back to Awaiting / No SO yet, the sent pack stays', off.ok && off.split === 2 && stg(2) === 'awaiting' && stg(3) === 'noso' && stg(1) === 'rolled');
    t('revert: nothing lost or duplicated', st.orders.length === 5 && new Set(st.orders.map(o => o.id)).size === 5);
  } finally { s3.child.kill(); fs.rmSync(s3.dir, { recursive: true, force: true }); }

  /* ---- per-crate billing on one drop-off across two packs ---- */
  const port4 = port + 3;
  const s4 = await boot(port4, 'k4');
  try {
    const K = { 'X-Admin-Key': 'k4' };
    const mk = async () => (await req(port4, 'POST', '/api/dropoff', { cust: 'x', custCode: 'CNI0222', by: 'T', crates: 10 })).json.order;
    const cnt = async (o, n, q) => (await req(port4, 'POST', '/api/count', { orderId: o.id, by: 'T', crates: n, lines: [{ p: 'Water 6L', q }] })).json;
    const o = await mk(), empty = await mk();
    await cnt(o, 1, 5); await cnt(o, 1, 7);                      // 2 crates, 12 units
    const p1 = (await req(port4, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    await cnt(o, 1, 4);                                          // 1 more crate on the SAME drop-off
    let st = (await req(port4, 'GET', '/api/state')).json, me = () => st.orders.find(x => x.id === o.id);
    t('per crate: pack 1 bills the 2 crates counted so far on a part-counted drop-off', p1.ok && p1.rollup.crates === 2 && p1.rollup.units === 12);
    t('per crate: the part-counted drop-off stays on the open roll-up', P.stageOf(me(), undefined, st.customers) === 'monthly' && P.unbilled(me()).length === 1);
    t('per crate: Remove empty drop-off refused once crates are counted', (await req(port4, 'POST', '/api/roll-remove', { orderId: o.id })).status === 400);
    t('per crate: amend refused once any crate is billed', (await req(port4, 'POST', '/api/amend', { orderId: o.id, reason: 'x', crates: 3 })).status === 409);
    await req(port4, 'POST', '/api/rollup-mark', { id: p1.rollup.id, field: 'sent', value: true });
    const rv1 = await req(port4, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'T' }, K);
    t('revert refused while an open order has crates already billed', rv1.status === 400 && /billed on a season WTN/.test(rv1.json.error));
    const p2 = (await req(port4, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port4, 'GET', '/api/state')).json;
    t('per crate: pack 2 bills only the crate counted after pack 1', p2.ok && p2.rollup.crates === 1 && p2.rollup.units === 4);
    t('per crate: never billed twice, never skipped (2 + 1 crates, 12 + 4 = 16 units)', p1.rollup.crates + p2.rollup.crates === P.countedCrates(me())
      && p1.rollup.units + p2.rollup.units === P.orderUnits(me()) && me().counts.every(c => c.packId));
    const s1 = (await req(port4, 'GET', '/wtn/rollup/' + p1.rollup.id)).text, s2 = (await req(port4, 'GET', '/wtn/rollup/' + p2.rollup.id)).text;
    t('per crate: each season WTN shows its own crates', s1.includes(p1.rollup.wtn) && s2.includes(p2.rollup.wtn) && /<td>2<\/td><td>12<\/td>/.test(s1) && /<td>1<\/td><td>4<\/td>/.test(s2));
    const info = (await req(port4, 'GET', '/api/receipt-of-waste-info')).json;
    t('Defra: the drop-off is reported under its own WTN, not the season WTNs', info.count === 1 && /^WTN-/.test(me().wtn) && me().wtn !== p1.rollup.wtn);
    t('Remove empty drop-off: kept, audited, in no stage', (await req(port4, 'POST', '/api/roll-remove', { orderId: empty.id, by: 'T' })).json.ok);
    await req(port4, 'POST', '/api/rollup-mark', { id: p2.rollup.id, field: 'sent', value: true });
    t('Finish: a fully billed part-counted drop-off closes on its last pack', (await req(port4, 'POST', '/api/roll-finish', { orderId: o.id, by: 'T' })).json.ok);
    st = (await req(port4, 'GET', '/api/state')).json;
    const em = st.orders.find(x => x.id === empty.id);
    t('removed drop-off kept with its audit trail', em && em.rollVoidAt && em.rollVoidBy === 'T' && P.stageOf(em, undefined, st.customers) === 'removed' && em.rollMember === 'removed');
    t('finished drop-off left the roll-up on pack 2, closed at 3 crates', me().rollupId === p2.rollup.id && me().status === 'done' && me().crates === 3 && me().wtnSentAt);
    t('revert allowed once nothing part-billed is open', (await req(port4, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'T' }, K)).json.ok);
  } finally { s4.child.kill(); fs.rmSync(s4.dir, { recursive: true, force: true }); }

  /* ---- blocker 1: billed crates can never move to another customer or be billed again ---- */
  const port5 = port + 4;
  const cw = (q, when, packId) => Object.assign({ crateFrom: 1, crateTo: 1, by: 'T', when, lines: [{ p: 'Water 6L', q }] }, packId ? { packId } : {});
  const chubb = { code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb'], billing: 'monthly', history: [], note: '' };
  const s5 = await boot(port5, 'k5', { seq: 9, wtnSeq: { 2026: 50 }, lastSync: null, customers: [chubb],
    rollups: [{ id: 1, code: 'CNI0222', name: chubb.name, visitIds: [5, 7], wtn: 'WTN-2026-0040', from: iso(120), to: iso(110), crates: 2, createdAt: 'x', createdBy: 'T', sentAt: '01/08/2026', nsRef: null, processedAt: null }],
    orders: [
      { id: 5, so: 'SO860005C', cust: 'Chubb Fire and Security Ltd', date: iso(120), by: 'NS', crates: 5, counts: [cw(3, '01/07/2026, 10:00', 1), cw(2, '02/07/2026, 10:00')], status: 'open', wtn: 'WTN-2026-0031', finalSo: null, source: 'netsuite' },
      { id: 6, so: 'SO860006C', cust: 'Acme Ltd', date: iso(2), by: 'NS', crates: 1, counts: [cw(1, '20/10/2026, 10:00')], status: 'done', wtn: 'WTN-2026-0032', finalSo: null, source: 'netsuite' },
      { id: 7, so: 'DROP-2026-0907', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', date: iso(115), by: 'T', crates: 4, counts: [cw(4, '05/07/2026, 10:00', 1)], status: 'open', wtn: 'WTN-2026-0033', finalSo: null, source: 'dropoff', dropOff: true }] });
  try {
    let st = (await req(port5, 'GET', '/api/state')).json;
    t('blocker 1: aged part-billed orders stay on the roll-up, not Archive', [5, 7].every(i => P.stageOf(st.orders.find(o => o.id === i), undefined, st.customers) === 'monthly'));
    const r409 = async (p, body) => (await req(port5, 'POST', p, body)).status === 409;
    t('blocker 1: move-crate refuses a billed crate', await r409('/api/move-crate', { orderId: 5, countIndex: 0, so: 'SO860006C' }));
    t('blocker 1: consolidate refuses a part-billed source', await r409('/api/consolidate', { targetId: 6, sourceIds: [7] }));
    t('blocker 1: per-order Processed refuses a part-billed order', await r409('/api/process', { orderId: 5, nsRef: 'SO1' }));
    t('blocker 1: Invoiced tick refuses a part-billed order', await r409('/api/mark', { orderId: 7, field: 'invoiced', value: true }));
    const pr = (await req(port5, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port5, 'GET', '/api/state')).json;
    const acme = st.orders.find(o => o.id === 6);
    t('blocker 1: Process bills only the unbilled crate, nothing twice', pr.ok && pr.rollup.crates === 1 && pr.rollup.units === 2 && acme.counts.length === 1
      && st.orders.reduce((n, o) => n + o.counts.filter(c => c.packId).length, 0) === 3);
  } finally { s5.child.kill(); fs.rmSync(s5.dir, { recursive: true, force: true }); }

  /* ---- blocker 2: Defra reports by receipt; Process never moves a crate between quarters ---- */
  const port6 = port + 5;
  const s6 = await boot(port6, 'k6', { seq: 3, wtnSeq: { 2026: 70 }, lastSync: null, customers: [chubb], rollups: [],
    orders: [{ id: 1, so: 'DROP-2026-0901', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', date: '2026-09-20', by: 'T', crates: 10,
      counts: [cw(6, '20/09/2026, 10:00')], status: 'open', wtn: null, finalSo: null, source: 'dropoff', dropOff: true }] });
  try {
    const q = async (f, to) => (await req(port6, 'GET', `/api/receipt-of-waste-info?from=${f}&to=${to}`)).json.count;
    let st = (await req(port6, 'GET', '/api/state')).json;
    t('blocker 2: an open roll-up drop-off counted without a WTN gets its own on boot', /^WTN-2026-0071$/.test(st.orders[0].wtn));
    const q3a = await q('2026-07-01', '2026-09-30');
    await req(port6, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' });
    const q3b = await q('2026-07-01', '2026-09-30'), q4b = await q('2026-10-01', '2026-12-31');
    await req(port6, 'POST', '/api/count', { orderId: 1, by: 'T', crates: 1, lines: [{ p: 'Water 6L', q: 2 }] });   // counted today
    const q3c = await q('2026-07-01', '2026-09-30'), all = await q('', '');
    t('blocker 2: the 20/09 crate is in the Q3 export before and after Process', q3a === 1 && q3b === 1 && q3c === 1 && q4b === 0);
    t('blocker 2: a later crate on the same drop-off is its own row on its own day, nothing twice', all === 2);
    st = (await req(port6, 'GET', '/api/state')).json;
    t('blocker 2: the WTN on that drop-off never changes', st.orders[0].wtn === 'WTN-2026-0071');
  } finally { s6.child.kill(); fs.rmSync(s6.dir, { recursive: true, force: true }); }
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
