'use strict';

/** Utilitaires HTTP : pagination, messages flash, réponses, erreurs. */

const config = require('../config');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function notFound(message = 'Page introuvable') {
  return new HttpError(404, message);
}

function forbidden(message = 'Accès refusé') {
  return new HttpError(403, message);
}

function badRequest(message = 'Requête invalide', details) {
  return new HttpError(400, message, details);
}

function conflict(message = 'Conflit') {
  return new HttpError(409, message);
}

/** Pagination côté serveur — jamais de chargement complet du catalogue. */
function paginate({ page = 1, perPage = config.commerce.catalogPageSize, total = 0, maxPerPage = 100 }) {
  const size = Math.min(Math.max(parseInt(perPage, 10) || config.commerce.catalogPageSize, 1), maxPerPage);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  return {
    page: current,
    perPage: size,
    total,
    pages,
    offset: (current - 1) * size,
    hasPrev: current > 1,
    hasNext: current < pages,
    from: total === 0 ? 0 : (current - 1) * size + 1,
    to: Math.min(current * size, total),
  };
}

/** Fenêtre de numéros de page pour l'affichage. */
function pageWindow(pagination, span = 2) {
  const { page, pages } = pagination;
  const out = new Set([1, pages, page]);
  for (let i = 1; i <= span; i += 1) {
    if (page - i > 1) out.add(page - i);
    if (page + i < pages) out.add(page + i);
  }
  return [...out].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Messages flash (stockés côté serveur dans la session, pas dans le    )
/* stockage local du navigateur)                                        */
/* ------------------------------------------------------------------ */
/**
 * Messages flash.
 * Implémentation sans état : les messages sont déposés dans un cookie signé de
 * courte durée au moment de la redirection, puis consommés au rendu suivant.
 * Aucun stockage local du navigateur n'est utilisé comme source d'information.
 */
function flash(req, type, message, extra = null) {
  if (!req._flashes) req._flashes = [];
  req._flashes.push({ type, message, extra: extra || null, at: Date.now() });
}

function takeFlashes(req) {
  const list = req._incomingFlashes || [];
  req._incomingFlashes = [];
  return list;
}

/** Préserve les paramètres de requête lors de la navigation (filtres, tri, page). */
function queryString(req, overrides = {}) {
  const params = new URLSearchParams(req.query || {});
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === '') params.delete(k);
    else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function absoluteUrl(req, path = '/') {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

function isAjax(req) {
  return (
    req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    String(req.headers.accept || '').includes('application/json')
  );
}

module.exports = {
  HttpError,
  notFound,
  forbidden,
  badRequest,
  conflict,
  paginate,
  pageWindow,
  flash,
  takeFlashes,
  queryString,
  absoluteUrl,
  clientIp,
  isAjax,
};
