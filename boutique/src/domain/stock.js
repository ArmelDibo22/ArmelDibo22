'use strict';

/**
 * Stock, réservations et historique des mouvements.
 *
 * Règles :
 *  - une ligne `stock_items` par propriétaire de stock (produit simple ou variante) ;
 *  - disponible = qty_on_hand − qty_reserved ;
 *  - toute écriture passe par un UPDATE conditionnel atomique : si la garde
 *    échoue (`changes === 0`), l'opération est refusée → aucune survente, même
 *    en cas d'achats concurrents ;
 *  - chaque variation crée une ligne `stock_movements` (historique complet) ;
 *  - les réservations expirent et sont libérées par un balayage périodique ;
 *  - les kits consomment explicitement leurs composants.
 *
 * Toutes les fonctions sont SYNCHRONES et doivent être appelées dans une
 * transaction lorsqu'elles touchent plusieurs lignes.
 */

const db = require('../db');
const dates = require('../lib/dates');
const config = require('../config');

class StockError extends Error {
  constructor(message, code = 'STOCK_INSUFFICIENT', details = null) {
    super(message);
    this.name = 'StockError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Accès                                                               */
/* ------------------------------------------------------------------ */
function itemFor(productId, variantId = null) {
  if (variantId) {
    return db.get('SELECT * FROM stock_items WHERE product_id = ? AND variant_id = ?', [productId, variantId]) || null;
  }
  return db.get('SELECT * FROM stock_items WHERE product_id = ? AND variant_id IS NULL', [productId]) || null;
}

function itemsForProduct(productId) {
  return db.all('SELECT * FROM stock_items WHERE product_id = ? ORDER BY variant_id IS NULL DESC, id ASC', [productId]);
}

function available(item) {
  if (!item) return 0;
  if (!item.track_stock) return Infinity;
  return Math.max(0, (item.qty_on_hand || 0) - (item.qty_reserved || 0));
}

function availableForProduct(productId) {
  const items = itemsForProduct(productId);
  if (!items.length) return 0;
  if (items.some((i) => !i.track_stock)) return Infinity;
  return items.reduce((sum, i) => sum + Math.max(0, (i.qty_on_hand || 0) - (i.qty_reserved || 0)), 0);
}

/** Crée (ou met à jour) les lignes de stock d'un produit et de ses variantes. */
function syncItems(productId, { userId = null } = {}) {
  const product = db.get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) return [];
  const variants = db.all('SELECT * FROM product_variants WHERE product_id = ?', [productId]);

  db.transaction(() => {
    if (!variants.length) {
      const existing = itemFor(productId, null);
      if (!existing) {
        db.insert('stock_items', {
          product_id: productId,
          variant_id: null,
          sku: product.sku || '',
          qty_on_hand: Math.max(0, product.qty || 0),
          qty_reserved: 0,
          low_stock_threshold: product.low_stock_threshold || 0,
          track_stock: product.track_stock ? 1 : 0,
        });
        const created = itemFor(productId, null);
        if (created && product.qty > 0) {
          recordMovement(created.id, product.qty, 'initial', {
            note: 'Stock initial',
            userId,
            reference: product.sku || `P${productId}`,
          });
        }
      } else {
        db.update('stock_items', existing.id, {
          sku: product.sku || '',
          low_stock_threshold: product.low_stock_threshold || 0,
          track_stock: product.track_stock ? 1 : 0,
          updated_at: dates.nowIso(),
        });
        // Le produit simple reste la source de vérité pour le stock saisi.
        if (product.track_stock && (existing.qty_on_hand || 0) !== (product.qty || 0) && existing.qty_reserved === 0) {
          setOnHand(existing.id, product.qty, { reason: 'ajustement', note: 'Synchronisation fiche produit', userId });
        }
      }
    } else {
      // Supprime les lignes orphelines (variante supprimée) sans réservation active.
      const variantIds = new Set(variants.map((v) => v.id));
      for (const item of itemsForProduct(productId)) {
        if (item.variant_id && !variantIds.has(item.variant_id) && !item.qty_reserved) {
          db.run('DELETE FROM stock_items WHERE id = ?', [item.id]);
        }
      }
      const orphan = db.get('SELECT id FROM stock_items WHERE product_id = ? AND variant_id IS NULL AND qty_reserved = 0', [productId]);
      if (orphan) db.run('DELETE FROM stock_items WHERE id = ?', [orphan.id]);

      for (const v of variants) {
        const existing = itemFor(productId, v.id);
        if (!existing) {
          db.insert('stock_items', {
            product_id: productId,
            variant_id: v.id,
            sku: v.sku || product.sku || '',
            qty_on_hand: 0,
            qty_reserved: 0,
            low_stock_threshold: product.low_stock_threshold || 0,
            track_stock: product.track_stock ? 1 : 0,
          });
        } else {
          db.update('stock_items', existing.id, {
            sku: v.sku || product.sku || '',
            low_stock_threshold: product.low_stock_threshold || 0,
            track_stock: product.track_stock ? 1 : 0,
            updated_at: dates.nowIso(),
          });
        }
      }
    }
    // Le produit maître d'un kit ne porte pas de stock propre.
    if (product.is_kit) {
      db.run('UPDATE stock_items SET track_stock = 0, qty_on_hand = 0, qty_reserved = 0 WHERE product_id = ?', [productId]);
    }
  });
  return itemsForProduct(productId);
}

/* ------------------------------------------------------------------ */
/* Mouvements                                                          */
/* ------------------------------------------------------------------ */
function recordMovement(stockItemId, delta, reason, { reference = '', note = '', userId = null } = {}) {
  const item = db.get('SELECT * FROM stock_items WHERE id = ?', [stockItemId]);
  if (!item) return null;
  return db.insert('stock_movements', {
    stock_item_id: stockItemId,
    product_id: item.product_id,
    variant_id: item.variant_id,
    delta: Number(delta),
    reason,
    reference: String(reference || ''),
    note: String(note || ''),
    qty_after: item.qty_on_hand || 0,
    created_by: userId || null,
  });
}

/** Définit une quantité en stock (saisie d'inventaire / ajustement). */
function setOnHand(stockItemId, targetQty, { reason = 'ajustement', note = '', userId = null, reference = '' } = {}) {
  const item = db.get('SELECT * FROM stock_items WHERE id = ?', [stockItemId]);
  if (!item) throw new StockError('Ligne de stock introuvable.', 'STOCK_ITEM_MISSING');
  const target = Math.max(0, Math.round(Number(targetQty) || 0));
  if (target < item.qty_reserved) {
    throw new StockError(
      `Impossible de descendre sous ${item.qty_reserved} unité(s) déjà réservée(s).`,
      'STOCK_BELOW_RESERVED'
    );
  }
  const delta = target - item.qty_on_hand;
  db.run('UPDATE stock_items SET qty_on_hand = ?, updated_at = ? WHERE id = ?', [target, dates.nowIso(), stockItemId]);
  db.run('UPDATE products SET qty = ?, updated_at = ? WHERE id = ? AND is_kit = 0 AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id)', [target, dates.nowIso(), item.product_id]);
  if (delta !== 0) recordMovement(stockItemId, delta, reason, { note, userId, reference });
  return { item: db.get('SELECT * FROM stock_items WHERE id = ?', [stockItemId]), delta };
}

function adjust(stockItemId, delta, { reason = 'ajustement', note = '', userId = null, reference = '' } = {}) {
  const d = Math.round(Number(delta) || 0);
  const item = db.get('SELECT * FROM stock_items WHERE id = ?', [stockItemId]);
  if (!item) throw new StockError('Ligne de stock introuvable.', 'STOCK_ITEM_MISSING');
  if (d === 0) return { item, delta: 0 };
  const target = item.qty_on_hand + d;
  if (target < 0) throw new StockError('Le stock ne peut pas devenir négatif.', 'STOCK_NEGATIVE');
  return setOnHand(stockItemId, target, { reason, note, userId, reference });
}

function movements({ stockItemId = null, productId = null, limit = 100, offset = 0, reason = null } = {}) {
  const where = [];
  const params = [];
  if (stockItemId) { where.push('m.stock_item_id = ?'); params.push(stockItemId); }
  if (productId) { where.push('m.product_id = ?'); params.push(productId); }
  if (reason) { where.push('m.reason = ?'); params.push(reason); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.all(
    `SELECT m.*, p.name AS product_name, p.sku AS product_sku, u.full_name AS actor_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.created_by
       ${clause}
      ORDER BY m.id DESC
      LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
}

/** Produits dont le stock disponible atteint ou passe sous le seuil d'alerte. */
function lowStockList(limit = 200) {
  return db.all(
    `SELECT si.*, p.name AS product_name, p.sku AS product_sku, p.status AS product_status,
            v.options AS variant_options,
            (si.qty_on_hand - si.qty_reserved) AS available
       FROM stock_items si
       JOIN products p ON p.id = si.product_id
       LEFT JOIN product_variants v ON v.id = si.variant_id
      WHERE si.track_stock = 1
        AND (si.qty_on_hand - si.qty_reserved) <= si.low_stock_threshold
        AND p.status != 'archived'
      ORDER BY available ASC, p.name ASC
      LIMIT ?`,
    [Number(limit)]
  );
}

/* ------------------------------------------------------------------ */
/* Kits : disponibilité dérivée des composants                         */
/* ------------------------------------------------------------------ */
function kitComponents(kitProductId) {
  return db.all(
    `SELECT ki.*, p.name AS product_name, p.sku AS product_sku, p.status AS product_status,
            si.id AS stock_item_id, si.qty_on_hand, si.qty_reserved, si.track_stock
       FROM kit_items ki
       JOIN products p ON p.id = ki.component_product_id
       LEFT JOIN stock_items si
         ON si.product_id = ki.component_product_id
        AND ((ki.component_variant_id IS NULL AND si.variant_id IS NULL) OR si.variant_id = ki.component_variant_id)
      WHERE ki.kit_product_id = ?`,
    [kitProductId]
  );
}

/** Quantité disponible d'un kit = minimum des rapports composants. */
function kitAvailable(kitProductId) {
  const components = kitComponents(kitProductId);
  if (!components.length) return 0;
  let min = Infinity;
  for (const c of components) {
    if (!c.track_stock) continue; // composant non suivi => n'entre pas dans le calcul
    const avail = Math.max(0, (c.qty_on_hand || 0) - (c.qty_reserved || 0));
    min = Math.min(min, Math.floor(avail / Math.max(1, c.quantity)));
  }
  return min === Infinity ? Infinity : Math.max(0, min);
}

function saveKitComponents(kitProductId, components) {
  db.run('DELETE FROM kit_items WHERE kit_product_id = ?', [kitProductId]);
  for (const c of components || []) {
    const productId = Number(c.component_product_id);
    if (!productId || productId === Number(kitProductId)) continue;
    const qty = Math.max(1, Math.round(Number(c.quantity) || 1));
    const variantId = c.component_variant_id ? Number(c.component_variant_id) : null;
    db.run(
      `INSERT OR REPLACE INTO kit_items (kit_product_id, component_product_id, component_variant_id, quantity)
       VALUES (?, ?, ?, ?)`,
      [kitProductId, productId, variantId, qty]
    );
  }
  // Le stock d'un kit est dérivé : on désactive le suivi propre.
  db.run('UPDATE products SET is_kit = ?, track_stock = 0 WHERE id = ?', [
    (components || []).length ? 1 : 0,
    kitProductId,
  ]);
  syncItems(kitProductId);
}

/* ------------------------------------------------------------------ */
/* Réservation / consommation / libération                             */
/* ------------------------------------------------------------------ */

/**
 * Traduit une ligne de panier en cibles de stock.
 * Un kit éclate en ses composants ; un produit simple donne une cible.
 */
function resolveTargets(productId, variantId, qty) {
  const product = db.get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new StockError('Produit introuvable.', 'PRODUCT_MISSING');
  const quantity = Math.max(1, Math.round(Number(qty) || 1));

  if (product.is_kit) {
    const components = kitComponents(productId);
    if (!components.length) {
      throw new StockError(`Le kit « ${product.name} » n'a aucun composant configuré.`, 'KIT_EMPTY');
    }
    return components.map((c) => {
      if (!c.stock_item_id) throw new StockError(`Stock indisponible pour le composant « ${c.product_name} ».`, 'STOCK_ITEM_MISSING');
      return { stockItemId: c.stock_item_id, qty: c.quantity * quantity, label: c.product_name, isKitComponent: true, kitProductId: productId };
    });
  }

  const item = itemFor(productId, variantId || null);
  if (!item) throw new StockError('Stock indisponible pour cet article.', 'STOCK_ITEM_MISSING');
  return [{ stockItemId: item.id, qty: quantity, label: product.name, isKitComponent: false }];
}

/**
 * Réserve du stock pour un panier ou une commande.
 * L'UPDATE conditionnel garantit l'atomicité : en cas de concurrence, une seule
 * des deux réservations passe, l'autre reçoit StockError.
 */
function reserve(targets, { cartId = null, orderId = null, minutes = null, userId = null, note = '' } = {}) {
  const ttl = Number(minutes ?? (orderId ? config.commerce.orderReservationMinutes : config.commerce.cartReservationMinutes));
  const expiresAt = dates.addMinutes(dates.nowIso(), ttl);
  const created = [];

  const doWork = () => {
    for (const t of targets) {
      const item = db.get('SELECT * FROM stock_items WHERE id = ?', [t.stockItemId]);
      if (!item) throw new StockError('Ligne de stock introuvable.', 'STOCK_ITEM_MISSING');
      if (!item.track_stock) {
        created.push({ id: null, stockItemId: item.id, qty: t.qty, untracked: true });
        continue;
      }
      const before = item.qty_on_hand - item.qty_reserved;
      const res = db.run(
        `UPDATE stock_items
            SET qty_reserved = qty_reserved + ?, updated_at = ?
          WHERE id = ? AND (qty_on_hand - qty_reserved) >= ?`,
        [t.qty, dates.nowIso(), item.id, t.qty]
      );
      if (Number(res.changes) !== 1) {
        const fresh = db.get('SELECT * FROM stock_items WHERE id = ?', [item.id]);
        const p = db.get('SELECT name, sku FROM products WHERE id = ?', [item.product_id]);
        throw new StockError(
          `Stock insuffisant pour « ${p?.name || 'cet article'} » : ${Math.max(0, fresh.qty_on_hand - fresh.qty_reserved)} unité(s) disponible(s).`,
          'STOCK_INSUFFICIENT',
          { productId: item.product_id, requested: t.qty, available: before }
        );
      }
      const id = db.insert('reservations', {
        stock_item_id: item.id,
        cart_id: cartId,
        order_id: orderId,
        qty: t.qty,
        status: 'active',
        expires_at: expiresAt,
      });
      recordMovement(item.id, 0, 'reservation', {
        note: note || `Réservation de ${t.qty} unité(s)`,
        userId,
        reference: orderId ? `CMD-${orderId}` : cartId ? `PANIER-${cartId}` : '',
      });
      created.push({ id, stockItemId: item.id, qty: t.qty, expiresAt });
    }
    return created;
  };

  return db.inTransaction() ? doWork() : db.transaction(doWork);
}

/** Libère des réservations (annulation, panier expiré, suppression d'une ligne). */
function releaseReservations({ cartId = null, orderId = null, reservationIds = null, reason = 'liberation', userId = null, note = '' } = {}) {
  const where = [];
  const params = [];
  if (cartId) { where.push('cart_id = ?'); params.push(cartId); }
  if (orderId) { where.push('order_id = ?'); params.push(orderId); }
  if (reservationIds && reservationIds.length) {
    where.push(`id IN (${reservationIds.map(() => '?').join(',')})`);
    params.push(...reservationIds.map(Number));
  }
  if (!where.length) return 0;
  // Le statut est un littéral SQL : aucun paramètre supplémentaire ne doit être
  // poussé, sinon le nombre de valeurs liées dépasse le nombre de `?`.
  where.push("status = 'active'");

  const rows = db.all(`SELECT * FROM reservations WHERE ${where.join(' AND ')}`, params);
  if (!rows.length) return 0;

  const work = () => {
    for (const r of rows) {
      db.run('UPDATE stock_items SET qty_reserved = MAX(0, qty_reserved - ?), updated_at = ? WHERE id = ?', [
        r.qty, dates.nowIso(), r.stock_item_id,
      ]);
      db.run("UPDATE reservations SET status = 'released', released_at = ? WHERE id = ?", [dates.nowIso(), r.id]);
      recordMovement(r.stock_item_id, 0, reason, {
        note: note || `Libération de ${r.qty} unité(s)`,
        userId,
        reference: r.order_id ? `CMD-${r.order_id}` : r.cart_id ? `PANIER-${r.cart_id}` : '',
      });
    }
    return rows.length;
  };
  return db.inTransaction() ? work() : db.transaction(work);
}

/**
 * Consomme les réservations d'une commande : le stock physique est décrémenté.
 * Appelée au moment où le paiement est confirmé (ou à la validation si le moyen
 * de paiement est « à la réception » et que l'exploitant le souhaite).
 */
function consumeOrderReservations(orderId, { userId = null, reference = '' } = {}) {
  const rows = db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [orderId]);
  const work = () => {
    for (const r of rows) {
      const item = db.get('SELECT * FROM stock_items WHERE id = ?', [r.stock_item_id]);
      if (!item) continue;
      if (item.track_stock) {
        const res = db.run(
          `UPDATE stock_items
              SET qty_on_hand = MAX(0, qty_on_hand - ?),
                  qty_reserved = MAX(0, qty_reserved - ?),
                  updated_at = ?
            WHERE id = ? AND qty_on_hand >= ?`,
          [r.qty, r.qty, dates.nowIso(), item.id, r.qty]
        );
        if (Number(res.changes) !== 1) {
          // Cas limite : stock déjà décrémenté manuellement. On libère la réserve.
          db.run('UPDATE stock_items SET qty_reserved = MAX(0, qty_reserved - ?), updated_at = ? WHERE id = ?', [
            r.qty, dates.nowIso(), item.id,
          ]);
        }
        syncProductQty(item.product_id);
        recordMovement(item.id, -r.qty, 'commande', {
          note: 'Sortie de stock sur commande',
          userId,
          reference: reference || `CMD-${orderId}`,
        });
      } else {
        db.run('UPDATE stock_items SET qty_reserved = MAX(0, qty_reserved - ?), updated_at = ? WHERE id = ?', [
          r.qty, dates.nowIso(), item.id,
        ]);
      }
      db.run("UPDATE reservations SET status = 'consumed', released_at = ? WHERE id = ?", [dates.nowIso(), r.id]);
    }
    return rows.length;
  };
  return db.inTransaction() ? work() : db.transaction(work);
}

/** Réintègre du stock après annulation, retour ou remboursement avec restitution. */
function restock(targets, { reason = 'retour', userId = null, reference = '', note = '' } = {}) {
  const work = () => {
    for (const t of targets) {
      const item = db.get('SELECT * FROM stock_items WHERE id = ?', [t.stockItemId]);
      if (!item || !item.track_stock) continue;
      db.run('UPDATE stock_items SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ?', [
        Math.max(1, Number(t.qty) || 1), dates.nowIso(), item.id,
      ]);
      syncProductQty(item.product_id);
      recordMovement(item.id, Number(t.qty), reason, { note: note || 'Retour en stock', userId, reference });
    }
    return targets.length;
  };
  return db.inTransaction() ? work() : db.transaction(work);
}

/** Sortie immédiate de stock (vente physique en boutique) sans réservation. */
function deductNow(targets, { reason = 'vente_boutique', userId = null, reference = '', note = '', allowOversell = false } = {}) {
  const work = () => {
    for (const t of targets) {
      const item = db.get('SELECT * FROM stock_items WHERE id = ?', [t.stockItemId]);
      if (!item) throw new StockError('Ligne de stock introuvable.', 'STOCK_ITEM_MISSING');
      if (!item.track_stock) continue;
      const sql = allowOversell
        ? 'UPDATE stock_items SET qty_on_hand = MAX(0, qty_on_hand - ?), updated_at = ? WHERE id = ?'
        : 'UPDATE stock_items SET qty_on_hand = qty_on_hand - ?, updated_at = ? WHERE id = ? AND (qty_on_hand - qty_reserved) >= ?';
      const params = allowOversell ? [t.qty, dates.nowIso(), item.id] : [t.qty, dates.nowIso(), item.id, t.qty];
      const res = db.run(sql, params);
      if (Number(res.changes) !== 1) {
        const p = db.get('SELECT name FROM products WHERE id = ?', [item.product_id]);
        throw new StockError(
          `Stock insuffisant pour « ${p?.name || 'cet article'} » : ${Math.max(0, item.qty_on_hand - item.qty_reserved)} unité(s) disponible(s).`,
          'STOCK_INSUFFICIENT'
        );
      }
      syncProductQty(item.product_id);
      recordMovement(item.id, -t.qty, reason, { note, userId, reference });
    }
    return targets.length;
  };
  return db.inTransaction() ? work() : db.transaction(work);
}

/** Reporte le stock agrégé sur la fiche produit (produits sans variante). */
function syncProductQty(productId) {
  db.run(
    `UPDATE products
        SET qty = (SELECT COALESCE(SUM(qty_on_hand),0) FROM stock_items WHERE product_id = ?),
            updated_at = ?
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM product_variants WHERE product_id = ?)`,
    [productId, dates.nowIso(), productId, productId]
  );
}

/** Balayage des réservations expirées (paniers abandonnés, paiements non finalisés). */
function releaseExpired({ userId = null } = {}) {
  const now = dates.nowIso();
  const rows = db.all("SELECT * FROM reservations WHERE status = 'active' AND expires_at < ?", [now]);
  if (!rows.length) return 0;
  const work = () => {
    for (const r of rows) {
      db.run('UPDATE stock_items SET qty_reserved = MAX(0, qty_reserved - ?), updated_at = ? WHERE id = ?', [
        r.qty, dates.nowIso(), r.stock_item_id,
      ]);
      db.run("UPDATE reservations SET status = 'expired', released_at = ? WHERE id = ?", [now, r.id]);
      recordMovement(r.stock_item_id, 0, 'liberation', {
        note: 'Réservation expirée',
        userId,
        reference: r.order_id ? `CMD-${r.order_id}` : r.cart_id ? `PANIER-${r.cart_id}` : '',
      });
      syncProductQty(db.get('SELECT product_id FROM stock_items WHERE id = ?', [r.stock_item_id])?.product_id);
    }
    // Une commande `pending` dont la réservation expire avant paiement est annulée :
    // le stock redevient vendable et le client peut recommander.
    // Une commande `quote_required` n'est PAS annulée : elle attend l'accord du client
    // sur le montant de la livraison (délai long, volontairement). Le stock est libéré,
    // et il sera réservé à nouveau au moment où le devis est accepté.
    const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
    for (const oid of orderIds) {
      const order = db.get('SELECT * FROM orders WHERE id = ?', [oid]);
      if (!order) continue;
      if (order.status === 'pending' && order.payment_status === 'unpaid') {
        db.run("UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, updated_at = ? WHERE id = ?", [
          'Réservation de stock expirée avant confirmation du paiement.',
          now, now, oid,
        ]);
        db.run(
          `INSERT INTO order_events (order_id, scope, from_value, to_value, message, public)
           VALUES (?, 'order', ?, 'cancelled', 'Réservation de stock expirée : commande annulée automatiquement.', 1)`,
          [oid, order.status]
        );
      } else if (order.status === 'quote_required' && order.payment_status === 'unpaid') {
        db.run('UPDATE orders SET updated_at = ? WHERE id = ?', [now, oid]);
        db.run(
          `INSERT INTO order_events (order_id, scope, from_value, to_value, message, public)
           VALUES (?, 'order', ?, ?, 'Réservation de stock arrivée à échéance : les articles restent soumis à disponibilité lors de l’acceptation du devis.', 1)`,
          [oid, order.status, order.status]
        );
      }
    }
    return rows.length;
  };
  return db.inTransaction() ? work() : db.transaction(work);
}

/** Réserve à nouveau du stock pour une commande existante (après devis accepté, par ex.). */
function reserveForOrder(orderId, minutes = config.commerce.orderReservationMinutes) {
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  const targets = [];
  for (const it of items) {
    targets.push(...resolveTargets(it.product_id, it.variant_id, it.qty));
  }
  if (!targets.length) return [];
  return reserve(targets, { orderId, minutes, note: 'Réservation commande' });
}

module.exports = {
  StockError,
  itemFor,
  itemsForProduct,
  available,
  availableForProduct,
  syncItems,
  setOnHand,
  adjust,
  recordMovement,
  movements,
  lowStockList,
  kitComponents,
  kitAvailable,
  saveKitComponents,
  resolveTargets,
  reserve,
  releaseReservations,
  consumeOrderReservations,
  restock,
  deductNow,
  syncProductQty,
  releaseExpired,
  reserveForOrder,
};
