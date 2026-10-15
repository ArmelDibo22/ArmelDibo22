'use strict';

/**
 * Paiements.
 *
 * Principes :
 *  1. Aucun appel d'API inventé. Chaque moyen Mobile Money dispose d'un
 *     adaptateur ; tant que les identifiants marchands ne sont pas fournis,
 *     l'adaptateur renvoie NOT_CONFIGURED et le moyen reste désactivé à la
 *     validation de commande.
 *  2. Un paiement n'est validé QUE par une notification serveur authentifiée
 *     (signature HMAC) ou par la confirmation explicite d'un utilisateur
 *     habilité pour les encaissements espèces. Une capture d'écran, un message
 *     client ou une page de retour ne suffisent jamais.
 *  3. Montant, devise et référence de commande sont revérifiés à la réception.
 *  4. Les notifications répétées sont dédupliquées (contrainte d'unicité).
 *  5. Aucune donnée de carte bancaire n'est manipulée ni journalisée.
 */

const db = require('../../db');
const dates = require('../../lib/dates');
const config = require('../../config');
const money = require('../../lib/money');
const logger = require('../../lib/logger');
const { normalizeText } = require('../../lib/slug');
const shipping = require('../shipping');
const stock = require('../stock');
const settings = require('../../lib/settings');

class PaymentError extends Error {
  constructor(message, code = 'PAYMENT_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const CASH_METHODS = ['pay_at_pickup', 'pay_on_delivery'];
const MOBILE_MONEY_METHODS = ['wave', 'orange_money', 'mtn_momo', 'moov_money'];

function safeParse(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateMethod(row) {
  if (!row) return null;
  return {
    ...row,
    modes: safeParse(row.modes, ['pickup', 'delivery']),
    zone_codes: safeParse(row.zone_codes, []),
    enabled: Boolean(row.enabled),
    configured: Boolean(row.configured),
    simulated: Boolean(row.simulated),
    isCash: CASH_METHODS.includes(row.code),
    isMobileMoney: MOBILE_MONEY_METHODS.includes(row.code),
  };
}

/* ------------------------------------------------------------------ */
/* Configuration des moyens de paiement                                */
/* ------------------------------------------------------------------ */
function listMethods({ enabledOnly = false } = {}) {
  const rows = db.all(
    'SELECT * FROM payment_methods WHERE (? = 0 OR enabled = 1) ORDER BY position ASC, name ASC',
    [enabledOnly ? 1 : 0]
  );
  return rows.map(hydrateMethod);
}

function getMethod(code) {
  if (!code) return null;
  return hydrateMethod(db.get('SELECT * FROM payment_methods WHERE code = ?', [String(code)]));
}

function saveMethod(code, input, userId = null) {
  const method = getMethod(code);
  if (!method) throw new PaymentError('Moyen de paiement inconnu.', 'UNKNOWN_METHOD', 404);
  const data = {};
  if (input.name !== undefined) data.name = normalizeText(input.name).slice(0, 120);
  if (input.enabled !== undefined) data.enabled = input.enabled ? 1 : 0;
  if (input.position !== undefined) data.position = Math.max(0, Number(input.position) || 0);
  if (input.instructions !== undefined) data.instructions = normalizeText(input.instructions).slice(0, 1000);
  if (input.merchant_ref !== undefined) data.merchant_ref = normalizeText(input.merchant_ref).slice(0, 120);
  if (input.color !== undefined) data.color = /^#[0-9a-f]{6}$/i.test(String(input.color)) ? String(input.color) : '';
  if (input.modes !== undefined) data.modes = JSON.stringify((Array.isArray(input.modes) ? input.modes : []).filter((m) => ['pickup', 'delivery'].includes(m)));
  if (input.zone_codes !== undefined) data.zone_codes = JSON.stringify(Array.isArray(input.zone_codes) ? input.zone_codes : []);
  if (input.simulated !== undefined) data.simulated = input.simulated ? 1 : 0;

  // Un moyen Mobile Money ne peut être activé s'il n'est ni configuré ni simulé.
  const nextEnabled = data.enabled !== undefined ? data.enabled : method.enabled;
  const nextSimulated = data.simulated !== undefined ? data.simulated : method.simulated;
  if (nextEnabled && MOBILE_MONEY_METHODS.includes(code) && !nextSimulated && !hasProviderCredentials(code)) {
    throw new PaymentError(
      `${method.name} ne peut pas être activé : identifiants marchands absents. Renseignez-les ou laissez le mode bac à sable activé.`,
      'NOT_CONFIGURED',
      409
    );
  }
  data.updated_at = dates.nowIso();
  data.configured = hasProviderCredentials(code) ? 1 : 0;
  db.update('payment_methods', method.id, data);
  audit(userId, 'payment_method.update', code, { enabled: Boolean(nextEnabled), simulated: Boolean(nextSimulated) });
  return getMethod(code);
}

function hasProviderCredentials(code) {
  const creds = config.payments.providers[code];
  if (!creds) return false;
  const values = Object.values(creds);
  return values.length > 0 && values.every((v) => v && String(v).trim().length > 0);
}

/** État réel d'un moyen, affiché en administration. */
function methodState(method) {
  if (!method.enabled) return { key: 'disabled', label: 'Désactivé', tone: 'neutral' };
  if (method.isCash) return { key: 'manual', label: 'Encaissement manuel', tone: 'ok' };
  if (hasProviderCredentials(method.code) && !method.simulated) {
    return { key: 'live', label: 'Connecté (production)', tone: 'ok' };
  }
  if (method.simulated && config.payments.simulationEnabled) {
    return { key: 'sandbox', label: 'Bac à sable (simulation)', tone: 'warn' };
  }
  return { key: 'not_configured', label: 'Non configuré', tone: 'danger' };
}

/** Moyens proposés au tunnel de commande, filtrés par mode et zone. */
function methodsForCheckout({ mode, zone, subtotal = 0 }) {
  const zoneObj = zone && typeof zone === 'object' ? zone : shipping.getZone(zone);
  return listMethods({ enabledOnly: true })
    .map((m) => {
      const allowed = shipping.methodAllowedFor(m, { mode, zone: zoneObj });
      return { ...m, allowed: allowed.ok, unavailableReason: allowed.ok ? '' : allowed.reason, state: methodState(m) };
    })
    // Les moyens indisponibles restent listés (grisés) pour information en livraison.
    .filter((m) => m.allowed || mode === 'delivery')
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.position - b.position);
}

/* ------------------------------------------------------------------ */
/* Initialisation d'un paiement                                        */
/* ------------------------------------------------------------------ */
/**
 * Prépare le paiement d'une commande : renvoie les instructions à afficher ou
 * l'URL de redirection vers la passerelle. Ne valide jamais un paiement.
 */
function initiateForOrder(orderId, { source = 'web' } = {}) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw new PaymentError('Commande introuvable.', 'NOT_FOUND', 404);
  if (['cancelled', 'refunded'].includes(order.status)) {
    throw new PaymentError('Cette commande ne peut plus être payée.', 'ORDER_CLOSED', 409);
  }
  if (order.quote_required && order.quote_status !== 'accepted') {
    return { ok: false, needsQuote: true, message: 'Le devis de livraison doit être accepté avant paiement.' };
  }
  if (order.payment_status === 'paid') {
    return { ok: false, alreadyPaid: true, message: 'Cette commande est déjà réglée.' };
  }

  const method = getMethod(order.payment_method_code);
  if (!method) throw new PaymentError('Moyen de paiement inconnu.', 'UNKNOWN_METHOD', 400);
  if (!method.enabled) throw new PaymentError(`${method.name} n'est plus disponible.`, 'METHOD_DISABLED', 409);

  if (method.isCash) {
    const payment = ensurePaymentRow(order, method, {
      provider: 'manual',
      providerReference: '',
      status: 'created',
    });
    db.transaction(() => {
      if (order.payment_status !== 'paid') {
        db.update('orders', order.id, { payment_status: 'awaiting_confirmation', updated_at: dates.nowIso() });
      }
      db.insert('order_events', {
        order_id: order.id,
        scope: 'payment',
        from_value: order.payment_status,
        to_value: 'awaiting_confirmation',
        message: `${method.name} : encaissement à confirmer par un utilisateur habilité.`,
        public: 1,
      });
    });
    return {
      ok: true,
      type: 'instructions',
      paymentId: payment.id,
      method,
      message: method.instructions,
      awaitingConfirmation: true,
    };
  }

  const provider = providerFor(method.code);
  const payment = ensurePaymentRow(order, method, {
    provider: provider.name,
    providerReference: '',
    status: 'created',
  });

  try {
    const result = provider.createPayment({ order, method, payment });
    if (result.type === 'redirect') {
      db.update('payments', payment.id, { status: 'pending', provider_reference: result.providerReference || '', updated_at: dates.nowIso() });
      db.update('orders', order.id, { payment_status: 'awaiting_confirmation', updated_at: dates.nowIso() });
      return { ok: true, type: 'redirect', url: result.url, paymentId: payment.id, method, expiresAt: result.expiresAt };
    }
    if (result.type === 'instructions') {
      return { ok: true, type: 'instructions', paymentId: payment.id, method, message: result.message };
    }
    throw new PaymentError('Réponse de passerelle inattendue.', 'BAD_PROVIDER_RESPONSE', 502);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      db.update('payments', payment.id, { status: 'failed', failure_reason: err.message, updated_at: dates.nowIso() });
      db.update('orders', order.id, { payment_status: 'failed', updated_at: dates.nowIso() });
      throw new PaymentError(
        `${method.name} n'est pas encore connecté à la boutique. Choisissez un autre moyen de paiement ou réglez à la réception.`,
        'NOT_CONFIGURED',
        503
      );
    }
    logger.error('échec initialisation paiement', { orderId, code: method.code, error: err.message });
    throw new PaymentError(`Impossible d'initier le paiement : ${err.message}`, 'PROVIDER_ERROR', 502);
  }
}

function ensurePaymentRow(order, method, { provider, providerReference = '', status = 'created' }) {
  if (providerReference) {
    const existing = db.get('SELECT * FROM payments WHERE provider = ? AND provider_reference = ?', [provider, providerReference]);
    if (existing) return existing;
  }
  const open = db.get(
    `SELECT * FROM payments WHERE order_id = ? AND method_code = ? AND status IN ('created','pending')
      ORDER BY id DESC LIMIT 1`,
    [order.id, method.code]
  );
  if (open) return open;
  const id = db.insert('payments', {
    order_id: order.id,
    method_code: method.code,
    provider,
    provider_reference: providerReference,
    amount: Number(order.total),
    currency: order.currency,
    status,
  });
  return db.get('SELECT * FROM payments WHERE id = ?', [id]);
}

function providerFor(code) {
  if (!MOBILE_MONEY_METHODS.includes(code)) {
    return require('./providers/manual');
  }
  if (hasProviderCredentials(code) && !config.isDemo) {
    // Adaptateur réel : à brancher une fois la documentation du prestataire vérifiée.
    return require('./providers/generic');
  }
  if (config.payments.simulationEnabled) return require('./providers/simulated');
  return require('./providers/generic');
}

/* ------------------------------------------------------------------ */
/* Validation d'un paiement (unique chemin vers « payé »)               */
/* ------------------------------------------------------------------ */
/**
 * Marque un paiement comme réussi.
 * Vérifications obligatoires : commande existante et non close, devise, montant.
 * Effets : sortie de stock définitive, statuts paiement/commande/livraison,
 * journalisation et notification.
 *
 * @returns {{ok:boolean, reason?:string, order?:object}}
 */
function applySuccess(orderId, payload = {}, { actorId = null, actorName = '', source = 'webhook' } = {}) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' };
  if (order.payment_status === 'paid' && Number(order.amount_paid) >= Number(order.total)) {
    return { ok: true, reason: 'ALREADY_PAID', order: require('../orders').loadFull(order.id), duplicate: true };
  }
  if (order.status === 'cancelled') return { ok: false, reason: 'ORDER_CANCELLED' };

  const currency = String(payload.currency || order.currency || 'XOF').toUpperCase();
  if (currency !== String(order.currency).toUpperCase()) {
    logger.warn('devise de paiement incohérente', { orderId, currency, expected: order.currency });
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  const amount = Math.round(Number(payload.amount ?? order.total));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (amount !== Number(order.total)) {
    logger.warn('montant de paiement incohérent', { orderId, amount, expected: order.total });
    return { ok: false, reason: 'AMOUNT_MISMATCH', expected: order.total, received: amount };
  }

  const orders = require('../orders');
  db.transaction(() => {
    const provider = String(payload.provider || 'manual');
    const providerReference = String(payload.providerReference || '');
    let payment;
    if (providerReference) {
      payment = db.get('SELECT * FROM payments WHERE provider = ? AND provider_reference = ?', [provider, providerReference]);
    }
    if (!payment) {
      payment = db.get(
        `SELECT * FROM payments WHERE order_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'created' THEN 1 ELSE 2 END, id DESC LIMIT 1`,
        [order.id]
      );
    }
    if (payment) {
      db.update('payments', payment.id, {
        status: 'succeeded',
        amount,
        currency,
        provider,
        provider_reference: providerReference || payment.provider_reference,
        failure_reason: '',
        confirmed_by: actorId || null,
        confirmed_at: dates.nowIso(),
        updated_at: dates.nowIso(),
      });
    } else {
      db.insert('payments', {
        order_id: order.id,
        method_code: order.payment_method_code,
        provider,
        provider_reference: providerReference,
        amount,
        currency,
        status: 'succeeded',
        confirmed_by: actorId || null,
        confirmed_at: dates.nowIso(),
      });
    }

    // Sortie de stock définitive : les réservations sont consommées.
    stock.consumeOrderReservations(order.id, { userId: actorId, reference: order.reference });

    db.update('orders', order.id, {
      payment_status: 'paid',
      paid_at: dates.nowIso(),
      amount_paid: Number(order.amount_paid || 0) + amount,
      status: ['pending', 'quote_required'].includes(order.status) ? 'confirmed' : order.status,
      delivery_status: order.delivery_status === 'none' ? 'to_prepare' : order.delivery_status,
      updated_at: dates.nowIso(),
    });

    db.insert('order_events', {
      order_id: order.id,
      scope: 'payment',
      from_value: order.payment_status,
      to_value: 'paid',
      message: `Paiement de ${money.format(amount)} confirmé (${payload.methodLabel || provider}${
        providerReference ? ` — réf. ${providerReference}` : ''
      }) via ${source === 'webhook' ? 'notification du prestataire' : source === 'admin' ? 'confirmation en administration' : source}.`,
      public: 1,
      actor_id: actorId || null,
      actor_name: actorName || '',
    });
  });

  orders.queueNotification(order.id, 'payment.confirmed');
  logger.info('paiement confirmé', { orderId: order.id, amount, source });
  return { ok: true, order: require('../orders').loadFull(order.id) };
}

function applyFailure(orderId, { reason = '', provider = 'webhook', providerReference = '', actorId = null } = {}) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' };
  if (order.payment_status === 'paid') return { ok: false, reason: 'ALREADY_PAID' };

  db.transaction(() => {
    const payment = providerReference
      ? db.get('SELECT * FROM payments WHERE provider = ? AND provider_reference = ?', [provider, providerReference])
      : null;
    if (payment) {
      db.update('payments', payment.id, { status: 'failed', failure_reason: normalizeText(reason).slice(0, 300), updated_at: dates.nowIso() });
    } else {
      db.insert('payments', {
        order_id: order.id,
        method_code: order.payment_method_code,
        provider,
        provider_reference: providerReference,
        amount: Number(order.total),
        currency: order.currency,
        status: 'failed',
        failure_reason: normalizeText(reason).slice(0, 300),
      });
    }
    db.update('orders', order.id, { payment_status: 'failed', updated_at: dates.nowIso() });
    db.insert('order_events', {
      order_id: order.id,
      scope: 'payment',
      from_value: order.payment_status,
      to_value: 'failed',
      message: `Paiement refusé ou interrompu${reason ? ` : ${normalizeText(reason)}` : ''}. Le stock reste réservé temporairement.`,
      public: 1,
      actor_id: actorId || null,
    });
  });
  return { ok: true, order: require('../orders').loadFull(order.id) };
}

/** Annule un paiement en attente (client a abandonné, commande remplacée…). */
function applyCancellation(orderId, { provider = 'webhook', providerReference = '', reason = '' } = {}) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) return { ok: false, reason: 'ORDER_NOT_FOUND' };
  if (order.payment_status === 'paid') return { ok: false, reason: 'ALREADY_PAID' };
  db.transaction(() => {
    if (providerReference) {
      db.run(
        "UPDATE payments SET status = 'cancelled', failure_reason = ?, updated_at = ? WHERE provider = ? AND provider_reference = ?",
        [normalizeText(reason).slice(0, 300), dates.nowIso(), provider, providerReference]
      );
    }
    db.update('orders', order.id, { payment_status: 'cancelled', updated_at: dates.nowIso() });
    db.insert('order_events', {
      order_id: order.id,
      scope: 'payment',
      from_value: order.payment_status,
      to_value: 'cancelled',
      message: `Paiement annulé${reason ? ` : ${normalizeText(reason)}` : ''}.`,
      public: 1,
    });
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Encaissement espèces : confirmation par un utilisateur habilité      */
/* ------------------------------------------------------------------ */
function confirmCashCollection(orderId, { user, amount = null, note = '' } = {}) {
  if (!user) throw new PaymentError('Authentification requise.', 'UNAUTHENTICATED', 401);
  if (user.role !== 'admin' && !user.canConfirmCash) {
    throw new PaymentError(
      "Seul un utilisateur habilité peut confirmer un encaissement. Contactez un administrateur.",
      'NOT_AUTHORIZED',
      403
    );
  }
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw new PaymentError('Commande introuvable.', 'NOT_FOUND', 404);
  const method = getMethod(order.payment_method_code);
  if (!method || !method.isCash) {
    throw new PaymentError("Cette commande n'utilise pas un paiement à la réception.", 'NOT_CASH', 409);
  }
  if (order.payment_status === 'paid') {
    throw new PaymentError('Cette commande est déjà réglée.', 'ALREADY_PAID', 409);
  }

  const collected = amount === null || amount === '' ? Number(order.total) : Math.round(Number(amount));
  if (!Number.isFinite(collected) || collected <= 0) throw new PaymentError('Montant encaissé invalide.', 'BAD_AMOUNT', 400);

  const reference = `MANUAL-${order.reference}-${Date.now().toString(36).toUpperCase()}`;
  const result = applySuccess(
    order.id,
    {
      amount: collected,
      currency: order.currency,
      provider: 'manual',
      providerReference: reference,
      methodLabel: method.name,
    },
    { actorId: user.id, actorName: user.fullName, source: 'admin' }
  );
  if (!result.ok) {
    throw new PaymentError(`Encaissement refusé : ${result.reason}.`, 'CASH_REJECTED', 409);
  }
  audit(user.id, 'payment.cash_confirmed', order.reference, {
    amount: collected,
    note: normalizeText(note).slice(0, 300),
    reference,
  });
  return result.order;
}

function rejectCashCollection(orderId, { user, reason = '' } = {}) {
  if (!user) throw new PaymentError('Authentification requise.', 'UNAUTHENTICATED', 401);
  if (user.role !== 'admin' && !user.canConfirmCash) throw new PaymentError('Non autorisé.', 'NOT_AUTHORIZED', 403);
  const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
  if (!order) throw new PaymentError('Commande introuvable.', 'NOT_FOUND', 404);
  db.transaction(() => {
    db.update('orders', order.id, { payment_status: 'unpaid', updated_at: dates.nowIso() });
    db.insert('order_events', {
      order_id: order.id,
      scope: 'payment',
      from_value: order.payment_status,
      to_value: 'unpaid',
      message: `Encaissement non confirmé${reason ? ` : ${normalizeText(reason)}` : ''}.`,
      public: 0,
      actor_id: user.id,
      actor_name: user.fullName,
    });
  });
  audit(user.id, 'payment.cash_rejected', order.reference, { reason });
  return require('../orders').loadFull(order.id);
}

/* ------------------------------------------------------------------ */
/* Journalisation / audit                                              */
/* ------------------------------------------------------------------ */
function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'system',
      action,
      entity_type: 'payment',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* noop */ }
}

/** Historique complet des paiements (administration). */
function listPayments({ limit = 100, offset = 0, status = null } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('p.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.all(
    `SELECT p.*, o.reference, o.recipient_name FROM payments p
       JOIN orders o ON o.id = p.order_id
       ${clause}
      ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
}

/** Tableau de bord : montants encaissés / en attente / remboursés. */
function summary() {
  const paid = db.get(
    "SELECT COALESCE(SUM(amount_paid),0) AS total, COUNT(*) AS n FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded')"
  );
  const awaiting = db.get(
    "SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM orders WHERE payment_status = 'awaiting_confirmation' AND status != 'cancelled'"
  );
  const refunded = db.get("SELECT COALESCE(SUM(amount_refunded),0) AS total, COUNT(*) AS n FROM orders WHERE amount_refunded > 0");
  const failed = db.get("SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'failed'");
  return {
    paid: { amount: Number(paid.total), count: paid.n },
    awaiting: { amount: Number(awaiting.total), count: awaiting.n },
    refunded: { amount: Number(refunded.total), count: refunded.n },
    failed: { count: failed.n },
  };
}

module.exports = {
  PaymentError,
  CASH_METHODS,
  MOBILE_MONEY_METHODS,
  listMethods,
  getMethod,
  saveMethod,
  methodState,
  methodsForCheckout,
  hasProviderCredentials,
  initiateForOrder,
  applySuccess,
  applyFailure,
  applyCancellation,
  confirmCashCollection,
  rejectCashCollection,
  listPayments,
  summary,
  providerFor,
};
