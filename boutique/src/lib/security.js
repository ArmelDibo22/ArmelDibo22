'use strict';

/**
 * Primitives de sécurité : hachage de mots de passe (scrypt), signatures HMAC,
 * comparaison à temps constant, jetons CSRF.
 *
 * Aucune donnée de carte bancaire n'est manipulée, stockée ni journalisée.
 */

const crypto = require('node:crypto');
const config = require('../config');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return safeEqual(derived, expected);
  } catch {
    return false;
  }
}

function passwordIssues(password) {
  const problems = [];
  if (!password || password.length < 10) problems.push('au moins 10 caractères');
  if (password && !/[A-Za-z]/.test(password)) problems.push('au moins une lettre');
  if (password && !/\d/.test(password)) problems.push('au moins un chiffre');
  if (password && /^(password|motdepasse|12345678|azertyui)/i.test(password)) problems.push('un mot de passe moins évident');
  return problems;
}

function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare quand même pour ne pas révéler la longueur par le temps.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function hmac(value, secret = config.secrets.app) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

/** Valeur signée : `payload.signature` (utilisée pour les cookies non sensibles). */
function sign(value, secret = config.secrets.app) {
  const payload = Buffer.from(String(value)).toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

function unsign(signed, secret = config.secrets.app) {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = signed.slice(0, idx);
  const signature = signed.slice(idx + 1);
  if (!safeEqual(hmac(payload, secret), signature)) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function csrfToken(sessionId) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const mac = hmac(`${sessionId || 'anon'}:${nonce}`, config.secrets.app);
  return `${nonce}.${mac}`;
}

function verifyCsrf(tokenValue, sessionId) {
  if (!tokenValue || typeof tokenValue !== 'string' || !tokenValue.includes('.')) return false;
  const [nonce, mac] = tokenValue.split('.');
  const expected = hmac(`${sessionId || 'anon'}:${nonce}`, config.secrets.app);
  return safeEqual(expected, mac || '');
}

/** Signature d'une notification de paiement (en-tête `X-Signature: sha256=<hex>`). */
function signWebhookPayload(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex')}`;
}

function verifyWebhookSignature(rawBody, header, secret) {
  if (!secret) return false;
  if (!header) return false;
  const expected = signWebhookPayload(rawBody, secret);
  const given = String(header).trim();
  const givenNorm = given.startsWith('sha256=') ? given : `sha256=${given}`;
  return safeEqual(expected, givenNorm);
}

module.exports = {
  hashPassword,
  verifyPassword,
  passwordIssues,
  safeEqual,
  hmac,
  sign,
  unsign,
  csrfToken,
  verifyCsrf,
  signWebhookPayload,
  verifyWebhookSignature,
};
