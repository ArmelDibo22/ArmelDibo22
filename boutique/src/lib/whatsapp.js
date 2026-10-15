'use strict';

/**
 * Lien WhatsApp.
 *
 * Règles appliquées :
 *  - WhatsApp n'est proposé que si un contact est explicitement marqué
 *    « accepte WhatsApp » dans les réglages ; on ne le suppose jamais ;
 *  - ouvrir WhatsApp transmet une question ou un récapitulatif : cela ne
 *    confirme ni une commande, ni un paiement (rappel affiché à l'utilisateur).
 */

const settings = require('./settings');

function waNumber() {
  const contact = settings.whatsappContact();
  if (!contact) return '';
  return String(contact.value || '').replace(/\D/g, '');
}

function isEnabled() {
  return Boolean(settings.get('whatsapp.enabled')) && Boolean(waNumber());
}

/**
 * @param {string} text message pré-rempli
 * @returns {string} url https://wa.me/... ou chaîne vide si non configuré
 */
function url(text = '') {
  const number = waNumber();
  if (!number) return '';
  const message = String(text || '').slice(0, 1500);
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

function questionUrl(product = null) {
  const store = settings.get('store.name');
  const text = product
    ? `Bonjour ${store}, j'ai une question sur l'article « ${product.name} » (réf. ${product.sku || '—'}).`
    : `Bonjour ${store}, j'ai une question.`;
  return url(text);
}

function cartSummaryUrl(cart, { store = null } = {}) {
  const name = store || settings.get('store.short_name');
  const lines = (cart?.items || []).map(
    (i) => `• ${i.qty} × ${i.name}${i.optionsLabel ? ` (${i.optionsLabel})` : ''}`
  );
  const text = [
    `Bonjour ${name}, voici le récapitulatif de mon panier :`,
    ...lines,
    '',
    `Total articles : ${require('./money').format(cart?.subtotal || 0)}`,
    '',
    '(Récapitulatif transmis pour information : il ne confirme ni commande ni paiement.)',
  ].join('\n');
  return url(text);
}

function orderSummaryUrl(order, { store = null } = {}) {
  const name = store || settings.get('store.short_name');
  const lines = (order?.items || []).map((i) => `• ${i.qty} × ${i.name}${i.options_label ? ` (${i.options_label})` : ''}`);
  const text = [
    `Bonjour ${name}, je souhaite échanger au sujet de ma commande ${order?.reference || ''}.`,
    ...lines,
    '',
    `Total : ${require('./money').format(order?.total || 0)}`,
    `Statut : ${order?.statusLabel || order?.status || ''}`,
  ].join('\n');
  return url(text);
}

module.exports = { isEnabled, url, questionUrl, cartSummaryUrl, orderSummaryUrl, waNumber };
