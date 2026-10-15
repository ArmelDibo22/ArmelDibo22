'use strict';

/**
 * Comptes d'administration (rôles) et comptes clients facultatifs.
 *
 * Rôles :
 *   admin   — accès complet, seul habilité à supprimer, rembourser, gérer les
 *             utilisateurs et les réglages ;
 *   vendeur — catalogue, commandes, stock, caisse ; peut être habilité
 *             (`can_confirm_cash`) à confirmer un encaissement espèces.
 *
 * Les contrôles d'accès sont appliqués côté serveur (middleware + domaine) :
 * aucune action sensible ne dépend d'un élément masqué dans l'interface.
 */

const db = require('../db');
const dates = require('../lib/dates');
const security = require('../lib/security');
const session = require('../lib/session');
const { normalizeText } = require('../lib/slug');
const { isEmail, normalizePhone } = require('../lib/validate');

class AuthError extends Error {
  constructor(message, code = 'AUTH_ERROR', status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

const ROLES = [
  { value: 'admin', label: 'Administrateur', description: 'Accès complet : catalogue, commandes, remboursements, utilisateurs, réglages.' },
  { value: 'vendor', label: 'Vendeur', description: 'Catalogue, commandes, stock et caisse. Remboursements et réglages réservés à l’administrateur.' },
];

/** Ce qu'un rôle est autorisé à faire. */
const PERMISSIONS = {
  admin: new Set([
    'catalog.read', 'catalog.write', 'catalog.delete',
    'orders.read', 'orders.write', 'orders.refund', 'orders.cancel',
    'stock.read', 'stock.write',
    'pos.read', 'pos.write', 'pos.cancel',
    'customers.read', 'customers.write',
    'imports.run', 'imports.export',
    'settings.read', 'settings.write',
    'users.read', 'users.write',
    'stats.read',
    'cash.confirm',
    'audit.read',
  ]),
  vendor: new Set([
    'catalog.read', 'catalog.write',
    'orders.read', 'orders.write', 'orders.cancel',
    'stock.read', 'stock.write',
    'pos.read', 'pos.write',
    'customers.read',
    'imports.run', 'imports.export',
    'settings.read',
    'stats.read',
    // Soumis à l'habilitation individuelle : `can()` vérifie `canConfirmCash`.
    'cash.confirm',
  ]),
};

function can(user, permission) {
  if (!user) return false;
  const set = PERMISSIONS[user.role] || new Set();
  if (set.has(permission)) {
    if (permission === 'cash.confirm') return user.role === 'admin' || Boolean(user.canConfirmCash);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Utilisateurs d'administration                                       */
/* ------------------------------------------------------------------ */
function listUsers() {
  return db.all(
    `SELECT id, email, full_name, phone, role, active, can_confirm_cash, last_login_at, created_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
       FROM users ORDER BY role ASC, full_name ASC`,
    [dates.nowIso()]
  );
}

function getUser(id) {
  const row = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
  return row ? toUser(row) : null;
}

function getByEmail(email) {
  const row = db.get('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  return row ? toUser(row) : null;
}

function toUser(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    active: Boolean(row.active),
    canConfirmCash: Boolean(row.can_confirm_cash),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function createUser({ email, password, fullName = '', phone = '', role = 'vendor', canConfirmCash = false, active = true }, actor = null) {
  const mail = String(email || '').trim().toLowerCase();
  if (!isEmail(mail)) throw new AuthError('Adresse e-mail invalide.');
  if (getByEmail(mail)) throw new AuthError('Un compte existe déjà avec cette adresse e-mail.', 'EMAIL_TAKEN', 409);
  const problems = security.passwordIssues(password);
  if (problems.length) throw new AuthError(`Mot de passe insuffisant : il faut ${problems.join(', ')}.`, 'WEAK_PASSWORD');
  if (!['admin', 'vendor'].includes(role)) throw new AuthError('Rôle invalide.');

  const id = db.insert('users', {
    email: mail,
    full_name: normalizeText(fullName).slice(0, 160),
    phone: normalizePhone(phone) || '',
    password_hash: security.hashPassword(password),
    role,
    active: active ? 1 : 0,
    can_confirm_cash: canConfirmCash ? 1 : 0,
  });
  audit(actor?.id, 'user.create', mail, { role });
  return getUser(id);
}

function updateUser(id, input, actor = null) {
  const user = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
  if (!user) throw new AuthError('Utilisateur introuvable.', 'NOT_FOUND', 404);
  const data = {};
  if (input.fullName !== undefined) data.full_name = normalizeText(input.fullName).slice(0, 160);
  if (input.phone !== undefined) data.phone = normalizePhone(input.phone) || '';
  if (input.email !== undefined) {
    const mail = String(input.email).trim().toLowerCase();
    if (!isEmail(mail)) throw new AuthError('Adresse e-mail invalide.');
    const clash = db.get('SELECT id FROM users WHERE email = ? AND id != ?', [mail, id]);
    if (clash) throw new AuthError('Cette adresse e-mail est déjà utilisée.', 'EMAIL_TAKEN', 409);
    data.email = mail;
  }
  if (input.role !== undefined) {
    if (!['admin', 'vendor'].includes(input.role)) throw new AuthError('Rôle invalide.');
    const adminCount = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;
    if (user.role === 'admin' && input.role !== 'admin' && adminCount <= 1) {
      throw new AuthError('Impossible de retirer le dernier administrateur actif.', 'LAST_ADMIN', 409);
    }
    data.role = input.role;
  }
  if (input.active !== undefined) {
    const adminCount = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;
    if (user.active && !input.active && user.role === 'admin' && adminCount <= 1) {
      throw new AuthError('Impossible de désactiver le dernier administrateur actif.', 'LAST_ADMIN', 409);
    }
    data.active = input.active ? 1 : 0;
    if (!input.active) db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [dates.nowIso(), id]);
  }
  if (input.canConfirmCash !== undefined) data.can_confirm_cash = input.canConfirmCash ? 1 : 0;
  if (input.password) {
    const problems = security.passwordIssues(input.password);
    if (problems.length) throw new AuthError(`Mot de passe insuffisant : il faut ${problems.join(', ')}.`, 'WEAK_PASSWORD');
    data.password_hash = security.hashPassword(input.password);
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [dates.nowIso(), id]);
  }
  data.updated_at = dates.nowIso();
  db.update('users', id, data);
  audit(actor?.id, 'user.update', user.email, { fields: Object.keys(data).filter((k) => k !== 'password_hash' && k !== 'updated_at') });
  return getUser(id);
}

function deleteUser(id, actor = null) {
  const user = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
  if (!user) throw new AuthError('Utilisateur introuvable.', 'NOT_FOUND', 404);
  if (Number(id) === Number(actor?.id)) throw new AuthError('Vous ne pouvez pas supprimer votre propre compte.', 'SELF_DELETE', 409);
  const adminCount = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;
  if (user.role === 'admin' && adminCount <= 1) throw new AuthError('Impossible de supprimer le dernier administrateur actif.', 'LAST_ADMIN', 409);
  db.transaction(() => {
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [dates.nowIso(), id]);
    db.run('DELETE FROM users WHERE id = ?', [Number(id)]);
  });
  audit(actor?.id, 'user.delete', user.email, {});
  return true;
}

/** Connexion administration. Le message d'erreur ne révèle pas quel champ est faux. */
function loginAdmin({ email, password }, req = null) {
  const user = db.get('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  // Même chemin de calcul si l'utilisateur n'existe pas (résistance à l'énumération).
  const hash = user ? user.password_hash : security.hashPassword('comparaison-inutile');
  const ok = security.verifyPassword(String(password || ''), hash);
  if (!user || !ok) {
    audit(user?.id, 'auth.login_failed', String(email || '').slice(0, 120), { ip: req?.ip || '' });
    throw new AuthError('Identifiants incorrects.', 'BAD_CREDENTIALS', 401);
  }
  if (!user.active) throw new AuthError('Ce compte est désactivé. Contactez un administrateur.', 'INACTIVE', 403);
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [dates.nowIso(), user.id]);
  audit(user.id, 'auth.login', user.email, { ip: req?.ip || '' });
  return toUser(user);
}

function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'anonymous',
      action,
      entity_type: 'user',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* noop */ }
}

function auditList({ limit = 200, offset = 0, entityType = null, userId = null } = {}) {
  const where = [];
  const params = [];
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (userId) { where.push('user_id = ?'); params.push(Number(userId)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, params)?.n || 0;
  return {
    items: db.all(
      `SELECT a.*, u.email AS user_email, u.full_name AS user_name FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ),
    total,
  };
}

/* ------------------------------------------------------------------ */
/* Comptes clients (facultatifs)                                       */
/* ------------------------------------------------------------------ */
function findCustomer({ email = null, phone = null }) {
  if (email) {
    const row = db.get('SELECT * FROM customers WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (row) return row;
  }
  if (phone) {
    const norm = normalizePhone(phone);
    if (norm) {
      const row = db.get('SELECT * FROM customers WHERE phone = ?', [norm]);
      if (row) return row;
    }
  }
  return null;
}

/**
 * Connexion client. Un compte n'existe que si un mot de passe a été défini :
 * l'achat sans compte reste le parcours par défaut.
 */
function loginCustomer({ identifier, password }) {
  const value = normalizeText(identifier);
  const customer = isEmail(value)
    ? db.get('SELECT * FROM customers WHERE email = ?', [value.toLowerCase()])
    : db.get('SELECT * FROM customers WHERE phone = ?', [normalizePhone(value)]);
  const hash = customer?.password_hash || security.hashPassword('comparaison-inutile');
  const ok = customer && customer.password_hash && security.verifyPassword(String(password || ''), hash);
  if (!ok) throw new AuthError('Identifiants incorrects.', 'BAD_CREDENTIALS', 401);
  return customer;
}

function registerCustomer({ email = null, phone = '', fullName = '', password = '', marketingConsent = false }) {
  const mail = email ? String(email).trim().toLowerCase() : null;
  const normPhone = normalizePhone(phone) || '';
  if (!mail && !normPhone) throw new AuthError('Une adresse e-mail ou un numéro de téléphone est requis.', 'IDENTIFIER_REQUIRED');
  const problems = security.passwordIssues(password);
  if (problems.length) throw new AuthError(`Mot de passe insuffisant : il faut ${problems.join(', ')}.`, 'WEAK_PASSWORD');
  if (mail) {
    const clash = db.get('SELECT id FROM customers WHERE email = ? AND password_hash != \'\'', [mail]);
    if (clash) throw new AuthError('Un compte existe déjà avec cette adresse e-mail.', 'EMAIL_TAKEN', 409);
  }
  const existing = findCustomer({ email: mail, phone: normPhone });
  if (existing) {
    if (existing.password_hash) throw new AuthError('Un compte existe déjà avec ces informations.', 'ACCOUNT_EXISTS', 409);
    db.update('customers', existing.id, {
      email: mail || existing.email,
      phone: normPhone || existing.phone,
      full_name: normalizeText(fullName) || existing.full_name,
      password_hash: security.hashPassword(password),
      marketing_consent: marketingConsent ? 1 : 0,
      consent_at: marketingConsent ? dates.nowIso() : existing.consent_at,
      updated_at: dates.nowIso(),
    });
    return db.get('SELECT * FROM customers WHERE id = ?', [existing.id]);
  }
  const id = db.insert('customers', {
    email: mail,
    phone: normPhone,
    full_name: normalizeText(fullName).slice(0, 160),
    password_hash: security.hashPassword(password),
    marketing_consent: marketingConsent ? 1 : 0,
    consent_at: marketingConsent ? dates.nowIso() : null,
  });
  return db.get('SELECT * FROM customers WHERE id = ?', [id]);
}

function updateCustomerPassword(customerId, currentPassword, newPassword) {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [Number(customerId)]);
  if (!customer) throw new AuthError('Compte introuvable.', 'NOT_FOUND', 404);
  if (customer.password_hash && !security.verifyPassword(String(currentPassword || ''), customer.password_hash)) {
    throw new AuthError('Mot de passe actuel incorrect.', 'BAD_CREDENTIALS', 401);
  }
  const problems = security.passwordIssues(newPassword);
  if (problems.length) throw new AuthError(`Mot de passe insuffisant : il faut ${problems.join(', ')}.`, 'WEAK_PASSWORD');
  db.update('customers', customerId, { password_hash: security.hashPassword(newPassword), updated_at: dates.nowIso() });
  return true;
}

function listCustomers({ page = 1, perPage = 25, q = null, consented = null } = {}) {
  const where = [];
  const params = [];
  if (q) {
    const like = `%${normalizeText(q)}%`;
    where.push('(full_name LIKE ? OR phone LIKE ? OR email LIKE ?)');
    params.push(like, like, like);
  }
  if (consented === 'yes') where.push('marketing_consent = 1');
  if (consented === 'no') where.push('marketing_consent = 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(200, Number(perPage) || 25));
  const total = db.get(`SELECT COUNT(*) AS n FROM customers ${clause}`, params)?.n || 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db.all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count,
            (SELECT COALESCE(SUM(o.amount_paid),0) FROM orders o WHERE o.customer_id = c.id) AS orders_amount,
            (SELECT MAX(o.placed_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at
       FROM customers c ${clause}
      ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (current - 1) * size]
  );
  return { items: rows, pagination: { page: current, perPage: size, total, pages, offset: (current - 1) * size, hasNext: current < pages, hasPrev: current > 1, from: total ? (current - 1) * size + 1 : 0, to: Math.min(current * size, total) } };
}

function getCustomer(id) {
  const row = db.get('SELECT * FROM customers WHERE id = ?', [Number(id)]);
  if (!row) return null;
  return {
    ...row,
    orders: db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 100', [row.id]),
  };
}

function logoutEverywhere(customerId) {
  db.run('UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL', [dates.nowIso(), Number(customerId)]);
}

module.exports = {
  AuthError,
  ROLES,
  PERMISSIONS,
  can,
  listUsers,
  getUser,
  getByEmail,
  createUser,
  updateUser,
  deleteUser,
  loginAdmin,
  auditList,
  findCustomer,
  loginCustomer,
  registerCustomer,
  updateCustomerPassword,
  listCustomers,
  getCustomer,
  logoutEverywhere,
  session,
};
