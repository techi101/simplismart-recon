// Small RFC 4180 style CSV parser (quoted fields, escaped quotes, CRLF).
// Returns an array of objects keyed by the trimmed, lower-cased header row.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (rows.length === 0) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); });
    return o;
  });
}

export function toCSV(records, columns) {
  const cols = columns ?? (records[0] ? Object.keys(records[0]) : []);
  const esc = v => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [cols.join(','), ...records.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}
