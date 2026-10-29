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
t('alias edit: another account\'s name or alias, too short, or already matched is refused; a new name is fine',
  /CNI0222/.test(P.aliasProblem(CM, 'FP704', 'Chubb Fire')) && /CNI0222/.test(P.aliasProblem(CM, 'FP704', 'chubb fire & security limited'))
  && /3 letters/.test(P.aliasProblem(CM, 'FP704', 'ab')) && /already matches/.test(P.aliasProblem(CM, 'FP704', 'Firemark Ltd'))
  && P.aliasProblem(CM, 'FP704', 'Firemark Scrap Warehouse') === null);
const CR = [{ code: 'FP704', name: 'Firemark Limited', aliases: ['firemark'], billing: 'monthly', aliasLog: [{ alias: 'firemark scrap warehouse', action: 'remove' }] }];
t('alias edit: an alias removed on Customers is never re-added on boot', P.addAliases(CR) === 0 && CR[0].aliases.length === 1);
const fmOpen = O({ id: 30, so: 'TFO1C', cust: 'Firemark Scrap Warehouse', source: 'netsuite-tfo', status: 'open', crates: 1 });
const fmSent = O({ id: 31, so: 'TFO2C', cust: 'Firemark Scrap Warehouse', source: 'netsuite-tfo', counts: cnt(2), crates: 1, wtn: 'WTN-2026-0001', wtnSentAt: '06/10/2026' });
const CF = [{ code: 'FP704', name: 'Firemark Limited', aliases: ['firemark'], billing: 'monthly' }], CF2 = [Object.assign({}, CF[0], { aliases: ['firemark', 'Firemark Scrap Warehouse'] })];
const am = P.aliasMoves([fmOpen, fmSent], CF, 'FP704', CF2[0].aliases);
t('alias edit: preview counts the open order joining, not the WTN-sent one', am.into === 1 && am.out === 0 && am.by.awaiting === 1 && P.rollState(fmOpen, CF2) === 'pending');
t('not sent: a WTN-sent order of the account is offered, only once its name matches', P.sentOffRoll([fmOpen, fmSent], CF, 'FP704').length === 0
  && P.sentOffRoll([fmOpen, fmSent], CF2, 'FP704').map(o => o.id).join() === '31'
  && P.sentOffRoll([Object.assign({}, fmSent, { invoicedAt: '07/10/2026' })], CF2, 'FP704').length === 0);
t('not sent: monthly switch date and quarters read from UK dates', P.monthlySince({ history: [{ to: 'monthly', when: '27/10/2026, 10:17' }, { to: 'per-order', when: '01/09/2026, 09:00' }] }) === '2026-10-27'
  && P.monthlySince({ history: [] }) === '' && P.quarterOf(P.ukIso('30/09/2026, 17:00')) === '2026Q3' && P.quarterOf(P.ukIso('1/10/2026')) === '2026Q4');
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
const DF = P.defraOrders([Object.assign({ rollCode: 'CNI0222' }, multi), plain, nowtn], RU, CM), last = o => o.counts[o.counts.length - 1].when.split(',')[0];
t('Defra: one row per order per count day, under the order\'s own WTN', DF.length === 3 && DF.filter(o => o.wtn === 'WTN-31').map(last).sort().join() === '02/10/2026,20/09/2026');
t('Defra: every counted entry with a WTN appears exactly once', DF.reduce((n, o) => n + o.counts.length, 0) === 4);
t('Defra: the season WTN only rides along as a reference', DF.find(o => last(o) === '20/09/2026').seasonWtn === 'WTN-S1' && DF.every(o => !/^WTN-S/.test(o.wtn)));
t('Defra: billing does not change the rows (same rows before and after Process)', JSON.stringify(P.defraOrders([Object.assign({}, multi, { cust: 'Chubb Fire and Security Ltd', counts: multi.counts.map(c => Object.assign({}, c, { packId: undefined })) })], [], CM).map(o => [o.wtn, last(o), o.counts.length]))
  === JSON.stringify(P.defraOrders([Object.assign({}, multi, { cust: 'Chubb Fire and Security Ltd' })], RU, CM).map(o => [o.wtn, last(o), o.counts.length])));
const perOrder = O({ id: 36, so: 'SO860036C', cust: 'Acme Ltd', wtn: 'WTN-36', counts: [ew(2, '30/09/2026, 10:00'), ew(3, '01/10/2026, 10:00')] });
t('Defra: a per-order collection over two days stays ONE row, identical to 385cc58 (dated 01/10)', (r => r.length === 1 && r[0] === perOrder && last(r[0]) === '01/10/2026')(P.defraOrders([perOrder], RU, CM)));
const rollTwo = Object.assign({}, perOrder, { id: 37, cust: 'Chubb Fire and Security Ltd' });
t('Defra: a roll-up order over two days gives two dated rows', P.defraOrders([rollTwo], RU, CM).map(last).sort().join() === '01/10/2026,30/09/2026');
t('companyNorm: Ltd and Limited match, Plc / LLP / Inc do not', P.companyNorm('Acme Ltd') === P.companyNorm('ACME LIMITED') && P.companyNorm('Acme Plc') !== P.companyNorm('Acme') && P.companyNorm('Acme LLP') !== P.companyNorm('Acme Inc'));
const agedBilled = O({ id: 35, so: 'SO850035C', cust: 'Chubb Fire and Security Ltd', source: 'netsuite', status: 'open', date: iso(120), crates: 5, counts: [ew(3, '01/07/2026, 10:00', 1)] });
t('blocker 1: a part-billed order never ages out into Archive', P.stageOf(agedBilled, undefined, CM) === 'monthly');
const extO = O({ id: 40, so: 'DROP-2026-0040', cust: 'Chubb Fire and Security Ltd', dropOff: true, status: 'open', crates: 9, counts: [ew(3, '01/10/2026, 10:00'), ew(4, '02/10/2026, 10:00')] });
extO.counts.forEach(c => { c.packId = 'ext:1'; });
t('already billed: counts as billed, is done, sits in Processed, off the roll-up', P.hasBilled(extO) && !P.unbilled(extO).length && P.extDone(extO)
  && P.stageOf(extO, undefined, CM) === 'processed' && !P.openRollup([extO], 'CNI0222', CM).members.length && !P.openRollup([extO], 'CNI0222', CM).pending.length);
t('already billed: Defra rows are the same as before the mark', JSON.stringify(P.defraOrders([extO], [], CM).map(o => [o.wtn, o.counts.length]))
  === JSON.stringify(P.defraOrders([Object.assign({}, extO, { counts: extO.counts.map(c => Object.assign({}, c, { packId: undefined })) })], [], CM).map(o => [o.wtn, o.counts.length])));
// Reports: billed per crate entry (Pipeline.crateBilled), the one rule Reports uses
const RB = [{ id: 1, wtn: 'W1', processedAt: '20/10/2026, 10:00' }, { id: 2, wtn: 'W2', sentAt: '21/10/2026' }, { id: 3, wtn: 'W3', processedAt: 'x', voidedAt: 'y' }];
const cb = (o, c) => P.crateBilled(o, c, RB);
t('crateBilled: invoiced order, Already billed, processed pack = billed', cb({ invoicedAt: 'x' }, {}) && cb({}, { packId: 'ext:4' }) && cb({}, { packId: 1 }) && cb({ rollupId: 1 }, {}));
t('crateBilled: unpacked, sent-only pack, voided pack = not billed', !cb({}, {}) && !cb({}, { packId: 2 }) && !cb({}, { packId: 3 }));
{ // the real buildRecords from dashboard.js, on a mixed order
  const src = fs.readFileSync(path.join(APP, 'public/dashboard.js'), 'utf8');
  const grab = name => { const i = src.indexOf('function ' + name + '('); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
  const mixed = { id: 1, so: 'DROP-1', cust: 'Chubb', status: 'open', date: '2026-10-01', counts: [
    { when: '01/10/2026, 10:00', lines: [{ p: 'Water 6L', q: 5 }], packId: 'ext:1' },
    { when: '02/10/2026, 10:00', lines: [{ p: 'Water 6L', q: 7 }], packId: 1 },
    { when: '03/10/2026, 10:00', lines: [{ p: 'Water 6L', q: 3 }], packId: 2 },
    { when: '04/10/2026, 10:00', lines: [{ p: 'Water 6L', q: 4 }] }] };
  const run = new Function('P', 'STATE', 'PRODMAP', grab('parseWhen') + '\nfunction acctOf(){return null;}\nfunction stageOf(){return "monthly";}\nlet RECORDS=[];\n' + grab('buildRecords') + '\nbuildRecords();return RECORDS;');
  const rec = run(P, { orders: [mixed], rollups: RB }, {})[0];
  t('Reports: billed per crate (ext 5 + processed pack 7 = 12 of 19), not yet billed 7', rec.qty === 19 && rec.billed === 12 && rec.unbilled === 7 && !rec.invoiced);
}
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
    customers: [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire'], billing: 'per-order', history: [], note: '' },
      { code: 'FP704', name: 'Firemark Limited', aliases: ['firemark'], billing: 'per-order', history: [], note: '' }],
    orders: [
      { id: 1, so: 'SO860001C', cust: 'Chubb Fire & Security Limited', date: iso(5), by: 'NS', crates: 1, counts: cl(8), status: 'done', wtn: 'WTN-2026-0901', finalSo: null, source: 'netsuite' },
      { id: 2, so: 'SO860002C', cust: 'Chubb Fire and Security Ltd', date: iso(3), by: 'NS', crates: 2, counts: [], status: 'open', wtn: null, finalSo: null, source: 'netsuite' },
      { id: 3, so: 'DROP-2026-0901', cust: 'Chubb fire and security ltd', date: iso(2), by: 'T', crates: 1, counts: cl(4), status: 'done', wtn: 'WTN-2026-0902', finalSo: null, source: 'dropoff', dropOff: true },
      { id: 4, so: 'SO860003C', cust: 'Griffin Fire', date: iso(2), by: 'NS', crates: 1, counts: cl(2), status: 'done', wtn: 'WTN-2026-0903', finalSo: null, source: 'netsuite' },
      { id: 5, so: 'SO860004C', cust: 'Chubb Fire and Security Ltd', date: iso(2), by: 'NS', crates: 1, counts: cl(3).map(c => Object.assign(c, { when: new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) + ', 10:00' })), status: 'done', wtn: 'WTN-2026-0904', finalSo: null, source: 'netsuite', wtnSentAt: '22/10/2026' },
      { id: 6, so: 'SO860005C', cust: 'Chubb Fire and Security Ltd', date: '2025-01-10', by: 'NS', crates: 1, counts: cl(2).map(c => Object.assign(c, { when: '10/01/2025, 10:00' })).concat(cl(1).map(c => Object.assign(c, { crateFrom: 2, crateTo: 2, when: '13/01/2025, 10:00' }))), status: 'done', wtn: 'WTN-2025-0001', finalSo: null, source: 'netsuite', wtnSentAt: '14/01/2025' },
      { id: 7, so: 'SO860006C', cust: 'Chubb Fire and Security Ltd', date: '2025-02-10', by: 'NS', crates: 1, counts: cl(2).map(c => Object.assign(c, { when: '10/02/2025, 10:00' })), status: 'done', wtn: 'WTN-2025-0002', finalSo: null, source: 'netsuite', wtnSentAt: '11/02/2025' }] };
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
    t('revert: nothing lost or duplicated', st.orders.length === 7 && new Set(st.orders.map(o => o.id)).size === 7);
    /* ---- aliases (Customers tab) and WTNs marked sent that never went out ---- */
    t('alias: Firemark NetSuite name added on boot', st.customers.find(c => c.code === 'FP704').aliases.includes('Firemark Scrap Warehouse'));
    await req(port3, 'POST', '/api/customer-billing', { code: 'CNI0222', billing: 'monthly', by: 'T' }, K);
    const al = (body, h) => req(port3, 'POST', '/api/customer-alias', Object.assign({ code: 'CNI0222', by: 'T' }, body), h);
    t('alias: refused without the admin key', (await al({ alias: 'Griffin Fire' })).status === 403);
    t('alias: one that matches another account is refused', (await al({ alias: 'firemark' }, K)).status === 400);
    const ad = (await al({ alias: 'Griffin Fire' }, K)).json;
    st = (await req(port3, 'GET', '/api/state')).json;
    t('alias: add pulls the matching order in as needs Confirm, and logs it', ad.ok && ad.moved.into === 1 && P.rollState(by(4), st.customers) === 'pending'
      && st.customers[0].aliasLog.some(x => x.action === 'add' && x.alias === 'Griffin Fire' && x.by === 'T'));
    const rm = (await al({ alias: 'griffin fire', action: 'remove' }, K)).json;
    st = (await req(port3, 'GET', '/api/state')).json;
    t('alias: remove puts it back in its own stage', rm.ok && rm.moved.out === 1 && stg(4) === 'counted' && !st.customers[0].aliases.includes('Griffin Fire'));
    const un = (b, h) => req(port3, 'POST', '/api/customer-wtn-unsend', Object.assign({ code: 'CNI0222', by: 'T' }, b), h);
    t('not sent: only orders kept off the roll-up by a sent WTN are offered', P.sentOffRoll(st.orders, st.customers, 'CNI0222').map(o => o.id).sort().join() === '5,6,7');
    t('not sent: refused without the admin key', (await un({ orderIds: [5] })).status === 403);
    t('not sent: an order not on offer is refused', (await un({ orderIds: [1] }, K)).status === 400);
    const q = await un({ orderIds: [5, 6] }, K);
    st = (await req(port3, 'GET', '/api/state')).json;
    t('not sent: counted over several days in an earlier quarter refused (filed Defra row would split), nothing moved', q.status === 400 && /earlier quarter/.test(q.json.error) && stg(5) === 'wtn' && stg(6) === 'wtn');
    const defraRows = () => JSON.stringify(P.defraOrders(st.orders, st.rollups, st.customers).filter(r => r.id === 7).map(r => [r.wtn, r.defraDay || null, r.crates]));
    const rows7 = defraRows();
    const u = (await un({ orderIds: [5, 7] }, K)).json;
    st = (await req(port3, 'GET', '/api/state')).json;
    t('not sent: counted on one day in an earlier quarter moves, its Defra row unchanged', u.ok && stg(7) === 'monthly' && defraRows() === rows7);
    t('not sent: order joins the roll-up, its WTN number and the sent date kept on record', u.ok && u.count === 2 && stg(5) === 'monthly' && P.rollState(by(5), st.customers) === 'member'
      && by(5).wtn === 'WTN-2026-0904' && by(5).wtnUnsent[0].was === '22/10/2026');
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
    t('revert refused while an open order has crates already billed', rv1.status === 400 && /already billed/.test(rv1.json.error) && /Finish them first/.test(rv1.json.error));
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
    t('blocker 1: close-short refuses a roll-up order (use Finish)', await r409('/api/close-short', { orderId: 7, reason: 'x' }));
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

  /* ---- Already billed: crates invoiced outside the app ---- */
  const port7 = port + 6;
  const xw = (q, when) => ({ crateFrom: 1, crateTo: 1, by: 'T', when, lines: [{ p: 'Water 6L', q }] });
  const ch7 = { code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb'], billing: 'monthly', history: [], note: '' };
  const s7 = await boot(port7, 'k7', { seq: 9, wtnSeq: { 2026: 80 }, lastSync: null, customers: [ch7], rollups: [], orders: [
    { id: 1, so: 'DROP-2026-0701', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', date: iso(5), by: 'T', crates: 10, counts: [xw(5, '20/10/2026, 10:00'), xw(7, '21/10/2026, 10:00')], status: 'open', wtn: 'WTN-2026-0071', finalSo: null, source: 'dropoff', dropOff: true },
    { id: 2, so: 'DROP-2026-0702', cust: 'Chubb', date: iso(4), by: 'T', crates: 1, counts: [xw(3, '22/10/2026, 10:00')], status: 'done', wtn: 'WTN-2026-0072', finalSo: null, source: 'dropoff', dropOff: true },
    { id: 3, so: 'DROP-2026-0703', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', date: iso(3), by: 'T', crates: 1, counts: [xw(4, '23/10/2026, 10:00')], status: 'done', wtn: 'WTN-2026-0073', finalSo: null, source: 'dropoff', dropOff: true },
    { id: 4, so: 'SO870004C', cust: 'Acme Ltd', date: iso(3), by: 'NS', crates: 1, counts: [xw(1, '23/10/2026, 10:00')], status: 'done', wtn: 'WTN-2026-0074', finalSo: null, source: 'netsuite' }] });
  try {
    const K = { 'X-Admin-Key': 'k7' }, x = (p, b, h) => req(port7, 'POST', p, b, h);
    const ub = st => P.openRollup(st.orders, 'CNI0222', st.customers).members.concat(P.openRollup(st.orders, 'CNI0222', st.customers).pending)
      .reduce((a, o) => a + P.entriesUnits(P.unbilled(o)), 0);
    let st = (await req(port7, 'GET', '/api/state')).json;
    const by = id => st.orders.find(o => o.id === id), u0 = ub(st), defra0 = (await req(port7, 'GET', '/api/receipt-of-waste-info')).json.count;
    t('already billed: refused without a NetSuite reference', (await x('/api/roll-extbill', { orderIds: [1], ref: '   ' })).status === 400);
    const m1 = (await x('/api/roll-extbill', { orderIds: [1], ref: ' INV-190001 ', note: 'billed in Sept', by: 'T' })).json;
    st = (await req(port7, 'GET', '/api/state')).json;
    t('already billed: single mark takes every unbilled crate and moves it to Processed', m1.ok && m1.units === 12 && m1.ref === 'INV-190001'
      && by(1).counts.every(c => c.packId === 'ext:1') && P.stageOf(by(1), undefined, st.customers) === 'processed' && by(1).rollMember === 'billed-elsewhere');
    t('already billed: totals drop by exactly those units', ub(st) === u0 - 12);
    t('already billed: audit record kept on the order', (r => r.by === 'T' && r.ref === 'INV-190001' && r.note === 'billed in Sept' && r.units === 12)(by(1).extBills[0]));
    const m2 = (await x('/api/roll-extbill', { orderIds: [2, 3], ref: 'SO852009', by: 'T' })).json;
    st = (await req(port7, 'GET', '/api/state')).json;
    t('already billed: bulk mark with one reference, totals drop by exactly those units', m2.ok && m2.count === 2 && m2.units === 7 && ub(st) === u0 - 19);
    t('already billed: marking a needs-confirm order confirms it, and records that', by(2).rollConfirmedAt && /already billed SO852009/.test(by(2).rollConfirmedBy) && by(2).extBills[0].confirmedByMark);
    t('already billed: refused when nothing is unbilled', (await x('/api/roll-extbill', { orderIds: [3], ref: 'X' })).status === 400);
    t('already billed: Process has nothing to bill', (await x('/api/rollup-process', { code: 'CNI0222' })).status === 400);
    const r409 = async (p, b) => (await x(p, b)).status === 409;
    t('guard: per-order Invoiced refused on an already-billed order', await r409('/api/mark', { orderId: 3, field: 'invoiced', value: true }));
    t('guard: per-order Processed refused', await r409('/api/process', { orderId: 3, nsRef: 'SO1' }));
    t('guard: set-so refused', await r409('/api/set-so', { orderId: 3, so: 'SO777777' }));
    t('guard: consolidate refused', await r409('/api/consolidate', { targetId: 4, sourceIds: [3] }));
    t('guard: move-crate refused', await r409('/api/move-crate', { orderId: 3, countIndex: 0, so: 'SO870004C' }));
    t('Defra rows unchanged by marking', (await req(port7, 'GET', '/api/receipt-of-waste-info')).json.count === defra0);
    await x('/api/count', { orderId: 1, by: 'T', crates: 1, lines: [{ p: 'Water 6L', q: 2 }] });   // a later crate on the same drop-off
    st = (await req(port7, 'GET', '/api/state')).json;
    t('a later crate on the same drop-off is billable again on the roll-up', P.stageOf(by(1), undefined, st.customers) === 'monthly' && P.entriesUnits(P.unbilled(by(1))) === 2);
    const pr = (await x('/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port7, 'GET', '/api/state')).json;
    t('Process afterwards bills only the new crate, never the already-billed ones', pr.ok && pr.rollup.units === 2 && pr.rollup.visitIds.join() === '1'
      && by(1).counts.filter(c => c.packId === 'ext:1').length === 2 && by(1).counts.filter(c => c.packId === pr.rollup.id).length === 1);
    t('already billed: the same order twice is marked once (no empty audit record)', await (async () => { const d0 = (await x('/api/dropoff', { cust: 'x', custCode: 'CNI0222', by: 'T', crates: 2 })).json.order.id;
      await x('/api/count', { orderId: d0, by: 'T', crates: 1, lines: [{ p: 'Water 6L', q: 8 }] }); const j = (await x('/api/roll-extbill', { orderIds: [d0, d0, String(d0)], ref: 'INV-DUP' })).json;
      const o0 = (await req(port7, 'GET', '/api/state')).json.orders.find(o => o.id === d0); return j.ok && j.count === 1 && j.units === 8 && o0.extBills.length === 1; })());
    t('undo needs the admin key', (await x('/api/roll-extbill-undo', { orderId: 3 })).status === 403 && (await x('/api/roll-extbill-undo', { orderId: 3 }, { 'X-Admin-Key': 'nope' })).status === 403);
    t('undo refused once the order has crates on a pack since', (await x('/api/roll-extbill-undo', { orderId: 1 }, K)).status === 400);
    const u3 = (await x('/api/roll-extbill-undo', { orderId: 3, by: 'A' }, K)).json;
    const u2 = (await x('/api/roll-extbill-undo', { orderId: 2, by: 'A' }, K)).json;
    st = (await req(port7, 'GET', '/api/state')).json;
    t('undo restores the order to the roll-up exactly', u3.ok && u2.ok && P.rollState(by(3), st.customers) === 'member' && P.unbilled(by(3)).length === 1
      && P.rollState(by(2), st.customers) === 'pending' && !by(2).rollConfirmedAt && by(2).extBills[0].undoneAt && by(3).extBills[0].undoneBy === 'A');
  } finally { s7.child.kill(); fs.rmSync(s7.dir, { recursive: true, force: true }); }

  /* ---- probe9: revert and part-billed orders; a later crate is always billable exactly once ---- */
  const port8 = port + 7;
  const s8 = await boot(port8, 'k8');
  try {
    const K = { 'X-Admin-Key': 'k8' }, x = (p, b, h) => req(port8, 'POST', p, b, h);
    const mk = async n => (await x('/api/dropoff', { cust: 'x', custCode: 'CNI0222', by: 'T', crates: n })).json.order.id;
    const cnt = (id, q) => x('/api/count', { orderId: id, by: 'T', crates: 1, lines: [{ p: 'Water 6L', q }] });
    const units = (st, id) => P.orderUnits(st.orders.find(o => o.id === id));
    // instance 1: mark an open drop-off with 1 of 3 crates counted
    const d = await mk(3); await cnt(d, 5);
    await x('/api/roll-extbill', { orderId: d, ref: 'INV1' });
    const rv = await x('/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'A' }, K);
    t('probe9-1: revert refused while a marked order is open, naming it', rv.status === 400 && rv.json.error.includes('DROP-') && /Finish them first/.test(rv.json.error));
    await cnt(d, 7); await cnt(d, 9);
    let st = (await req(port8, 'GET', '/api/state')).json;
    t('probe9-1: the later crates are back on the roll-up', P.stageOf(st.orders.find(o => o.id === d), undefined, st.customers) === 'monthly');
    const p1 = (await x('/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port8, 'GET', '/api/state')).json;
    const od = st.orders.find(o => o.id === d);
    t('probe9-1: the later crates are billed exactly once', p1.ok && p1.rollup.units === 16 && od.counts.filter(c => c.packId === 'ext:1').length === 1 && od.counts.filter(c => c.packId === p1.rollup.id).length === 2);
    // instance 2: one crate marked, a later crate packed, order still open (extDone + pack)
    const e = await mk(5); await cnt(e, 2);
    await x('/api/roll-extbill', { orderId: e, ref: 'INV2' }); await cnt(e, 3);
    const p2 = (await x('/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port8, 'GET', '/api/state')).json;
    t('probe9-2: marked + packed open order sits in Processed', p2.ok && P.stageOf(st.orders.find(o => o.id === e), undefined, st.customers) === 'processed');
    for (const r of [p1, p2]) await x('/api/rollup-mark', { id: r.rollup.id, field: 'sent', value: true });
    const rv2 = await x('/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'A' }, K);
    t('probe9-2: revert still refused, it names the part-billed order', rv2.status === 400 && rv2.json.error.includes(st.orders.find(o => o.id === e).so));
    // the same order can't be marked again with nothing unbilled, and gets its next crate billed once
    t('probe9-2: nothing left to mark', (await x('/api/roll-extbill', { orderId: e, ref: 'INV3' })).status === 400);
    await cnt(e, 4);
    const p3 = (await x('/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    t('probe9-2: a further crate is billed exactly once', p3.ok && p3.rollup.units === 4);
    // Finish both, then revert is allowed
    for (const r of [p3]) await x('/api/rollup-mark', { id: r.rollup.id, field: 'sent', value: true });
    const f1 = (await x('/api/roll-finish', { orderId: d })).json, f2 = (await x('/api/roll-finish', { orderId: e })).json;
    const rv3 = (await x('/api/customer-billing', { code: 'CNI0222', billing: 'per-order', by: 'A' }, K)).json; 
    st = (await req(port8, 'GET', '/api/state')).json;
    t('probe9: after Finish, revert is allowed and the orders stay billed (d closed itself on its last crate)', f2.ok && rv3.ok && st.orders.find(x => x.id === d).rollupId === p1.rollup.id
      && [d, e].every(id => { const o = st.orders.find(x => x.id === id); return o.status === 'done' && !P.unbilled(o).length; }));
    // invariant: whatever the billing mode, a part-billed order with a later crate stays billable once
    const g = await mk(4); await cnt(g, 6);
    st = (await req(port8, 'GET', '/api/state')).json;
    t('invariant: per-order again, a new picked drop-off is per order', P.rollState(st.orders.find(o => o.id === g), st.customers) === null);
  } finally { s8.child.kill(); fs.rmSync(s8.dir, { recursive: true, force: true }); }
  /* invariant on a store left inconsistent (e.g. by older code): per-order account, open order with
     an already-billed crate and a later unbilled one. It stays on the roll-up and bills once. */
  const port9 = port + 8;
  const zw = (q, packId) => Object.assign({ crateFrom: 1, crateTo: 1, by: 'T', when: '20/10/2026, 10:00', lines: [{ p: 'Water 6L', q }] }, packId ? { packId } : {});
  const s9 = await boot(port9, 'k9', { seq: 2, wtnSeq: { 2026: 90 }, extSeq: 1, lastSync: null, rollups: [],
    customers: [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb'], billing: 'per-order', history: [], note: '' }],
    orders: [{ id: 1, so: 'DROP-2026-0951', cust: 'Chubb Fire and Security Ltd', custCode: 'CNI0222', custMatch: 'picked', rollCode: 'CNI0222', date: iso(3), by: 'T', crates: 4,
      counts: [zw(5, 'ext:1'), zw(6)], status: 'open', wtn: 'WTN-2026-0091', finalSo: null, source: 'dropoff', dropOff: true, extBills: [{ n: 1, ref: 'INV1', packsAtMark: [] }] }] });
  try {
    let st = (await req(port9, 'GET', '/api/state')).json;
    t('invariant: per-order account, part-billed order stays on its roll-up (not per-order billable)', P.stageOf(st.orders[0], undefined, st.customers) === 'monthly'
      && (await req(port9, 'POST', '/api/mark', { orderId: 1, field: 'invoiced', value: true })).status === 409);
    const pr = (await req(port9, 'POST', '/api/rollup-process', { code: 'CNI0222', by: 'T' })).json;
    st = (await req(port9, 'GET', '/api/state')).json;
    t('invariant: its later crate is billed exactly once, then nothing is left', pr.ok && pr.rollup.units === 6 && !P.unbilled(st.orders[0]).length
      && (await req(port9, 'POST', '/api/rollup-process', { code: 'CNI0222' })).status === 400);
  } finally { s9.child.kill(); fs.rmSync(s9.dir, { recursive: true, force: true }); }
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
