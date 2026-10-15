'use strict';

/**
 * Sessions serveur (administration et comptes clients facultatifs).
 *
 * Le cookie ne contient qu'un jeton aléatoire opaque ; sa version hachée est
 * stockée en base. Le panier est lui aussi rattaché à un jeton serveur :
 * le stockage local du navigateur n'est jamais la source de vérité.
 */

const cookie = require('cookie');
const db = require('../db');
const config = require('../config');
const ids = require('./ids');
const dates = require('./dates');

const ADMIN_COOKIE = 'prv_session';
const CUSTOMER_COOKIE = 'prv_customer';
const CART_COOKIE = 'prv_cart';

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: config.isProduction,
};

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  try {
    return cookie.parse(header);
  } catch {
    return {};
  }
}

function setCookie(res, name, value, opts = {}) {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  list.push(cookie.serialize(name, value, { ...COOKIE_BASE, ...opts }));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/* ------------------------------------------------------------------ */
/* Sessions d'administration                                           */
/* ------------------------------------------------------------------ */
function createAdminSession(user, req, res) {
  const raw = ids.token(32);
  const expires = new Date(Date.now() + config.security.sessionTtlHours * 3_600_000).toISOString();
  db.run(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, ids.hashToken(raw), expires, String(req?.ip || '').slice(0, 45), String(req?.headers?.['user-agent'] || '').slice(0, 200)]
  );
  setCookie(res, ADMIN_COOKIE, raw, { maxAge: config.security.sessionTtlHours * 3600 });
  return raw;
}

function loadAdminSession(req) {
  const cookies = req.cookies || parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (!raw) return null;
  const row = db.get(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.email, u.full_name, u.role, u.active,
            u.can_confirm_cash
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    [ids.hashToken(raw)]
  );
  if (!row) return null;
  if (dates.isPast(row.expires_at) || !row.active) {
    db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [dates.nowIso(), row.id]);
    return null;
  }
  return {
    sessionId: row.id,
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      canConfirmCash: Boolean(row.can_confirm_cash),
    },
    rawToken: raw,
  };
}

function destroyAdminSession(req, res) {
  const cookies = req.cookies || parseCookies(req);
  const raw = cookies[ADMIN_COOKIE];
  if (raw) db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [dates.nowIso(), ids.hashToken(raw)]);
  clearCookie(res, ADMIN_COOKIE);
}

function purgeExpiredSessions() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', [dates.addMinutes(dates.nowIso(), -60)]);
  db.run('DELETE FROM customer_sessions WHERE expires_at < ?', [dates.addMinutes(dates.nowIso(), -60)]);
}

/* ------------------------------------------------------------------ */
/* Sessions clients (compte facultatif)                                */
/* ------------------------------------------------------------------ */
function createCustomerSession(customer, res, ttlDays = 30) {
  const raw = ids.token(32);
  db.run(
    `INSERT INTO customer_sessions (customer_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [customer.id, ids.hashToken(raw), dates.addDays(dates.nowIso(), ttlDays)]
  );
  setCookie(res, CUSTOMER_COOKIE, raw, { maxAge: ttlDays * 86400 });
  return raw;
}

function loadCustomerSession(req) {
  const cookies = req.cookies || parseCookies(req);
  const raw = cookies[CUSTOMER_COOKIE];
  if (!raw) return null;
  const row = db.get(
    `SELECT cs.id, c.id AS customer_id, c.email, c.full_name, c.phone, c.marketing_consent
       FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id
      WHERE cs.token_hash = ? AND cs.revoked_at IS NULL`,
    [ids.hashToken(raw)]
  );
  if (!row) return null;
  const session = db.get('SELECT expires_at FROM customer_sessions WHERE id = ?', [row.id]);
  if (!session || dates.isPast(session.expires_at)) {
    db.run('UPDATE customer_sessions SET revoked_at = ? WHERE id = ?', [dates.nowIso(), row.id]);
    return null;
  }
  return {
    id: row.customer_id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    marketingConsent: Boolean(row.marketing_consent),
  };
}

function destroyCustomerSession(res) {
  clearCookie(res, CUSTOMER_COOKIE);
}

/* ------------------------------------------------------------------ */
/* Jeton de panier (signé, non sensible)                               */
/* ------------------------------------------------------------------ */
function readCartToken(req) {
  const cookies = req.cookies || parseCookies(req);
  return cookies[CART_COOKIE] || null;
}

function issueCartToken(res) {
  const raw = ids.token(24);
  setCookie(res, CART_COOKIE, raw, { maxAge: 90 * 86400 });
  return raw;
}

function clearCartToken(res) {
  clearCookie(res, CART_COOKIE);
}

module.exports = {
  ADMIN_COOKIE,
  CUSTOMER_COOKIE,
  CART_COOKIE,
  parseCookies,
  setCookie,
  clearCookie,
  createAdminSession,
  loadAdminSession,
  destroyAdminSession,
  purgeExpiredSessions,
  createCustomerSession,
  loadCustomerSession,
  destroyCustomerSession,
  readCartToken,
  issueCartToken,
  clearCartToken,
};
