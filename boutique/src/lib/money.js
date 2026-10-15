'use strict';

/** Formatage monétaire et calculs entiers.
 *  Le XOF n'a pas de sous-unité : tous les montants sont stockés en FCFA entiers.
 *  Aucun flottant n'est utilisé pour l'argent.
 */

const CURRENCY = 'XOF';
const CURRENCY_LABEL = 'FCFA';

const formatter = new Intl.NumberFormat('fr-FR', {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/** Convertit une saisie utilisateur ("12 500", "12500,50", 12500) en entier FCFA. */
function toCents(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input);
  }
  let s = String(input).trim();
  if (!s) return null;
  // Retire les séparateurs de milliers et symboles usuels.
  s = s
    .replace(/[\u00a0\u202f\u2009\s]/g, '')
    .replace(/(FCFA|F\s?CFA|XOF|€|\$)/gi, '')
    .trim();
  if (!s) return null;
  const negative = /^-/.test(s);
  s = s.replace(/^-/, '');
  // "12500,50" ou "12500.50" : la partie décimale est ignorée (XOF sans décimales)
  // mais une valeur comme "1500,00" doit donner 1500.
  const m = s.match(/^(\d+)(?:[.,](\d+))?$/);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function isValidAmount(v) {
  return Number.isInteger(v) && v >= 0 && v <= 9_000_000_000;
}

/** 12500 -> "12 500 FCFA" */
function format(value, { withCurrency = true } = {}) {
  const n = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return withCurrency ? `${formatter.format(n)} ${CURRENCY_LABEL}` : formatter.format(n);
}

/** 12500 -> "12500" (champ de formulaire) */
function plain(value) {
  const n = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return String(n);
}

function add(...vals) {
  return vals.reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
}

function mul(a, b) {
  return Math.round((Number.isInteger(a) ? a : 0) * (Number.isFinite(b) ? b : 0));
}

/** Répartition d'un montant total sur des parts entières, sans perte ni création de franc. */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0 && i < out.length; i += 1, rest -= 1) out[i] += 1;
  return out;
}

module.exports = {
  CURRENCY,
  CURRENCY_LABEL,
  toCents,
  isValidAmount,
  format,
  plain,
  add,
  mul,
  allocate,
};
