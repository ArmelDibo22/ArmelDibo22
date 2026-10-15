'use strict';

/**
 * Passerelle de démonstration (bac à sable).
 *
 * Pages visibles uniquement si PAYMENT_SIMULATION_ENABLED=true. Elles imitent
 * l'écran d'un prestataire Mobile Money pour permettre de tester le parcours
 * complet — succès, échec, annulation et notification répétée — avant toute
 * souscription réelle. Un bandeau permanent rappelle qu'aucun argent réel
 * n'est mouvementé.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const money = require('../lib/money');
const orders = require('../domain/orders');
const payments = require('../domain/payments');
const simulated = require('../domain/payments/providers/simulated');
const { notFound } = require('../lib/http');

const router = express.Router();

router.use((req, res, next) => {
  if (!config.payments.simulationEnabled) {
    return next(notFound('La passerelle de démonstration est désactivée sur cette installation.'));
  }
  next();
});

/** État technique de la passerelle de démonstration (diagnostic). */
router.get('/paiements/simuler/etat', (req, res) => {
  res.json({
    enabled: config.payments.simulationEnabled,
    webhookSecretConfigured: Boolean(config.secrets.paymentWebhook),
    recentEvents: db.all('SELECT id, provider, event_id, kind, signature_ok, status, received_at FROM webhook_events ORDER BY id DESC LIMIT 10'),
  });
});

router.get('/paiements/simuler/:reference', (req, res, next) => {
  const order = orders.getByReference(req.params.reference);
  if (!order) return next(notFound('Commande introuvable.'));
  const method = payments.getMethod(order.payment_method_code);
  const payment = db.get(
    `SELECT * FROM payments WHERE order_id = ? AND status IN ('created','pending') ORDER BY id DESC LIMIT 1`,
    [order.id]
  );
  const intent = db.get('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id]);
  const alreadyNotified = db.all('SELECT * FROM webhook_events WHERE provider = ? ORDER BY id DESC LIMIT 5', [simulated.name]);

  res.renderPage(
    'sandbox/gateway',
    {
      title: `Paiement de démonstration — ${order.reference}`,
      order,
      method,
      payment: payment || intent,
      total: money.format(order.total),
      alreadyNotified,
      sandbox: true,
      noLayoutChrome: true,
    },
    'layout-min'
  );
});

router.post('/paiements/simuler/:reference', async (req, res, next) => {
  const order = orders.getByReference(req.params.reference);
  if (!order) return next(notFound('Commande introuvable.'));

  const action = String(req.body.action || '');
  const method = payments.getMethod(order.payment_method_code);
  const providerReference =
    String(req.body.provider_reference || '').trim() ||
    `SIM-${order.reference}-${Date.now().toString(36).toUpperCase()}`;

  let status = 'succeeded';
  if (action === 'echec') status = 'failed';
  if (action === 'annulation') status = 'cancelled';

  // Montant modifiable pour tester le contrôle serveur (AMOUNT_MISMATCH).
  const amount =
    req.body.amount !== undefined && req.body.amount !== ''
      ? Math.round(Number(money.toCents(req.body.amount)))
      : Number(order.total);
  const currency = String(req.body.currency || order.currency);
  const repeat = Math.max(1, Math.min(5, Number(req.body.repeat) || 1));

  const results = [];
  const eventId = `sim-${order.reference}-${Date.now()}`;
  for (let i = 0; i < repeat; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await simulated.sendNotification({
      orderReference: order.reference,
      amount,
      currency,
      status,
      providerReference,
      // Même identifiant d'événement à chaque envoi : reproduit exactement le
      // comportement d'un prestataire qui renvoie la même notification. La
      // déduplication serveur doit répondre 200 {duplicate:true} sans repayer.
      eventId,
      reason: action === 'echec' ? 'Solde insuffisant (simulation)' : '',
    });
    results.push(outcome);
  }

  const fresh = orders.loadFull(order.id);
  res.renderPage(
    'sandbox/result',
    {
      title: `Résultat du paiement de démonstration — ${order.reference}`,
      order: fresh,
      method,
      results,
      action,
      amount,
      currency,
      sandbox: true,
    },
    'layout-min'
  );
});

module.exports = router;
