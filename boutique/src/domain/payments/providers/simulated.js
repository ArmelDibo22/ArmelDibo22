'use strict';

/**
 * Passerelle de démonstration (bac à sable).
 *
 * Elle n'imite AUCUN prestataire réel : c'est un serveur de test local qui
 * rejoue exactement le même contrat technique qu'une vraie passerelle
 * (création d'un paiement, redirection, notification serveur signée HMAC,
 * déduplication). Elle sert à :
 *   - valider le parcours de paiement de bout en bout avant souscription ;
 *   - exécuter les tests automatisés (succès, échec, notification répétée) ;
 *   - former l'équipe à la confirmation des encaissements.
 *
 * Elle est désactivée dès que PAYMENT_SIMULATION_ENABLED=false et n'est jamais
 * utilisable quand un adaptateur réel est configuré.
 */

const crypto = require('node:crypto');
const config = require('../../../config');
const ids = require('../../../lib/ids');
const dates = require('../../../lib/dates');
const security = require('../../../lib/security');
const logger = require('../../../lib/logger');

const PROVIDER = 'sandbox';

function createPayment({ order, method, payment }) {
  if (!config.payments.simulationEnabled) {
    const err = new Error('La passerelle de démonstration est désactivée.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const providerReference = `SIM-${order.reference}-${(payment?.id || Date.now()).toString(36).toUpperCase()}`;
  const url = `${config.payments.simulationPath}/${encodeURIComponent(order.reference)}?p=${payment?.id || ''}&m=${encodeURIComponent(method.code)}`;
  return {
    type: 'redirect',
    url,
    providerReference,
    expiresAt: dates.addMinutes(dates.nowIso(), 30),
  };
}

/** Construit et signe une notification conforme au contrat de la passerelle. */
function buildNotification({ orderReference, amount, currency = 'XOF', status = 'succeeded', providerReference, eventId = null, reason = '' }) {
  const payload = {
    event_id: eventId || ids.token(12),
    provider: PROVIDER,
    order_reference: orderReference,
    amount: Number(amount),
    currency,
    status, // succeeded | failed | cancelled
    provider_reference: providerReference || `SIM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    reason: reason || undefined,
    timestamp: dates.nowIso(),
  };
  const body = JSON.stringify(payload);
  const secret = config.secrets.paymentWebhook;
  if (!secret) {
    throw Object.assign(new Error('PAYMENT_WEBHOOK_SECRET absent : impossible de signer la notification.'), { code: 'CONFIG_MISSING' });
  }
  return { body, signature: security.signWebhookPayload(Buffer.from(body, 'utf8'), secret), payload };
}

/**
 * Envoie une notification signée au point d'entrée webhook, comme le ferait un
 * prestataire réel. Utilisé par la page de démonstration et par les tests.
 */
async function sendNotification(payload, { baseUrl = null } = {}) {
  const { body, signature } = buildNotification(payload);
  // Appel serveur à serveur : on passe toujours par la boucle locale, jamais par
  // l'URL publique (qui peut être un proxy). Le chemin HTTP complet est ainsi
  // réellement exercé : signature, déduplication, contrôles métier.
  const target = `${baseUrl || `http://127.0.0.1:${config.port}`}/webhooks/${PROVIDER}`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signature,
        'x-provider': PROVIDER,
        'user-agent': 'privilege-sandbox-gateway/1.0',
      },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non JSON */ }
    return { status: res.status, body: json || text };
  } catch (err) {
    logger.warn('notification de démonstration non remise', { target, error: err.message });
    throw err;
  }
}

function verifySignature(rawBody, headers) {
  const secret = config.secrets.paymentWebhook;
  const header = headers['x-signature'] || headers['X-Signature'];
  return security.verifyWebhookSignature(rawBody, header, secret);
}

/** Normalise la notification vers le contrat interne. */
function parseNotification(rawBody) {
  const data = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const statusMap = { succeeded: 'succeeded', success: 'succeeded', paid: 'succeeded', failed: 'failed', error: 'failed', cancelled: 'cancelled' };
  return {
    eventId: String(data.event_id || data.id || ''),
    provider: PROVIDER,
    orderReference: String(data.order_reference || data.reference || ''),
    amount: Number(data.amount),
    currency: String(data.currency || 'XOF').toUpperCase(),
    status: statusMap[String(data.status || '').toLowerCase()] || 'failed',
    providerReference: String(data.provider_reference || ''),
    reason: String(data.reason || ''),
    raw: data,
  };
}

module.exports = {
  name: PROVIDER,
  kind: 'mobile_money',
  supportsWebhook: true,
  createPayment,
  buildNotification,
  sendNotification,
  verifySignature,
  parseNotification,
};
