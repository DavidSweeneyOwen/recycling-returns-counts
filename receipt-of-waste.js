/* =========================================================================
   Defra "Report receipt of waste" export
   Fills Defra's own spreadsheet (assets/receipt-of-waste-template.xlsx) from
   the waste transfer notes this app has issued — one movement row and one
   item row per WTN — and hands back a ready-to-upload .xlsx.

   Defra's guidance tab is explicit: do not change the formatting, do not copy
   onto a blank sheet. So nothing here builds a workbook. The template is
   opened as the zip it is, values are dropped into the existing cells of the
   two entry tabs (keeping every cell's own style), and every other part of
   the file is passed through byte-for-byte.

   Zero dependencies, like the rest of the app — the zip reader/writer below
   needs only Node's zlib.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* The template ships with rows 9-338 formatted and validated on BOTH entry
   tabs. Staying inside them means the file never has to be restructured; a
   longer date range is split into several files instead. */
const FIRST_ROW = 9;
const ROWS_PER_FILE = 330;
const MOVEMENT_SHEET = '7. Waste movement level';
const ITEM_SHEET = '8. Waste item level';

/* ---------------- minimal zip ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* Entries keep their original compressed bytes, so untouched parts are written
   back exactly as Defra shipped them. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.push({ name, method, crc, usize, raw: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}
function entryText(e) {
  return (e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw)).toString('utf8');
}
function setEntryText(e, text) {
  const data = Buffer.from(text, 'utf8');
  e.method = 8; e.crc = crc32(data); e.usize = data.length;
  e.raw = zlib.deflateRawSync(data, { level: 6 });
}
function writeZip(entries) {
  const parts = [], dir = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);   // 1980-01-01, as the template
    lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.raw.length, 18); lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.raw.length, 20); ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, e.raw);
    dir.push(ch, name);
    offset += 30 + name.length + e.raw.length;
  }
  const dirBuf = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

/* ---------------- template ---------------- */
let TEMPLATE = null;   // { file, mtime, entries, movementPart, itemPart }
function loadTemplate(file) {
  const mtime = fs.statSync(file).mtimeMs;
  if (TEMPLATE && TEMPLATE.file === file && TEMPLATE.mtime === mtime) return TEMPLATE;
  const entries = readZip(fs.readFileSync(file));
  const byName = n => entries.find(e => e.name === n);
  const wb = byName('xl/workbook.xml'), rels = byName('xl/_rels/workbook.xml.rels');
  if (!wb || !rels || !byName('xl/sharedStrings.xml')) throw new Error('template is not an Excel workbook');
  const wbXml = entryText(wb), relXml = entryText(rels);
  const partFor = sheetName => {
    const s = new RegExp('<sheet\\b[^>]*name="' + sheetName.replace(/[.]/g, '\\.') + '"[^>]*r:id="([^"]+)"').exec(wbXml);
    if (!s) throw new Error('template has no "' + sheetName + '" tab — is this the Defra receipt of waste spreadsheet?');
    const r = new RegExp('<Relationship\\b[^>]*Id="' + s[1] + '"[^>]*Target="([^"]+)"').exec(relXml)
           || new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + s[1] + '"').exec(relXml);
    if (!r) throw new Error('template is missing the sheet for "' + sheetName + '"');
    return 'xl/' + r[1].replace(/^\/?xl\//, '');
  };
  TEMPLATE = { file, mtime, entries, movementPart: partFor(MOVEMENT_SHEET), itemPart: partFor(ITEM_SHEET) };
  return TEMPLATE;
}

/* ---------------- cell writing ---------------- */
function xmlEsc(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function colNum(c) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

/* Appends to the workbook's shared string table, the same way Excel stores typed text. */
function stringTable(xml) {
  const head = /<sst\b[^>]*>/.exec(xml)[0];
  let unique = Number((/uniqueCount="(\d+)"/.exec(head) || [])[1] || 0);
  let total = Number((/\bcount="(\d+)"/.exec(head) || [])[1] || 0);
  const seen = new Map(), added = [];
  return {
    ref(text) {
      total++;
      if (seen.has(text)) return seen.get(text);
      const i = unique++;
      seen.set(text, i);
      added.push('<si><t' + (/^\s|\s$/.test(text) ? ' xml:space="preserve"' : '') + '>' + xmlEsc(text) + '</t></si>');
      return i;
    },
    xml() {
      const newHead = head.replace(/uniqueCount="\d+"/, 'uniqueCount="' + unique + '"').replace(/\bcount="\d+"/, 'count="' + total + '"');
      return xml.replace(head, newHead).replace('</sst>', added.join('') + '</sst>');
    }
  };
}

/* rows: Map(rowNumber -> { COL: value }). A string becomes text, a number a number,
   null clears whatever the template had in that cell. Styles are never touched. */
function fillSheet(xml, rows, sst) {
  return xml.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (whole, r, attrs, inner) => {
    const values = rows.get(Number(r));
    if (!values) return whole;
    const cells = [];
    inner.replace(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, col, cAttrs, body) => {
      cells.push({ col, attrs: cAttrs.replace(/\/$/, ''), body: body || '' });
      return m;
    });
    for (const col of Object.keys(values)) {
      const v = values[col];
      let cell = cells.find(c => c.col === col);
      if (!cell) {
        if (v == null || v === '') continue;
        /* the template leaves the odd cell undefined — give it its neighbour's style */
        const n = colNum(col);
        const near = cells.slice().sort((a, b) => Math.abs(colNum(a.col) - n) - Math.abs(colNum(b.col) - n))[0];
        const style = near ? (/\ss="\d+"/.exec(near.attrs) || [''])[0] : '';
        cell = { col, attrs: style, body: '' };
        cells.push(cell);
        cells.sort((a, b) => colNum(a.col) - colNum(b.col));
      }
      const style = (/\ss="\d+"/.exec(cell.attrs) || [''])[0];
      if (v == null || v === '') { cell.attrs = style; cell.body = ''; }
      else if (typeof v === 'number') { cell.attrs = style; cell.body = '<v>' + v + '</v>'; }
      else { cell.attrs = style + ' t="s"'; cell.body = '<v>' + sst.ref(String(v)) + '</v>'; }
    }
    const out = cells.map(c => '<c r="' + c.col + r + '"' + c.attrs + (c.body ? '>' + c.body + '</c>' : '/>')).join('');
    return '<row r="' + r + '"' + attrs + '>' + out + '</row>';
  });
}

/* ---------------- WTN -> rows ---------------- */
/* "11/06/2026, 16:39" (how the app stamps a count) or an ISO date. */
function parseStamp(s) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (m) return { y: +m[3], mo: +m[2], d: +m[1], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
  return null;
}
/* Same date the printed WTN shows as "Date of Collection": the last count. */
function received(o) {
  const last = o.counts && o.counts.length ? o.counts[o.counts.length - 1].when : null;
  return parseStamp(last) || parseStamp(o.date);
}
const isoDay = t => t ? `${t.y}-${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}` : '';
const excelSerial = t => Number((Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) / 86400000 + 25569).toFixed(10));

/* Section E of the WTN, in words. */
const BOX_LABELS = [['water', 'Water'], ['powder', 'Powder'], ['foam', 'Foam'], ['co2alu5', '5KG CO2 Aluminium'],
  ['co2tall', '2KG CO2 Tall'], ['co2squat', '2KG CO2 Squat'], ['co2steel2', '2KG CO2 Steel'], ['co2steel5', '5KG CO2 Steel']];
function describe(o, wtnTotals) {
  const { t, others } = wtnTotals(o);
  const bits = BOX_LABELS.filter(([k]) => t[k] > 0).map(([k, label]) => `${label} x${t[k]}`);
  if (others.length) bits.push('Other: ' + others.join(', '));
  return 'Used fire extinguishers' + (bits.length ? ' - ' + bits.join('; ') : '');
}
/* Weight is only ever worked out from per-unit weights the office has entered in
   config (receiptOfWaste.unitWeightsKg). A collection containing anything without
   an entered weight gets no figure at all rather than a part-total. */
function weightKg(o, R) {
  const w = R.unitWeightsKg || {};
  let total = 0, any = false;
  for (const c of (o.counts || [])) for (const l of (c.lines || [])) {
    const per = Number(w[l.p]);
    if (!(per > 0)) return null;
    total += per * Number(l.q); any = true;
  }
  return any ? Math.round(total * 100) / 100 : null;
}

function selectOrders(orders, from, to) {
  return (orders || [])
    .filter(o => o && o.wtn)
    .map(o => ({ o, at: received(o) }))
    .filter(x => { const d = isoDay(x.at); return (!from || (d && d >= from)) && (!to || (d && d <= to)); })
    .sort((a, b) => (isoDay(a.at) + String(a.o.wtn)).localeCompare(isoDay(b.at) + String(b.o.wtn)));
}

/* Mandatory answers the WTN does not carry. Left blank until someone who knows
   the site fills them in — never guessed. */
function missingSettings(config) {
  const R = config.receiptOfWaste || {}, out = [];
  if (!R.receiverAuthorisationNumber) out.push("Receiver's authorisation number (site permit)");
  if (/^road$/i.test(R.meansOfTransport || '') && !R.vehicleRegistration) out.push('Vehicle registration number');
  if (!R.meansOfTransport) out.push('Means of transport');
  if (!R.physicalForm) out.push('Physical form of the waste');
  if (!R.unitWeightsKg || !Object.keys(R.unitWeightsKg).length) out.push('Weight per extinguisher (total weight of waste)');
  if (!R.containsPops) out.push('Does the waste contain POPs?');
  if (!R.disposalRecoveryCode) out.push('Disposal / recovery code');
  return out;
}

function summary(orders, config, from, to) {
  const picked = selectOrders(orders, from, to);
  const R = config.receiptOfWaste || {};
  const days = picked.map(x => isoDay(x.at)).filter(Boolean);
  return {
    count: picked.length,
    files: Math.max(1, Math.ceil(picked.length / ROWS_PER_FILE)),
    rowsPerFile: ROWS_PER_FILE,
    first: days[0] || null, last: days[days.length - 1] || null,
    noWeight: picked.filter(x => weightKg(x.o, R) == null).length,
    missing: missingSettings(config)
  };
}

function build(orders, config, opts) {
  const R = config.receiptOfWaste || {};
  const tpl = loadTemplate(path.resolve(opts.appDir, R.template || 'assets/receipt-of-waste-template.xlsx'));
  const picked = selectOrders(orders, opts.from, opts.to);
  const files = Math.max(1, Math.ceil(picked.length / ROWS_PER_FILE));
  const part = Math.min(Math.max(1, parseInt(opts.part, 10) || 1), files);
  const slice = picked.slice((part - 1) * ROWS_PER_FILE, part * ROWS_PER_FILE);
  const ewc = String((config.wtn && config.wtn.ewcCode) || '').replace(/\s+/g, '');   // "No spaces should be added"
  const hazardous = R.hazardous || '';
  const unit = R.weightUnit || 'Kilograms';
  const unitShort = /^kilo/i.test(unit) ? 'kg' : /^gram/i.test(unit) ? 'g' : /^tonne/i.test(unit) ? 't' : unit;

  const movement = new Map(), items = new Map();
  /* the uploaded template had a test reference typed into the first row */
  movement.set(FIRST_ROW, { C: null });
  slice.forEach((x, i) => {
    const o = x.o, row = FIRST_ROW + i, kg = weightKg(o, R);
    movement.set(row, {
      C: o.wtn,
      D: R.siteName, E: R.siteAddress, F: R.sitePostcode,
      G: R.receiverAuthorisationNumber, I: R.receiverEmail, J: R.receiverPhone,
      K: x.at ? excelSerial(x.at) : null,
      M: /^no$/i.test(hazardous) ? R.reasonNoConsignmentCode : '',
      O: config.wtn && config.wtn.carrierRegistration,
      Q: R.carrierName, R: R.carrierAddress, S: R.carrierPostcode, T: R.carrierEmail, U: R.carrierPhone,
      V: R.meansOfTransport, W: R.vehicleRegistration
    });
    items.set(row, {
      B: o.wtn, C: ewc, D: opts.wtnTotals ? describe(o, opts.wtnTotals) : 'Used fire extinguishers',
      E: R.physicalForm, F: Number(o.crates) || null, G: R.containerType,
      H: kg != null ? unit : '', I: kg, J: kg != null ? (R.weightEstimated || 'Yes') : '',
      K: R.containsPops, N: hazardous,
      R: (R.disposalRecoveryCode && kg != null)
        ? `${R.disposalRecoveryCode} = ${kg} = ${unitShort} = ${/^no$/i.test(R.weightEstimated || '') ? 'Actual' : 'Estimate'}` : ''
    });
  });

  const out = tpl.entries.map(e => ({ ...e }));
  const get = n => out.find(e => e.name === n);
  const sst = stringTable(entryText(get('xl/sharedStrings.xml')));
  setEntryText(get(tpl.movementPart), fillSheet(entryText(get(tpl.movementPart)), movement, sst));
  setEntryText(get(tpl.itemPart), fillSheet(entryText(get(tpl.itemPart)), items, sst));
  setEntryText(get('xl/sharedStrings.xml'), sst.xml());

  const span = [opts.from || (slice[0] && isoDay(slice[0].at)) || 'start', opts.to || (slice.length && isoDay(slice[slice.length - 1].at)) || 'today'];
  return {
    buffer: writeZip(out),
    filename: `Receipt-of-waste_${span[0]}_to_${span[1]}${files > 1 ? `_part${part}of${files}` : ''}.xlsx`,
    count: slice.length, total: picked.length, part, files
  };
}

module.exports = { build, summary, ROWS_PER_FILE };
