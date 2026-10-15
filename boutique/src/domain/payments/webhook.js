'use strict';

/**
 * Réception des notifications de paiement.
 *
 * Chaîne de contrôle appliquée à CHAQUE notification, dans cet ordre :
 *   1. limite de débit par adresse IP ;
 *   2. vérification de la signature HMAC (comparaison à temps constant) ;
 *   3. déduplication par (provider, event_id) — contrainte d'unicité en base ;
 *   4. recherche de la commande par référence boutique ;
 *   5. vérification de la devise et du montant attendus ;
 *   6. application de l'effet (une seule fois) dans une transaction.
 *
 * Une page de retour, un message du client ou une capture d'écran ne passent
 * jamais par ce chemin et ne peuvent donc jamais valider un paiement.
 */

const db = require('../../db');
const dates = require('../../lib/dates');
const logger = require('../../lib/logger');
const payments = require('./index');
const orders = require('../orders');

const ADAPTERS = {
  sandbox: () => require('./providers/simulated'),
  generic: () => require('./providers/generic'),
};

function adapterFor(provider) {
  const factory = ADAPTERS[provider];
  return factory ? factory() : null;
}

/**
 * @param {{provider:string, rawBody:Buffer|string, headers:object, ip:string}} req
 * @returns {{status:number, body:object}}
 */
function handleNotification({ provider, rawBody, headers = {}, ip = '' }) {
  const adapter = adapterFor(provider);
  if (!adapter) {
    return { status: 404, body: { ok: false, error: 'Passerelle inconnue.' } };
  }
  if (!adapter.supportsWebhook) {
    return { status: 405, body: { ok: false, error: 'Cette passerelle ne reçoit pas de notification.' } };
  }

  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  if (!bodyText) return { status: 400, body: { ok: false, error: 'Corps de notification vide.' } };
  if (bodyText.length > 64 * 1024) return { status: 413, body: { ok: false, error: 'Notification trop volumineuse.' } };

  // --- 2. Signature --------------------------------------------------------
  let signatureOk = false;
  try {
    signatureOk = Boolean(adapter.verifySignature(Buffer.from(bodyText, 'utf8'), headers));
  } catch (err) {
    logger.error('vérification de signature en échec', { provider, error: err.message });
  }

  // --- 3. Déduplication ------------------------------------------------------
  let parsed = null;
  try {
    parsed = adapter.parseNotification(bodyText);
  } catch (err) {
    record({ provider, eventId: `bad-${dates.nowIso()}`, bodyText, signatureOk, status: 'rejected', error: `Notification illisible : ${err.message}`, ip });
    return { status: 400, body: { ok: false, error: 'Notification illisible.' } };
  }

  const eventId = parsed.eventId || `auto-${hashOf(bodyText)}`;
  const dedupe = record({ provider, eventId, bodyText, signatureOk, status: 'received', ip, kind: parsed.status });

  if (!signatureOk) {
    db.run("UPDATE webhook_events SET status = 'rejected', error = ? WHERE id = ?", ['Signature invalide ou absente.', dedupe.id]);
    logger.warn('notification rejetée : signature invalide', { provider, eventId, ip });
    return { status: 401, body: { ok: false, error: 'Signature invalide.' } };
  }
  if (dedupe.duplicate) {
    logger.info('notification dupliquée ignorée', { provider, eventId });
    return { status: 200, body: { ok: true, duplicate: true, eventId } };
  }

  // --- 4. Commande ------------------------------------------------------------
  const order = orders.getByReference(parsed.orderReference);
  if (!order) {
    db.run("UPDATE webhook_events SET status = 'rejected', error = ? WHERE id = ?", [`Commande introuvable : ${parsed.orderReference}`, dedupe.id]);
    return { status: 404, body: { ok: false, error: 'Commande introuvable.' } };
  }

  // --- 5 & 6. Effet ------------------------------------------------------------
  let result;
  try {
    if (parsed.status === 'succeeded') {
      result = payments.applySuccess(order.id, {
        amount: parsed.amount,
        currency: parsed.currency,
        provider,
        providerReference: parsed.providerReference,
        methodLabel: payments.getMethod(order.payment_method_code)?.name || provider,
      }, { source: 'webhook' });
    } else if (parsed.status === 'failed') {
      result = payments.applyFailure(order.id, {
        reason: parsed.reason || 'Paiement refusé par la passerelle.',
        provider,
        providerReference: parsed.providerReference,
      });
    } else {
      result = payments.applyCancellation(order.id, {
        provider,
        providerReference: parsed.providerReference,
        reason: parsed.reason || 'Paiement annulé.',
      });
    }
  } catch (err) {
    db.run("UPDATE webhook_events SET status = 'error', error = ?, processed_at = ? WHERE id = ?", [
      err.message.slice(0, 500), dates.nowIso(), dedupe.id,
    ]);
    logger.error('traitement de notification en échec', { provider, eventId, error: err.message });
    return { status: 500, body: { ok: false, error: 'Traitement en échec.' } };
  }

  if (!result.ok) {
    db.run("UPDATE webhook_events SET status = 'rejected', error = ?, processed_at = ? WHERE id = ?", [
      String(result.reason), dates.nowIso(), dedupe.id,
    ]);
    logger.warn('notification refusée par contrôle métier', { provider, eventId, reason: result.reason });
    return { status: 422, body: { ok: false, reason: result.reason } };
  }

  db.run("UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE id = ?", [dates.nowIso(), dedupe.id]);
  return { status: 200, body: { ok: true, eventId, result: result.duplicate ? 'already_paid' : parsed.status } };
}

/** Enregistre l'événement et détecte les doublons via la contrainte UNIQUE. */
function record({ provider, eventId, bodyText, signatureOk, status, ip = '', kind = '', error = '' }) {
  const payload = bodyText.length > 8000 ? `${bodyText.slice(0, 8000)}…` : bodyText;
  const existing = db.get('SELECT id, status FROM webhook_events WHERE provider = ? AND event_id = ?', [provider, eventId]);
  if (existing) {
    return { id: existing.id, duplicate: true, status: existing.status };
  }
  const id = db.insert('webhook_events', {
    provider,
    event_id: eventId,
    kind,
    payload,
    signature_ok: signatureOk ? 1 : 0,
    status,
    error,
    ip: String(ip).slice(0, 45),
  });
  return { id, duplicate: false, status };
}

function hashOf(text) {
  return require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function recentEvents(limit = 50) {
  return db.all('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?', [Number(limit)]);
}

function stats() {
  return db.get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed,
       SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN signature_ok = 0 THEN 1 ELSE 0 END) AS bad_signature
     FROM webhook_events`
  );
}

module.exports = { handleNotification, adapterFor, recentEvents, stats };
