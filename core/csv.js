// core/csv.js: CSV parsing and writing (RFC 4180: quotes, doubled quotes,
// commas and newlines inside quotes). Used for seed data, bank statement
// imports and every "Download CSV".
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

// Parse CSV text into an array of rows (arrays of strings).
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
}

// Parse CSV with a header row into objects keyed by header.
function parseObjects(text) {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const header = rows[0].map(function (h) { return h.trim(); });
  return rows.slice(1).map(function (r) {
    const o = {};
    header.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

function quote(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Write rows (arrays) or objects (with a header list) as CSV text.
function toCsv(rows, header) {
  const lines = [];
  if (header) {
    lines.push(header.map(quote).join(','));
    rows.forEach(function (o) { lines.push(header.map(function (h) { return quote(o[h]); }).join(',')); });
  } else {
    rows.forEach(function (r) { lines.push(r.map(quote).join(',')); });
  }
  return lines.join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined') module.exports = {
  parseRows,
  parseObjects,
  toCsv,
};
