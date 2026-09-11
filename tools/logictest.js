/* Exercise the new client-side classifiers (noSo / isAged / likelyDuplicate)
   straight out of dashboard.js, against the live /api/state of the test server. */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const APP = process.argv[2];
const src = fs.readFileSync(path.join(APP, 'public/dashboard.js'), 'utf8');

const grab = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const code = ['ageDays','lastCountDate','noSo','dmy','likelyDuplicate'].map(grab).join('\n')
  + '\nconst AGED_DAYS=90;\nfunction isAged(o){return o.status===\'open\'&&!o.keepOpen&&ageDays(o.date)>AGED_DAYS;}\n';

http.get('http://localhost:8123/api/state', r => {
  let b = ''; r.on('data', d => b += d); r.on('end', () => {
    const state = JSON.parse(b);
    const f = new Function('STATE', code + `
      return {
        noSo: STATE.orders.filter(noSo).map(o=>o.so),
        aged: STATE.orders.filter(isAged).map(o=>o.so),
        awaiting: STATE.orders.filter(o=>o.status==='open'&&!isAged(o)).map(o=>o.so),
        counted: STATE.orders.filter(o=>o.status==='done').map(o=>o.so),
        dupes: STATE.orders.filter(noSo).map(o=>{const d=likelyDuplicate(o);return d?o.so+' ~ '+d.so+' ('+d.cust+')':null;}).filter(Boolean)
      };`)(state);
    console.log('  No SO Yet tab :', f.noSo.join(', ') || '(none)');
    console.log('  Archive tab   :', f.aged.join(', ') || '(none)');
    console.log('  Awaiting tab  :', f.awaiting.join(', ') || '(none)');
    console.log('  Counted tab   :', f.counted.join(', ') || '(none)');
    console.log('  Duplicates    :', f.dupes.join(' | ') || '(none flagged)');
    const bad = [];
    if (!f.aged.length) bad.push('the 140-day-old collection was not archived');
    if (f.aged.some(so => state.orders.find(o => o.so === so && o.keepOpen)))
      bad.push('a kept-open collection is still being archived');
    if (!f.noSo.includes('DROP-2026-0002')) bad.push('unmatched drop-off missing from No SO Yet');
    if (f.noSo.includes('SO824039C')) bad.push('a matched drop-off is still showing as unmatched');
    if (f.counted.length !== 3) bad.push('Counted should hold all 3 counted collections, got ' + f.counted.length);
    if (!f.dupes.length) bad.push('the Mitie duplicate was not flagged');
    console.log(bad.length ? '\n  FAILED: ' + bad.join('; ') : '\n  LOGIC CHECKS PASSED');
    process.exit(bad.length ? 1 : 0);
  });
}).on('error', e => { console.log('server not up:', e.message); process.exit(1); });
