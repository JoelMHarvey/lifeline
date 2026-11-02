'use strict';

// A small RFC 4180 CSV reader for coordinator imports (people, resources).
// Handles quoted fields with commas, doubled quotes and line breaks inside
// them, CRLF or LF line ends, a leading byte-order mark (Excel adds one),
// and semicolon- or tab-separated files (Excel in many locales, and
// spreadsheet "copy as text"). Returns rows of trimmed strings, skipping
// rows that are entirely empty.

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => firstLine.split('"').filter((_, i) => i % 2 === 0)
    .join('').split(ch).length - 1;
  const scores = [[',', count(',')], [';', count(';')], ['\t', count('\t')]];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ',';
}

function parseCsv(input) {
  const text = String(input || '').replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delim) {
      row.push(field.trim());
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field.trim());
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Header row → { canonical name: column index }, matching each canonical
// field against a list of accepted header spellings (case and punctuation
// ignored), so exports from iCarol or a spreadsheet import as they are.
function mapHeader(header, fields) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const cols = header.map(norm);
  const out = {};
  for (const [name, aliases] of Object.entries(fields)) {
    const idx = cols.findIndex((c) => [name, ...aliases].map(norm).includes(c));
    if (idx !== -1) out[name] = idx;
  }
  const used = new Set(Object.values(out));
  return { map: out, unknown: header.filter((h, i) => !used.has(i) && h) };
}

module.exports = { parseCsv, mapHeader, detectDelimiter };
