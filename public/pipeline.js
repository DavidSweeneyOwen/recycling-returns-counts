/* =========================================================================
   Pipeline rules — shared by server.js (require) and the dashboard (<script>).
   Zero dependencies. Nothing here writes to the store: it only DERIVES the stage
   of a collection from the fields the live app has always kept, plus a few new
   ones that are only ever added (never renamed or removed), so /classic and a
   rollback to the pre-redesign tag still read the same data correctly.

   Stage of a collection (first rule that matches wins):
     monthly    on a monthly customer's open roll-up (or waiting for Rec Admin to
                confirm an alias match) — shown under Monthly accounts
     rolled     covered by a season WTN — the roll-up record carries its stage
     archive    still uncounted 90+ days after the SO was raised (live meaning)
     awaiting   status 'open'
     noso       counted on a DROP-/MANUAL- placeholder: no real SO attached yet
     processed  invoicedAt set (processed on NetSuite; nsRef holds the number)
     wtn        wtnSentAt set
     counted    everything else that is 'done'
   New, additive order fields: custCode, custMatch ('picked'|'alias'), rollCode,
   rollConfirmedAt/By, rollOutAt/Why, rollupId, nsRef, processedAt, processedBy.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pipeline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const AGED_DAYS = 90;
  const STAGES = ['awaiting', 'noso', 'counted', 'wtn', 'processed'];

  function isPlaceholder(so) { return /^(DROP|MANUAL)-/.test(String(so || '')); }
  /* Same test the live No SO Yet tab uses: the reference, not o.source, so it
     clears the moment set-so swaps the DROP- ref for the real SO. */
  /* noSoExpected on an order that was stamped for a roll-up (rollCode, 385cc58) only hid it
     from /classic — it does not make it a drop-only customer, so it still needs an SO. */
  function noSo(o) { return isPlaceholder(o.so) && !(o.noSoExpected && !o.rollCode); }
  function ageDays(iso, now) {
    const d = new Date(String(iso || '') + 'T00:00:00');
    if (isNaN(d)) return 0;
    return Math.max(0, Math.floor(((now || Date.now()) - d.getTime()) / 86400000));
  }
  function isAged(o, now) { return o.status === 'open' && !o.keepOpen && ageDays(o.date, now) > AGED_DAYS; }

  /* ---------- customers ---------- */
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function findCustomer(customers, code) {
    const c = String(code || '').trim().toUpperCase();
    return c ? (customers || []).find(x => String(x.code || '').toUpperCase() === c) || null : null;
  }
  /* Typed text that is EXACTLY a code, name or alias (ignoring case/punctuation).
     Strict on purpose: "chubb" matches the alias, "chubb fire alarms ltd" does not. */
  function matchTyped(customers, text) {
    const t = norm(text);
    if (!t) return null;
    for (const c of customers || []) {
      if (norm(c.code) === t) return { customer: c, by: 'code' };
      if (norm(c.name) === t) return { customer: c, by: 'name' };
      if ((c.aliases || []).some(a => norm(a) === t)) return { customer: c, by: 'alias' };
    }
    return null;
  }
  /* Suggestions for the /count picker — substring on code, name or alias. */
  function suggest(customers, text, max) {
    const t = norm(text);
    if (!t) return [];
    return (customers || []).filter(c =>
      norm(c.code).includes(t) || norm(c.name).includes(t) || (c.aliases || []).some(a => norm(a).includes(t))
    ).slice(0, max || 6);
  }
  /* How a new drop-off is attributed. Picked from the list = trusted. Typed text that
     only matches = flagged for Rec Admin to confirm. No match = today's behaviour. */
  function classifyDropoff(customers, pickedCode, typed) {
    const picked = findCustomer(customers, pickedCode);
    if (picked) return { customer: picked, match: 'picked', roll: picked.billing === 'monthly' };
    const m = matchTyped(customers, typed);
    if (m && m.customer.billing === 'monthly') return { customer: m.customer, match: 'alias', roll: true };
    return { customer: null, match: null, roll: false };
  }
  /* Aliases added after the store was seeded. Applied once, additively, to the live record:
     an alias only ever widens 'needs Confirm' matching, it never makes an order trusted. */
  const ALIAS_ADDS = [{ code: 'CNI0222', alias: 'chubby fire and security ltd', why: 'David confirmed DROP-2026-0002 is Chubb (26/10/2026)' }];
  function addAliases(customers) {
    let n = 0;
    ALIAS_ADDS.forEach(a => { const c = findCustomer(customers, a.code);
      if (c && !(c.aliases || []).some(x => norm(x) === norm(a.alias))) { c.aliases = (c.aliases || []).concat(a.alias); (c.aliasLog = c.aliasLog || []).push({ alias: a.alias, why: a.why }); n++; } });
    return n;
  }
  function seedCustomers(config) {
    const out = [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire', 'chubby fire and security ltd'],
      billing: 'monthly', history: [], note: '' }];
    ((config && config.monthlyCustomers) || []).forEach(m => {
      if (out.some(c => c.code && c.code === m.code && m.code)) return;
      out.push({ code: m.code || '', name: m.name || m.match || '', aliases: m.match ? [m.match] : [],
        billing: 'per-order', history: [], note: 'previously tagged monthly in config' });
    });
    return out;
  }

  /* ---------- roll-ups ---------- */
  /* 'member' = counts towards the open roll-up; 'pending' = alias match waiting for
     Confirm (excluded until then); null = not on a roll-up. */
  /* ---------- roll-up membership (derived, never stored) ----------
     While a customer is on Monthly rolling, EVERY open order of theirs belongs to the
     open roll-up: NetSuite SOs and drop-offs, whenever they were created, whether they
     are still being counted, waiting for an SO or fully counted. Not members: orders
     already on a pack (rollupId), WTN sent, invoiced, or archived (90+ days uncounted).
     Membership is worked out from the customer list every time, so switching billing
     pulls orders in or puts them back with nothing written to the orders themselves.
     Strict matching, because a mix-up bills the wrong customer:
       trusted  picked from the list on /count, or a NetSuite order whose company name
                (or code) equals the account exactly, ignoring case, punctuation, Ltd/Limited
       confirm  anything typed on the tablet (drop-offs) that matches the name or code,
                and any alias match — excluded from Process until Rec Admin confirms
       none     no match: stays per order
     "Not <code>" (rollRejectCode) takes an order off that account for good. */
  function companyNorm(s) { return norm(String(s || '').replace(/&/g, ' and ')).replace(/\b(ltd|limited)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function rejectedCode(o) {
    if (o.rollRejectCode) return o.rollRejectCode;
    return (o.rollOutAt && /^rejected/.test(o.rollOutWhy || '')) ? o.rollCode : null;   // 385cc58 data
  }
  function rollMatch(o, customers, now) {
    if (!o || o.rollVoidAt || o.rollupId || o.invoicedAt || o.wtnSentAt) return null;
    if (isAged(o, now) && !hasBilled(o)) return null;   // part-billed: stays until Finish, never drops into Archive
    const rej = rejectedCode(o), typed = !!o.dropOff || o.source === 'unmatched' || o.source === 'moved';
    const cn = companyNorm(o.cust), n = norm(o.cust);
    for (const c of customers || []) {
      if (c.billing !== 'monthly' || !c.code || rej === c.code) continue;
      let trust = null;
      if (o.custCode === c.code && o.custMatch === 'picked') trust = 'trusted';
      else if (cn && (cn === companyNorm(c.name) || n === norm(c.code))) trust = typed ? 'confirm' : 'trusted';
      else if (n && (c.aliases || []).some(a => norm(a) === n || companyNorm(a) === cn)) trust = 'confirm';
      if (!trust) continue;
      if (trust === 'confirm' && o.rollConfirmedAt && (o.rollConfirmCode || o.rollCode) === c.code) trust = 'trusted';
      return { code: c.code, trust };
    }
    return null;
  }
  /* 'member' = trusted on the open roll-up; 'pending' = waiting for Confirm; null = not on one. */
  function rollState(o, customers, now) {
    const m = rollMatch(o, customers, now);
    return m ? (m.trust === 'trusted' ? 'member' : 'pending') : null;
  }
  function stageOf(o, now, customers) {
    if (o.rollVoidAt) return 'removed';            // empty drop-off taken off a roll-up (kept, audited)
    if (rollState(o, customers, now)) return 'monthly';
    if (o.rollupId) return 'rolled';
    if (o.status === 'open') return isAged(o, now) ? 'archive' : 'awaiting';
    if (noSo(o)) return 'noso';
    if (o.invoicedAt) return 'processed';
    if (o.wtnSentAt) return 'wtn';
    return 'counted';
  }
  function rollupStage(r) {
    if (!r || r.voidedAt) return 'void';
    if (r.processedAt) return 'processed';
    if (r.sentAt) return 'wtn';
    return 'pack';
  }
  /* The open roll-up for one account: confirmed visits (counted or still counting),
     visits waiting for Confirm, and the ones a Process click would take now. */
  function openRollup(orders, code, customers, now) {
    const mine = (orders || []).map(o => ({ o, m: rollMatch(o, customers, now) })).filter(x => x.m && x.m.code === code);
    const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id - b.id;
    const members = mine.filter(x => x.m.trust === 'trusted').map(x => x.o).sort(byDate);
    const pending = mine.filter(x => x.m.trust === 'confirm').map(x => x.o).sort(byDate);
    /* Monthly accounts bill every crate counted, not whole orders: a confirmed member with
       any crate not yet on a pack is ready, complete or part-counted. */
    const ready = members.filter(o => unbilled(o).length);
    return { code, members, pending, ready,
      empty: members.filter(o => !(o.counts || []).length),                         // nothing counted: not billable
      billedOpen: members.filter(o => (o.counts || []).length && !unbilled(o).length) };   // all billed, still open
  }
  /* ---------- per-crate billing ----------
     Each crate entry (order.counts[i]) records the pack that billed it in packId. Packs
     from 385cc58 billed whole orders (order.rollupId) — their entries count as billed too. */
  function entryPack(o, c) { return (c && c.packId) || (o && o.rollupId) || null; }
  function unbilled(o) { return (o.counts || []).filter(c => !entryPack(o, c)); }
  function billedOn(o, packId) { return (o.counts || []).filter(c => entryPack(o, c) === packId); }
  function hasBilled(o) { return (o.counts || []).some(c => entryPack(o, c)); }
  function crateN(c) { return c.crateTo ? (c.crateTo - c.crateFrom + 1) : 1; }
  function entriesCrates(list) { return (list || []).reduce((a, c) => a + crateN(c), 0); }
  function entriesUnits(list) { return (list || []).reduce((a, c) => a + (c.lines || []).reduce((s, l) => s + (Number(l.q) || 0), 0), 0); }
  /* The rows the Defra receipt of waste export should see. Receipt reporting is by when the
     waste came in, never by billing, so Process can never change a filed return:
       one row per order per count day, dated by that day's crate entries (the export dates a
       row by its last entry), under the order's OWN WTN — the season WTN only rides along as
       seasonWtn for reference. Open orders are included as soon as they have a WTN; drop-offs
       and monthly-roll-up orders get theirs on their first counted crate. */
  function countDay(c) { return String((c && c.when) || '').split(',')[0].trim(); }
  function defraOrders(orders, rollups) {
    const packs = new Map((rollups || []).filter(r => !r.voidedAt && r.wtn).map(r => [r.id, r.wtn]));
    const out = [];
    (orders || []).forEach(o => {
      if (!o.wtn || o.rollVoidAt || !(o.counts || []).length) return;
      const days = new Map();
      o.counts.forEach(c => { const d = countDay(c) || 'undated'; (days.get(d) || days.set(d, []).get(d)).push(c); });
      if (days.size === 1) { const only = [...days.values()][0]; out.push(Object.assign({}, o, { seasonWtn: packs.get(entryPack(o, only[0])) || null })); return; }
      days.forEach((counts, d) => out.push(Object.assign({}, o, { counts, crates: entriesCrates(counts), defraDay: d,
        seasonWtn: [...new Set(counts.map(c => packs.get(entryPack(o, c))).filter(Boolean))].join(', ') || null })));
    });
    return out;
  }
  function countedCrates(o) { return (o.counts || []).reduce((a, c) => a + (c.crateTo ? (c.crateTo - c.crateFrom + 1) : 1), 0); }
  function orderUnits(o) { return (o.counts || []).reduce((a, c) => a + (c.lines || []).reduce((s, l) => s + (Number(l.q) || 0), 0), 0); }
  /* What a billing switch would move, by the stage each order is in now. */
  function movesOnToggle(orders, customers, code, to, now) {
    const after = (customers || []).map(c => c.code === code ? Object.assign({}, c, { billing: to }) : c);
    const by = {}; let total = 0;
    (orders || []).forEach(o => {
      const was = stageOf(o, now, customers), will = stageOf(o, now, after);
      if (was === will || (was !== 'monthly' && will !== 'monthly')) return;
      const k = to === 'monthly' ? was : will; by[k] = (by[k] || 0) + 1; total++;
    });
    return { total, by };
  }

  /* ---------- admin key ---------- */
  function adminCheck(adminKey, supplied, safeEqual) {
    if (!adminKey) return { ok: false, status: 403, error: 'Set ADMIN_KEY on Render to enable changes' };
    const s = String(supplied || '');
    const same = safeEqual ? safeEqual(adminKey, s) : adminKey === s;
    return same ? { ok: true } : { ok: false, status: 403, error: 'Admin key not accepted' };
  }

  return { AGED_DAYS, STAGES, isPlaceholder, noSo, ageDays, isAged, norm, findCustomer, matchTyped, suggest,
    classifyDropoff, seedCustomers, addAliases, companyNorm, rollMatch, rollState, stageOf, rollupStage, openRollup,
    movesOnToggle, countedCrates, orderUnits, entryPack, unbilled, billedOn, hasBilled, entriesCrates, entriesUnits, defraOrders, adminCheck };
});
