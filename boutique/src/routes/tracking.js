'use strict';

/**
 * Suivi de commande sécurisé.
 *
 * Deux voies d'accès, toutes deux contrôlées côté serveur :
 *   1. le lien privé `/suivi/<jeton>` transmis après la commande (jeton
 *      aléatoire 192 bits, non devinable, distinct de la référence) ;
 *   2. le compte client, qui ne liste que les commandes du client connecté.
 *
 * Une recherche par référence seule est refusée : il faut aussi les quatre
 * derniers chiffres du téléphone de contact. Les tentatives sont limitées.
 * Le suivi public masque l'adresse complète et l'historique interne.
 */

const express = require('express');
const orders = require('../domain/orders');
const ratelimit = require('../lib/ratelimit');
const { flash, notFound } = require('../lib/http');
const { normalizeText } = require('../lib/slug');
const whatsapp = require('../lib/whatsapp');
const settings = require('../lib/settings');

const router = express.Router();

router.get('/suivi', (req, res) => {
  res.renderPage('tracking-lookup', {
    title: 'Suivre ma commande',
    canonical: '/suivi',
    noindex: true,
    error: req.query.erreur ? decodeURIComponent(String(req.query.erreur)) : '',
  });
});

router.post(
  '/suivi',
  ratelimit.middleware({
    keyPrefix: 'rl-tracking',
    windowMs: 15 * 60_000,
    max: 8,
    keyFn: () => 'lookup',
  }),
  (req, res) => {
    const reference = normalizeText(req.body.reference || '').toUpperCase();
    const digits = String(req.body.phone || '').replace(/\D/g, '').slice(-4);
    if (!reference || digits.length < 4) {
      return res.redirect(`/suivi?erreur=${encodeURIComponent('Indiquez la référence de commande et les 4 derniers chiffres du téléphone.')}`);
    }
    const order = orders.getByReference(reference);
    if (!order || String(order.recipient_phone || '').replace(/\D/g, '').slice(-4) !== digits) {
      // Réponse volontairement imprécise : ne révèle pas si la référence existe.
      return res.redirect(
        `/suivi?erreur=${encodeURIComponent('Aucune commande ne correspond à ces informations.')}`
      );
    }
    return res.redirect(`/suivi/${order.tracking_token}`);
  }
);

router.get('/suivi/:token', (req, res, next) => {
  const tracked = orders.forTracking(req.params.token);
  if (!tracked) return next(notFound('Lien de suivi introuvable ou expiré.'));
  const carrier = tracked.carrier;
  res.renderPage('tracking', {
    title: `Suivi ${tracked.reference}`,
    noindex: true,
    canonical: null,
    order: tracked,
    carrier,
    whatsappUrl: whatsapp.orderSummaryUrl(tracked),
    steps: buildSteps(tracked),
  });
});

/** Construit une chronologie lisible pour le client (étapes publiques uniquement). */
function buildSteps(order) {
  const steps = [];
  const push = (label, detail, at, state) => steps.push({ label, detail, at, state });

  push('Commande enregistrée', 'Votre commande a bien été reçue.', order.placed_at, 'done');

  const paid = order.payment_status === 'paid' || order.payment_status === 'partially_refunded' || order.payment_status === 'refunded';
  if (order.quote_required && order.quote_status !== 'accepted') {
    push('Devis de livraison', "Aucun tarif n'étant défini pour cette destination, la boutique doit vous proposer un montant.", order.quote_sent_at, order.quote_status === 'sent' ? 'current' : 'pending');
  }
  if (order.payment_method_code === 'pay_at_pickup' || order.payment_method_code === 'pay_on_delivery') {
    push(
      'Paiement à la réception',
      paid ? 'Encaissement confirmé par la boutique.' : "Le règlement s'effectuera à la réception. La boutique confirmera l'encaissement.",
      order.paid_at,
      paid ? 'done' : 'current'
    );
  } else {
    push('Paiement', paid ? 'Paiement confirmé.' : 'En attente de confirmation du paiement.', order.paid_at, paid ? 'done' : 'current');
  }

  if (order.fulfillment_mode === 'pickup') {
    push('Préparation', order.delivery_status === 'in_preparation' ? 'En cours de préparation.' : 'À venir.', null, order.delivery_status === 'in_preparation' ? 'current' : 'pending');
    push('Disponible au retrait', order.delivery_status === 'pickup_ready' ? 'Votre commande vous attend en boutique.' : 'À venir.', null, order.delivery_status === 'pickup_ready' ? 'current' : 'pending');
    push('Retrait effectué', order.delivery_status === 'picked_up' ? 'Merci de votre visite.' : 'À venir.', null, order.delivery_status === 'picked_up' ? 'done' : 'pending');
  } else {
    push('Préparation', order.delivery_status === 'in_preparation' ? 'En cours de préparation.' : 'À venir.', null, order.delivery_status === 'in_preparation' ? 'current' : 'pending');
    push('Remise au transporteur', order.delivery_status === 'handed_to_carrier' ? 'Colis pris en charge.' : 'À venir.', null, order.delivery_status === 'handed_to_carrier' ? 'current' : 'pending');
    push('En transit', order.delivery_status === 'in_transit' ? 'Acheminement en cours.' : 'À venir.', null, order.delivery_status === 'in_transit' ? 'current' : 'pending');
    push('Livraison', order.delivery_status === 'delivered' ? 'Colis livré.' : 'À venir.', null, order.delivery_status === 'delivered' ? 'done' : 'pending');
  }

  if (order.status === 'cancelled') {
    steps.forEach((s) => { s.state = 'cancelled'; });
    push('Commande annulée', order.cancel_reason || 'Annulée.', order.cancelled_at, 'cancelled');
  }

  for (const event of order.deliveryEvents || []) {
    if (!event.public) continue;
    steps.push({ label: event.label, detail: event.detail || event.location || '', at: event.happened_at, state: 'info' });
  }
  steps.sort((a, b) => (a.at && b.at ? String(a.at).localeCompare(String(b.at)) : a.at ? -1 : b.at ? 1 : 0));
  return steps;
}

module.exports = router;
module.exports.buildSteps = buildSteps;
