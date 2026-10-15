'use strict';

/**
 * Adaptateur « encaissement à la réception » (retrait ou livraison).
 * Aucun appel réseau : la validation passe obligatoirement par la confirmation
 * d'un utilisateur habilité dans l'administration, avec historique.
 */

const money = require('../../../lib/money');

module.exports = {
  name: 'manual',
  kind: 'cash',

  createPayment({ order, method }) {
    return {
      type: 'instructions',
      message:
        method.instructions ||
        `Vous réglerez ${money.format(order.total)} en espèces au moment du ${
          order.fulfillment_mode === 'pickup' ? 'retrait en boutique' : 'de la livraison'
        }.`,
      awaitingConfirmation: true,
    };
  },

  /** Pas de notification entrante : l'encaissement est saisi en administration. */
  supportsWebhook: false,
};
