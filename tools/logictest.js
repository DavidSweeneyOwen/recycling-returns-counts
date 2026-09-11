/* Runs the dashboard's own classifiers against a live /api/state and checks the
   invariants that decide which tab a collection lands on. Data-independent — point
   it at any running instance. Usage: node tools/logictest.js <app path> [port] */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const APP = process.argv[2] || '.';
const PORT = process.argv[3] || 8123;
const src = fs.readFileSync(path.join(APP, 'public/dashboard.js'), 'utf8');

const grab = name => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found in dashboard.js: ' + name);
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
    const state = JSON.parse(b);
    const f = new Function('STATE', code)(state);
    const by = so => state.orders.find(o => o.so === so) || {};
    const show = (label, list) => console.log('  ' + label.padEnd(14) + ': ' + (list.join(', ') || '(none)'));
    show('Awaiting', f.awaiting); show('Counted', f.counted); show('Invoiced', f.inv);
    show('No SO Yet', f.noso); show('Archive', f.aged);
    show('Mergeable', f.mergeable); show('Duplicates', f.dupes);

    const bad = [];
    f.noso.filter(so => by(so).noSoExpected).forEach(so =>
      bad.push(so + ' is marked drop-off only but still sits in No SO Yet'));
    f.noso.filter(so => !/^DROP-/.test(so)).forEach(so =>
      bad.push(so + ' has a real SO but still sits in No SO Yet'));
    f.counted.filter(so => by(so).invoicedAt).forEach(so =>
      bad.push(so + ' is invoiced but still sits on Counted'));
    state.orders.filter(o => o.status === 'done' && o.invoicedAt).forEach(o =>
      f.inv.includes(o.so) || bad.push(o.so + ' is invoiced but missing from the Invoiced tab'));
    f.aged.filter(so => by(so).keepOpen).forEach(so =>
      bad.push(so + ' was kept open but is still being archived'));
    f.aged.filter(so => by(so).status !== 'open').forEach(so =>
      bad.push(so + ' is counted but sits in Archive'));
    f.awaiting.concat(f.aged).filter(so => by(so).status !== 'open').forEach(so =>
      bad.push(so + ' is not open but shows as awaiting'));
    const seen = {};
    for (const tab of ['awaiting','counted','inv','aged'])
      f[tab].forEach(so => { (seen[so] = seen[so] || []).push(tab); });
    Object.entries(seen).filter(([, t]) => t.length > 1).forEach(([so, t]) =>
      bad.push(so + ' appears on more than one tab: ' + t.join(' + ')));

    console.log(bad.length ? '\n  FAILED:\n   - ' + bad.join('\n   - ') : '\n  ALL CLASSIFICATION CHECKS PASSED');
    process.exit(bad.length ? 1 : 0);
  });
}).on('error', e => { console.log('server not up on ' + PORT + ':', e.message); process.exit(1); });
