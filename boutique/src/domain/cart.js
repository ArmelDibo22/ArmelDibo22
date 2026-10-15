'use strict';

/**
 * Panier côté SERVEUR.
 *
 * Le panier est identifié par un jeton aléatoire stocké dans un cookie httpOnly.
 * Les lignes, les prix et la disponibilité sont relus de la base à chaque
 * affichage : le navigateur n'est jamais la source de vérité.
 */

const db = require('../db');
const dates = require('../lib/dates');
const config = require('../config');
const ids = require('../lib/ids');
const stock = require('./stock');
const products = require('./products');

function ensureCart(req) {
  const token = req.cookies && req.cookies.prv_cart;
  if (token) {
    const existing = db.get('SELECT * FROM carts WHERE token = ?', [token]);
    if (existing && existing.status === 'active') {
      db.run('UPDATE carts SET last_seen_at = ? WHERE id = ?', [dates.nowIso(), existing.id]);
      return { cart: loadCart(existing.id, token), created: false };
    }
  }
  const newToken = ids.token(24);
  const id = db.insert('carts', {
    token: newToken,
    customer_id: req.customer ? req.customer.id : null,
    status: 'active',
    expires_at: dates.addMinutes(dates.nowIso(), config.commerce.cartReservationMinutes * 24), // purge panier inactif : 24x la réservation
  });
  const cart = loadCart(id, newToken);
  cart.__newToken = newToken;
  return { cart, created: true };
}

function getCart(id) {
  const row = db.get('SELECT * FROM carts WHERE id = ?', [id]);
  return row ? loadCart(row.id, row.token) : null;
}

/**
 * Charge un panier avec ses lignes recalculées depuis le catalogue.
 * Les lignes devenues invalides (produit archivé, retiré de la vente) sont
 * signalées mais conservées pour explication à l'utilisateur.
 */
function loadCart(id, token) {
  const row = db.get('SELECT * FROM carts WHERE id = ?', [id]);
  if (!row) return null;
  const rows = db.all(
    `SELECT ci.id, ci.product_id, ci.variant_id, ci.qty, ci.added_at,
            v.options AS variant_options, v.sku AS variant_sku, v.active AS variant_active,
            v.price AS variant_price, v.promo_price AS variant_promo_price
       FROM cart_items ci
       LEFT JOIN product_variants v ON v.id = ci.variant_id
      WHERE ci.cart_id = ?
      ORDER BY ci.added_at ASC`,
    [id]
  );

  const items = [];
  let subtotal = 0;
  let itemCount = 0;
  const problems = [];
  let totalWeight = 0;

  for (const r of rows) {
    const product = products.rawProduct(r.product_id);
    if (!product) {
      problems.push({ id: r.id, message: 'Un article de votre panier n’est plus disponible.' });
      continue;
    }
    const variant = r.variant_id ? products.getVariant(r.variant_id) : null;
    const price = products.priceOf(product, variant);
    const purchasable = products.purchasability(product, variant);
    const availability = products.availabilityOf(product, variant);
    const item = {
      id: r.id,
      productId: product.id,
      variantId: r.variant_id || null,
      sku: (variant && variant.sku) || product.sku || '',
      name: product.name,
      slug: product.slug,
      options: variant ? variant.options : {},
      optionsLabel: variant ? Object.values(variant.options).filter(Boolean).join(' · ') : '',
      unitLabel: product.sale_unit_label || unitLabel(product.sale_unit),
      qty: r.qty,
      unitPrice: price.sale,
      basePrice: price.base,
      compareAt: price.compareAt,
      lineTotal: price.sale * r.qty,
      image: primaryImage(product.id),
      available: availability.available === Infinity ? null : availability.available,
      availabilityStatus: availability.status,
      availabilityLabel: availability.label,
      purchasable: purchasable.ok,
      problems: purchasable.ok ? [] : purchasable.reasons,
      isKit: Boolean(product.is_kit),
      trackStock: Boolean(product.track_stock),
      weightG: (variant && variant.weight_g) || product.weight_g || 0,
    };
    if (!purchasable.ok || availability.status === 'out') {
      problems.push({ id: r.id, name: product.name, message: purchasable.reasons[0] || availability.label });
    } else if (availability.status !== 'untracked' && r.qty > availability.available) {
      problems.push({
        id: r.id,
        name: product.name,
        message: `Quantité réduite : ${availability.available} unité(s) disponible(s).`,
        adjustTo: availability.available,
      });
    }
    if (product.status !== 'published') continue; // non affiché, non compté
    items.push(item);
    subtotal += item.lineTotal;
    itemCount += item.qty;
    totalWeight += item.weightG * item.qty;
  }

  return {
    id: row.id,
    token,
    status: row.status,
    customerId: row.customer_id,
    items,
    itemCount,
    subtotal,
    totalWeightG: totalWeight,
    problems,
    valid: problems.filter((p) => p.adjustTo === undefined).length === 0,
    updatedAt: row.updated_at,
  };
}

function unitLabel(unit) {
  return products.SALE_UNITS.find((u) => u.value === unit)?.label || 'Pièce';
}

function primaryImage(productId) {
  const row = db.get(
    `SELECT m.file_key, pi.alt FROM product_images pi JOIN media_files m ON m.id = pi.media_id
      WHERE pi.product_id = ? ORDER BY pi.is_primary DESC, pi.position ASC LIMIT 1`,
    [productId]
  );
  return row ? { fileKey: row.file_key, alt: row.alt } : null;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */
function addItem(cartId, productId, { variantId = null, qty = 1 } = {}) {
  const product = products.rawProduct(productId);
  if (!product) throw Object.assign(new Error('Produit introuvable.'), { status: 404 });

  const variant = variantId ? products.getVariant(variantId) : null;
  if (variantId && (!variant || variant.product_id !== product.id)) {
    throw Object.assign(new Error('Variante introuvable pour ce produit.'), { status: 400 });
  }
  const purchasable = products.purchasability(product, variant);
  if (!purchasable.ok) {
    throw Object.assign(new Error(purchasable.reasons[0]), { status: 409, code: 'NOT_PURCHASABLE', reasons: purchasable.reasons });
  }

  const quantity = Math.max(1, Math.min(Number(qty) || 1, 9999));
  const existing = db.get(
    `SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_id IS ?`,
    [cartId, productId, variant ? variant.id : null]
  );
  const nextQty = (existing?.qty || 0) + quantity;

  // Contrôle de disponibilité AVANT réservation (message clair côté client).
  const availability = products.availabilityOf(product, variant);
  if (availability.status !== 'untracked' && nextQty > availability.available) {
    throw Object.assign(
      new Error(
        `Quantité demandée supérieure au stock disponible (${availability.available} unité(s) pour « ${product.name} »).`
      ),
      { status: 409, code: 'STOCK_INSUFFICIENT', available: availability.available }
    );
  }

  db.transaction(() => {
    if (existing) {
      db.run('UPDATE cart_items SET qty = ? WHERE id = ?', [nextQty, existing.id]);
    } else {
      db.insert('cart_items', { cart_id: cartId, product_id: productId, variant_id: variant ? variant.id : null, qty: quantity });
    }
    db.run('UPDATE carts SET updated_at = ? WHERE id = ?', [dates.nowIso(), cartId]);
    revalidateReservations(cartId);
  });

  return { added: true, qty: nextQty, product: products.getById(productId) };
}

function setItemQty(cartId, itemId, qty) {
  const item = db.get('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', [itemId, cartId]);
  if (!item) throw Object.assign(new Error('Ligne de panier introuvable.'), { status: 404 });
  const next = Math.max(0, Math.min(Number(qty) || 0, 9999));
  db.transaction(() => {
    if (next === 0) db.run('DELETE FROM cart_items WHERE id = ?', [itemId]);
    else db.run('UPDATE cart_items SET qty = ? WHERE id = ?', [next, itemId]);
    db.run('UPDATE carts SET updated_at = ? WHERE id = ?', [dates.nowIso(), cartId]);
    revalidateReservations(cartId);
  });
  return true;
}

function removeItem(cartId, itemId) {
  db.transaction(() => {
    db.run('DELETE FROM cart_items WHERE id = ? AND cart_id = ?', [itemId, cartId]);
    db.run('UPDATE carts SET updated_at = ? WHERE id = ?', [dates.nowIso(), cartId]);
    revalidateReservations(cartId);
  });
  return true;
}

function clear(cartId) {
  db.transaction(() => {
    stock.releaseReservations({ cartId, note: 'Panier vidé' });
    db.run('DELETE FROM cart_items WHERE cart_id = ?', [cartId]);
    db.run('UPDATE carts SET updated_at = ? WHERE id = ?', [dates.nowIso(), cartId]);
  });
  return true;
}

/**
 * Recalcule les réservations du panier pour coller exactement à son contenu.
 * La réservation est volontairement courte (CART_RESERVATION_MINUTES) : elle
 * évite le blocage de stock par des paniers abandonnés.
 */
function revalidateReservations(cartId) {
  stock.releaseExpired();
  stock.releaseReservations({ cartId, note: 'Recalcul du panier' });

  const items = db.all('SELECT * FROM cart_items WHERE cart_id = ?', [cartId]);
  const targets = [];
  for (const item of items) {
    const product = products.rawProduct(item.product_id);
    if (!product || product.status !== 'published' || !product.data_confirmed) continue;
    try {
      targets.push(...stock.resolveTargets(item.product_id, item.variant_id, item.qty));
    } catch {
      // Article devenu invendable : la ligne est signalée à l'affichage du panier.
    }
  }
  if (targets.length) {
    try {
      stock.reserve(targets, { cartId, note: 'Réservation panier' });
    } catch (err) {
      // Stock insuffisant entre-temps : on réserve ce qui est possible, ligne par ligne.
      for (const t of targets) {
        try {
          stock.reserve([t], { cartId, note: 'Réservation panier (partielle)' });
        } catch { /* la ligne correspondante sera signalée */ }
      }
    }
  }
  return targets.length;
}

/** Convertit un panier en commande : les réservations passent du panier à la commande. */
function convertToOrder(cartId, orderId) {
  db.run('UPDATE reservations SET order_id = ?, cart_id = NULL WHERE cart_id = ? AND status = \'active\'', [orderId, cartId]);
  db.run("UPDATE carts SET status = 'converted', updated_at = ? WHERE id = ?", [dates.nowIso(), cartId]);
}

/** Fusionne le panier invité dans le panier d'un client connecté. */
function mergeInto(customerId, cartId) {
  db.run('UPDATE carts SET customer_id = ? WHERE id = ?', [customerId, cartId]);
}

function purgeStale(olderThanHours = 72) {
  const cutoff = dates.addMinutes(dates.nowIso(), -olderThanHours * 60);
  const stale = db.all("SELECT id FROM carts WHERE status = 'active' AND last_seen_at < ?", [cutoff]);
  for (const c of stale) {
    stock.releaseReservations({ cartId: c.id, note: 'Panier inactif purgé' });
    db.run('DELETE FROM cart_items WHERE cart_id = ?', [c.id]);
    db.run("UPDATE carts SET status = 'abandoned' WHERE id = ?", [c.id]);
  }
  return stale.length;
}

module.exports = {
  ensureCart,
  getCart,
  loadCart,
  addItem,
  setItemQty,
  removeItem,
  clear,
  revalidateReservations,
  convertToOrder,
  mergeInto,
  purgeStale,
  unitLabel,
};
