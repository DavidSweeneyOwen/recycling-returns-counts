/* Stub of the GitHub API that reproduces the >1MB behaviour: the contents endpoint
   returns metadata with EMPTY content (exactly as GitHub does past 1,048,576 bytes)
   and the real bytes are only available from the blobs endpoint as raw.
   Used to prove server.js reads the store correctly at that size, with no token. */
'use strict';
const http = require('http');
const orders = [];
for (let i = 1; i <= 3028; i++) {
  orders.push({ id: i, so: 'SO' + (800000 + i) + 'C', cust: 'Customer ' + (i % 400),
    date: '2026-08-01', by: 'Sarah', crates: 2,
    counts: i <= 40 ? [{ crateFrom: 1, crateTo: 2, by: 'Lee', when: '10/09/2026, 09:00',
      lines: [{ p: 'Water 6L', q: 4 }] }] : [],
    status: i <= 40 ? 'done' : 'open', wtn: i <= 40 ? 'WTN-2026-' + i : null,
    invoicedAt: i <= 25 ? '10/09/2026' : null, finalSo: null, source: 'netsuite',
    padding: 'x'.repeat(220) });
}
for (let i = 1; i <= 78; i++) orders.push({ id: 4000 + i, so: 'DROP-2026-' + String(i).padStart(4, '0'),
  cust: 'Drop Customer ' + (i % 12), date: '2026-09-10', by: 'Lee', crates: 1, counts: [],
  status: 'open', wtn: null, finalSo: null, source: 'dropoff', dropOff: true });

const BODY = JSON.stringify({ orders, seq: 4078, wtnSeq: { 2026: 40 },
  lastSync: { when: '11/09/2026, 09:26', ok: true, msg: 'stub' } });
const SHA = 'deadbeefcafe';
console.log('[stub] store payload is ' + BODY.length.toLocaleString() + ' bytes (limit 1,048,576)');

http.createServer((req, res) => {
  if (req.method === 'GET' && /\/contents\/data\.json/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    /* GitHub's actual behaviour over 1MB: metadata, empty content, encoding "none" */
    return res.end(JSON.stringify({ name: 'data.json', sha: SHA, size: BODY.length,
      content: '', encoding: 'none' }));
  }
  if (req.method === 'GET' && req.url.includes('/git/blobs/' + SHA)) {
    if ((req.headers.accept || '') !== 'application/vnd.github.raw') {
      res.writeHead(415); return res.end('{}');           // must ask for raw
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(BODY);
  }
  if (req.method === 'PUT' && /\/contents\/data\.json/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ content: { sha: SHA } }));
  }
  res.writeHead(404); res.end('{}');
}).listen(8199, () => console.log('[stub] listening on 8199'));
