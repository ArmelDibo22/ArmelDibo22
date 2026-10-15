'use strict';

/**
 * Commandes : création, machine à états, suivi sécurisé, annulations, devis.
 *
 * Séparation stricte des trois statuts :
 *   status          — cycle de vie de la commande
 *   payment_status  — encaissement
 *   delivery_status — acheminement / mise à disposition
 *
 * Tous les montants sont recalculés côté serveur à partir du catalogue : aucune
 * valeur transmise par le navigateur n'est jamais utilisée pour facturer.
 */

const db = require('../db');
const dates = require('../lib/dates');
const config = require('../config');
const ids = require('../lib/ids');
const settings = require('../lib/settings');
const stock = require('./stock');
const products = require('./products');
const shipping = require('./shipping');
const { normalizeText } = require('../lib/slug');
const { normalizePhone } = require('../lib/validate');

const ORDER_STATUSES = [
  { value: 'pending', label: 'En attente', group: 'reçue' },
  { value: 'quote_required', label: 'Devis à établir', group: 'reçue' },
  { value: 'confirmed', label: 'Confirmée', group: 'reçue' },
  { value: 'preparing', label: 'En préparation', group: 'preparation' },
  { value: 'ready', label: 'Prête au retrait', group: 'preparation' },
  { value: 'shipped', label: 'Expédiée', group: 'livraison' },
  { value: 'delivered', label: 'Livrée', group: 'livraison' },
  { value: 'partially_refunded', label: 'Partiellement remboursée', group: 'clos' },
  { value: 'refunded', label: 'Remboursée', group: 'clos' },
  { value: 'cancelled', label: 'Annulée', group: 'clos' },
];

const PAYMENT_STATUSES = [
  { value: 'unpaid', label: 'Non payée' },
  { value: 'awaiting_confirmation', label: "En attente d'encaissement" },
  { value: 'paid', label: 'Payée' },
  { value: 'partially_refunded', label: 'Partiellement remboursée' },
  { value: 'refunded', label: 'Remboursée' },
  { value: 'failed', label: 'Échec de paiement' },
  { value: 'cancelled', label: 'Paiement annulé' },
];

const DELIVERY_STATUSES = [
  { value: 'none', label: 'Non démarrée' },
  { value: 'to_prepare', label: 'À préparer' },
  { value: 'in_preparation', label: 'En préparation' },
  { value: 'pickup_ready', label: 'Disponible au retrait' },
  { value: 'picked_up', label: 'Retirée par le client' },
  { value: 'handed_to_carrier', label: 'Remise au transporteur' },
  { value: 'in_transit', label: 'En transit' },
  { value: 'delivered', label: 'Livrée' },
  { value: 'returned', label: 'Retournée' },
  { value: 'cancelled', label: 'Annulée' },
];

/** Transitions autorisées du statut de commande. */
const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'quote_required', 'cancelled'],
  quote_required: ['pending', 'confirmed', 'cancelled'],
  confirmed: ['preparing', 'ready', 'shipped', 'delivered', 'cancelled'],
  preparing: ['ready', 'shipped', 'delivered', 'cancelled'],
  ready: ['delivered', 'shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  cancelled: [],
};

class OrderError extends Error {
  constructor(message, code = 'ORDER_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Calcul des totaux (serveur)                                         */
/* ------------------------------------------------------------------ */
/**
 * @param {Array<{productId:number, variantId?:number, qty:number}>} lines
 * @param {{zoneId?:number|string, discount?:number}} options
 */
function computeTotals(lines, { zoneId = null, discount = 0 } = {}) {
  const items = [];
  let subtotal = 0;
  let weightG = 0;
  const problems = [];

  for (const line of lines || []) {
    const product = products.rawProduct(line.productId);
    if (!product) {
      problems.push({ message: 'Article introuvable dans le catalogue.', line });
      continue;
    }
    const variant = line.variantId ? products.getVariant(line.variantId) : null;
    if (line.variantId && (!variant || variant.product_id !== product.id)) {
      problems.push({ message: `Variante invalide pour « ${product.name} ».`, line });
      continue;
    }
    const purchasability = products.purchasability(product, variant);
    if (!purchasability.ok) {
      problems.push({ message: `« ${product.name} » : ${purchasability.reasons[0]}`, line, product });
      continue;
    }
    const qty = Math.max(1, Math.min(Math.round(Number(line.qty) || 1), settings.get('commerce.max_qty_per_line')));
    const price = products.priceOf(product, variant);
    const availability = products.availabilityOf(product, variant);
    if (availability.status !== 'untracked' && qty > availability.available) {
      problems.push({
        message: `« ${product.name} » : ${availability.available} unité(s) disponible(s) pour ${qty} demandée(s).`,
        line,
        product,
        code: 'STOCK_INSUFFICIENT',
      });
      continue;
    }
    const lineTotal = price.sale * qty;
    subtotal += lineTotal;
    weightG += ((variant && variant.weight_g) || product.weight_g || 0) * qty;
    items.push({
      productId: product.id,
      variantId: variant ? variant.id : null,
      stockItemId: stock.itemFor(product.id, variant ? variant.id : null)?.id || null,
      sku: (variant && variant.sku) || product.sku || '',
      name: product.name,
      optionsLabel: variant ? Object.values(variant.options).filter(Boolean).join(' · ') : '',
      unit: product.sale_unit_label || products.SALE_UNITS.find((u) => u.value === product.sale_unit)?.label || 'Pièce',
      unitPrice: price.sale,
      originalPrice: price.base,
      qty,
      lineTotal,
      isKit: Boolean(product.is_kit),
      weightG: (variant && variant.weight_g) || product.weight_g || 0,
    });
  }

  const safeDiscount = Math.max(0, Math.min(Math.round(Number(discount) || 0), subtotal));
  const afterDiscount = Math.max(0, subtotal - safeDiscount);
  const shippingResult = shipping.resolveShipping({ zoneId, subtotal: afterDiscount, weightG });
  const shippingCost = shippingResult.status === 'quote' ? 0 : Number(shippingResult.amount || 0);

  return {
    items,
    problems,
    subtotal,
    discount: safeDiscount,
    weightG,
    shipping: shippingResult,
    shippingCost,
    quoteRequired: shippingResult.status === 'quote',
    total: afterDiscount + shippingCost,
    currency: settings.get('commerce.currency'),
    ok: problems.length === 0 && items.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Références                                                          */
/* ------------------------------------------------------------------ */
function nextReference(prefix = null) {
  const p = (prefix || settings.get('commerce.order_prefix') || 'PRV').toUpperCase().slice(0, 8);
  const year = dates.yearInTz();
  const row = db.get("SELECT COUNT(*) AS n FROM orders WHERE reference LIKE ?", [`${p}-${year}-%`]);
  let seq = (row?.n || 0) + 1;
  let candidate = ids.orderReference(p, year, seq);
  while (db.get('SELECT id FROM orders WHERE reference = ?', [candidate])) {
    seq += 1;
    candidate = ids.orderReference(p, year, seq);
    if (seq > 999999) throw new OrderError('Impossible de générer une référence de commande.', 'REF_EXHAUSTED', 500);
  }
  return candidate;
}

function nextPosReference() {
  const p = (settings.get('commerce.pos_prefix') || 'VT').toUpperCase().slice(0, 8);
  const year = dates.yearInTz();
  const row = db.get('SELECT COUNT(*) AS n FROM pos_sales WHERE reference LIKE ?', [`${p}-B${year.slice(2)}-%`]);
  let seq = (row?.n || 0) + 1;
  let candidate = ids.posReference(p, year, seq);
  while (db.get('SELECT id FROM pos_sales WHERE reference = ?', [candidate])) {
    seq += 1;
    candidate = ids.posReference(p, year, seq);
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Création de commande                                                */
/* ------------------------------------------------------------------ */
/**
 * @param {object} input
 * @param {Array} input.lines [{productId, variantId, qty}]
 * @param {string} input.mode 'pickup' | 'delivery'
 * @param {string|number} input.zoneId
 * @param {object} input.customer {fullName, phone, email}
 * @param {object} input.shippingInfo {city, quarter, address, landmark, recipientName, recipientPhone}
 * @param {string} input.paymentMethod
 * @param {string} [input.idempotencyKey]
 */
function createOrder(input, { actorId = null, source = 'web' } = {}) {
  const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 120) : null;

  // --- Anti-doublon : même clé d'idempotence => même commande ------------
  if (idempotencyKey) {
    const existing = db.get('SELECT * FROM orders WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return { order: loadFull(existing.id), duplicate: true };
  }

  const mode = input.mode === 'pickup' ? 'pickup' : 'delivery';
  const zone = mode === 'pickup' ? shipping.pickupZone() : shipping.getZone(input.zoneId);
  if (!zone || !zone.enabled) throw new OrderError('Mode de réception indisponible.', 'ZONE_INVALID', 400);
  if (mode === 'pickup' && zone.kind !== 'pickup') throw new OrderError('Zone de retrait invalide.', 'ZONE_INVALID', 400);
  if (mode === 'delivery' && zone.kind === 'pickup') throw new OrderError('Choisissez une zone de livraison.', 'ZONE_INVALID', 400);

  // --- Identité ------------------------------------------------------------
  const fullName = normalizeText(input.customer?.fullName || '');
  const phone = normalizePhone(input.customer?.phone || '');
  const emailRaw = normalizeText(input.customer?.email || '').toLowerCase();
  if (fullName.length < 2) throw new OrderError('Le nom est obligatoire.', 'NAME_REQUIRED', 400);
  if (!phone) throw new OrderError('Un numéro de téléphone valide est obligatoire.', 'PHONE_REQUIRED', 400);
  if (settings.get('commerce.email_required') && !emailRaw) {
    throw new OrderError('Une adresse e-mail est requise pour ce parcours.', 'EMAIL_REQUIRED', 400);
  }
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(emailRaw)) {
    throw new OrderError('Adresse e-mail invalide.', 'EMAIL_INVALID', 400);
  }

  // --- Adresse de livraison -------------------------------------------------
  let shippingInfo = {};
  if (mode === 'delivery') {
    const city = normalizeText(input.shippingInfo?.city || '');
    const quarter = normalizeText(input.shippingInfo?.quarter || '');
    const address = normalizeText(input.shippingInfo?.address || '');
    if (!city) throw new OrderError('La ville de livraison est obligatoire.', 'CITY_REQUIRED', 400);
    if (!address && !quarter) {
      throw new OrderError('Le quartier ou l’adresse de livraison est obligatoire.', 'ADDRESS_REQUIRED', 400);
    }
    shippingInfo = {
      city,
      quarter,
      address,
      landmark: normalizeText(input.shippingInfo?.landmark || ''),
      recipientName: normalizeText(input.shippingInfo?.recipientName || '') || fullName,
      recipientPhone: normalizePhone(input.shippingInfo?.recipientPhone || '') || phone,
    };
  }

  // --- Lignes et totaux ------------------------------------------------------
  const totals = computeTotals(input.lines, { zoneId: zone.id });
  if (!totals.items.length) {
    throw new OrderError(
      totals.problems[0]?.message || 'Votre panier est vide ou contient des articles indisponibles.',
      'CART_INVALID',
      409,
      totals.problems
    );
  }
  if (totals.problems.length) {
    throw new OrderError('Certains articles ne peuvent pas être commandés en l’état.', 'CART_INVALID', 409, totals.problems);
  }
  const minOrder = Number(settings.get('commerce.min_order_amount') || 0);
  if (minOrder > 0 && totals.subtotal < minOrder) {
    throw new OrderError(`Montant minimum de commande : ${require('../lib/money').format(minOrder)}.`, 'MIN_ORDER', 400);
  }

  // --- Moyen de paiement -------------------------------------------------------
  const payments = require('./payments');
  const method = payments.getMethod(input.paymentMethod);
  if (!method) throw new OrderError('Moyen de paiement inconnu.', 'PAYMENT_METHOD_INVALID', 400);
  const allowed = shipping.methodAllowedFor(method, { mode, zone });
  if (!allowed.ok) throw new OrderError(allowed.reason, 'PAYMENT_METHOD_UNAVAILABLE', 400);
  if (totals.quoteRequired && method.kind !== 'cash') {
    // Un devis doit être accepté avant tout paiement en ligne.
    // Le paiement à la réception reste possible : il interviendra après accord.
  }

  const termsAccepted = input.termsAccepted ? 1 : 0;
  if (!termsAccepted) {
    throw new OrderError('L’acceptation des conditions de vente est requise.', 'TERMS_REQUIRED', 400);
  }

  const reference = nextReference();
  const trackingToken = ids.token(24);
  const marketingConsent = settings.get('commerce.marketing_consent_enabled') && input.marketingConsent ? 1 : 0;

  const orderId = db.transaction(() => {
    // Client : réutilise un client existant (par téléphone ou e-mail) sinon création.
    let customer = null;
    if (emailRaw) customer = db.get('SELECT * FROM customers WHERE email = ?', [emailRaw]);
    if (!customer && phone) customer = db.get('SELECT * FROM customers WHERE phone = ?', [phone]);
    if (!customer) {
      const cid = db.insert('customers', {
        email: emailRaw || null,
        phone,
        full_name: fullName,
        marketing_consent: marketingConsent,
        consent_at: marketingConsent ? dates.nowIso() : null,
      });
      customer = db.get('SELECT * FROM customers WHERE id = ?', [cid]);
    } else {
      const patch = { updated_at: dates.nowIso() };
      if (!customer.full_name && fullName) patch.full_name = fullName;
      if (!customer.phone && phone) patch.phone = phone;
      if (!customer.email && emailRaw) patch.email = emailRaw;
      if (marketingConsent && !customer.marketing_consent) {
        patch.marketing_consent = 1;
        patch.consent_at = dates.nowIso();
      }
      db.update('customers', customer.id, patch);
    }

    const initialStatus = totals.quoteRequired ? 'quote_required' : 'pending';
    const newOrderId = db.insert('orders', {
      reference,
      tracking_token: trackingToken,
      idempotency_key: idempotencyKey,
      cart_id: input.cartId || null,
      customer_id: customer.id,
      user_id: actorId,
      status: initialStatus,
      payment_status: 'unpaid',
      delivery_status: 'none',
      fulfillment_mode: mode,
      zone_id: zone.id,
      carrier_id: zone.default_carrier_id || null,
      recipient_name: shippingInfo.recipientName || fullName,
      recipient_phone: shippingInfo.recipientPhone || phone,
      recipient_email: emailRaw || '',
      city: shippingInfo.city || '',
      quarter: shippingInfo.quarter || '',
      address: shippingInfo.address || '',
      landmark: shippingInfo.landmark || '',
      desired_date: normalizeText(input.desiredDate || '').slice(0, 40),
      payment_method_code: method.code,
      subtotal: totals.subtotal,
      discount: totals.discount,
      shipping_cost: totals.quoteRequired ? 0 : totals.shippingCost,
      total: totals.total,
      currency: totals.currency,
      quote_required: totals.quoteRequired ? 1 : 0,
      quote_status: totals.quoteRequired ? 'requested' : 'none',
      customer_note: normalizeText(input.note || '').slice(0, 1000),
      marketing_consent: marketingConsent,
      terms_accepted: termsAccepted,
      terms_accepted_at: dates.nowIso(),
      placed_at: dates.nowIso(),
    });

    totals.items.forEach((item, index) => {
      db.insert('order_items', {
        order_id: newOrderId,
        product_id: item.productId,
        variant_id: item.variantId,
        stock_item_id: item.stockItemId,
        sku: item.sku,
        name: item.name,
        options_label: item.optionsLabel,
        unit: item.unit,
        unit_price: item.unitPrice,
        original_price: item.originalPrice,
        qty: item.qty,
        line_total: item.lineTotal,
        is_kit: item.isKit ? 1 : 0,
        position: index,
      });
    });

    // Réservation du stock : reprise des réservations du panier, sinon création.
    const movedFromCart = input.cartId
      ? db.run(
          "UPDATE reservations SET order_id = ?, cart_id = NULL, expires_at = ? WHERE cart_id = ? AND status = 'active'",
          [newOrderId, dates.addMinutes(dates.nowIso(), reservationMinutes(initialStatus)), input.cartId]
        ).changes
      : 0;

    if (!movedFromCart) {
      const targets = [];
      for (const item of totals.items) {
        targets.push(...stock.resolveTargets(item.productId, item.variantId, item.qty));
      }
      stock.reserve(targets, {
        orderId: newOrderId,
        minutes: reservationMinutes(initialStatus),
        note: 'Réservation commande',
      });
    } else {
      // Complète la réservation si le panier était partiellement réservé.
      ensureOrderReservations(newOrderId, totals.items);
    }

    if (input.cartId) {
      db.run("UPDATE carts SET status = 'converted', updated_at = ? WHERE id = ?", [dates.nowIso(), input.cartId]);
    }

    logEvent(newOrderId, 'order', '', initialStatus, 'Commande enregistrée.', { public: 1, actorId });
    if (totals.quoteRequired) {
      logEvent(
        newOrderId,
        'quote',
        '',
        'requested',
        `Livraison sur devis pour « ${zone.name} » : aucun frais de livraison n'a été appliqué. La boutique doit proposer un montant avant tout paiement.`,
        { public: 1, actorId }
      );
    }
    return newOrderId;
  });

  // Initialisation du paiement hors transaction (peut appeler un prestataire).
  let paymentIntent = null;
  try {
    paymentIntent = require('./payments').initiateForOrder(orderId, { source });
  } catch (err) {
    require('../lib/logger').warn('initialisation paiement échouée', { orderId, error: err.message });
    paymentIntent = { ok: false, error: err.message };
  }

  queueNotification(orderId, 'order.created');
  return { order: loadFull(orderId), duplicate: false, paymentIntent };
}

function reservationMinutes(status) {
  if (status === 'quote_required') return 60 * Number(process.env.QUOTE_RESERVATION_HOURS || 72);
  return config.commerce.orderReservationMinutes;
}

/** Vérifie que la commande est entièrement réservée et complète le cas échéant. */
function ensureOrderReservations(orderId, items) {
  const reserved = db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [orderId]);
  const perItem = new Map();
  for (const r of reserved) perItem.set(r.stock_item_id, (perItem.get(r.stock_item_id) || 0) + r.qty);
  const missing = [];
  for (const item of items || []) {
    for (const target of stock.resolveTargets(item.productId, item.variantId, item.qty)) {
      const have = perItem.get(target.stockItemId) || 0;
      if (have < target.qty) {
        missing.push({ ...target, qty: target.qty - have });
        perItem.set(target.stockItemId, target.qty);
      }
    }
  }
  if (missing.length) {
    const order = db.get('SELECT status FROM orders WHERE id = ?', [orderId]);
    stock.reserve(missing, { orderId, minutes: reservationMinutes(order?.status), note: 'Complément de réservation' });
  }
  return missing.length;
}

function logEvent(orderId, scope, from, to, message, { public: isPublic = 0, actorId = null, actorName = '' } = {}) {
  db.insert('order_events', {
    order_id: orderId,
    scope,
    from_value: String(from || ''),
    to_value: String(to || ''),
    message: String(message || ''),
    public: isPublic ? 1 : 0,
    actor_id: actorId || null,
    actor_name: actorName || '',
  });
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */
function getById(id) {
  return db.get('SELECT * FROM orders WHERE id = ?', [Number(id)]);
}

function getByReference(reference) {
  return db.get('SELECT * FROM orders WHERE reference = ?', [String(reference).trim().toUpperCase()]);
}

function getByTrackingToken(token) {
  if (!token) return null;
  return db.get('SELECT * FROM orders WHERE tracking_token = ?', [String(token)]);
}

function itemsOf(orderId) {
  return db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY position ASC, id ASC', [orderId]);
}

function eventsOf(orderId, { publicOnly = false } = {}) {
  return db.all(
    `SELECT e.*, u.full_name AS actor_full_name FROM order_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.order_id = ? ${publicOnly ? 'AND e.public = 1' : ''}
      ORDER BY e.created_at ASC, e.id ASC`,
    [orderId]
  );
}

function deliveryEventsOf(orderId) {
  return db.all('SELECT * FROM delivery_events WHERE order_id = ? ORDER BY happened_at ASC, id ASC', [orderId]);
}

function paymentsOf(orderId) {
  return db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC', [orderId]);
}

function refundsOf(orderId) {
  return db.all(
    `SELECT r.*, u.full_name AS processed_by_name FROM refunds r
       LEFT JOIN users u ON u.id = r.processed_by
      WHERE r.order_id = ? ORDER BY r.created_at DESC`,
    [orderId]
  );
}

/** Commande complète pour affichage (admin, confirmation, suivi). */
function loadFull(orderId) {
  const order = getById(orderId);
  if (!order) return null;
  const zone = order.zone_id ? shipping.getZone(order.zone_id) : null;
  const carrier = order.carrier_id ? shipping.getCarrier(order.carrier_id) : null;
  return {
    ...order,
    items: itemsOf(orderId),
    events: eventsOf(orderId),
    publicEvents: eventsOf(orderId, { publicOnly: true }),
    deliveryEvents: deliveryEventsOf(orderId),
    payments: paymentsOf(orderId),
    refunds: refundsOf(orderId),
    zone,
    carrier,
    trackingUrl: carrier ? shipping.trackingUrl(carrier, order.tracking_reference) : '',
    paymentMethod: db.get('SELECT * FROM payment_methods WHERE code = ?', [order.payment_method_code]),
    customer: order.customer_id ? db.get('SELECT * FROM customers WHERE id = ?', [order.customer_id]) : null,
    statusLabel: ORDER_STATUSES.find((s) => s.value === order.status)?.label || order.status,
    paymentStatusLabel: PAYMENT_STATUSES.find((s) => s.value === order.payment_status)?.label || order.payment_status,
    deliveryStatusLabel: DELIVERY_STATUSES.find((s) => s.value === order.delivery_status)?.label || order.delivery_status,
    trackingLink: `/suivi/${order.tracking_token}`,
  };
}

/** Suivi sécurisé : le jeton privé est obligatoire. */
function forTracking(token) {
  const order = getByTrackingToken(token);
  if (!order) return null;
  const full = loadFull(order.id);
  // Le suivi public n'expose ni l'adresse complète, ni l'historique interne.
  return {
    ...full,
    events: full.publicEvents,
    address: order.address ? maskAddress(order.address) : '',
    recipient_phone: maskPhone(order.recipient_phone),
    customer_note: '',
    internal_note: '',
  };
}

function maskAddress(value) {
  const s = String(value || '');
  return s.length <= 6 ? `${s.slice(0, 2)}…` : `${s.slice(0, Math.ceil(s.length / 2))}…`;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  return `${digits.slice(0, digits.length - 4).replace(/./g, '•').slice(0, 6)} ${digits.slice(-4)}`;
}

function listForCustomer(customerId, limit = 50) {
  return db.all(
    'SELECT * FROM orders WHERE customer_id = ? AND status != ? ORDER BY placed_at DESC LIMIT ?',
    [customerId, 'cancelled', limit]
  );
}

/** Recherche administrateur avec filtres serveur. */
function adminList(filters = {}, { page = 1, perPage = 25 } = {}) {
  const where = [];
  const params = [];
  if (filters.status) { where.push('o.status = ?'); params.push(filters.status); }
  if (filters.paymentStatus) { where.push('o.payment_status = ?'); params.push(filters.paymentStatus); }
  if (filters.deliveryStatus) { where.push('o.delivery_status = ?'); params.push(filters.deliveryStatus); }
  if (filters.mode) { where.push('o.fulfillment_mode = ?'); params.push(filters.mode); }
  if (filters.zoneId) { where.push('o.zone_id = ?'); params.push(Number(filters.zoneId)); }
  if (filters.from) { where.push('o.placed_at >= ?'); params.push(dates.fromInput(filters.from) || filters.from); }
  if (filters.to) { where.push('o.placed_at <= ?'); params.push(dates.fromInput(filters.to, { endOfDay: true }) || filters.to); }
  if (filters.q) {
    const like = `%${normalizeText(filters.q)}%`;
    where.push('(o.reference LIKE ? OR o.recipient_name LIKE ? OR o.recipient_phone LIKE ? OR o.customer_note LIKE ? OR o.tracking_reference LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (filters.group === 'open') where.push("o.status NOT IN ('cancelled','refunded','delivered','partially_refunded')");
  if (filters.group === 'quote') where.push("o.quote_required = 1 AND o.quote_status IN ('requested','sent')");
  if (filters.group === 'cash') where.push("o.payment_status = 'awaiting_confirmation'");

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(200, Number(perPage) || 25));
  const total = db.get(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`, params)?.n || 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db.all(
    `SELECT o.*, z.name AS zone_name, c.name AS carrier_name, cust.full_name AS customer_name
       FROM orders o
       LEFT JOIN shipping_zones z ON z.id = o.zone_id
       LEFT JOIN carriers c ON c.id = o.carrier_id
       LEFT JOIN customers cust ON cust.id = o.customer_id
       ${whereSql}
      ORDER BY o.placed_at DESC, o.id DESC
      LIMIT ? OFFSET ?`,
    [...params, size, (current - 1) * size]
  );
  return {
    items: rows,
    pagination: { page: current, perPage: size, total, pages, offset: (current - 1) * size, hasNext: current < pages, hasPrev: current > 1, from: total ? (current - 1) * size + 1 : 0, to: Math.min(current * size, total) },
  };
}

/* ------------------------------------------------------------------ */
/* Machine à états                                                     */
/* ------------------------------------------------------------------ */
function canTransition(from, to) {
  if (from === to) return true;
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

function setStatus(orderId, status, { userId = null, note = '', force = false, actorName = '' } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (!ORDER_STATUSES.some((s) => s.value === status)) throw new OrderError('Statut invalide.', 'BAD_STATUS', 400);
  if (!force && !canTransition(order.status, status)) {
    throw new OrderError(
      `Transition impossible de « ${labelOf(order.status)} » vers « ${labelOf(status)} ».`,
      'BAD_TRANSITION',
      409
    );
  }
  if (order.status === status && !note) return loadFull(orderId);

  db.transaction(() => {
    const patch = { status, updated_at: dates.nowIso() };
    if (status === 'delivered' && !order.completed_at) patch.completed_at = dates.nowIso();
    if (status === 'cancelled') {
      patch.cancelled_at = dates.nowIso();
      patch.cancel_reason = note || 'Annulation';
    }
    db.update('orders', orderId, patch);
    logEvent(orderId, 'order', order.status, status, note || `Statut : ${labelOf(status)}`, {
      public: ['confirmed', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled'].includes(status) ? 1 : 0,
      actorId: userId,
      actorName,
    });
    if (status === 'ready' && order.fulfillment_mode === 'pickup') {
      db.run("UPDATE orders SET delivery_status = 'pickup_ready', updated_at = ? WHERE id = ?", [dates.nowIso(), orderId]);
      addDeliveryEvent(orderId, { label: 'Commande prête', detail: 'Disponible au retrait en boutique.', userId });
    }
    if (status === 'preparing') {
      db.run("UPDATE orders SET delivery_status = 'in_preparation', updated_at = ? WHERE id = ?", [dates.nowIso(), orderId]);
    }
    if (status === 'cancelled') {
      db.run("UPDATE orders SET delivery_status = 'cancelled', payment_status = CASE WHEN payment_status = 'paid' THEN 'paid' ELSE 'cancelled' END, updated_at = ? WHERE id = ?", [dates.nowIso(), orderId]);
      releaseStock(orderId, { userId, note: note || 'Annulation de la commande' });
    }
  });
  return loadFull(orderId);
}

function labelOf(status) {
  return ORDER_STATUSES.find((s) => s.value === status)?.label || status;
}

function setPaymentStatus(orderId, status, { userId = null, note = '', actorName = '' } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (!PAYMENT_STATUSES.some((s) => s.value === status)) throw new OrderError('Statut de paiement invalide.', 'BAD_STATUS', 400);
  db.transaction(() => {
    db.update('orders', orderId, { payment_status: status, updated_at: dates.nowIso() });
    logEvent(orderId, 'payment', order.payment_status, status, note || `Paiement : ${status}`, {
      public: ['paid', 'refunded'].includes(status) ? 1 : 0,
      actorId: userId,
      actorName,
    });
  });
  return loadFull(orderId);
}

function setDeliveryStatus(orderId, status, { userId = null, note = '', actorName = '' } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (!DELIVERY_STATUSES.some((s) => s.value === status)) throw new OrderError('Statut de livraison invalide.', 'BAD_STATUS', 400);
  db.transaction(() => {
    db.update('orders', orderId, { delivery_status: status, updated_at: dates.nowIso() });
    logEvent(orderId, 'delivery', order.delivery_status, status, note || `Livraison : ${status}`, {
      public: ['handed_to_carrier', 'in_transit', 'delivered', 'pickup_ready', 'picked_up'].includes(status) ? 1 : 0,
      actorId: userId,
      actorName,
    });
    if (status === 'delivered') {
      db.run("UPDATE orders SET status = 'delivered', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?", [
        dates.nowIso(), dates.nowIso(), orderId,
      ]);
      addDeliveryEvent(orderId, { label: 'Colis livré', detail: note, userId });
    }
    if (status === 'picked_up') {
      db.run("UPDATE orders SET status = 'delivered', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?", [
        dates.nowIso(), dates.nowIso(), orderId,
      ]);
      addDeliveryEvent(orderId, { label: 'Retrait effectué', detail: note, userId });
    }
  });
  return loadFull(orderId);
}

function addDeliveryEvent(orderId, { label, detail = '', location = '', happenedAt = null, isPublic = 1, userId = null }) {
  const clean = normalizeText(label);
  if (!clean) throw new OrderError('Le libellé de l’étape est obligatoire.', 'BAD_LABEL', 400);
  const id = db.insert('delivery_events', {
    order_id: orderId,
    label: clean.slice(0, 160),
    detail: normalizeText(detail).slice(0, 500),
    location: normalizeText(location).slice(0, 160),
    happened_at: happenedAt || dates.nowIso(),
    public: isPublic ? 1 : 0,
    created_by: userId,
  });
  return db.get('SELECT * FROM delivery_events WHERE id = ?', [id]);
}

function setTracking(orderId, { carrierId = null, trackingReference = '', userId = null }) {
  db.transaction(() => {
    const patch = { updated_at: dates.nowIso() };
    if (carrierId) patch.carrier_id = Number(carrierId);
    if (trackingReference !== undefined) patch.tracking_reference = normalizeText(trackingReference).slice(0, 120);
    db.update('orders', orderId, patch);
    logEvent(orderId, 'delivery', '', '', `Suivi : transporteur ${carrierId || 'inchangé'}, référence ${trackingReference || '—'}`, { actorId: userId });
  });
  return loadFull(orderId);
}

/** Libère (et restitue si déjà consommé) le stock d'une commande. */
function releaseStock(orderId, { userId = null, note = '' } = {}) {
  const consumed = db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'consumed'", [orderId]);
  if (consumed.length) {
    stock.restock(
      consumed.map((r) => ({ stockItemId: r.stock_item_id, qty: r.qty })),
      { reason: 'annulation', userId, reference: `CMD-${orderId}`, note: note || 'Restitution après annulation' }
    );
    db.run("UPDATE reservations SET status = 'released', released_at = ? WHERE order_id = ? AND status = 'consumed'", [dates.nowIso(), orderId]);
  }
  const released = stock.releaseReservations({ orderId, reason: 'annulation', userId, note: note || 'Annulation de commande' });
  return { released, restocked: consumed.length };
}

function cancel(orderId, { reason = '', userId = null, restock = true } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (order.status === 'cancelled') return loadFull(orderId);
  if (order.payment_status === 'paid') {
    // Un remboursement reste nécessaire : on bascule en annulation puis remboursement.
    db.transaction(() => {
      db.update('orders', orderId, {
        status: 'cancelled',
        cancelled_at: dates.nowIso(),
        cancel_reason: reason || 'Annulation après paiement',
        updated_at: dates.nowIso(),
      });
      logEvent(orderId, 'order', order.status, 'cancelled', reason || 'Annulation après paiement : remboursement à traiter.', { public: 1, actorId: userId });
      if (restock) releaseStock(orderId, { userId, note: reason });
    });
    return loadFull(orderId);
  }
  return setStatus(orderId, 'cancelled', { userId, note: reason || 'Annulation de la commande' });
}

/* ------------------------------------------------------------------ */
/* Devis de livraison                                                  */
/* ------------------------------------------------------------------ */
function sendQuote(orderId, amount, { note = '', userId = null } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  const value = Math.max(0, Math.round(Number(amount) || 0));
  if (value <= 0) throw new OrderError('Le montant du devis doit être supérieur à zéro.', 'BAD_QUOTE', 400);

  db.transaction(() => {
    const newTotal = Math.max(0, order.subtotal - order.discount) + value;
    db.update('orders', orderId, {
      quote_amount: value,
      quote_status: 'sent',
      quote_sent_at: dates.nowIso(),
      shipping_cost: value,
      total: newTotal,
      status: order.status === 'quote_required' ? 'pending' : order.status,
      updated_at: dates.nowIso(),
    });
    // Prolonge la réservation le temps de l'acceptation du devis.
    db.run("UPDATE reservations SET expires_at = ? WHERE order_id = ? AND status = 'active'", [
      dates.addMinutes(dates.nowIso(), reservationMinutes('quote_required')),
      orderId,
    ]);
    logEvent(
      orderId,
      'quote',
      'requested',
      'sent',
      `Devis de livraison proposé : ${require('../lib/money').format(value)}. ${normalizeText(note)}`.trim(),
      { public: 1, actorId: userId }
    );
  });
  queueNotification(orderId, 'quote.sent');
  return loadFull(orderId);
}

function acceptQuote(orderId, { customerToken = null, userId = null } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (order.quote_status !== 'sent') throw new OrderError('Aucun devis en attente d’acceptation.', 'NO_QUOTE', 409);
  if (!userId && order.tracking_token !== customerToken) {
    throw new OrderError('Lien de suivi invalide.', 'FORBIDDEN', 403);
  }
  db.transaction(() => {
    db.update('orders', orderId, {
      quote_status: 'accepted',
      quote_accepted_at: dates.nowIso(),
      quote_required: 0,
      status: order.status === 'quote_required' ? 'pending' : order.status,
      updated_at: dates.nowIso(),
    });
    db.run("UPDATE reservations SET expires_at = ? WHERE order_id = ? AND status = 'active'", [
      dates.addMinutes(dates.nowIso(), config.commerce.orderReservationMinutes),
      orderId,
    ]);
    logEvent(orderId, 'quote', 'sent', 'accepted', `Le client a accepté le devis de ${require('../lib/money').format(order.quote_amount)}. Le paiement peut être finalisé.`, {
      public: 1,
      actorId: userId,
    });
  });
  return loadFull(orderId);
}

function refuseQuote(orderId, { reason = '', customerToken = null, userId = null } = {}) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  if (!userId && order.tracking_token !== customerToken) throw new OrderError('Lien de suivi invalide.', 'FORBIDDEN', 403);
  db.transaction(() => {
    db.update('orders', orderId, { quote_status: 'refused', updated_at: dates.nowIso() });
    logEvent(orderId, 'quote', 'sent', 'refused', `Devis refusé. ${normalizeText(reason)}`.trim(), { public: 1, actorId: userId });
  });
  return cancel(orderId, { reason: reason || 'Devis de livraison refusé par le client.', userId });
}

/* ------------------------------------------------------------------ */
/* Remboursements et retours                                           */
/* ------------------------------------------------------------------ */
function createRefund(orderId, { kind = 'refund', amount = 0, items = [], method = '', reason = '', restock = false, userId = null, status = 'pending' }) {
  const order = getById(orderId);
  if (!order) throw new OrderError('Commande introuvable.', 'NOT_FOUND', 404);
  const remaining = Math.max(0, Number(order.amount_paid || 0) - Number(order.amount_refunded || 0));
  let total = Math.max(0, Math.round(Number(amount) || 0));
  const lines = [];

  if (Array.isArray(items) && items.length) {
    for (const it of items) {
      const line = db.get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [Number(it.orderItemId), orderId]);
      if (!line) continue;
      const qty = Math.max(1, Math.min(Math.round(Number(it.qty) || 1), line.qty));
      const lineAmount = Math.round((line.line_total / line.qty) * qty);
      lines.push({ orderItemId: line.id, qty, amount: lineAmount, stockItemId: line.stock_item_id, productId: line.product_id, variantId: line.variant_id });
    }
    if (!total) total = lines.reduce((s, l) => s + l.amount, 0);
  }
  if (total <= 0) throw new OrderError('Le montant du remboursement doit être supérieur à zéro.', 'BAD_AMOUNT', 400);
  if (total > remaining) {
    throw new OrderError(`Montant supérieur au reste remboursable (${require('../lib/money').format(remaining)}).`, 'AMOUNT_EXCEEDED', 400);
  }

  const refundId = db.transaction(() => {
    const id = db.insert('refunds', {
      order_id: orderId,
      kind,
      amount: total,
      method: normalizeText(method).slice(0, 80),
      reason: normalizeText(reason).slice(0, 500),
      restock: restock ? 1 : 0,
      status,
      processed_by: status === 'done' ? userId : null,
      processed_at: status === 'done' ? dates.nowIso() : null,
    });
    for (const l of lines) {
      db.insert('refund_items', { refund_id: id, order_item_id: l.orderItemId, qty: l.qty, amount: l.amount });
    }
    if (status === 'done') applyRefund(id, { userId });
    return id;
  });
  return db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
}

function applyRefund(refundId, { userId = null } = {}) {
  const refund = db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!refund || refund.status === 'done') return refund;
  const order = getById(refund.order_id);

  db.transaction(() => {
    db.update('refunds', refundId, { status: 'done', processed_by: userId || null, processed_at: dates.nowIso() });
    const refunded = Number(order.amount_refunded || 0) + Number(refund.amount);
    const paymentStatus = refunded >= Number(order.amount_paid) ? 'refunded' : 'partially_refunded';
    const orderStatus = refunded >= Number(order.total) ? 'refunded' : 'partially_refunded';
    db.update('orders', refund.order_id, {
      amount_refunded: refunded,
      payment_status: paymentStatus,
      status: ['cancelled', 'refunded'].includes(order.status) ? order.status : orderStatus,
      updated_at: dates.nowIso(),
    });
    logEvent(refund.order_id, 'payment', order.payment_status, paymentStatus, `Remboursement de ${require('../lib/money').format(refund.amount)} (${refund.kind}).`, {
      public: 1,
      actorId: userId,
    });

    if (refund.restock) {
      const items = db.all('SELECT * FROM refund_items WHERE refund_id = ?', [refundId]);
      const targets = [];
      for (const it of items) {
        const line = db.get('SELECT * FROM order_items WHERE id = ?', [it.order_item_id]);
        if (!line || !line.stock_item_id) continue;
        targets.push({ stockItemId: line.stock_item_id, qty: it.qty });
      }
      if (targets.length) {
        stock.restock(targets, { reason: 'retour', userId, reference: order.reference, note: 'Retour client' });
      }
    }
    // Un remboursement sur paiement en ligne est tracé côté passerelle.
    if (order.payment_method_code && !['pay_at_pickup', 'pay_on_delivery'].includes(order.payment_method_code)) {
      const payment = db.get("SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1", [order.id]);
      if (payment) {
        db.update('payments', payment.id, {
          status: refunded >= Number(payment.amount) ? 'refunded' : 'partially_refunded',
          updated_at: dates.nowIso(),
        });
      }
    }
  });
  return db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
}

/* ------------------------------------------------------------------ */
/* Notifications (file d'attente locale, connecteurs à brancher)       */
/* ------------------------------------------------------------------ */
function queueNotification(orderId, kind) {
  try {
    const order = getById(orderId);
    if (!order) return;
    const channel = settings.get('notifications.email_enabled') && order.recipient_email ? 'email' : 'log';
    db.insert('outbox', {
      channel,
      recipient: order.recipient_email || order.recipient_phone,
      subject: `Commande ${order.reference} — ${kind}`,
      body: JSON.stringify({ orderId, kind, reference: order.reference }),
      meta: JSON.stringify({ kind, phone: order.recipient_phone }),
    });
  } catch { /* la notification ne doit jamais bloquer la commande */ }
}

function outboxPending(limit = 50) {
  return db.all("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id ASC LIMIT ?", [limit]);
}

/* ------------------------------------------------------------------ */
/* Données d'impression                                                */
/* ------------------------------------------------------------------ */
function printData(orderId) {
  const order = loadFull(orderId);
  if (!order) return null;
  return {
    order,
    // NB : ne pas nommer cette clé `store`, qui écraserait la vue établissement
    // injectée par le middleware de contexte.
    settingsMap: settings.load(),
    printedAt: dates.nowIso(),
  };
}

module.exports = {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_STATUSES,
  ORDER_TRANSITIONS,
  OrderError,
  computeTotals,
  createOrder,
  nextReference,
  nextPosReference,
  getById,
  getByReference,
  getByTrackingToken,
  itemsOf,
  eventsOf,
  deliveryEventsOf,
  paymentsOf,
  refundsOf,
  loadFull,
  forTracking,
  listForCustomer,
  adminList,
  canTransition,
  setStatus,
  setPaymentStatus,
  setDeliveryStatus,
  addDeliveryEvent,
  setTracking,
  releaseStock,
  cancel,
  sendQuote,
  acceptQuote,
  refuseQuote,
  createRefund,
  applyRefund,
  queueNotification,
  outboxPending,
  printData,
  logEvent,
  labelOf,
  ensureOrderReservations,
  reservationMinutes,
};
