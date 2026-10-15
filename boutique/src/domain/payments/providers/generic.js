'use strict';

/**
 * Adaptateur générique pour une passerelle Mobile Money RÉELLE.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CET ADAPTATEUR EST VOLONTAIREMENT INACTIF
 * ---------------------------------------------------------------------------
 * L'environnement de développement qui a produit ce code n'a pas d'accès
 * sortant vers les documentations de Wave, Orange Money, MTN MoMo ou Moov
 * Money. Les contrats d'API (points d'entrée, authentification, schémas de
 * notification, environnements bac à sable) n'ont donc pas pu être vérifiés.
 * Écrire ici des appels « plausibles » reviendrait à inventer une API, ce qui
 * produirait une intégration fausse et dangereuse (double encaissement,
 * paiements validés à tort).
 *
 * L'adaptateur renvoie donc NOT_CONFIGURED tant que :
 *   1. un compte marchand est ouvert auprès du prestataire ou d'un agrégateur ;
 *   2. sa documentation officielle a été lue et les identifiants sont dans .env ;
 *   3. les deux fonctions ci-dessous sont implémentées conformément à cette doc.
 *
 * ---------------------------------------------------------------------------
 * CE QU'IL FAUT IMPLÉMENTER (3 points, aucun autre changement nécessaire)
 * ---------------------------------------------------------------------------
 * A. createPayment({order, method, payment}) ->
 *      { type:'redirect', url, providerReference, expiresAt }
 *    Créée côté serveur avec les identifiants marchands (jamais exposés).
 *    Montant : order.total (FCFA entier). Devise : order.currency ('XOF').
 *    Référence boutique : order.reference. Callback : /webhooks/<code>.
 *
 * B. parseNotification(rawBody, headers) ->
 *      { eventId, orderReference, amount, currency, status, providerReference, raw }
 *    `eventId` doit être l'identifiant unique de l'événement côté prestataire :
 *    c'est lui qui garantit la déduplication des notifications répétées.
 *
 * C. verifySignature(rawBody, headers) -> boolean
 *    Vérification de la signature ou du jeton fourni par le prestataire.
 *    En l'absence de signature côté prestataire, protéger l'URL par un secret
 *    partagé dans le chemin + liste blanche d'adresses IP.
 *
 * Le reste du système (contrôle du montant, de la devise, sortie de stock,
 * statuts séparés, journalisation, idempotence) est déjà en place dans
 * `src/domain/payments/index.js` et `src/domain/payments/webhook.js`.
 */

const config = require('../../../config');

class NotConfiguredError extends Error {
  constructor(methodName) {
    super(
      `Le moyen « ${methodName} » n'est pas encore connecté. Aucun compte marchand ni documentation ` +
        "d'API n'a pu être vérifié depuis cet environnement. Renseignez les identifiants dans .env puis " +
        "implémentez l'adaptateur (voir src/domain/payments/providers/generic.js)."
    );
    this.name = 'NotConfiguredError';
    this.code = 'NOT_CONFIGURED';
    this.status = 503;
  }
}

module.exports = {
  name: 'generic',
  kind: 'mobile_money',
  supportsWebhook: false,

  createPayment({ method }) {
    const creds = config.payments.providers[method.code] || {};
    const missing = Object.entries(creds)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const err = new NotConfiguredError(method.name);
    err.details = { code: method.code, missingEnvVars: missing };
    throw err;
  },

  parseNotification() {
    throw new NotConfiguredError('passerelle');
  },

  verifySignature() {
    return false;
  },
};
