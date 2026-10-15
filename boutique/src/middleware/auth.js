'use strict';

/** Garde-fous d'accès : administration, rôles, comptes clients. */

const path = require('node:path');
const users = require('../domain/users');
const { HttpError, forbidden } = require('../lib/http');
const rateLimit = require('../lib/ratelimit');
const config = require('../config');
const security = require('../lib/security');

/** Exige une session d'administration valide. */
function requireAdmin(req, res, next) {
  if (!req.admin) {
    // `req.path` est relatif au point de montage du routeur : on reconstruit le
    // chemin complet pour décider entre redirection (navigation) et 403 (API).
    const fullPath = `${req.baseUrl || ''}${req.path}`;
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const isNavigation = fullPath.startsWith('/admin') && !path.extname(fullPath);
    if (isNavigation && (wantsHtml || req.method === 'GET')) {
      return res.redirect(`/admin/connexion?suite=${encodeURIComponent(req.originalUrl)}`);
    }
    return next(forbidden('Authentification requise.'));
  }
  req.user = req.admin.user;
  return next();
}

/** Exige une permission précise (contrôle côté serveur, jamais dans le gabarit). */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin) return next(forbidden('Authentification requise.'));
    req.user = req.admin.user;
    if (!users.can(req.admin.user, permission)) {
      const err = new HttpError(403, "Votre rôle ne permet pas cette action. Contactez un administrateur.");
      err.code = 'INSUFFICIENT_ROLE';
      return next(err);
    }
    return next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin) return next(forbidden('Authentification requise.'));
    if (!roles.includes(req.admin.user.role)) return next(forbidden('Action réservée à un autre rôle.'));
    req.user = req.admin.user;
    return next();
  };
}

/** Exige un compte client connecté. */
function requireCustomer(req, res, next) {
  if (!req.customer) return res.redirect(`/compte/connexion?suite=${encodeURIComponent(req.originalUrl)}`);
  return next();
}

/** Limite spécifique sur les routes d'authentification (anti-force brute). */
function authRateLimit(scope = 'auth') {
  return rateLimit.middleware({
    keyPrefix: 'rl-auth',
    windowMs: 5 * 60_000,
    max: config.security.rateLimit.authMax,
    keyFn: () => scope,
  });
}

function checkoutRateLimit() {
  return rateLimit.middleware({
    keyPrefix: 'rl-checkout',
    windowMs: 10 * 60_000,
    max: config.security.rateLimit.checkoutMax,
    keyFn: () => 'checkout',
  });
}

/** Vérifie la signature HMAC d'un lien signé (ex. action client sur devis). */
function verifySignedLink(value, expected) {
  return security.safeEqual(String(value || ''), String(expected || ''));
}

module.exports = {
  requireAdmin,
  requirePermission,
  requireRole,
  requireCustomer,
  authRateLimit,
  checkoutRateLimit,
  verifySignedLink,
};
