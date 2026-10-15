'use strict';

/** Identifiants, références lisibles et jetons aléatoires. */

const crypto = require('node:crypto');

/** Jeton aléatoire sûr (URL-safe, non devinable). */
function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Empreinte non réversible d'une donnée personnelle (ex. IP) pour l'anti-abus. */
function fingerprint(value, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex').slice(0, 32);
}

const SEQ_ALPHABET = '0123456789';

/**
 * Référence lisible : PRV-2026-000123.
 * Le compteur est dérivé du nombre de commandes existantes, puis rendu unique
 * par une boucle (garantie par la contrainte UNIQUE en base).
 */
function orderReference(prefix, year, seq) {
  const n = String(seq).padStart(6, '0');
  return `${prefix}-${year}-${n}`;
}

function posReference(prefix, year, seq) {
  return `${prefix}-B${year.slice(2)}-${String(seq).padStart(6, '0')}`;
}

function refundReference(prefix, year, seq) {
  return `${prefix}-R${year.slice(2)}-${String(seq).padStart(5, '0')}`;
}

function newKey(prefix = 'k') {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

/** Clé de fichier média : 2 niveaux de répertoires + nom aléatoire. */
function mediaKey(ext = 'jpg') {
  const id = crypto.randomBytes(12).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}${ext ? `.${ext}` : ''}`;
}

function idempotencyKey(...parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex');
}

module.exports = {
  token,
  hashToken,
  fingerprint,
  orderReference,
  posReference,
  refundReference,
  newKey,
  mediaKey,
  idempotencyKey,
  SEQ_ALPHABET,
};
