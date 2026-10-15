'use strict';

/**
 * Contexte de requête : réglages, identité, panier, CSRF, aides de rendu.
 * Tout est calculé côté serveur ; le navigateur ne reçoit que le strict nécessaire.
 */

const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const session = require('../lib/session');
const security = require('../lib/security');
const dates = require('../lib/dates');
const money = require('../lib/money');
const { formatPhone } = require('../lib/validate');
const cart = require('../domain/cart');
const images = require('../lib/images');
const { icon } = require('../lib/icons');
const categories = require('../domain/categories');
const ordersDomain = require('../domain/orders');

function mediaUrl(fileKey, size = 'medium') {
  if (!fileKey) return '';
  return `/media/${String(fileKey).replace(/[^a-z0-9._/-]/gi, '')}?s=${encodeURIComponent(size)}`;
}

const FLASH_COOKIE = 'prv_flash';

function contextMiddleware(req, res, next) {
  req.cookies = session.parseCookies(req);

  // Messages flash entrants (cookie signé, durée de vie très courte).
  req._incomingFlashes = [];
  const flashCookie = req.cookies[FLASH_COOKIE];
  if (flashCookie) {
    const decoded = security.unsign(flashCookie);
    if (decoded) {
      try {
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed)) req._incomingFlashes = parsed.slice(0, 6);
      } catch { /* cookie illisible : ignoré */ }
    }
    session.clearCookie(res, FLASH_COOKIE);
  }

  // Dépose les nouveaux messages flash au moment d'une redirection.
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req._flashes && req._flashes.length) {
      session.setCookie(res, FLASH_COOKIE, security.sign(JSON.stringify(req._flashes)), { maxAge: 300 });
    }
    return originalRedirect(...args);
  };

  const all = settings.load();
  req.settings = all;

  // Panier serveur (jamais de source de vérité côté navigateur)
  try {
    const { cart: currentCart, created } = cart.ensureCart(req);
    req.cart = currentCart;
    if (created) session.issueCartToken(res);
    // La valeur du cookie est émise par ensureCart via res (voir domain/cart.js)
    if (currentCart && currentCart.__newToken) {
      session.setCookie(res, session.CART_COOKIE, currentCart.__newToken, { maxAge: 90 * 86400 });
      delete currentCart.__newToken;
    }
  } catch (err) {
    req.cart = null;
    req.cartError = err.message;
  }

  req.admin = session.loadAdminSession(req);
  req.customer = session.loadCustomerSession(req);

  const csrf = security.csrfToken(req.admin?.sessionId || req.customer?.id || req.cart?.token || 'anon');
  req.csrfToken = csrf;

  res.locals = {
    ...res.locals,
    // NB : ne surtout pas exposer cette carte sous le nom `settings`.
    // Express publie déjà `app.locals.settings` (ses propres réglages) et EJS y
    // lit `settings.views` et `settings['view options'].root`, qui permettent
    // les includes absolus. Une clé homonyme dans res.locals casserait tout.
    appSettings: all,
    store: buildStoreView(all),
    config: {
      env: config.env,
      isDemo: config.isDemo,
      publicUrl: config.publicUrl,
      pageSize: config.commerce.catalogPageSize,
      uploadLimitMb: Math.max(1, Math.round(config.storage.maxUploadBytes / (1024 * 1024))),
      allowedImageTypes: config.storage.allowedImageTypes,
    },
    admin: req.admin ? req.admin.user : null,
    customer: req.customer || null,
    cart: req.cart,
    csrfToken: csrf,
    // `req` est exposé aux gabarits : les aides comme queryString(req, overrides)
    // en ont besoin pour construire des liens conservant les filtres actifs.
    req,
    currentPath: req.path,
    currentUrl: req.originalUrl,
    query: req.query,
    flashes: require('../lib/http').takeFlashes(req),
    dates,
    money,
    mediaUrl,
    formatPhone,
    icon,
    theme: buildThemeVars(all),
    labels: STATUS_LABELS,
    statusTone,
    navTree: memoize(() => categories.tree()),
    footerPages: memoize(() =>
      db.all('SELECT slug, title FROM pages WHERE published = 1 ORDER BY position ASC, title ASC')
    ),
    pageTitle: (title) => (title ? `${title} · ${all['store.name']}` : all['store.name']),
    placeholderSvg: images.placeholderSvg,
    year: dates.todayInTz().slice(0, 4),
  };

  next();
}

/** Vue « établissement » utilisée par les gabarits. */
function buildStoreView(all) {
  const contacts = Array.isArray(all['store.contacts']) ? all['store.contacts'] : [];
  const visible = contacts.filter((c) => c.visible !== false);
  const primary = visible.find((c) => c.is_primary) || visible[0] || null;
  const phones = visible.filter((c) => c.type === 'phone');
  const whatsapp = visible.find((c) => c.type === 'phone' && c.whatsapp_enabled) || null;
  const emails = visible.filter((c) => c.type === 'email');

  return {
    name: all['store.name'],
    shortName: all['store.short_name'],
    tagline: all['store.tagline'],
    city: all['store.city'],
    region: all['store.region'],
    country: all['store.country'],
    address: all['store.address'],
    addressConfirmed: Boolean(all['store.address_confirmed']),
    mapsUrl: all['store.maps_url'],
    lat: all['store.maps_lat'],
    lng: all['store.maps_lng'],
    hoursStatus: all['store.hours_status'],
    hours: Array.isArray(all['store.hours']) ? all['store.hours'] : [],
    registration: all['store.registration'],
    logoKey: all['store.logo_key'],
    logoStatus: all['store.logo_status'],
    contacts: visible,
    primary,
    phones,
    emails,
    whatsapp,
    whatsappEnabled: Boolean(whatsapp && all['whatsapp.enabled']),
    whatsappDisclaimer: all['whatsapp.disclaimer'],
    phoneDisplay: primary ? primary.display || formatPhone(primary.value) : '',
    phoneRaw: primary ? String(primary.value || '').replace(/\D/g, '') : '',
    currency: all['commerce.currency'],
    currencyLabel: all['commerce.currency_label'],
    demoBanner: Boolean(all['ui.demo_banner']) || config.isDemo,
    maintenance: Boolean(all['ui.maintenance']),
    maintenanceMessage: all['ui.maintenance_message'],
    homeIntro: all['ui.home_intro'],
    theme: {
      primary: all['theme.primary'],
      primaryDark: all['theme.primary_dark'],
      primarySoft: all['theme.primary_soft'],
      accent: all['theme.accent'],
      accentSoft: all['theme.accent_soft'],
      ink: all['theme.ink'],
      background: all['theme.background'],
      surface: all['theme.surface'],
      border: all['theme.border'],
      radius: all['theme.radius'],
      density: all['theme.density'],
    },
  };
}

/** En-têtes de sécurité appliqués à toutes les réponses. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** Bloque le site pendant une maintenance annoncée. */
function maintenanceGate(req, res, next) {
  const on = settings.get('ui.maintenance');
  if (!on || req.path.startsWith('/admin') || req.path.startsWith('/media')) return next();
  res.status(503).setHeader('Retry-After', '1800');
  return res.render('errors/maintenance', {
    title: 'Boutique momentanément indisponible',
    message: settings.get('ui.maintenance_message') || 'La boutique est en cours de mise à jour.',
  });
}

/** Journalise les accès (sans donnée personnelle superflue). */
function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    require('../lib/logger')[level]('requete', {
      method: req.method,
      path: req.originalUrl.slice(0, 300),
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip: require('../lib/http').clientIp(req),
    });
  });
  next();
}

/** Vérifie le jeton CSRF sur toutes les méthodes non sûres. */
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fromHeader = req.get('x-csrf-token');
  const fromBody = req.body && (req.body._csrf || req.body.csrfToken);
  const provided = fromHeader || fromBody;
  const scope = req.admin?.sessionId || req.customer?.id || req.cart?.token || 'anon';
  if (!provided || !security.verifyCsrf(provided, scope)) {
    // Les webhooks de paiement utilisent une signature HMAC, pas le CSRF.
    if (req.path.startsWith('/webhooks/')) return next();
    const message = 'Jeton de sécurité invalide ou expiré. Rechargez la page puis réessayez.';
    if (require('../lib/http').isAjax(req)) {
      return res.status(403).json({ ok: false, error: message });
    }
    const layout = req.path.startsWith('/admin') ? 'admin/layout' : 'layout';
    return res
      .status(403)
      .renderPage('errors/generic', { title: 'Session expirée', message, status: 403, adminLayout: layout === 'admin/layout' }, layout);
  }
  return next();
}

/** Vérification de santé (sonde d'hébergeur). */
function health(req, res) {
  try {
    db.get('SELECT 1 AS ok');
    res.json({ ok: true, time: new Date().toISOString(), env: config.env, version: require('../../package.json').version });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
}

/** Libellés français des statuts, partagés par tous les gabarits. */
const STATUS_LABELS = (() => {
  const map = (list) => Object.fromEntries(list.map((s) => [s.value, s.label]));
  return {
    order: map(ordersDomain.ORDER_STATUSES),
    payment: map(ordersDomain.PAYMENT_STATUSES),
    delivery: map(ordersDomain.DELIVERY_STATUSES),
  };
})();

/** Tonalité de pastille cohérente pour un statut (succès, alerte, danger…). */
function statusTone(kind, value) {
  const table = {
    order: {
      pending: 'warn', quote_required: 'info', confirmed: 'brand', preparing: 'brand',
      ready: 'brand', shipped: 'info', delivered: 'success',
      partially_refunded: 'warn', refunded: 'warn', cancelled: 'danger',
    },
    payment: {
      unpaid: 'warn', awaiting_confirmation: 'warn', paid: 'success',
      partially_refunded: 'info', refunded: 'info', failed: 'danger', cancelled: 'danger',
    },
    delivery: {
      none: 'neutral', to_prepare: 'warn', in_preparation: 'brand', pickup_ready: 'success',
      picked_up: 'success', handed_to_carrier: 'info', in_transit: 'info',
      delivered: 'success', returned: 'warn', cancelled: 'danger',
    },
  };
  return (table[kind] && table[kind][value]) || 'neutral';
}

/** Mémoïsation par requête : évite les requêtes SQL répétées dans les gabarits. */
function memoize(fn) {
  let done = false;
  let value = null;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

/**
 * Variables CSS dérivées des réglages : la palette est modifiable depuis
 * l'administration (pour s'aligner sur le logo officiel) sans toucher au code.
 */
function buildThemeVars(all) {
  const vars = {
    brand: all['theme.primary'],
    'brand-dark': all['theme.primary_dark'],
    'brand-soft': all['theme.primary_soft'],
    accent: all['theme.accent'],
    'accent-soft': all['theme.accent_soft'],
    ink: all['theme.ink'],
    bg: all['theme.background'],
    surface: all['theme.surface'],
    border: all['theme.border'],
    radius: `${Math.max(0, Math.min(28, Number(all['theme.radius']) || 0))}px`,
  };
  return {
    vars,
    density: all['theme.density'] === 'compact' ? 'compact' : 'comfortable',
    primary: all['theme.primary'],
    accent: all['theme.accent'],
    /** Bloc <style> à injecter dans le <head>. */
    cssText: `:root{${Object.entries(vars)
      .map(([k, v]) => `--${k}:${v}`)
      .join(';')}}`,
  };
}

module.exports = {
  contextMiddleware,
  buildThemeVars,
  securityHeaders,
  maintenanceGate,
  requestLogger,
  csrfProtection,
  buildStoreView,
  mediaUrl,
  health,
};
