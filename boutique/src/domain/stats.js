'use strict';

/**
 * Statistiques de l'administration.
 * Distinction stricte entre : commandes reçues, ventes réellement encaissées,
 * ventes physiques au comptoir et remboursements. Aucun chiffre n'est extrapolé.
 */

const db = require('../db');
const dates = require('../lib/dates');
const money = require('../lib/money');

function dayBounds(daysAgo = 0) {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  const start = `${dates.todayInTz(day)}T00:00:00.000Z`;
  const end = `${dates.todayInTz(day)}T23:59:59.999Z`;
  return { start, end };
}

function rangeBounds(fromIso, toIso) {
  return { start: fromIso || dayBounds(29).start, end: toIso || dates.nowIso() };
}

/** Indicateurs de tête pour le tableau de bord. */
function dashboard() {
  const today = dayBounds(0);
  const yesterday = dayBounds(1);
  const week = dayBounds(6);

  const orders = (start, end) =>
    db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders WHERE placed_at >= ? AND placed_at <= ? AND status != 'cancelled'",
      [start, end]
    );
  const paid = (start, end) =>
    db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid),0) AS amount FROM orders WHERE paid_at >= ? AND paid_at <= ? AND amount_paid > 0",
      [start, end]
    );
  const pos = (start, end) =>
    db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM pos_sales WHERE created_at >= ? AND created_at <= ? AND status != 'cancelled'",
      [start, end]
    );
  const refunded = (start, end) =>
    db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM refunds WHERE created_at >= ? AND created_at <= ?', [start, end]);

  const now = dates.nowIso();
  const openOrders = db.get(
    "SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('cancelled','refunded','delivered')"
  ).n;
  const awaitingCash = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders WHERE payment_status = 'awaiting_confirmation' AND status != 'cancelled'"
  );
  const quotes = db.get(
    "SELECT COUNT(*) AS n FROM orders WHERE quote_required = 1 AND quote_status IN ('requested','sent')"
  ).n;
  const lowStock = db.get(
    `SELECT COUNT(*) AS n FROM products p
      WHERE p.status = 'published' AND p.track_stock = 1 AND p.low_stock_threshold > 0
        AND COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si WHERE si.product_id = p.id),0) <= p.low_stock_threshold`
  ).n;
  const outOfStock = db.get(
    `SELECT COUNT(*) AS n FROM products p
      WHERE p.status = 'published' AND p.track_stock = 1
        AND COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si WHERE si.product_id = p.id),0) <= 0`
  ).n;
  const drafts = db.get("SELECT COUNT(*) AS n FROM products WHERE status = 'draft'").n;
  const unconfirmed = db.get('SELECT COUNT(*) AS n FROM products WHERE data_confirmed = 0').n;

  return {
    today: {
      orders: orders(today.start, today.end),
      paid: paid(today.start, today.end),
      pos: pos(today.start, today.end),
      refunds: refunded(today.start, today.end),
    },
    yesterday: {
      orders: orders(yesterday.start, yesterday.end),
      paid: paid(yesterday.start, yesterday.end),
      pos: pos(yesterday.start, yesterday.end),
    },
    week: {
      orders: orders(week.start, now),
      paid: paid(week.start, now),
      pos: pos(week.start, now),
      refunds: refunded(week.start, now),
    },
    pending: {
      openOrders,
      awaitingCash: { count: awaitingCash.n, amount: Number(awaitingCash.amount) },
      quotes,
      lowStock,
      outOfStock,
      drafts,
      unconfirmed,
    },
  };
}

/** Séries journalières pour les graphiques (30 jours glissants par défaut). */
function dailySeries({ days = 30, from = null, to = null } = {}) {
  const { start, end } = from && to ? rangeBounds(from, to) : { start: dayBounds(days - 1).start, end: dates.nowIso() };
  const ordersRows = db.all(
    "SELECT substr(placed_at,1,10) AS d, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders WHERE placed_at >= ? AND placed_at <= ? AND status != 'cancelled' GROUP BY d",
    [start, end]
  );
  const paidRows = db.all(
    'SELECT substr(paid_at,1,10) AS d, COUNT(*) AS n, COALESCE(SUM(amount_paid),0) AS amount FROM orders WHERE paid_at >= ? AND paid_at <= ? AND amount_paid > 0 GROUP BY d',
    [start, end]
  );
  const posRows = db.all(
    "SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM pos_sales WHERE created_at >= ? AND created_at <= ? AND status != 'cancelled' GROUP BY d",
    [start, end]
  );
  const refundRows = db.all(
    'SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM refunds WHERE created_at >= ? AND created_at <= ? GROUP BY d',
    [start, end]
  );

  const byDay = new Map();
  const ensure = (d) => {
    if (!byDay.has(d)) byDay.set(d, { date: d, orders: 0, ordersAmount: 0, paid: 0, paidAmount: 0, pos: 0, posAmount: 0, refunds: 0, refundsAmount: 0 });
    return byDay.get(d);
  };
  for (const r of ordersRows) { const x = ensure(r.d); x.orders = r.n; x.ordersAmount = Number(r.amount); }
  for (const r of paidRows) { const x = ensure(r.d); x.paid = r.n; x.paidAmount = Number(r.amount); }
  for (const r of posRows) { const x = ensure(r.d); x.pos = r.n; x.posAmount = Number(r.amount); }
  for (const r of refundRows) { const x = ensure(r.d); x.refunds = r.n; x.refundsAmount = Number(r.amount); }

  // Complète les jours sans activité pour un graphique lisible.
  const out = [];
  const cursor = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const last = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) || { date: key, orders: 0, ordersAmount: 0, paid: 0, paidAmount: 0, pos: 0, posAmount: 0, refunds: 0, refundsAmount: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function topProducts({ limit = 10, from = null, to = null } = {}) {
  const { start, end } = from && to ? rangeBounds(from, to) : { start: dayBounds(29).start, end: dates.nowIso() };
  return db.all(
    `SELECT oi.name, oi.sku, SUM(oi.qty) AS qty, SUM(oi.line_total) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.placed_at >= ? AND o.placed_at <= ? AND o.status != 'cancelled'
      GROUP BY oi.product_id, oi.variant_id
      ORDER BY qty DESC LIMIT ?`,
    [start, end, Number(limit)]
  );
}

function salesByZone({ from = null, to = null } = {}) {
  const { start, end } = from && to ? rangeBounds(from, to) : { start: dayBounds(29).start, end: dates.nowIso() };
  return db.all(
    `SELECT COALESCE(z.name,'Non précisé') AS zone, o.fulfillment_mode, COUNT(*) AS n, COALESCE(SUM(o.total),0) AS amount
       FROM orders o LEFT JOIN shipping_zones z ON z.id = o.zone_id
      WHERE o.placed_at >= ? AND o.placed_at <= ? AND o.status != 'cancelled'
      GROUP BY z.name, o.fulfillment_mode ORDER BY n DESC`,
    [start, end]
  );
}

function salesByPayment({ from = null, to = null } = {}) {
  const { start, end } = from && to ? rangeBounds(from, to) : { start: dayBounds(29).start, end: dates.nowIso() };
  return db.all(
    `SELECT o.payment_method_code AS code, COALESCE(pm.name, o.payment_method_code) AS name,
            COUNT(*) AS n, COALESCE(SUM(o.amount_paid),0) AS amount
       FROM orders o LEFT JOIN payment_methods pm ON pm.code = o.payment_method_code
      WHERE o.placed_at >= ? AND o.placed_at <= ? AND o.amount_paid > 0
      GROUP BY o.payment_method_code ORDER BY amount DESC`,
    [start, end]
  );
}

/** Totaux consolidés, prêts pour l'export comptable. */
function totals({ from = null, to = null } = {}) {
  const { start, end } = rangeBounds(from, to);
  const online = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS gross, COALESCE(SUM(amount_paid),0) AS collected, COALESCE(SUM(amount_refunded),0) AS refunded FROM orders WHERE placed_at >= ? AND placed_at <= ? AND status != 'cancelled'",
    [start, end]
  );
  const counter = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS gross FROM pos_sales WHERE created_at >= ? AND created_at <= ? AND status != 'cancelled'",
    [start, end]
  );
  const cashAwaiting = db.get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS gross FROM orders WHERE placed_at >= ? AND placed_at <= ? AND payment_status = 'awaiting_confirmation' AND status != 'cancelled'",
    [start, end]
  );
  return {
    range: { start, end },
    online: {
      count: online.n,
      gross: Number(online.gross),
      collected: Number(online.collected),
      refunded: Number(online.refunded),
      net: Number(online.collected) - Number(online.refunded),
    },
    counter: { count: counter.n, gross: Number(counter.gross) },
    cashAwaiting: { count: cashAwaiting.n, gross: Number(cashAwaiting.gross) },
    combined: {
      collected: Number(online.collected) + Number(counter.gross),
      refunded: Number(online.refunded),
    },
  };
}

module.exports = { dashboard, dailySeries, topProducts, salesByZone, salesByPayment, totals, dayBounds, rangeBounds, money };
