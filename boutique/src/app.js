'use strict';

/**
 * Application Express.
 *
 * Rendu serveur (EJS) + améliorations progressives : aucune étape du parcours
 * d'achat ne dépend de JavaScript, ce qui garantit le fonctionnement sur des
 * smartphones modestes et une bonne indexation locale.
 */

const path = require('node:path');
const express = require('express');
const ejs = require('ejs');

const config = require('./config');
const db = require('./db');
const settings = require('./lib/settings');
const logger = require('./lib/logger');
const ratelimit = require('./lib/ratelimit');
const stock = require('./domain/stock');
const cartDomain = require('./domain/cart');
const context = require('./middleware/context');
const { HttpError } = require('./lib/http');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  // Permet les includes absolus (`/partials/...`) depuis n'importe quelle
  // profondeur de dossier, sans dépendre du chemin relatif du gabarit.
  app.set('view options', { root: path.join(__dirname, 'views') });
  app.set('etag', 'strong');
  app.set('json spaces', 0);

  // --- Rendu avec gabarit -------------------------------------------------
  app.use((req, res, next) => {
    res.renderPage = (view, data = {}, layout = 'layout') => {
      res.render(view, data, (err, html) => {
        if (err) return next(err);
        if (!layout) return res.send(html);
        return res.render(layout, { ...data, body: html, layoutContent: html }, (err2, out) => {
          if (err2) return next(err2);
          return res.send(out);
        });
      });
    };
    next();
  });

  // --- Statiques (CSS/JS/icônes) ------------------------------------------
  app.use(
    '/assets',
    express.static(path.join(__dirname, '..', 'assets'), {
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
      index: false,
    })
  );
  app.get('/favicon.ico', (req, res) => {
    const key = settings.get('store.favicon_key');
    if (key) return res.redirect(`/media/${key}`);
    // Favicon provisoire typographique, remplaçable depuis les réglages.
    const fallback = path.join(__dirname, '..', 'assets', 'img', 'favicon.svg');
    if (require('node:fs').existsSync(fallback)) return res.type('image/svg+xml').sendFile(fallback);
    return res.type('image/svg+xml').send(require('./lib/images').placeholderSvg('LP', { width: 64, height: 64 }));
  });

  // --- Médias produits (hors dépôt Git, cache long) ------------------------
  app.use('/media', require('./routes/media'));

  // --- Corps de requête ----------------------------------------------------
  app.use('/webhooks', express.raw({ type: '*/*', limit: '64kb' }));
  // `extended: true` (analyseur qs) est indispensable : plusieurs formulaires
  // d'administration envoient des structures imbriquées (variantes,
  // caractéristiques, composants de kit, contacts, heures d'ouverture).
  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 5000 }));
  app.use(express.json({ limit: '1mb' }));

  // --- Sécurité, contexte, CSRF, limites ----------------------------------
  app.use(context.securityHeaders);
  app.use(context.requestLogger);
  app.use(ratelimit.middleware({ keyPrefix: 'rl-global', windowMs: config.security.rateLimit.windowMs, max: config.security.rateLimit.max }));
  app.use(context.contextMiddleware);
  app.use(context.csrfProtection);
  app.use(context.maintenanceGate);

  app.get('/sante', context.health);

  // --- Garde-fous de paramètres --------------------------------------------
  // path-to-regexp v8 (Express 5) n'accepte plus les motifs du type `:id(\\d+)`.
  // La validation des identifiants numériques est donc centralisée ici : une
  // valeur non numérique produit un 404 au lieu d'atteindre la base de données.
  for (const name of ['id', 'itemId', 'imageId', 'templateId', 'zoneId', 'rateId', 'carrierId', 'jobId', 'customerId', 'productId']) {
    // eslint-disable-next-line no-loop-func
    app.param(name, (req, res, next, value) => {
      if (!/^\d{1,15}$/.test(String(value))) {
        const err = new Error('Identifiant invalide.');
        err.status = 404;
        return next(err);
      }
      next();
    });
  }

  // --- Routes --------------------------------------------------------------
  app.use('/', require('./routes/storefront'));
  app.use('/', require('./routes/cart'));
  app.use('/', require('./routes/checkout'));
  app.use('/', require('./routes/tracking'));
  app.use('/', require('./routes/account'));
  app.use('/webhooks', require('./routes/webhooks'));
  app.use('/', require('./routes/sandbox'));
  app.use('/', require('./routes/seo'));
  app.use('/admin', require('./routes/admin'));

  // --- 404 ------------------------------------------------------------------
  app.use((req, res) => {
    if (req.path.startsWith('/admin')) {
      return res.status(404).renderPage('errors/404', { title: 'Page introuvable', adminLayout: true }, 'admin/layout');
    }
    return res.status(404).renderPage('errors/404', { title: 'Page introuvable' });
  });

  // --- Erreurs ---------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err instanceof HttpError ? err.status : 500);
    if (status >= 500) logger.error('erreur serveur', { path: req.originalUrl, message: err.message, stack: err.stack });
    else logger.debug('erreur client', { path: req.originalUrl, status, message: err.message });

    const wantsJson = req.path.startsWith('/api/') || require('./lib/http').isAjax(req);
    if (wantsJson) {
      return res.status(status).json({
        ok: false,
        error: status >= 500 ? 'Erreur interne du serveur.' : err.message,
        code: err.code || null,
        errors: err.errors || err.details || null,
      });
    }
    const message =
      status >= 500
        ? 'Une erreur inattendue est survenue. Notre équipe en est informée.'
        : err.message || 'Requête impossible.';
    const layout = req.path.startsWith('/admin') ? 'admin/layout' : 'layout';
    return res.status(status).renderPage('errors/generic', {
      title: status === 403 ? 'Accès refusé' : status === 409 ? 'Action impossible' : 'Erreur',
      message,
      status,
      code: err.code || null,
      adminLayout: layout === 'admin/layout',
    }, layout);
  });

  return app;
}

/* ------------------------------------------------------------------ */
/* Tâches périodiques                                                  */
/* ------------------------------------------------------------------ */
let timers = [];

function startBackgroundTasks({ intervalMinutes = 5 } = {}) {
  const tick = () => {
    try {
      const released = stock.releaseExpired();
      if (released) logger.info('réservations expirées libérées', { count: released });
    } catch (err) {
      logger.warn('balayage des réservations en échec', { error: err.message });
    }
    try {
      const purged = cartDomain.purgeStale(72);
      if (purged) logger.info('paniers inactifs purgés', { count: purged });
    } catch (err) {
      logger.warn('purge des paniers en échec', { error: err.message });
    }
    try {
      ratelimit.purge();
      require('./lib/session').purgeExpiredSessions();
    } catch { /* noop */ }
    try {
      const retention = Number(settings.get('backup.retention') || 14);
      if (settings.get('backup.auto_enabled')) {
        const backups = require('./lib/backups');
        backups.backupDatabase();
        backups.prune(retention);
      }
    } catch (err) {
      logger.warn('sauvegarde automatique en échec', { error: err.message });
    }
  };
  timers.push(setInterval(tick, intervalMinutes * 60_000));
  timers.push(setInterval(() => { try { db.run('PRAGMA wal_checkpoint(PASSIVE);'); } catch { /* noop */ } }, 30 * 60_000));
  for (const t of timers) t.unref?.();
  tick();
  return () => stopBackgroundTasks();
}

function stopBackgroundTasks() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

module.exports = { createApp, startBackgroundTasks, stopBackgroundTasks };
