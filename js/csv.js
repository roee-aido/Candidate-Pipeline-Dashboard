/* Minimal CSV helpers (RFC 4180 style), no dependencies.
 * Generic: they know nothing about leads. app.js maps leads to/from rows.
 */

// Builds CSV text from an array of rows (each row is an array of values).
function toCSV(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  let text = String(value ?? '');
  // Excel runs cells starting with = + - @ as formulas. Prefix an apostrophe,
  // except for plain numbers/phones like "+972-50-1234567".
  if (/^[=+\-@]/.test(text) && !/^[+\-]?[\d\s\-().]+$/.test(text)) {
    text = "'" + text;
  }
  if (/[",\r\n]/.test(text)) {
    text = '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

// Parses CSV text into an array of rows (arrays of strings).
// Handles quoted fields, escaped quotes ("") and line breaks inside quotes.
// The delimiter is detected from the first line: comma or semicolon
// (Excel uses semicolons in some regional settings).
function parseCSV(text) {
  text = text.replace(/^﻿/, ''); // strip UTF-8 BOM
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = countChar(firstLine, ';') > countChar(firstLine, ',') ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  // Drop completely empty lines (e.g. trailing newline, blank rows from Excel).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function countChar(str, ch) {
  return str.split(ch).length - 1;
}

// Reverses the formula-protection apostrophe added by csvCell.
function unprotectCell(text) {
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}
