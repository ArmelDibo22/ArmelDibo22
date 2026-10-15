'use strict';

/** Clients : consultation dans les limites des permissions, consentement, export. */

const express = require('express');
const db = require('../../db');
const users = require('../../domain/users');
const orders = require('../../domain/orders');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const csv = require('../../lib/csv');
const { flash, notFound } = require('../../lib/http');
const { normalizeText } = require('../../lib/slug');
const { formatPhone } = require('../../lib/validate');

const router = express.Router();

router.get('/clients', auth.requirePermission('customers.read'), (req, res) => {
  const result = users.listCustomers({
    page: Number(req.query.page) || 1,
    perPage: Number(req.query.par_page) || 25,
    q: req.query.q || '',
    consented: req.query.consentement || null,
  });
  res.render('admin/customers/list', {
    title: 'Clients',
    activeNav: 'customers',
    items: result.items,
    pagination: result.pagination,
    q: req.query.q || '',
    consented: req.query.consentement || '',
    formatPhone,
  });
});

router.get('/clients/:id', auth.requirePermission('customers.read'), (req, res, next) => {
  const customer = users.getCustomer(Number(req.params.id));
  if (!customer) return next(notFound('Client introuvable.'));
  res.render('admin/customers/detail', {
    title: customer.full_name || 'Client',
    activeNav: 'customers',
    customer,
    orders: customer.orders.map((o) => ({ ...o, totalLabel: money.format(o.total) })),
    refunds: db.all('SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.customer_id = ? ORDER BY r.id DESC', [customer.id]),
    canWrite: users.can(req.admin.user, 'customers.write'),
  });
});

router.post('/clients/:id/note', auth.requirePermission('customers.write'), (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [Number(req.params.id)]);
  if (!customer) { flash(req, 'error', 'Client introuvable.'); return res.redirect('/admin/clients'); }
  db.update('customers', customer.id, { notes: normalizeText(req.body.notes || '').slice(0, 2000), updated_at: dates.nowIso() });
  db.insert('audit_log', {
    user_id: req.admin.user.id,
    actor: 'admin',
    action: 'customer.note',
    entity_type: 'customer',
    entity_id: String(customer.id),
    detail: JSON.stringify({ length: normalizeText(req.body.notes || '').length }),
  });
  flash(req, 'success', 'Note enregistrée.');
  return res.redirect(`/admin/clients/${customer.id}`);
});

/** Retrait du consentement marketing à la demande du client. */
router.post('/clients/:id/consentement', auth.requirePermission('customers.write'), (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [Number(req.params.id)]);
  if (!customer) { flash(req, 'error', 'Client introuvable.'); return res.redirect('/admin/clients'); }
  const granted = req.body.marketing === '1';
  db.update('customers', customer.id, {
    marketing_consent: granted ? 1 : 0,
    consent_at: granted ? dates.nowIso() : null,
    updated_at: dates.nowIso(),
  });
  db.insert('audit_log', {
    user_id: req.admin.user.id,
    actor: 'admin',
    action: granted ? 'consent.granted' : 'consent.withdrawn',
    entity_type: 'customer',
    entity_id: String(customer.id),
    detail: JSON.stringify({ channel: 'admin' }),
  });
  flash(req, 'success', granted ? 'Consentement marketing enregistré.' : 'Consentement marketing retiré.');
  return res.redirect(`/admin/clients/${customer.id}`);
});

/** Anonymisation d'un client (droit à l'effacement) sans perdre la comptabilité. */
router.post('/clients/:id/anonymiser', auth.requirePermission('customers.write'), auth.requireRole('admin'), (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [Number(req.params.id)]);
  if (!customer) { flash(req, 'error', 'Client introuvable.'); return res.redirect('/admin/clients'); }
  db.transaction(() => {
    db.run('UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ?', [dates.nowIso(), customer.id]);
    db.update('customers', customer.id, {
      email: null,
      phone: '',
      full_name: 'Client anonymisé',
      password_hash: '',
      marketing_consent: 0,
      notes: 'Données personnelles effacées à la demande. Les commandes sont conservées pour les obligations comptables.',
      updated_at: dates.nowIso(),
    });
    db.run("UPDATE orders SET recipient_email = '', customer_note = '' WHERE customer_id = ?", [customer.id]);
    db.insert('audit_log', {
      user_id: req.admin.user.id,
      actor: 'admin',
      action: 'customer.anonymized',
      entity_type: 'customer',
      entity_id: String(customer.id),
      detail: JSON.stringify({ at: dates.nowIso() }),
    });
  });
  flash(req, 'info', 'Client anonymisé. Les commandes restent conservées à des fins comptables.');
  return res.redirect('/admin/clients');
});

/** Export CSV des clients (colonnes utiles uniquement). */
router.get('/exports/clients.csv', auth.requirePermission('customers.read'), (req, res) => {
  const rows = db.all('SELECT * FROM customers ORDER BY id DESC');
  const headers = ['id', 'Nom', 'Téléphone', 'E-mail', 'Consentement marketing', 'Compte créé', 'Commandes', 'Dernière commande'];
  const body = rows.map((c) => [
    c.id,
    csv.safeCell(c.full_name),
    csv.safeCell(formatPhone(c.phone)),
    csv.safeCell(c.email || ''),
    c.marketing_consent ? 'oui' : 'non',
    dates.formatDateTime(c.created_at),
    db.get('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?', [c.id]).n,
    dates.formatDateTime(db.get('SELECT MAX(placed_at) AS d FROM orders WHERE customer_id = ?', [c.id]).d),
  ]);
  res
    .setHeader('Content-Type', 'text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="clients-${dates.todayInTz()}.csv"`)
    .send(csv.stringify(headers, body));
});

module.exports = router;
