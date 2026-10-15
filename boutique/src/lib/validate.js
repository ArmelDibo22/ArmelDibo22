'use strict';

/**
 * Validation des entrées (formulaires, API, imports).
 * Approche explicite sans dépendance externe : chaque validateur retourne
 * { value } ou lève une ValidationError avec un message en français.
 */

const { stripHtml, normalizeText, slugify } = require('./slug');
const money = require('./money');

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field || null;
    this.status = 400;
  }
}

/** Collecte les erreurs au lieu de lever immédiatement (formulaires). */
class Validator {
  constructor(input = {}, label = '') {
    this.input = input || {};
    this.label = label;
    this.errors = {};
    this.values = {};
  }

  has(field) {
    const v = this.input[field];
    return v !== undefined && v !== null && String(v).trim() !== '';
  }

  raw(field) {
    return this.input[field];
  }

  fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return undefined;
  }

  string(field, opts = {}) {
    const { required = false, min = 0, max = 5000, trim = true, fallback = '', label } = opts;
    let v = this.input[field];
    if (v === undefined || v === null) v = '';
    v = String(v);
    if (trim) v = normalizeText(v);
    if (!v) {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = fallback;
      return fallback;
    }
    if (v.length < min) return this.fail(field, `${label || field} : ${min} caractères minimum.`);
    if (v.length > max) return this.fail(field, `${label || field} : ${max} caractères maximum.`);
    this.values[field] = v;
    return v;
  }

  /** Texte riche : assainissement strict (aucune balise dangereuse conservée). */
  richText(field, opts = {}) {
    const { required = false, max = 20000, label } = opts;
    let v = this.input[field];
    if (v === undefined || v === null) v = '';
    v = sanitizeHtml(String(v));
    if (!stripHtml(v)) {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = '';
      return '';
    }
    if (v.length > max) return this.fail(field, `${label || field} : contenu trop long.`);
    this.values[field] = v;
    return v;
  }

  enum(field, values, opts = {}) {
    const { required = false, fallback = null, label } = opts;
    const v = this.input[field];
    if (v === undefined || v === null || v === '') {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = fallback;
      return fallback;
    }
    if (!values.includes(String(v))) {
      return this.fail(field, `${label || field} : valeur non autorisée.`);
    }
    this.values[field] = String(v);
    return String(v);
  }

  integer(field, opts = {}) {
    const { required = false, min = -Infinity, max = Infinity, fallback = null, allowEmpty = true, label } = opts;
    const raw = this.input[field];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = allowEmpty ? fallback : min > -Infinity ? min : fallback;
      return this.values[field];
    }
    const n = typeof raw === 'number' ? raw : parseInt(String(raw).replace(/\s/g, ''), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return this.fail(field, `${label || field} : nombre entier attendu.`);
    }
    if (n < min) return this.fail(field, `${label || field} : minimum ${min}.`);
    if (n > max) return this.fail(field, `${label || field} : maximum ${max}.`);
    this.values[field] = n;
    return n;
  }

  number(field, opts = {}) {
    const { required = false, min = -Infinity, max = Infinity, fallback = null, label } = opts;
    const raw = this.input[field];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = fallback;
      return fallback;
    }
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(n)) return this.fail(field, `${label || field} : nombre attendu.`);
    if (n < min || n > max) return this.fail(field, `${label || field} : hors limites.`);
    this.values[field] = n;
    return n;
  }

  /** Montant en FCFA : accepte "12 500", 12500, "12500,00". */
  amount(field, opts = {}) {
    const { required = false, min = 0, max = 9_000_000_000, fallback = null, label } = opts;
    const raw = this.input[field];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = fallback;
      return fallback;
    }
    const n = money.toCents(raw);
    if (n === null) return this.fail(field, `${label || field} : montant invalide.`);
    if (n < min) return this.fail(field, `${label || field} : minimum ${money.format(min)}.`);
    if (n > max) return this.fail(field, `${label || field} : montant trop élevé.`);
    this.values[field] = n;
    return n;
  }

  boolean(field, opts = {}) {
    const { fallback = false } = opts;
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === '') {
      this.values[field] = fallback;
      return fallback;
    }
    const v = raw === true || raw === 1 || ['1', 'true', 'on', 'oui', 'yes'].includes(String(raw).toLowerCase());
    this.values[field] = v;
    return v;
  }

  email(field, opts = {}) {
    const { required = false, max = 200, label } = opts;
    const v = this.string(field, { required, max, label: label || 'Adresse e-mail' });
    if (v === undefined) return undefined;
    if (!v) {
      this.values[field] = null;
      return null;
    }
    if (!isEmail(v)) return this.fail(field, `${label || 'Adresse e-mail'} : format invalide.`);
    this.values[field] = v.toLowerCase();
    return v.toLowerCase();
  }

  /** Téléphone ivoirien / international : normalisé en +225XXXXXXXXXX. */
  phone(field, opts = {}) {
    const { required = false, label } = opts;
    const v = this.string(field, { required, max: 40, label: label || 'Téléphone' });
    if (v === undefined) return undefined;
    if (!v) {
      this.values[field] = '';
      return '';
    }
    const norm = normalizePhone(v);
    if (!norm) return this.fail(field, `${label || 'Téléphone'} : numéro invalide. Format attendu : 07 58 11 38 57 ou +225 07 58 11 38 57.`);
    this.values[field] = norm;
    return norm;
  }

  date(field, opts = {}) {
    const { required = false, endOfDay = false, label } = opts;
    const raw = this.input[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (required) return this.fail(field, `${label || field} est obligatoire.`);
      this.values[field] = null;
      return null;
    }
    const iso = require('./dates').fromInput(raw, { endOfDay });
    if (!iso) return this.fail(field, `${label || field} : date invalide.`);
    this.values[field] = iso;
    return iso;
  }

  slug(field, opts = {}) {
    const v = this.string(field, { max: 100, ...opts });
    if (v === undefined) return undefined;
    this.values[field] = v ? slugify(v) : '';
    return this.values[field];
  }

  url(field, opts = {}) {
    const { required = false, max = 1200, label } = opts;
    const v = this.string(field, { required, max, label: label || 'Lien' });
    if (v === undefined) return undefined;
    if (!v) {
      this.values[field] = '';
      return '';
    }
    if (!/^https?:\/\/[^\s]+$/i.test(v)) return this.fail(field, `${label || 'Lien'} : adresse http(s) attendue.`);
    this.values[field] = v;
    return v;
  }

  json(field, fallback = {}) {
    const raw = this.input[field];
    if (raw === undefined || raw === null || raw === '') {
      this.values[field] = fallback;
      return fallback;
    }
    if (typeof raw === 'object') {
      this.values[field] = raw;
      return raw;
    }
    try {
      const parsed = JSON.parse(raw);
      this.values[field] = parsed;
      return parsed;
    } catch {
      this.values[field] = fallback;
      return fallback;
    }
  }

  get valid() {
    return Object.keys(this.errors).length === 0;
  }

  throwIfInvalid(context = '') {
    if (this.valid) return this.values;
    const first = Object.values(this.errors)[0];
    const err = new ValidationError(context ? `${context} : ${first}` : first, Object.keys(this.errors)[0]);
    err.errors = this.errors;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation téléphone Côte d'Ivoire (plan de numérotation à 10 chiffres)
/* ------------------------------------------------------------------ */
function normalizePhone(input) {
  let s = String(input || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    // Numéro local ivoirien : 0X XX XX XX XX (10 chiffres) ou 8 chiffres historiques
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) return `+225${digits}`;
    if (digits.length === 8) return `+2250${digits}`; // ancien format -> préfixe 0
    return '';
  }
  const digits = s.slice(1);
  if (digits.length < 8 || digits.length > 15) return '';
  return `+${digits}`;
}

/** +2250758113857 -> "+225 07 58 11 38 57" */
function formatPhone(e164) {
  const s = String(e164 || '').replace(/\D/g, '');
  if (!s) return '';
  if (s.startsWith('225') && s.length === 13) {
    const n = s.slice(3);
    return `+225 ${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8, 10)}`;
  }
  return `+${s}`;
}

function isEmail(v) {
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(String(v || '').trim());
}

/* ------------------------------------------------------------------ */
/* Assainissement HTML (liste blanche)                                 */
/* ------------------------------------------------------------------ */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4',
  'blockquote', 'code', 'pre', 'span', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr',
]);
const ALLOWED_ATTRS = { a: new Set(['href', 'title', 'rel', 'target']) };

function sanitizeHtml(input) {
  let html = String(input || '');
  // Supprime les blocs exécutables ou de style.
  html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|form|input|button)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|form|input|button)[^>]*\/?\s*>/gi, '');
  // Retire tout attribut de gestionnaire d'événement et javascript:.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return html.replace(/<\/?([a-z0-9]+)((?:\s+[^<>]*?)?)(\/?)>/gi, (match, tagRaw, attrsRaw, selfClose) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const allowed = ALLOWED_ATTRS[tag];
    let attrs = '';
    if (allowed && attrsRaw) {
      const re = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
      let m;
      while ((m = re.exec(attrsRaw))) {
        const name = m[1].toLowerCase();
        const value = (m[3] ?? m[4] ?? '').trim();
        if (!allowed.has(name)) continue;
        if (name === 'href') {
          if (/^\s*javascript:/i.test(value)) continue;
          if (!/^(https?:|mailto:|tel:|\/|#)/i.test(value)) continue;
        }
        attrs += ` ${name}="${value.replace(/"/g, '&quot;')}"`;
      }
    }
    if (tag === 'a' && attrs) attrs += ' rel="noopener noreferrer nofollow"';
    const closing = match.startsWith('</') ? `</${tag}>` : `<${tag}${attrs}${selfClose ? ' /' : ''}>`;
    return closing;
  });
}

module.exports = {
  Validator,
  ValidationError,
  sanitizeHtml,
  normalizePhone,
  formatPhone,
  isEmail,
};
