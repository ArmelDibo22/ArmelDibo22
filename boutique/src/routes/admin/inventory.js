'use strict';

/** Stock (suivi, ajustements, historique) et ventes physiques en boutique. */

const express = require('express');
const db = require('../../db');
const stock = require('../../domain/stock');
const products = require('../../domain/products');
const pos = require('../../domain/pos');
const payments = require('../../domain/payments');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const { flash, notFound, queryString } = require('../../lib/http');
const { normalizeText } = require('../../lib/slug');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Stock                                                               */
/* ------------------------------------------------------------------ */
router.get('/stock', auth.requirePermission('stock.read'), (req, res) => {
  const view = String(req.query.vue || 'alertes');
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 50;

  const where = ['1 = 1'];
  const params = [];
  if (view === 'alertes') {
    where.push('si.track_stock = 1', '(si.qty_on_hand - si.qty_reserved) <= si.low_stock_threshold', "p.status != 'archived'");
  } else if (view === 'ruptures') {
    where.push('si.track_stock = 1', '(si.qty_on_hand - si.qty_reserved) <= 0');
  } else if (view === 'tous') {
    where.push('1 = 1');
  }
  if (req.query.q) {
    const like = `%${normalizeText(req.query.q)}%`;
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR si.sku LIKE ?)');
    params.push(like, like, like);
  }

  const total = db.get(`SELECT COUNT(*) AS n FROM stock_items si JOIN products p ON p.id = si.product_id WHERE ${where.join(' AND ')}`, params).n;
  const rows = db.all(
    `SELECT si.*, p.name AS product_name, p.sku AS product_sku, p.status AS product_status, p.track_stock AS product_track_stock,
            v.options AS variant_options, v.sku AS variant_sku,
            u.full_name AS last_actor
       FROM stock_items si
       JOIN products p ON p.id = si.product_id
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN users u ON u.id = (SELECT created_by FROM stock_movements WHERE stock_item_id = si.id ORDER BY id DESC LIMIT 1)
      WHERE ${where.join(' AND ')}
      ORDER BY (si.qty_on_hand - si.qty_reserved) ASC, p.name ASC
      LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage]
  );

  res.render('admin/stock', {
    title: 'Stock',
    activeNav: 'stock',
    view,
    items: rows.map((r) => ({
      ...r,
      options: r.variant_options ? JSON.parse(r.variant_options) : null,
      available: r.qty_on_hand - r.qty_reserved,
    })),
    pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)), hasNext: page * perPage < total, hasPrev: page > 1, from: total ? (page - 1) * perPage + 1 : 0, to: Math.min(page * perPage, total) },
    lowStockCount: stock.lowStockList(5000).length,
    qs: queryString,
  });
});

router.post('/stock/masse', auth.requirePermission('stock.write'), (req, res) => {
  const pairs = Array.isArray(req.body.lignes) ? req.body.lignes : String(req.body.lignes || '').split(',');
  let done = 0;
  let failed = 0;
  db.transaction(() => {
    for (const pair of pairs) {
      const [itemId, qty] = String(pair).split(':');
      const id = Number(itemId);
      if (!id) continue;
      try {
        stock.setOnHand(id, Math.max(0, Math.round(Number(qty) || 0)), {
          reason: 'inventaire',
          note: 'Inventaire groupé',
          userId: req.admin.user.id,
        });
        done += 1;
      } catch { failed += 1; }
    }
  });
  flash(req, failed ? 'warn' : 'success', `${done} ligne(s) mise(s) à jour${failed ? `, ${failed} refusée(s)` : ''}.`);
  return res.redirect('/admin/stock?vue=tous');
});

router.post('/stock/:itemId', auth.requirePermission('stock.write'), (req, res, next) => {
  const itemId = Number(req.params.itemId);
  const item = db.get('SELECT * FROM stock_items WHERE id = ?', [itemId]);
  if (!item) return next(notFound('Ligne de stock introuvable.'));
  const mode = String(req.body.mode || 'set');
  try {
    if (mode === 'set') {
      stock.setOnHand(itemId, Math.max(0, Math.round(Number(req.body.qty) || 0)), {
        reason: ['initial', 'inventaire', 'ajustement', 'achat_fournisseur', 'perte'].includes(req.body.reason) ? req.body.reason : 'ajustement',
        note: normalizeText(req.body.note || '').slice(0, 300) || 'Ajustement manuel',
        userId: req.admin.user.id,
        reference: req.body.reference || '',
      });
      flash(req, 'success', 'Stock mis à jour et mouvement enregistré.');
    } else {
      stock.adjust(itemId, Math.round(Number(req.body.delta) || 0), {
        reason: ['achat_fournisseur', 'perte', 'inventaire', 'ajustement', 'retour'].includes(req.body.reason) ? req.body.reason : 'ajustement',
        note: normalizeText(req.body.note || '').slice(0, 300) || 'Ajustement manuel',
        userId: req.admin.user.id,
        reference: req.body.reference || '',
      });
      flash(req, 'success', 'Mouvement de stock enregistré.');
    }
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(req.body.retour || `/admin/stock?vue=tous&q=${encodeURIComponent(item.sku || '')}`);
});

/** Ajustement groupé : utile pour un inventaire rapide. */

router.get('/stock/mouvements', auth.requirePermission('stock.read'), (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 100;
  const productId = req.query.produit ? Number(req.query.produit) : null;
  const reason = req.query.motif ? String(req.query.motif) : null;
  const rows = stock.movements({ productId, reason, limit: perPage, offset: (page - 1) * perPage });
  const total = db.get(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE (? IS NULL OR product_id = ?) AND (? IS NULL OR reason = ?)`,
    [productId, productId, reason, reason]
  ).n;
  res.render('admin/stock-movements', {
    title: 'Historique des mouvements',
    activeNav: 'stock',
    items: rows,
    pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)), hasNext: page * perPage < total, hasPrev: page > 1, from: total ? (page - 1) * perPage + 1 : 0, to: Math.min(page * perPage, total) },
    reasons: ['initial', 'ajustement', 'achat_fournisseur', 'vente', 'vente_boutique', 'commande', 'retour', 'annulation', 'import', 'reservation', 'liberation', 'kit', 'perte', 'inventaire'],
    qs: queryString,
    productId,
    reason,
  });
});

/* ------------------------------------------------------------------ */
/* Caisse : ventes physiques                                           */
/* ------------------------------------------------------------------ */
router.get('/caisse', auth.requirePermission('pos.read'), (req, res) => {
  const result = pos.listSales({ page: Number(req.query.page) || 1, perPage: 20, q: req.query.q, from: req.query.du, to: req.query.au });
  const sale = req.query.vente ? pos.getSale(Number(req.query.vente)) : null;
  res.render('admin/pos', {
    title: 'Vente en boutique',
    activeNav: 'pos',
    sales: result.items,
    pagination: result.pagination,
    methods: payments.listMethods({ enabledOnly: true }).filter((m) => m.isCash || m.isMobileMoney),
    totals: pos.totals({ from: req.query.du, to: req.query.au }),
    todayTotals: pos.totals({ from: `${dates.todayInTz()}T00:00:00.000Z` }),
    sale,
    qs: queryString,
    canCancel: require('../../domain/users').can(req.admin.user, 'pos.cancel'),
  });
});

/** Panier de caisse : calcul serveur à chaque frappe (rien n'est calculé côté navigateur). */
router.post('/caisse/calcul', auth.requirePermission('pos.write'), (req, res) => {
  try {
    const lines = parsePosLines(req.body);
    const result = pos.computeSale(lines, { discount: money.toCents(req.body.discount) || 0 });
    res.json({
      ok: true,
      subtotal: result.subtotal,
      discount: result.discount,
      total: result.total,
      subtotalLabel: money.format(result.subtotal),
      discountLabel: money.format(result.discount),
      totalLabel: money.format(result.total),
      problems: result.problems,
      items: result.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        sku: i.sku,
        name: i.name,
        optionsLabel: i.optionsLabel,
        qty: i.qty,
        unitPrice: i.unitPrice,
        catalogPrice: i.catalogPrice,
        lineTotal: i.lineTotal,
        unitPriceLabel: money.format(i.unitPrice),
        lineTotalLabel: money.format(i.lineTotal),
        adjusted: i.catalogPrice !== i.unitPrice,
      })),
    });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

router.post('/caisse', auth.requirePermission('pos.write'), (req, res, next) => {
  try {
    const lines = parsePosLines(req.body);
    if (!lines.length) {
      flash(req, 'error', 'Ajoutez au moins un article.');
      return res.redirect('/admin/caisse');
    }
    const sale = pos.recordSale({
      lines,
      discount: money.toCents(req.body.discount) || 0,
      methodCode: String(req.body.method_code || 'pay_at_pickup'),
      amountPaid: req.body.amount_paid === '' || req.body.amount_paid === undefined ? null : money.toCents(req.body.amount_paid),
      customerName: req.body.customer_name,
      customerPhone: req.body.customer_phone,
      note: req.body.note,
      user: req.admin.user,
      allowNegativeStock: req.body.forcer_stock === '1' && req.admin.user.role === 'admin',
    });
    flash(req, 'success', `Vente ${sale.reference} enregistrée — ${money.format(sale.total)}${sale.change_due > 0 ? ` (rendu ${money.format(sale.change_due)})` : ''}.`);
    return res.redirect(`/admin/caisse?vente=${sale.id}`);
  } catch (err) {
    if (err.status && err.status < 500) {
      flash(req, 'error', err.message);
      return res.redirect('/admin/caisse');
    }
    return next(err);
  }
});

router.get('/caisse/:id/impression', auth.requirePermission('pos.read'), (req, res, next) => {
  const sale = pos.getSale(Number(req.params.id));
  if (!sale) return next(notFound('Vente introuvable.'));
  res.render('admin/pos-print', { sale, title: `Vente ${sale.reference}`, bare: true, print: true, store: res.locals.store, money, dates });
});

router.post('/caisse/:id/annuler', auth.requirePermission('pos.cancel'), (req, res) => {
  try {
    pos.cancelSale(Number(req.params.id), {
      user: req.admin.user,
      reason: normalizeText(req.body.reason || ''),
      restock: req.body.restock !== '0',
    });
    flash(req, 'info', 'Vente annulée et stock restitué.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/caisse');
});

/**
 * Accepte deux formes d'entrée : un tableau `lines` (appel AJAX) ou des tableaux
 * parallèles issus d'un formulaire classique (JavaScript désactivé).
 */
function parsePosLines(body) {
  if (Array.isArray(body.lines)) {
    return body.lines
      .map((l) => ({
        productId: Number(l.productId || l.product_id || 0),
        variantId: l.variantId || l.variant_id ? Number(l.variantId || l.variant_id) : null,
        qty: Math.max(1, Number(l.qty) || 1),
        unitPrice: l.unitPrice === undefined || l.unitPrice === null || l.unitPrice === '' ? undefined : money.toCents(l.unitPrice),
      }))
      .filter((l) => l.productId);
  }
  const ids = Array.isArray(body.product_id) ? body.product_id : String(body.product_id || '').split(',').filter(Boolean);
  const qtys = Array.isArray(body.qty) ? body.qty : String(body.qty || '').split(',');
  const variants = Array.isArray(body.variant_id) ? body.variant_id : String(body.variant_id || '').split(',');
  const prices = Array.isArray(body.unit_price) ? body.unit_price : String(body.unit_price || '').split(',');
  return ids
    .map((id, index) => ({
      productId: Number(id),
      variantId: variants[index] ? Number(variants[index]) : null,
      qty: Math.max(1, Number(qtys[index]) || 1),
      unitPrice: prices[index] !== undefined && prices[index] !== '' ? money.toCents(prices[index]) : undefined,
    }))
    .filter((l) => l.productId);
}

module.exports = router;
