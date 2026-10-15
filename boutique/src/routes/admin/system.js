'use strict';

/** Utilisateurs et rôles, statistiques, journal d'audit, sauvegardes. */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('../../db');
const users = require('../../domain/users');
const stats = require('../../domain/stats');
const orders = require('../../domain/orders');
const pos = require('../../domain/pos');
const payments = require('../../domain/payments');
const products = require('../../domain/products');
const backups = require('../../lib/backups');
const config = require('../../config');
const csv = require('../../lib/csv');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const { flash, notFound } = require('../../lib/http');
const { Validator } = require('../../lib/validate');
const { normalizeText } = require('../../lib/slug');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Statistiques                                                        */
/* ------------------------------------------------------------------ */
router.get('/statistiques', auth.requirePermission('stats.read'), (req, res) => {
  const from = req.query.du || '';
  const to = req.query.au || '';
  const days = Number(req.query.jours) || 30;
  res.render('admin/stats', {
    title: 'Statistiques',
    activeNav: 'stats',
    from,
    to,
    days,
    totals: stats.totals({ from: from || null, to: to || null }),
    series: stats.dailySeries(from && to ? { from, to } : { days }),
    topProducts: stats.topProducts({ from: from || null, to: to || null, limit: 15 }),
    byZone: stats.salesByZone({ from: from || null, to: to || null }),
    byPayment: stats.salesByPayment({ from: from || null, to: to || null }),
    paymentSummary: payments.summary(),
    posTotals: pos.totals({ from: from || null, to: to || null }),
    productCounts: products.counts(),
  });
});

router.get('/statistiques/export.csv', auth.requirePermission('stats.read'), (req, res) => {
  const from = req.query.du || null;
  const to = req.query.au || null;
  const series = stats.dailySeries(from && to ? { from, to } : { days: Number(req.query.jours) || 30 });
  const headers = ['Date', 'Commandes reçues', 'Montant commandé', 'Paiements encaissés', 'Montant encaissé', 'Ventes boutique', 'Montant boutique', 'Remboursements', 'Montant remboursé'];
  const rows = series.map((d) => [
    d.date,
    d.orders,
    csv.safeCell(d.ordersAmount),
    d.paid,
    csv.safeCell(d.paidAmount),
    d.pos,
    csv.safeCell(d.posAmount),
    d.refunds,
    csv.safeCell(d.refundsAmount),
  ]);
  res
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="statistiques-${dates.todayInTz()}.csv"`)
    .send(csv.stringify(headers, rows));
});

/* ------------------------------------------------------------------ */
/* Utilisateurs et rôles                                               */
/* ------------------------------------------------------------------ */
router.get('/utilisateurs', auth.requirePermission('users.read'), (req, res) => {
  res.render('admin/users', {
    title: 'Utilisateurs',
    activeNav: 'users',
    users: users.listUsers(),
    roles: users.ROLES,
    permissions: users.PERMISSIONS,
    errors: {},
  });
});

router.post('/utilisateurs', auth.requirePermission('users.write'), auth.requireRole('admin'), (req, res) => {
  const v = new Validator(req.body);
  v.email('email', { required: true, label: 'Adresse e-mail' });
  v.string('fullName', { max: 160, label: 'Nom complet' });
  v.phone('phone', { required: false });
  v.string('password', { required: true, min: 10, max: 200, label: 'Mot de passe' });
  v.enum('role', ['admin', 'vendor'], { fallback: 'vendor', label: 'Rôle' });
  v.boolean('canConfirmCash');
  v.boolean('active', { fallback: true });
  if (!v.valid) {
    flash(req, 'error', Object.values(v.errors)[0]);
    return res.redirect('/admin/utilisateurs');
  }
  try {
    users.createUser({
      email: v.values.email,
      password: v.values.password,
      fullName: v.values.fullName,
      phone: v.values.phone,
      role: v.values.role,
      canConfirmCash: v.values.canConfirmCash,
      active: v.values.active,
    }, req.admin.user);
    flash(req, 'success', `Compte créé : ${v.values.email}.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/utilisateurs');
});

router.post('/utilisateurs/:id', auth.requirePermission('users.write'), auth.requireRole('admin'), (req, res) => {
  try {
    users.updateUser(Number(req.params.id), {
      fullName: req.body.fullName,
      phone: req.body.phone,
      email: req.body.email,
      role: req.body.role,
      active: req.body.active === '1',
      canConfirmCash: req.body.canConfirmCash === '1',
      password: req.body.password || undefined,
    }, req.admin.user);
    flash(req, 'success', 'Utilisateur mis à jour.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/utilisateurs');
});

router.post('/utilisateurs/:id/supprimer', auth.requirePermission('users.write'), auth.requireRole('admin'), (req, res) => {
  try {
    users.deleteUser(Number(req.params.id), req.admin.user);
    flash(req, 'info', 'Utilisateur supprimé.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/utilisateurs');
});

/* ------------------------------------------------------------------ */
/* Journal d'audit                                                     */
/* ------------------------------------------------------------------ */
router.get('/journal', auth.requirePermission('audit.read'), (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 100;
  const result = users.auditList({
    limit: perPage,
    offset: (page - 1) * perPage,
    entityType: req.query.entite || null,
    userId: req.query.utilisateur ? Number(req.query.utilisateur) : null,
  });
  res.render('admin/audit', {
    title: 'Journal d’audit',
    activeNav: 'audit',
    items: result.items,
    total: result.total,
    pagination: { page, perPage, total: result.total, pages: Math.max(1, Math.ceil(result.total / perPage)), hasNext: page * perPage < result.total, hasPrev: page > 1 },
    entityTypes: db.all('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type').map((r) => r.entity_type),
    filters: { entite: req.query.entite || '', utilisateur: req.query.utilisateur || '' },
  });
});

/* ------------------------------------------------------------------ */
/* Sauvegardes et restauration                                         */
/* ------------------------------------------------------------------ */
router.get('/sauvegardes', auth.requirePermission('settings.read'), (req, res) => {
  res.render('admin/backups', {
    title: 'Sauvegardes',
    activeNav: 'backups',
    backups: backups.listBackups(),
    dbPath: config.db.path,
    dbSize: fs.existsSync(config.db.path) ? fs.statSync(config.db.path).size : 0,
    mediaDir: config.storage.mediaDir,
    integrity: db.integrityCheck(),
    autoEnabled: require('../../lib/settings').get('backup.auto_enabled'),
    retention: require('../../lib/settings').get('backup.retention'),
    counts: {
      products: db.get('SELECT COUNT(*) AS n FROM products').n,
      orders: db.get('SELECT COUNT(*) AS n FROM orders').n,
      customers: db.get('SELECT COUNT(*) AS n FROM customers').n,
      media: db.get('SELECT COUNT(*) AS n FROM media_files').n,
    },
  });
});

router.post('/sauvegardes/creer', auth.requirePermission('settings.write'), auth.requireRole('admin'), (req, res, next) => {
  try {
    const full = req.body.complet === '1';
    const result = full ? backups.backupFull() : backups.backupDatabase();
    backups.prune(Number(require('../../lib/settings').get('backup.retention')) || 14);
    db.insert('audit_log', {
      user_id: req.admin.user.id, actor: 'admin', action: 'backup.create', entity_type: 'backup',
      entity_id: path.basename(result.archive || result.database), detail: JSON.stringify({ full }),
    });
    flash(req, 'success', `Sauvegarde créée : ${path.basename(result.archive || result.database)} (${result.integrity ? `intégrité ${result.integrity.integrity}` : 'base seule'}).`);
    return res.redirect('/admin/sauvegardes');
  } catch (err) { return next(err); }
});

router.get('/sauvegardes/telecharger/:name', auth.requirePermission('settings.write'), auth.requireRole('admin'), (req, res, next) => {
  const name = path.basename(String(req.params.name || ''));
  const file = path.join(config.storage.backupDir, name);
  if (!name || name.includes('..') || !fs.existsSync(file)) return next(notFound('Sauvegarde introuvable.'));
  res.download(file, name);
});

router.get('/sauvegardes/export-json', auth.requirePermission('settings.write'), auth.requireRole('admin'), (req, res, next) => {
  try {
    const { json } = backups.exportJson();
    res
      .setHeader('Content-Type', 'application/json; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="export-complet-${dates.todayInTz()}.json"`)
      .send(json);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Export des commandes (comptabilité)                                 */
/* ------------------------------------------------------------------ */
router.get('/exports/commandes.csv', auth.requirePermission('orders.read'), (req, res) => {
  const rows = db.all(
    `SELECT o.*, z.name AS zone_name, c.name AS carrier_name, pm.name AS method_name
       FROM orders o
       LEFT JOIN shipping_zones z ON z.id = o.zone_id
       LEFT JOIN carriers c ON c.id = o.carrier_id
       LEFT JOIN payment_methods pm ON pm.code = o.payment_method_code
      ORDER BY o.placed_at DESC`
  );
  const headers = ['Référence', 'Date', 'Statut', 'Paiement', 'Livraison', 'Mode', 'Zone', 'Client', 'Téléphone', 'Ville', 'Moyen de paiement', 'Sous-total', 'Remise', 'Frais de livraison', 'Total', 'Encaissé', 'Remboursé', 'Transporteur', 'Suivi'];
  const body = rows.map((o) => [
    csv.safeCell(o.reference),
    dates.formatDateTime(o.placed_at),
    orders.labelOf(o.status),
    o.payment_status,
    o.delivery_status,
    o.fulfillment_mode === 'pickup' ? 'Retrait' : 'Livraison',
    csv.safeCell(o.zone_name || ''),
    csv.safeCell(o.recipient_name),
    csv.safeCell(o.recipient_phone),
    csv.safeCell(o.city || ''),
    csv.safeCell(o.method_name || o.payment_method_code),
    o.subtotal, o.discount, o.shipping_cost, o.total, o.amount_paid, o.amount_refunded,
    csv.safeCell(o.carrier_name || ''),
    csv.safeCell(o.tracking_reference || ''),
  ]);
  res
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="commandes-${dates.todayInTz()}.csv"`)
    .send(csv.stringify(headers, body));
});

router.get('/exports/ventes.csv', auth.requirePermission('pos.read'), (req, res) => {
  const rows = db.all('SELECT s.*, u.full_name AS user_name FROM pos_sales s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC');
  const headers = ['Référence', 'Date', 'Vendeur', 'Client', 'Téléphone', 'Sous-total', 'Remise', 'Total', 'Reçu', 'Rendu', 'Moyen', 'Statut'];
  const body = rows.map((s) => [
    csv.safeCell(s.reference),
    dates.formatDateTime(s.created_at),
    csv.safeCell(s.user_name || ''),
    csv.safeCell(s.customer_name || ''),
    csv.safeCell(s.customer_phone || ''),
    s.subtotal, s.discount, s.total, s.amount_paid, s.change_due,
    csv.safeCell(s.method_code),
    s.status,
  ]);
  res
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="ventes-boutique-${dates.todayInTz()}.csv"`)
    .send(csv.stringify(headers, body));
});

/* ------------------------------------------------------------------ */
/* État technique (diagnostic)                                         */
/* ------------------------------------------------------------------ */
router.get('/etat', auth.requirePermission('settings.read'), (req, res) => {
  res.render('admin/status', {
    title: 'État technique',
    activeNav: 'settings',
    integrity: db.integrityCheck(),
    migrations: db.all('SELECT * FROM schema_migrations ORDER BY version'),
    dbPath: config.db.path,
    dbSize: fs.existsSync(config.db.path) ? fs.statSync(config.db.path).size : 0,
    mediaSize: dirSize(config.storage.mediaDir),
    env: {
      node: process.version,
      env: config.env,
      demo: config.isDemo,
      publicUrl: config.publicUrl,
      simulation: config.payments.simulationEnabled,
      webhookSecret: Boolean(config.secrets.paymentWebhook),
      trustProxy: config.trustProxy,
      pageSize: config.commerce.catalogPageSize,
    },
    tables: db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map((t) => ({ name: t.name, rows: db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n })),
    outbox: db.all("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"),
    webhookStats: require('../../domain/payments/webhook').stats(),
    reservations: db.all("SELECT status, COUNT(*) AS n, COALESCE(SUM(qty),0) AS qty FROM reservations GROUP BY status"),
  });
});

function dirSize(dir) {
  try {
    let total = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return total;
  } catch {
    return 0;
  }
}

module.exports = router;
