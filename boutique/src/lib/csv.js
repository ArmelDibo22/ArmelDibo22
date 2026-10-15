'use strict';

/** Analyseur CSV robuste : guillemets, séparateur détecté, BOM, CRLF. */

const SEPARATORS = [',', ';', '\t', '|'];

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Choisit le séparateur le plus probable en comptant les occurrences hors guillemets. */
function detectSeparator(sample) {
  const counts = SEPARATORS.map((sep) => ({ sep, count: countOutsideQuotes(sample, sep) }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0] && counts[0].count > 0 ? counts[0].sep : ',';
}

function countOutsideQuotes(text, char) {
  let count = 0;
  let inQuotes = false;
  const limit = Math.min(text.length, 20000);
  for (let i = 0; i < limit; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { i += 1; continue; }
      inQuotes = !inQuotes;
    } else if (c === char && !inQuotes) count += 1;
  }
  return count;
}

/**
 * @param {string} text contenu du fichier
 * @param {{separator?:string, hasHeader?:boolean, maxRows?:number}} options
 * @returns {{headers:string[], rows:string[][], separator:string}}
 */
function parse(text, options = {}) {
  const src = stripBom(String(text || ''));
  const separator = options.separator || detectSeparator(src);
  const maxRows = options.maxRows ?? 200000;

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === separator) { row.push(field); field = ''; continue; }
    if (c === '\r') {
      if (src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
      continue;
    }
    if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);

  const hasHeader = options.hasHeader !== false;
  const headers = hasHeader && rows.length
    ? rows[0].map((h, idx) => String(h || '').trim() || `colonne_${idx + 1}`)
    : (rows[0] || []).map((_, idx) => `colonne_${idx + 1}`);
  const body = hasHeader && rows.length ? rows.slice(1) : rows;

  return { headers, rows: body, separator };
}

/** Sérialise des lignes en CSV (RFC 4180) avec BOM pour la compatibilité Excel. */
function stringify(headers, rows, { separator = ';', bom = true } = {}) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n\r]/.test(s) || s.startsWith('=') || s.startsWith('+') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.map(esc).join(separator)];
  for (const row of rows) out.push(headers.map((_, i) => esc(row[i])).join(separator));
  return `${bom ? '\ufeff' : ''}${out.join('\r\n')}\r\n`;
}

/**
 * Neutralise les formules Excel (injection CSV) lors des EXPORTS :
 * un export ouvert dans Excel ne doit pas pouvoir exécuter de formule.
 */
function safeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

module.exports = { parse, stringify, detectSeparator, safeCell, stripBom };
