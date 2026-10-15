'use strict';

/**
 * Panier.
 *
 * Le panier vit côté serveur (table `carts`), identifié par un cookie httpOnly.
 * Les prix, la disponibilité et les totaux sont recalculés à chaque affichage :
 * rien n'est jamais repris tel quel depuis le navigateur.
 */

const express = require('express');
const cart = require('../domain/cart');
const products = require('../domain/products');
const settings = require('../lib/settings');
const money = require('../lib/money');
const { flash, isAjax } = require('../lib/http');
const whatsapp = require('../lib/whatsapp');
const ratelimit = require('../lib/ratelimit');
const shipping = require('../domain/shipping');

const router = express.Router();

function respond(req, res, { redirect = '/panier', payload = null, status = 200, errorMessage = null }) {
  if (isAjax(req)) {
    return res.status(status).json(payload || { ok: status < 400, error: errorMessage });
  }
  return res.redirect(redirect);
}

router.get('/panier', (req, res) => {
  const current = req.cart ? cart.loadCart(req.cart.id, req.cart.token) : null;
  res.renderPage('cart', {
    title: 'Panier',
    canonical: '/panier',
    noindex: true,
    cart: current,
    whatsappCartUrl: current && current.items.length ? whatsapp.cartSummaryUrl(current) : '',
    minOrder: Number(settings.get('commerce.min_order_amount') || 0),
    pickupZone: shipping.pickupZone(),
    deliveryZones: shipping.deliveryZones(),
  });
});

router.post(
  '/panier/ajouter',
  ratelimit.middleware({ keyPrefix: 'rl-cart', windowMs: 60_000, max: 60, keyFn: () => 'add' }),
  (req, res) => {
    if (!req.cart) return respond(req, res, { status: 400, errorMessage: 'Panier indisponible.' });
    const productId = Number(req.body.productId || req.body.product_id || 0);
    const variantId = req.body.variantId || req.body.variant_id ? Number(req.body.variantId || req.body.variant_id) : null;
    const qty = Math.max(1, Number(req.body.qty || req.body.quantite || 1));

    try {
      const result = cart.addItem(req.cart.id, productId, { variantId, qty });
      const fresh = cart.loadCart(req.cart.id, req.cart.token);
      const product = products.rawProduct(productId);
      const message = `« ${product?.name || 'Article'} » a été ajouté au panier.`;
      if (isAjax(req)) {
        return res.json({
          ok: true,
          message,
          itemCount: fresh.itemCount,
          subtotal: fresh.subtotal,
          subtotalLabel: money.format(fresh.subtotal),
          cartUrl: '/panier',
          line: result,
        });
      }
      flash(req, 'success', message);
      const stay = String(req.body.rester || '') === '1';
      return res.redirect(stay && product ? `/produit/${product.slug}` : '/panier');
    } catch (err) {
      const status = err.status || 400;
      if (isAjax(req)) {
        return res.status(status).json({ ok: false, error: err.message, code: err.code || null, available: err.available ?? null });
      }
      flash(req, 'error', err.message);
      const product = products.rawProduct(productId);
      return res.redirect(status === 404 ? '/catalogue' : product ? `/produit/${product.slug}` : '/panier');
    }
  }
);

router.post('/panier/ligne/:id', (req, res) => {
  if (!req.cart) return respond(req, res, { status: 400, errorMessage: 'Panier indisponible.' });
  try {
    cart.setItemQty(req.cart.id, Number(req.params.id), Number(req.body.qty ?? req.body.quantite ?? 0));
    const fresh = cart.loadCart(req.cart.id, req.cart.token);
    if (isAjax(req)) {
      return res.json({ ok: true, itemCount: fresh.itemCount, subtotal: fresh.subtotal, subtotalLabel: money.format(fresh.subtotal), problems: fresh.problems });
    }
    flash(req, 'success', 'Panier mis à jour.');
    return res.redirect('/panier');
  } catch (err) {
    if (isAjax(req)) return res.status(err.status || 400).json({ ok: false, error: err.message });
    flash(req, 'error', err.message);
    return res.redirect('/panier');
  }
});

router.post('/panier/supprimer/:id', (req, res) => {
  if (!req.cart) return respond(req, res, { status: 400, errorMessage: 'Panier indisponible.' });
  cart.removeItem(req.cart.id, Number(req.params.id));
  const fresh = cart.loadCart(req.cart.id, req.cart.token);
  if (isAjax(req)) {
    return res.json({ ok: true, itemCount: fresh.itemCount, subtotal: fresh.subtotal, subtotalLabel: money.format(fresh.subtotal) });
  }
  flash(req, 'info', 'Article retiré du panier.');
  return res.redirect('/panier');
});

router.post('/panier/vider', (req, res) => {
  if (req.cart) cart.clear(req.cart.id);
  if (isAjax(req)) return res.json({ ok: true, itemCount: 0, subtotal: 0 });
  flash(req, 'info', 'Panier vidé.');
  return res.redirect('/panier');
});

/** Compteur de panier pour l'en-tête (appel léger, sans rendu). */
router.get('/api/panier', (req, res) => {
  const fresh = req.cart ? cart.loadCart(req.cart.id, req.cart.token) : null;
  res.json({
    ok: true,
    itemCount: fresh?.itemCount || 0,
    subtotal: fresh?.subtotal || 0,
    subtotalLabel: money.format(fresh?.subtotal || 0),
    problems: fresh?.problems || [],
  });
});

module.exports = router;
