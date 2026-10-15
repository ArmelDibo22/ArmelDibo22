'use strict';

/** Administration des commandes : suivi, préparation, encaissements, devis, retours, impression. */

const express = require('express');
const db = require('../../db');
const orders = require('../../domain/orders');
const payments = require('../../domain/payments');
const shipping = require('../../domain/shipping');
const products = require('../../domain/products');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const { flash, notFound, queryString } = require('../../lib/http');
const { normalizeText } = require('../../lib/slug');
const whatsapp = require('../../lib/whatsapp');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Liste                                                               */
/* ------------------------------------------------------------------ */
router.get('/commandes', auth.requirePermission('orders.read'), (req, res) => {
  const filters = {
    q: req.query.q || '',
    status: req.query.statut || '',
    paymentStatus: req.query.paiement || '',
    deliveryStatus: req.query.livraison || '',
    mode: req.query.mode || '',
    zoneId: req.query.zone || '',
    from: req.query.du || '',
    to: req.query.au || '',
    group: req.query.groupe || '',
  };
  const result = orders.adminList(filters, { page: Number(req.query.page) || 1, perPage: Number(req.query.par_page) || 25 });
  res.render('admin/orders/list', {
    title: 'Commandes',
    activeNav: 'orders',
    items: result.items,
    pagination: result.pagination,
    filters,
    zones: shipping.listZones(),
    qs: queryString,
    counts: {
      open: db.get("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('cancelled','refunded','delivered')").n,
      quotes: db.get("SELECT COUNT(*) AS n FROM orders WHERE quote_required = 1 AND quote_status IN ('requested','sent')").n,
      cash: db.get("SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'awaiting_confirmation' AND status != 'cancelled'").n,
    },
  });
});

router.get('/commandes/:id', auth.requirePermission('orders.read'), (req, res, next) => {
  const order = orders.loadFull(Number(req.params.id));
  if (!order) return next(notFound('Commande introuvable.'));
  res.render('admin/orders/detail', {
    title: `Commande ${order.reference}`,
    activeNav: 'orders',
    order,
    carriers: shipping.listCarriers(),
    zones: shipping.listZones(),
    methods: payments.listMethods(),
    transitions: orders.ORDER_TRANSITIONS[order.status] || [],
    stockItems: order.items.map((i) => ({
      item: i,
      stockItem: i.stock_item_id ? db.get('SELECT * FROM stock_items WHERE id = ?', [i.stock_item_id]) : null,
      product: i.product_id ? products.rawProduct(i.product_id) : null,
    })),
    webhookEvents: db.all(
      'SELECT * FROM webhook_events WHERE payload LIKE ? ORDER BY id DESC LIMIT 10',
      [`%${order.reference}%`]
    ),
    whatsappUrl: whatsapp.orderSummaryUrl(order),
    canConfirmCash: require('../../domain/users').can(req.admin.user, 'cash.confirm'),
    kitDetails: order.items.filter((i) => i.is_kit).map((i) => ({ item: i, components: require('../../domain/stock').kitComponents(i.product_id) })),
  });
});

/** Vue détaillée par référence (raccourci depuis la caisse ou le suivi). */
router.get('/commandes/ref/:reference', auth.requirePermission('orders.read'), (req, res, next) => {
  const order = orders.getByReference(req.params.reference);
  if (!order) return next(notFound('Commande introuvable.'));
  return res.redirect(`/admin/commandes/${order.id}`);
});

/* ------------------------------------------------------------------ */
/* Statuts                                                             */
/* ------------------------------------------------------------------ */
router.post('/commandes/:id/statut', auth.requirePermission('orders.write'), (req, res, next) => {
  try {
    orders.setStatus(Number(req.params.id), String(req.body.status), {
      userId: req.admin.user.id,
      actorName: req.admin.user.fullName,
      note: normalizeText(req.body.note || ''),
    });
    flash(req, 'success', 'Statut de la commande mis à jour.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}`);
});

router.post('/commandes/:id/livraison', auth.requirePermission('orders.write'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (req.body.carrier_id !== undefined || req.body.tracking_reference !== undefined) {
      orders.setTracking(id, {
        carrierId: req.body.carrier_id ? Number(req.body.carrier_id) : null,
        trackingReference: normalizeText(req.body.tracking_reference || ''),
        userId: req.admin.user.id,
      });
      flash(req, 'success', 'Transporteur et référence de suivi enregistrés.');
    }
    if (req.body.delivery_status) {
      orders.setDeliveryStatus(id, String(req.body.delivery_status), {
        userId: req.admin.user.id,
        actorName: req.admin.user.fullName,
        note: normalizeText(req.body.note || ''),
      });
      flash(req, 'success', 'Étape de livraison mise à jour.');
    }
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#livraison`);
});

router.post('/commandes/:id/etapes', auth.requirePermission('orders.write'), (req, res, next) => {
  try {
    orders.addDeliveryEvent(Number(req.params.id), {
      label: req.body.label,
      detail: req.body.detail,
      location: req.body.location,
      happenedAt: req.body.happened_at ? dates.fromInput(req.body.happened_at) : null,
      isPublic: req.body.public === '1' ? 1 : 0,
      userId: req.admin.user.id,
    });
    flash(req, 'success', 'Étape de livraison ajoutée.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#livraison`);
});

router.post('/commandes/:id/note', auth.requirePermission('orders.write'), (req, res) => {
  const order = orders.getById(Number(req.params.id));
  if (!order) { flash(req, 'error', 'Commande introuvable.'); return res.redirect('/admin/commandes'); }
  db.update('orders', order.id, { internal_note: normalizeText(req.body.internal_note || '').slice(0, 2000), updated_at: dates.nowIso() });
  orders.logEvent(order.id, 'note', '', '', normalizeText(req.body.internal_note || '').slice(0, 300), { actorId: req.admin.user.id, actorName: req.admin.user.fullName });
  flash(req, 'success', 'Note interne enregistrée.');
  return res.redirect(`/admin/commandes/${order.id}`);
});

/* ------------------------------------------------------------------ */
/* Encaissements                                                       */
/* ------------------------------------------------------------------ */
router.post('/commandes/:id/encaisser', auth.requirePermission('orders.write'), (req, res) => {
  try {
    orders.loadFull(Number(req.params.id));
    payments.confirmCashCollection(Number(req.params.id), {
      user: req.admin.user,
      amount: req.body.amount === '' || req.body.amount === undefined ? null : money.toCents(req.body.amount),
      note: normalizeText(req.body.note || ''),
    });
    flash(req, 'success', 'Encaissement confirmé. Le stock est sorti et la commande passe en confirmée.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#paiement`);
});

router.post('/commandes/:id/encaissement-refuser', auth.requirePermission('orders.write'), (req, res) => {
  try {
    payments.rejectCashCollection(Number(req.params.id), { user: req.admin.user, reason: req.body.reason });
    flash(req, 'info', 'Encaissement non confirmé : la commande repasse en non payée.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#paiement`);
});

/** Relance du paiement (éventuellement avec un autre moyen) côté passerelle. */
router.post('/commandes/:id/relancer-paiement', auth.requirePermission('orders.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Changement de moyen de paiement demandé par l'opérateur : uniquement si la
    // commande n'est pas déjà réglée, et le moyen doit être autorisé pour le mode
    // et la zone (règles identiques à celles appliquées au client).
    if (req.body.payment_method) {
      const order = orders.getById(id);
      if (!order) throw notFound('Commande introuvable.');
      if (order.payment_status === 'paid') throw Object.assign(new Error('Commande déjà réglée : moyen inchangé.'), { status: 409 });
      const method = payments.getMethod(String(req.body.payment_method));
      if (!method) throw Object.assign(new Error('Moyen de paiement inconnu.'), { status: 400 });
      if (method.code !== order.payment_method_code) {
        const zone = order.zone_id ? shipping.getZone(order.zone_id) : null;
        const allowed = shipping.methodAllowedFor(method, { mode: order.fulfillment_mode, zone });
        if (!allowed.ok) throw Object.assign(new Error(allowed.reason), { status: 409 });
        db.update('orders', order.id, { payment_method_code: method.code, payment_status: 'unpaid', updated_at: dates.nowIso() });
        orders.logEvent(order.id, 'payment', order.payment_method_code, method.code, `Moyen de paiement modifié par l'administration : ${method.name}.`, {
          actorId: req.admin.user.id,
          actorName: req.admin.user.fullName,
          public: 1,
        });
      }
    }
    const intent = payments.initiateForOrder(id, { source: 'admin' });
    if (intent.ok && intent.type === 'redirect') {
      flash(req, 'success', 'Nouvelle tentative de paiement générée.');
    } else if (intent.needsQuote) {
      flash(req, 'warn', 'Le devis de livraison doit d’abord être accepté par le client.');
    } else {
      flash(req, 'info', intent.message || 'Paiement enregistré.');
    }
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#paiement`);
});

/* ------------------------------------------------------------------ */
/* Devis de livraison                                                  */
/* ------------------------------------------------------------------ */
router.post('/commandes/:id/devis', auth.requirePermission('orders.write'), (req, res) => {
  const action = String(req.body.action || '');
  try {
    const id = Number(req.params.id);
    if (action === 'envoyer') {
      orders.sendQuote(id, money.toCents(req.body.amount), { note: req.body.note, userId: req.admin.user.id });
      flash(req, 'success', 'Devis envoyé. Le client peut l’accepter depuis son lien de suivi.');
    } else if (action === 'accepter') {
      orders.acceptQuote(id, { userId: req.admin.user.id });
      flash(req, 'success', 'Devis accepté (saisi par l’administration au téléphone du client).');
    } else {
      flash(req, 'error', 'Action inconnue.');
    }
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#livraison`);
});

/* ------------------------------------------------------------------ */
/* Annulation, retours, remboursements                                 */
/* ------------------------------------------------------------------ */
router.post('/commandes/:id/annuler', auth.requirePermission('orders.cancel'), (req, res) => {
  try {
    orders.cancel(Number(req.params.id), {
      reason: normalizeText(req.body.reason || ''),
      userId: req.admin.user.id,
      restock: req.body.restock !== '0',
    });
    flash(req, 'info', 'Commande annulée et stock restitué.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}`);
});

router.post('/commandes/:id/remboursement', auth.requirePermission('orders.refund'), (req, res) => {
  try {
    const items = (Array.isArray(req.body.lignes) ? req.body.lignes : String(req.body.lignes || '').split(','))
      .map((v) => {
        const [orderItemId, qty] = String(v).split(':');
        return { orderItemId: Number(orderItemId), qty: Number(qty) || 1 };
      })
      .filter((l) => l.orderItemId);

    const refund = orders.createRefund(Number(req.params.id), {
      kind: ['return', 'refund', 'cancellation', 'exchange'].includes(req.body.kind) ? req.body.kind : 'refund',
      amount: money.toCents(req.body.amount) || 0,
      items,
      method: normalizeText(req.body.method || ''),
      reason: normalizeText(req.body.reason || ''),
      restock: req.body.restock === '1',
      userId: req.admin.user.id,
      status: req.body.appliquer === '1' ? 'done' : 'pending',
    });
    flash(req, 'success', `Remboursement de ${money.format(refund.amount)} enregistré (${refund.status === 'done' ? 'appliqué' : 'en attente de validation'}).`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.params.id}#retours`);
});

router.post('/remboursements/:id/appliquer', auth.requirePermission('orders.refund'), (req, res) => {
  try {
    const refund = db.get('SELECT * FROM refunds WHERE id = ?', [Number(req.params.id)]);
    if (!refund) throw notFound('Remboursement introuvable.');
    orders.applyRefund(refund.id, { userId: req.admin.user.id });
    flash(req, 'success', 'Remboursement appliqué.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/commandes/${req.body.order_id || ''}`);
});

/* ------------------------------------------------------------------ */
/* Impression du récapitulatif                                         */
/* ------------------------------------------------------------------ */
router.get('/commandes/:id/impression', auth.requirePermission('orders.read'), (req, res, next) => {
  const data = orders.printData(Number(req.params.id));
  if (!data) return next(notFound('Commande introuvable.'));
  res.render('admin/orders/print', {
    ...data,
    title: `Récapitulatif ${data.order.reference}`,
    bare: true,
    print: true,
    layout: false,
  });
});

module.exports = router;
