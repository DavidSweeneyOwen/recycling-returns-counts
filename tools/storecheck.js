/* Reads the live data store exactly the way server.js does, and reports what came
   back. Read-only — makes no writes and prints no token. Catches the failure mode
   that wiped the store on 11/09/2026: data.json growing past the 1MB the GitHub
   contents API will inline.
   Usage: node tools/storecheck.js   (needs GH_DATA_REPO and GH_TOKEN in the env) */
'use strict';
const GH_REPO = (process.env.GH_DATA_REPO || '').trim()
  .replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_BRANCH = process.env.GH_DATA_BRANCH || 'main';
const GH_API = 'https://api.github.com';
if (!GH_REPO || !GH_TOKEN) { console.log('set GH_DATA_REPO and GH_TOKEN first'); process.exit(1); }

const H = extra => Object.assign({
  'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'recycling-returns' }, extra);

(async () => {
  const meta = await fetch(`${GH_API}/repos/${GH_REPO}/contents/data.json?ref=${GH_BRANCH}`,
    { headers: H({ 'Accept': 'application/vnd.github+json' }) });
  console.log('contents API      : HTTP ' + meta.status);
  if (meta.status !== 200) { console.log('  cannot read the store'); process.exit(1); }
  const j = await meta.json();
  console.log('reported size     : ' + j.size.toLocaleString() + ' bytes');
  console.log('inline limit      : 1,048,576 bytes');
  console.log('content inlined   : ' + (j.content ? 'yes' : 'NO — must be read as a raw blob'));

  let text;
  if (j.content && j.encoding === 'base64') text = Buffer.from(j.content, 'base64').toString('utf8');
  else {
    const blob = await fetch(`${GH_API}/repos/${GH_REPO}/git/blobs/${j.sha}`,
      { headers: H({ 'Accept': 'application/vnd.github.raw' }) });
    console.log('raw blob fetch    : HTTP ' + blob.status);
    if (blob.status !== 200) { console.log('  BLOB READ FAILED — the app would go read-only'); process.exit(1); }
    text = await blob.text();
  }
  const d = JSON.parse(text);
  const o = d.orders || [];
  console.log('parsed            : ' + text.length.toLocaleString() + ' bytes, ' + o.length + ' orders');
  console.log('  counted         : ' + o.filter(x => x.status === 'done').length);
  console.log('  of those invoiced: ' + o.filter(x => x.status === 'done' && x.invoicedAt).length);
  console.log('  drop-offs       : ' + o.filter(x => /^DROP-|^MANUAL-/.test(x.so)).length);
  console.log('  last sync       : ' + JSON.stringify(d.lastSync));
  console.log(Array.isArray(d.orders) && o.length ? '\nSTORE READS CORRECTLY' : '\nSTORE LOOKS EMPTY — do not let the app write');
})().catch(e => { console.log('failed: ' + e.message); process.exit(1); });
