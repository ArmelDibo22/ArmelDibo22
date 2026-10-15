'use strict';

/**
 * Point d'entrée unique des notifications de paiement.
 *
 * Le corps est reçu BRUT (express.raw monté sur /webhooks dans app.js) afin que
 * la signature HMAC soit calculée sur exactement les octets transmis.
 */

const express = require('express');
const config = require('../config');
const ratelimit = require('../lib/ratelimit');
const logger = require('../lib/logger');
const { handleNotification } = require('../domain/payments/webhook');

const router = express.Router();

router.post(
  '/:provider',
  ratelimit.middleware({
    keyPrefix: 'rl-webhook',
    windowMs: 60_000,
    max: config.security.rateLimit.webhookMax,
    keyFn: (req) => req.params.provider,
  }),
  (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    try {
      const result = handleNotification({
        provider,
        rawBody,
        headers: req.headers,
        ip: require('../lib/http').clientIp(req),
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('exception webhook', { provider, error: err.message });
      return res.status(500).json({ ok: false, error: 'Traitement impossible.' });
    }
  }
);

router.get('/:provider', (req, res) => {
  // Réponse explicite : les prestataires n'utilisent pas GET pour notifier.
  res.status(405).json({ ok: false, error: 'Méthode non autorisée : les notifications sont reçues en POST.' });
});

module.exports = router;
