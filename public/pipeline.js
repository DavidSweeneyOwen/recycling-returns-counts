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
  function noSo(o) { return isPlaceholder(o.so) && !o.noSoExpected; }
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
  function seedCustomers(config) {
    const out = [{ code: 'CNI0222', name: 'Chubb Fire and Security Ltd', aliases: ['chubb', 'chubb fire'],
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
  function rollState(o) {
    if (!o || !o.rollCode || o.rollupId || o.rollOutAt || o.invoicedAt) return null;
    return (o.custMatch === 'picked' || o.rollConfirmedAt) ? 'member' : 'pending';
  }
  function stageOf(o, now) {
    if (rollState(o)) return 'monthly';
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
  function openRollup(orders, code) {
    const mine = (orders || []).filter(o => o.rollCode === code && rollState(o));
    const members = mine.filter(o => rollState(o) === 'member');
    const pending = mine.filter(o => rollState(o) === 'pending');
    const ready = members.filter(o => o.status === 'done');
    const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id - b.id;
    return { code, members: members.sort(byDate), pending: pending.sort(byDate), ready: ready.sort(byDate) };
  }

  /* ---------- admin key ---------- */
  function adminCheck(adminKey, supplied, safeEqual) {
    if (!adminKey) return { ok: false, status: 403, error: 'Set ADMIN_KEY on Render to enable changes' };
    const s = String(supplied || '');
    const same = safeEqual ? safeEqual(adminKey, s) : adminKey === s;
    return same ? { ok: true } : { ok: false, status: 403, error: 'Admin key not accepted' };
  }

  return { AGED_DAYS, STAGES, isPlaceholder, noSo, ageDays, isAged, norm, findCustomer, matchTyped, suggest,
    classifyDropoff, seedCustomers, rollState, stageOf, rollupStage, openRollup, adminCheck };
});
