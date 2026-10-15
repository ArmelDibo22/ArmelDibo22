'use strict';

/**
 * Ventes physiques en boutique (caisse).
 * Une vente au comptoir sort du stock, crée un mouvement d'historique et alimente
 * les statistiques « ventes encaissées » distinctement des commandes en ligne.
 */

const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');
const stock = require('./stock');
const products = require('./products');
const orders = require('./orders');
const payments = require('./payments');
const { normalizeText } = require('../lib/slug');
const { normalizePhone } = require('../lib/validate');

class PosError extends Error {
  constructor(message, code = 'POS_ERROR', status = 400) {
    super(message);
    this.name = 'PosError';
    this.code = code;
    this.status = status;
  }
}

/** Calcule une vente à partir de lignes {productId, variantId, qty, unitPrice?}. */
function computeSale(lines, { discount = 0 } = {}) {
  const items = [];
  let subtotal = 0;
  const problems = [];
  for (const line of lines || []) {
    const product = products.rawProduct(line.productId);
    if (!product) { problems.push('Article introuvable.'); continue; }
    const variant = line.variantId ? products.getVariant(line.variantId) : null;
    const price = products.priceOf(product, variant);
    // Le vendeur peut corriger un prix (geste commercial) : la correction est tracée.
    const manual = line.unitPrice !== undefined && line.unitPrice !== null && line.unitPrice !== '';
    const unitPrice = manual ? Math.max(0, Math.round(Number(line.unitPrice))) : price.sale;
    if (manual && unitPrice !== price.sale) {
      if (unitPrice < 0) { problems.push(`Prix négatif pour « ${product.name} ».`); continue; }
    }
    const qty = Math.max(1, Math.round(Number(line.qty) || 1));
    const item = products.getById(product.id);
    const availability = products.availabilityOf(product, variant);
    if (availability.status !== 'untracked' && qty > availability.available) {
      problems.push(`« ${product.name} » : ${availability.available} unité(s) disponible(s) pour ${qty} demandée(s).`);
      continue;
    }
    subtotal += unitPrice * qty;
    items.push({
      productId: product.id,
      variantId: variant ? variant.id : null,
      stockItemId: stock.itemFor(product.id, variant ? variant.id : null)?.id || null,
      sku: (variant && variant.sku) || product.sku || '',
      name: product.name,
      optionsLabel: variant ? Object.values(variant.options).filter(Boolean).join(' · ') : '',
      unitPrice,
      catalogPrice: price.sale,
      qty,
      lineTotal: unitPrice * qty,
      image: item?.image || null,
    });
  }
  const safeDiscount = Math.max(0, Math.min(Math.round(Number(discount) || 0), subtotal));
  return { items, problems, subtotal, discount: safeDiscount, total: Math.max(0, subtotal - safeDiscount), ok: !problems.length && items.length > 0 };
}

/** Enregistre une vente au comptoir et décrémente le stock immédiatement. */
function recordSale({ lines, discount = 0, methodCode = 'pay_at_pickup', amountPaid = null, customerName = '', customerPhone = '', note = '', user, allowNegativeStock = false }) {
  if (!user) throw new PosError('Authentification requise.', 'UNAUTHENTICATED', 401);
  const sale = computeSale(lines, { discount });
  if (!sale.ok) throw new PosError(sale.problems[0] || 'Vente invalide.', 'SALE_INVALID', 409);

  const method = payments.getMethod(methodCode) || payments.getMethod('pay_at_pickup');
  const paid = amountPaid === null || amountPaid === '' ? sale.total : Math.max(0, Math.round(Number(amountPaid)));
  if (paid < sale.total && !method?.isCash) {
    throw new PosError('Montant reçu inférieur au total.', 'AMOUNT_SHORT', 400);
  }

  const reference = orders.nextPosReference();
  let customerId = null;
  const phone = normalizePhone(customerPhone);
  const name = normalizeText(customerName);

  const saleId = db.transaction(() => {
    if (phone || name) {
      let customer = phone ? db.get('SELECT * FROM customers WHERE phone = ?', [phone]) : null;
      if (!customer && name) customer = db.get('SELECT * FROM customers WHERE LOWER(full_name) = LOWER(?)', [name]);
      if (!customer) {
        customerId = db.insert('customers', { phone, full_name: name });
      } else {
        customerId = customer.id;
      }
    }

    const id = db.insert('pos_sales', {
      reference,
      user_id: user.id,
      customer_id: customerId,
      customer_name: name,
      customer_phone: phone,
      subtotal: sale.subtotal,
      discount: sale.discount,
      total: sale.total,
      amount_paid: paid,
      change_due: Math.max(0, paid - sale.total),
      method_code: method ? method.code : 'pay_at_pickup',
      status: 'done',
      note: normalizeText(note).slice(0, 500),
    });

    const targets = [];
    sale.items.forEach((item, index) => {
      db.insert('pos_sale_items', {
        sale_id: id,
        product_id: item.productId,
        variant_id: item.variantId,
        stock_item_id: item.stockItemId,
        name: item.name,
        sku: item.sku,
        options_label: item.optionsLabel,
        unit_price: item.unitPrice,
        qty: item.qty,
        line_total: item.lineTotal,
      });
      if (item.stockItemId) {
        targets.push({ stockItemId: item.stockItemId, qty: item.qty });
      }
    });
    if (targets.length) {
      stock.deductNow(targets, {
        reason: 'vente_boutique',
        userId: user.id,
        reference,
        note: 'Vente au comptoir',
        allowOversell: Boolean(allowNegativeStock),
      });
    }

    // Toute correction manuelle de prix est tracée.
    const adjusted = sale.items.filter((i) => i.unitPrice !== i.catalogPrice);
    if (adjusted.length) {
      db.insert('audit_log', {
        user_id: user.id,
        actor: 'admin',
        action: 'pos.price_adjusted',
        entity_type: 'pos_sale',
        entity_id: reference,
        detail: JSON.stringify(adjusted.map((i) => ({ sku: i.sku, catalog: i.catalogPrice, applied: i.unitPrice }))),
      });
    }
    return id;
  });

  return getSale(saleId);
}

function getSale(id) {
  const sale = db.get('SELECT * FROM pos_sales WHERE id = ?', [Number(id)]);
  if (!sale) return null;
  return {
    ...sale,
    items: db.all('SELECT * FROM pos_sale_items WHERE sale_id = ? ORDER BY id ASC', [sale.id]),
    user: sale.user_id ? db.get('SELECT id, full_name, email FROM users WHERE id = ?', [sale.user_id]) : null,
    method: db.get('SELECT * FROM payment_methods WHERE code = ?', [sale.method_code]),
  };
}

function getSaleByReference(reference) {
  const sale = db.get('SELECT * FROM pos_sales WHERE reference = ?', [String(reference).trim().toUpperCase()]);
  return sale ? getSale(sale.id) : null;
}

function listSales({ page = 1, perPage = 25, from = null, to = null, userId = null, q = null } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('s.created_at >= ?'); params.push(dates.fromInput(from) || from); }
  if (to) { where.push('s.created_at <= ?'); params.push(dates.fromInput(to, { endOfDay: true }) || to); }
  if (userId) { where.push('s.user_id = ?'); params.push(Number(userId)); }
  if (q) {
    const like = `%${normalizeText(q)}%`;
    where.push('(s.reference LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(200, Number(perPage) || 25));
  const total = db.get(`SELECT COUNT(*) AS n FROM pos_sales s ${clause}`, params)?.n || 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db.all(
    `SELECT s.*, u.full_name AS user_name FROM pos_sales s LEFT JOIN users u ON u.id = s.user_id
      ${clause} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (current - 1) * size]
  );
  return {
    items: rows,
    pagination: { page: current, perPage: size, total, pages, offset: (current - 1) * size, hasNext: current < pages, hasPrev: current > 1, from: total ? (current - 1) * size + 1 : 0, to: Math.min(current * size, total) },
  };
}

function cancelSale(saleId, { user, reason = '', restock = true } = {}) {
  const sale = db.get('SELECT * FROM pos_sales WHERE id = ?', [Number(saleId)]);
  if (!sale) throw new PosError('Vente introuvable.', 'NOT_FOUND', 404);
  if (sale.status === 'cancelled') return getSale(saleId);
  if (user.role !== 'admin') throw new PosError('Seul un administrateur peut annuler une vente.', 'NOT_AUTHORIZED', 403);

  db.transaction(() => {
    db.update('pos_sales', saleId, { status: 'cancelled', note: `${sale.note || ''} [Annulée : ${normalizeText(reason)}]`.trim().slice(0, 500) });
    if (restock) {
      const items = db.all('SELECT * FROM pos_sale_items WHERE sale_id = ?', [saleId]);
      const targets = items.filter((i) => i.stock_item_id).map((i) => ({ stockItemId: i.stock_item_id, qty: i.qty }));
      if (targets.length) stock.restock(targets, { reason: 'annulation', userId: user.id, reference: sale.reference, note: 'Annulation de vente' });
    }
    db.insert('audit_log', {
      user_id: user.id,
      actor: 'admin',
      action: 'pos.cancel',
      entity_type: 'pos_sale',
      entity_id: sale.reference,
      detail: JSON.stringify({ reason, restock }),
    });
  });
  return getSale(saleId);
}

function totals({ from = null, to = null } = {}) {
  const where = ["status != 'cancelled'"];
  const params = [];
  if (from) { where.push('created_at >= ?'); params.push(dates.fromInput(from) || from); }
  if (to) { where.push('created_at <= ?'); params.push(dates.fromInput(to, { endOfDay: true }) || to); }
  const row = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount),0) AS discount FROM pos_sales WHERE ${where.join(' AND ')}`,
    params
  );
  return { count: row?.n || 0, total: Number(row?.total || 0), discount: Number(row?.discount || 0), money: money.format(row?.total || 0) };
}

module.exports = { PosError, computeSale, recordSale, getSale, getSaleByReference, listSales, cancelSale, totals };
