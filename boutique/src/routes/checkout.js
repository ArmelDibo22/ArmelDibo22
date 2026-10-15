'use strict';

/**
 * Tunnel de commande : validation, paiement, confirmation.
 *
 * - Achat sans compte possible ; l'adresse e-mail n'est exigée que si le
 *   réglage `commerce.email_required` l'impose.
 * - Tous les montants (articles, remise, livraison) sont recalculés côté
 *   serveur au moment de la validation.
 * - Une clé d'idempotence empêche la création de commandes en double
 *   (double clic, renvoi de formulaire, réseau instable).
 */

const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const orders = require('../domain/orders');
const cart = require('../domain/cart');
const payments = require('../domain/payments');
const shipping = require('../domain/shipping');
const settings = require('../lib/settings');
const money = require('../lib/money');
const dates = require('../lib/dates');
const config = require('../config');
const ids = require('../lib/ids');
const { flash, isAjax, notFound } = require('../lib/http');
const { formatPhone } = require('../lib/validate');
const auth = require('../middleware/auth');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

/**
 * Forme « affichage » d'un moyen de paiement : le gabarit ne manipule que des
 * champs stables, identiques en rendu direct et en réponse AJAX.
 */
function serializeMethods(list) {
  return (list || []).map((m) => ({
    code: m.code,
    name: m.name,
    kind: m.kind,
    color: m.color || '',
    logoKey: m.logo_key || '',
    instructions: m.instructions || '',
    merchantRef: m.merchant_ref || '',
    allowed: Boolean(m.allowed),
    unavailableReason: m.unavailableReason || '',
    stateKey: (m.state && m.state.key) || m.stateKey || '',
    stateLabel: (m.state && m.state.label) || m.stateLabel || '',
    isCash: Boolean(m.isCash),
    simulated: Boolean(m.simulated),
  }));
}

/* ------------------------------------------------------------------ */
/* Étape 1 : coordonnées, mode de réception, moyen de paiement         */
/* ------------------------------------------------------------------ */
router.get('/commande', (req, res) => {
  const current = req.cart ? cart.loadCart(req.cart.id, req.cart.token) : null;
  if (!current || !current.items.length) {
    flash(req, 'info', 'Votre panier est vide.');
    return res.redirect('/catalogue');
  }

  const pickupZone = shipping.pickupZone();
  const deliveryZones = shipping.deliveryZones();
  const mode = req.query.mode === 'delivery' ? 'delivery' : 'pickup';
  const selectedZone =
    req.query.zone && mode === 'delivery'
      ? shipping.getZone(req.query.zone)
      : mode === 'pickup'
        ? pickupZone
        : deliveryZones[0] || null;

  const totals = orders.computeTotals(
    current.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })),
    { zoneId: selectedZone?.id || null, cartId: current.id }
  );

  const methods = payments.methodsForCheckout({ mode, zone: selectedZone, subtotal: totals.subtotal });
  const customer = req.customer
    ? db.get('SELECT * FROM customers WHERE id = ?', [req.customer.id])
    : null;

  const idempotencyKey = ids.token(16);
  if (!req.session) req.session = {};

  res.renderPage('checkout', {
    title: 'Valider ma commande',
    canonical: '/commande',
    noindex: true,
    cart: current,
    totals,
    mode,
    pickupZone,
    deliveryZones,
    selectedZone,
    methods: serializeMethods(methods),
    customer,
    values: {
      fullName: req.query.nom || customer?.full_name || req.customer?.fullName || '',
      phone: req.query.telephone || customer?.phone || '',
      email: req.query.email || customer?.email || req.customer?.email || '',
      city: req.query.ville || customer?.city || '',
      quarter: req.query.quartier || '',
      address: req.query.adresse || customer?.address || '',
      landmark: req.query.repere || '',
      recipientName: req.query.destinataire || '',
      recipientPhone: req.query.destinataire_tel || '',
      note: req.query.note || '',
      terms: req.query.cgu === '1',
      marketing: req.query.marketing === '1',
      paymentMethod: req.query.paiement || '',
    },
    errors: {},
    idempotencyKey,
    emailRequired: Boolean(settings.get('commerce.email_required')),
    guestCheckout: Boolean(settings.get('commerce.guest_checkout')),
    marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
    shippingNote: settings.get('shipping.pickup_note'),
    quoteNote: settings.get('shipping.quote_note'),
    whatsappUrl: whatsapp.url(`Bonjour ${settings.get('store.short_name')}, j'ai une question avant de commander.`),
  });
});

/* ------------------------------------------------------------------ */
/* Recalcul des frais et des moyens de paiement (affichage en direct)   */
/* ------------------------------------------------------------------ */
/**
 * Le navigateur ne calcule jamais un montant : il demande au serveur le
 * résultat pour le mode et la zone choisis, et ne fait que l'afficher.
 */
router.get('/commande/frais', (req, res) => {
  const current = req.cart ? cart.loadCart(req.cart.id, req.cart.token) : null;
  if (!current || !current.items.length) {
    return res.status(400).json({ ok: false, error: 'Panier vide.' });
  }
  const mode = req.query.mode === 'delivery' ? 'delivery' : 'pickup';
  const zone =
    mode === 'pickup'
      ? shipping.pickupZone()
      : shipping.getZone(req.query.zone) || shipping.deliveryZones()[0] || null;

  const totals = orders.computeTotals(
    current.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })),
    { zoneId: zone ? zone.id : null, cartId: current.id }
  );
  const methods = payments.methodsForCheckout({ mode, zone, subtotal: totals.subtotal });

  const methodList = serializeMethods(methods);

  const payload = {
    ok: true,
    mode,
    zone: zone ? { id: zone.id, code: zone.code, name: zone.name, etaText: zone.eta_text || '', requiresQuote: Boolean(zone.requires_quote) } : null,
    subtotal: totals.subtotal,
    subtotalLabel: money.format(totals.subtotal),
    shipping: {
      status: totals.shipping.status,
      amount: totals.shipping.amount,
      amountLabel: totals.shipping.status === 'quote' ? 'Sur devis' : money.format(totals.shipping.amount || 0),
      message: totals.shipping.message || '',
      etaText: totals.shipping.etaText || '',
      codAllowed: Boolean(totals.shipping.codAllowed),
      freeOver: zone ? zone.free_over : null,
    },
    total: totals.total,
    totalLabel: totals.quoteRequired ? money.format(totals.subtotal) + ' + livraison sur devis' : money.format(totals.total),
    quoteRequired: totals.quoteRequired,
    quoteNote: settings.get('shipping.quote_note'),
    problems: totals.problems.map((pr) => pr.message),
    methods: methodList,
  };

  // Le bloc « moyens de paiement » est rendu côté serveur (EJS) puis renvoyé en
  // HTML : le navigateur n'a aucune règle métier à appliquer.
  res.render(
    'partials/checkout-methods',
    {
      methods: methodList,
      mode,
      zone,
      selectedMethod: String(req.query.paiement || ''),
      totals,
      bare: true,
    },
    (err, html) => {
      if (!err) payload.methodsHtml = html;
      res.json(payload);
    }
  );
});

/* ------------------------------------------------------------------ */
/* Étape 2 : enregistrement de la commande                             */
/* ------------------------------------------------------------------ */
router.post('/commande', auth.checkoutRateLimit(), (req, res, next) => {
  const current = req.cart ? cart.loadCart(req.cart.id, req.cart.token) : null;
  if (!current || !current.items.length) {
    flash(req, 'error', 'Votre panier est vide.');
    return res.redirect('/catalogue');
  }

  const idempotencyKey = String(req.body.idempotency_key || '').slice(0, 120) || null;
  const mode = req.body.mode === 'delivery' ? 'delivery' : 'pickup';

  // Les champs du formulaire portent des noms français : les mêmes noms servent
  // au renvoi en GET (recalcul des frais sans JavaScript) et à la création en POST.
  const field = (...names) => {
    for (const n of names) {
      if (req.body[n] !== undefined && req.body[n] !== null && String(req.body[n]).trim() !== '') return req.body[n];
    }
    return '';
  };
  const input = {
    fullName: field('nom', 'full_name', 'fullName'),
    phone: field('telephone', 'phone'),
    email: field('email'),
    city: field('ville', 'city'),
    quarter: field('quartier', 'quarter'),
    address: field('adresse', 'address'),
    landmark: field('repere', 'landmark'),
    recipientName: field('destinataire', 'recipient_name'),
    recipientPhone: field('destinataire_tel', 'recipient_phone'),
    note: field('note'),
    paymentMethod: field('paiement', 'payment_method'),
    zoneId: field('zone', 'zone_id'),
    terms: ['1', 'on', 'oui'].includes(String(req.body.cgu || req.body.terms || '')),
    marketing: ['1', 'on'].includes(String(req.body.marketing || '')),
  };

  // Double protection anti-doublon : la clé client + une empreinte du contenu.
  const contentFingerprint = ids.idempotencyKey(
    current.id,
    current.items.map((i) => `${i.productId}:${i.variantId || 0}:${i.qty}`).join(','),
    input.phone || '',
    mode
  );
  const effectiveKey = idempotencyKey ? `${idempotencyKey}:${contentFingerprint}` : contentFingerprint;

  // Garde-fou : le total annoncé à l'écran doit correspondre au total recalculé.
  // Évite qu'un changement de zone (ou de stock) ne produise un montant différent
  // de celui que le client a accepté.
  const expectedTotal = req.body.expected_total !== undefined && req.body.expected_total !== ''
    ? Number(req.body.expected_total)
    : null;
  const expectedZone = req.body.expected_zone ? Number(req.body.expected_zone) : null;
  const preCheck = orders.computeTotals(
    current.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })),
    { zoneId: input.zoneId || null, cartId: current.id }
  );
  if (expectedTotal != null && !Number.isNaN(expectedTotal) && !preCheck.quoteRequired) {
    if (expectedTotal !== preCheck.total || (expectedZone && expectedZone !== Number(input.zoneId || 0))) {
      flash(
        req,
        'warn',
        `Le montant a changé depuis votre dernière consultation (total actuel : ${money.format(preCheck.total)}). Vérifiez le récapitulatif puis confirmez à nouveau.`
      );
      return res.redirect(backToCheckout(req, mode));
    }
  }

  try {
    const { order, duplicate, paymentIntent } = orders.createOrder(
      {
        lines: current.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })),
        mode,
        zoneId: input.zoneId,
        customer: {
          fullName: input.fullName,
          phone: input.phone,
          email: input.email,
        },
        shippingInfo: {
          city: input.city,
          quarter: input.quarter,
          address: input.address,
          landmark: input.landmark,
          recipientName: input.recipientName,
          recipientPhone: input.recipientPhone,
        },
        paymentMethod: input.paymentMethod,
        note: input.note,
        termsAccepted: input.terms,
        marketingConsent: settings.get('commerce.marketing_consent_enabled') && input.marketing,
        cartId: current.id,
        idempotencyKey: effectiveKey,
      },
      { source: 'web' }
    );

    if (duplicate) {
      return res.redirect(`/commande/confirmation/${order.tracking_token}?doublon=1`);
    }

    // Le panier est converti : on repart d'un panier neuf.
    require('../lib/session').clearCartToken(res);
    req.cart = null;

    // Paiement en ligne : redirection vers la passerelle.
    if (paymentIntent && paymentIntent.ok && paymentIntent.type === 'redirect' && paymentIntent.url) {
      return res.redirect(paymentIntent.url);
    }

    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  } catch (err) {
    if (err.status === 409 || err.code === 'CART_INVALID') {
      flash(req, 'error', err.message);
      return res.redirect('/panier');
    }
    if (err.name === 'OrderError' && err.status === 400) {
      // Erreur de saisie : on redonne la main au tunnel avec les valeurs.
      const details = Array.isArray(err.details) ? err.details.map((d) => d.message).join(' ') : err.message;
      flash(req, 'error', details);
      return res.redirect(backToCheckout(req, mode));
    }
    return next(err);
  }
});

/**
 * Reconstruit l'URL du tunnel en conservant ce que le client avait saisi, pour
 * qu'une erreur de validation ne fasse pas perdre le formulaire.
 */
function backToCheckout(req, mode) {
  const keep = {
    mode,
    zone: req.body.zone || req.body.zone_id || '',
    nom: req.body.nom || req.body.full_name || '',
    telephone: req.body.telephone || req.body.phone || '',
    email: req.body.email || '',
    ville: req.body.ville || req.body.city || '',
    quartier: req.body.quartier || req.body.quarter || '',
    adresse: req.body.adresse || req.body.address || '',
    repere: req.body.repere || req.body.landmark || '',
    destinataire: req.body.destinataire || req.body.recipient_name || '',
    destinataire_tel: req.body.destinataire_tel || req.body.recipient_phone || '',
    note: req.body.note || '',
    paiement: req.body.paiement || req.body.payment_method || '',
    cgu: req.body.cgu || req.body.terms ? '1' : '',
    marketing: req.body.marketing ? '1' : '',
  };
  const qs = new URLSearchParams(Object.entries(keep).filter(([, v]) => v !== '' && v != null));
  return `/commande?${qs.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */
router.get('/commande/confirmation/:token', (req, res, next) => {
  const order = orders.getByTrackingToken(req.params.token);
  if (!order) return next(notFound('Commande introuvable.'));
  const full = orders.loadFull(order.id);
  const method = payments.getMethod(order.payment_method_code);
  const intent = db.get(
    `SELECT * FROM payments WHERE order_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'created' THEN 1 ELSE 2 END, id DESC LIMIT 1`,
    [order.id]
  );

  res.renderPage('confirmation', {
    title: `Commande ${order.reference}`,
    noindex: true,
    canonical: null,
    order: full,
    method,
    payment: intent,
    duplicate: req.query.doublon === '1',
    needsPayment:
      order.payment_status !== 'paid' &&
      order.status !== 'cancelled' &&
      !(order.quote_required && order.quote_status !== 'accepted') &&
      method &&
      !method.isCash,
    whatsappUrl: whatsapp.orderSummaryUrl(full),
  });
});

/* ------------------------------------------------------------------ */
/* Paiement d'une commande existante (nouvelle tentative)              */
/* ------------------------------------------------------------------ */
router.post('/commande/:token/payer', (req, res, next) => {
  const order = orders.getByTrackingToken(req.params.token);
  if (!order) return next(notFound('Commande introuvable.'));
  if (req.body.payment_method && req.body.payment_method !== order.payment_method_code) {
    const method = payments.getMethod(req.body.payment_method);
    if (!method) {
      flash(req, 'error', 'Moyen de paiement inconnu.');
      return res.redirect(`/commande/confirmation/${order.tracking_token}`);
    }
    const zone = order.zone_id ? shipping.getZone(order.zone_id) : null;
    const allowed = shipping.methodAllowedFor(method, { mode: order.fulfillment_mode, zone });
    if (!allowed.ok) {
      flash(req, 'error', allowed.reason);
      return res.redirect(`/commande/confirmation/${order.tracking_token}`);
    }
    db.update('orders', order.id, { payment_method_code: method.code, payment_status: 'unpaid', updated_at: dates.nowIso() });
    orders.logEvent(order.id, 'payment', order.payment_method_code, method.code, `Moyen de paiement modifié : ${method.name}.`, { public: 1 });
  }

  try {
    const intent = payments.initiateForOrder(order.id, { source: 'web' });
    if (intent.ok && intent.type === 'redirect' && intent.url) return res.redirect(intent.url);
    flash(req, 'success', intent.message || 'Paiement enregistré. Vous réglerez à la réception.');
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  } catch (err) {
    flash(req, 'error', err.message);
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  }
});

/* ------------------------------------------------------------------ */
/* Devis de livraison : acceptation ou refus par le client             */
/* ------------------------------------------------------------------ */
router.post('/commande/:token/devis', (req, res, next) => {
  const order = orders.getByTrackingToken(req.params.token);
  if (!order) return next(notFound('Commande introuvable.'));
  const action = String(req.body.action || '');
  try {
    if (action === 'accepter') {
      const updated = orders.acceptQuote(order.id, { customerToken: order.tracking_token });
      const intent = payments.initiateForOrder(updated.id, { source: 'web' });
      if (intent && intent.ok && intent.type === 'redirect' && intent.url) return res.redirect(intent.url);
      flash(req, 'success', 'Devis accepté. Vous pouvez finaliser le paiement.');
      return res.redirect(`/commande/confirmation/${order.tracking_token}`);
    }
    if (action === 'refuser') {
      orders.refuseQuote(order.id, { customerToken: order.tracking_token, reason: String(req.body.reason || '') });
      flash(req, 'info', 'Commande annulée à votre demande. Aucun paiement n’a été effectué.');
      return res.redirect(`/commande/confirmation/${order.tracking_token}`);
    }
    flash(req, 'error', 'Action inconnue.');
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  } catch (err) {
    flash(req, 'error', err.message);
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  }
});

/** Annulation par le client tant que la commande n'est ni payée ni préparée. */
router.post('/commande/:token/annuler', (req, res, next) => {
  const order = orders.getByTrackingToken(req.params.token);
  if (!order) return next(notFound('Commande introuvable.'));
  if (order.payment_status === 'paid') {
    flash(req, 'error', 'Cette commande est déjà réglée : contactez la boutique pour une annulation.');
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  }
  if (!['pending', 'quote_required', 'confirmed'].includes(order.status)) {
    flash(req, 'error', 'Cette commande est déjà en préparation : contactez la boutique.');
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  }
  try {
    orders.cancel(order.id, { reason: `Annulation par le client : ${String(req.body.reason || 'sans précision').slice(0, 200)}` });
    flash(req, 'info', 'Commande annulée. Le stock a été libéré.');
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  } catch (err) {
    flash(req, 'error', err.message);
    return res.redirect(`/commande/confirmation/${order.tracking_token}`);
  }
});

module.exports = router;
