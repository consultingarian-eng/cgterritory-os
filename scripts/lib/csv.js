'use strict';
// Minimal RFC-4180 CSV parser shared by the import scripts. Spreadsheets
// quote any field holding a comma ("6,436" households), so a plain split()
// would shift columns.

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = String(text).replace(/^﻿/, '');   // Excel's byte-order mark
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}

// Rows as objects keyed by lower-cased, trimmed header.
function readCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

module.exports = { parseCsv, readCsvObjects };
