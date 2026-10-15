'use strict';

/**
 * Espace d'administration : authentification, tableau de bord, montage des
 * sous-modules. Tous les contrôles d'accès sont appliqués ici, côté serveur.
 */

const express = require('express');
const db = require('../../db');
const users = require('../../domain/users');
const orders = require('../../domain/orders');
const products = require('../../domain/products');
const stock = require('../../domain/stock');
const stats = require('../../domain/stats');
const settings = require('../../lib/settings');
const payments = require('../../domain/payments');
const session = require('../../lib/session');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const { flash } = require('../../lib/http');
const imports = require('../../domain/imports');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Connexion                                                           */
/* ------------------------------------------------------------------ */
router.get('/connexion', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.renderPage(
    'admin/login',
    {
      title: 'Connexion administration',
      noindex: true,
      bare: true,
      suite: String(req.query.suite || '/admin'),
      errors: {},
      values: {},
      hasAdmin: Boolean(db.get('SELECT id FROM users LIMIT 1')),
    },
    'admin/layout-bare'
  );
});

router.post('/connexion', auth.authRateLimit('admin-login'), (req, res) => {
  const suite = String(req.body.suite || '/admin');
  const safeSuite = suite.startsWith('/admin') && !suite.startsWith('//') ? suite : '/admin';
  try {
    const user = users.loginAdmin({ email: req.body.email, password: req.body.password }, req);
    session.createAdminSession(user, req, res);
    flash(req, 'success', `Bonjour ${user.fullName || user.email}.`);
    return res.redirect(safeSuite);
  } catch (err) {
    return res.status(err.status || 400).renderPage(
      'admin/login',
      {
        title: 'Connexion administration',
        noindex: true,
        bare: true,
        suite: safeSuite,
        errors: { email: err.message },
        values: { email: req.body.email },
        hasAdmin: Boolean(db.get('SELECT id FROM users LIMIT 1')),
      },
      'admin/layout-bare'
    );
  }
});

router.post('/deconnexion', auth.requireAdmin, (req, res) => {
  session.destroyAdminSession(req, res);
  flash(req, 'info', 'Vous êtes déconnecté.');
  return res.redirect('/admin/connexion');
});

/* ------------------------------------------------------------------ */
/* Tout le reste exige une session                                     */
/* ------------------------------------------------------------------ */
router.use(auth.requireAdmin);

router.use((req, res, next) => {
  res.locals.adminLayout = true;
  res.locals.bare = false;
  res.locals.adminUser = req.admin.user;
  res.locals.can = (permission) => users.can(req.admin.user, permission);
  res.locals.adminNav = buildNav(req);
  res.locals.money = money;
  res.locals.dates = dates;
  res.locals.orderStatuses = orders.ORDER_STATUSES;
  res.locals.paymentStatuses = orders.PAYMENT_STATUSES;
  res.locals.deliveryStatuses = orders.DELIVERY_STATUSES;
  res.locals.adminChecklist = settings.completenessChecklist();
  res.locals.paymentMethodsSummary = payments.listMethods();
  next();
});

/* ------------------------------------------------------------------ */
/* Tableau de bord                                                     */
/* ------------------------------------------------------------------ */
router.get('/', auth.requirePermission('stats.read'), (req, res) => {
  res.render('admin/dashboard', {
    title: 'Tableau de bord',
    activeNav: 'dashboard',
    dashboard: stats.dashboard(),
    recentOrders: db.all(
      `SELECT o.*, z.name AS zone_name FROM orders o LEFT JOIN shipping_zones z ON z.id = o.zone_id
        ORDER BY o.placed_at DESC LIMIT 8`
    ),
    lowStock: stock.lowStockList(8),
    checklist: settings.completenessChecklist(),
    paymentReady: payments.listMethods().filter((m) => m.enabled && payments.methodState(m).key !== 'not_configured').length,
    productCounts: products.counts(),
    series: stats.dailySeries({ days: 14 }),
    lastImport: imports.listJobs(1)[0] || null,
    webhookStats: require('../../domain/payments/webhook').stats(),
  });
});

function buildNav(req) {
  const can = (p) => users.can(req.admin.user, p);
  const groups = [
    {
      label: 'Pilotage',
      items: [
        { key: 'dashboard', label: 'Tableau de bord', href: '/admin', permission: 'stats.read', icon: 'gauge' },
        { key: 'stats', label: 'Statistiques', href: '/admin/statistiques', permission: 'stats.read', icon: 'chart' },
      ],
    },
    {
      label: 'Ventes',
      items: [
        { key: 'orders', label: 'Commandes', href: '/admin/commandes', permission: 'orders.read', icon: 'cart', badge: countOpenOrders() },
        { key: 'pos', label: 'Vente en boutique', href: '/admin/caisse', permission: 'pos.read', icon: 'store' },
        { key: 'quotes', label: 'Devis à établir', href: '/admin/commandes?groupe=quote', permission: 'orders.read', icon: 'quote', badge: countQuotes() },
        { key: 'cash', label: 'Encaissements', href: '/admin/commandes?groupe=cash', permission: 'orders.read', icon: 'cash', badge: countCash() },
      ],
    },
    {
      label: 'Catalogue',
      items: [
        { key: 'products', label: 'Produits', href: '/admin/produits', permission: 'catalog.read', icon: 'box' },
        { key: 'categories', label: 'Catégories', href: '/admin/categories', permission: 'catalog.read', icon: 'tree' },
        { key: 'brands', label: 'Marques', href: '/admin/marques', permission: 'catalog.read', icon: 'tag' },
        { key: 'stock', label: 'Stock', href: '/admin/stock', permission: 'stock.read', icon: 'layers', badge: countLowStock() },
        { key: 'imports', label: 'Import / export', href: '/admin/import', permission: 'imports.run', icon: 'upload' },
      ],
    },
    {
      label: 'Relation client',
      items: [
        { key: 'customers', label: 'Clients', href: '/admin/clients', permission: 'customers.read', icon: 'users' },
        { key: 'media', label: 'Médiathèque', href: '/admin/medias', permission: 'catalog.read', icon: 'image' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { key: 'settings', label: 'Réglages', href: '/admin/reglages', permission: 'settings.read', icon: 'sliders' },
        { key: 'users', label: 'Utilisateurs', href: '/admin/utilisateurs', permission: 'users.read', icon: 'shield' },
        { key: 'audit', label: 'Journal', href: '/admin/journal', permission: 'audit.read', icon: 'list' },
        { key: 'backups', label: 'Sauvegardes', href: '/admin/sauvegardes', permission: 'settings.read', icon: 'database' },
      ],
    },
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => can(i.permission)) })).filter((g) => g.items.length);
}

function countOpenOrders() {
  try {
    return db.get("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('cancelled','refunded','delivered')").n;
  } catch { return 0; }
}
function countQuotes() {
  try {
    return db.get("SELECT COUNT(*) AS n FROM orders WHERE quote_required = 1 AND quote_status IN ('requested','sent')").n;
  } catch { return 0; }
}
function countCash() {
  try {
    return db.get("SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'awaiting_confirmation' AND status != 'cancelled'").n;
  } catch { return 0; }
}
function countLowStock() {
  try {
    return db.get(
      `SELECT COUNT(*) AS n FROM products p WHERE p.status = 'published' AND p.track_stock = 1 AND p.low_stock_threshold > 0
        AND COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si WHERE si.product_id = p.id),0) <= p.low_stock_threshold`
    ).n;
  } catch { return 0; }
}

/* ------------------------------------------------------------------ */
/* Sous-modules                                                        */
/* ------------------------------------------------------------------ */
router.use('/', require('./catalog'));
router.use('/', require('./orders'));
router.use('/', require('./inventory'));
router.use('/', require('./customers'));
router.use('/', require('./imports'));
router.use('/', require('./settings'));
router.use('/', require('./system'));

module.exports = router;
