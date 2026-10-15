'use strict';

/**
 * Livraison et paiements : calcul des frais (jamais 0 FCFA inventé), devis,
 * cohérence moyen de paiement / mode / zone, puis le pipeline webhook complet
 * (succès, échec, signature invalide, doublon, montant erroné, commande inconnue).
 */

const test = require('node:test');
const assert = require('node:assert');
const { before } = test;

const { boot, makeProduct, makeOrder } = require('./helpers/boot');
const T = boot(__filename);

const { shipping, payments, orders, stock, db } = T;
const simulated = require('../src/domain/payments/providers/simulated');

const zoneOf = (code) => db.get('SELECT * FROM shipping_zones WHERE code = ?', [code]);
const adminRow = () => db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");

before(() => {
  const admin = adminRow();
  payments.saveMethod('wave', { enabled: true, simulated: true, modes: ['pickup', 'delivery'] }, admin.id);
  payments.saveMethod('pay_on_delivery', { enabled: true, modes: ['delivery'], zone_codes: ['daoukro', 'iffou', 'cote-divoire'] }, admin.id);
  for (const code of ['daoukro', 'iffou']) {
    shipping.saveZone(Object.assign({}, zoneOf(code), { cod_allowed: 1 }), admin.id);
  }
  shipping.saveRate({ zone_id: zoneOf('daoukro').id, label: 'Course Daoukro', price: 1000, per_extra_kg: 250 }, admin.id);
});

/* ------------------------------------------------------------------ */
/* Frais de livraison                                                  */
/* ------------------------------------------------------------------ */

test('retrait en boutique : seul cas de gratuité assumé', () => {
  const r = shipping.resolveShipping({ zoneId: zoneOf('retrait-boutique').id, subtotal: 5000, weightG: 800 });
  assert.strictEqual(r.status, 'free');
  assert.strictEqual(r.amount, 0);
  assert.strictEqual(r.reason, 'PICKUP');
});

test('zone chiffrée : tarif de base puis supplément au poids', () => {
  const zoneId = zoneOf('daoukro').id;
  const light = shipping.resolveShipping({ zoneId, subtotal: 5000, weightG: 0 });
  assert.strictEqual(light.status, 'priced');
  assert.strictEqual(light.amount, 1000);

  const heavy = shipping.resolveShipping({ zoneId, subtotal: 5000, weightG: 3000 });
  assert.strictEqual(heavy.amount, 1000 + Math.round(3 * 250), 'le supplément au kilo est appliqué');
  assert.ok(heavy.amount > light.amount);
});

test('zone sans tarif : « Livraison sur devis », jamais 0 FCFA', () => {
  for (const code of ['iffou', 'cote-divoire']) {
    const r = shipping.resolveShipping({ zoneId: zoneOf(code).id, subtotal: 25000, weightG: 1200 });
    assert.strictEqual(r.status, 'quote', `${code} doit rester sur devis`);
    assert.strictEqual(r.amount, null, `${code} : un frais inconnu n’est jamais présenté comme gratuit`);
    assert.notStrictEqual(r.amount, 0);
    assert.match(r.message, /devis/i);
  }
});

test('zone inconnue ou désactivée : devis, pas de montant inventé', () => {
  const unknown = shipping.resolveShipping({ zoneId: 999999, subtotal: 5000 });
  assert.strictEqual(unknown.status, 'quote');
  assert.strictEqual(unknown.amount, null);
  assert.strictEqual(unknown.reason, 'ZONE_INCONNUE');

  const disabled = Object.assign({}, zoneOf('iffou'), { enabled: 0 });
  shipping.saveZone(disabled, adminRow().id);
  const r = shipping.resolveShipping({ zoneId: disabled.id, subtotal: 5000 });
  assert.strictEqual(r.status, 'quote');
  shipping.saveZone(Object.assign({}, zoneOf('iffou'), { enabled: 1 }), adminRow().id);
});

test('franchise de livraison : appliquée seulement si elle est configurée', () => {
  const zone = zoneOf('daoukro');
  assert.strictEqual(zone.free_over, null, 'aucune franchise par défaut');
  shipping.saveZone(Object.assign({}, zone, { free_over: 100000 }), adminRow().id);

  const below = shipping.resolveShipping({ zoneId: zone.id, subtotal: 99000, weightG: 0 });
  assert.strictEqual(below.status, 'priced', 'en dessous du seuil, les frais restent dus');
  const above = shipping.resolveShipping({ zoneId: zone.id, subtotal: 100000, weightG: 0 });
  assert.strictEqual(above.status, 'free');
  assert.strictEqual(above.amount, 0);

  shipping.saveZone(Object.assign({}, zoneOf('daoukro'), { free_over: '' }), adminRow().id);
  assert.strictEqual(shipping.resolveShipping({ zoneId: zone.id, subtotal: 500000, weightG: 0 }).status, 'priced',
    'franchise retirée : plus de gratuité automatique');
});

test('cohérence moyen de paiement / mode / zone', () => {
  const daoukro = zoneOf('daoukro');
  const iffou = zoneOf('iffou');
  assert.strictEqual(shipping.methodAllowedFor(payments.getMethod('pay_at_pickup'), { mode: 'delivery', zone: daoukro }).ok, false,
    'le paiement au retrait n’est pas valable en livraison');
  assert.strictEqual(shipping.methodAllowedFor(payments.getMethod('pay_at_pickup'), { mode: 'pickup', zone: zoneOf('retrait-boutique') }).ok, true);

  // Zone sans paiement à la livraison autorisé.
  shipping.saveZone(Object.assign({}, iffou, { cod_allowed: 0 }), adminRow().id);
  assert.strictEqual(
    shipping.methodAllowedFor(payments.getMethod('pay_on_delivery'), { mode: 'delivery', zone: shipping.getZone(iffou.id) }).ok,
    false,
    'le paiement à la livraison est refusé si la zone ne l’autorise pas'
  );
  shipping.saveZone(Object.assign({}, shipping.getZone(iffou.id), { cod_allowed: 1 }), adminRow().id);
  assert.strictEqual(shipping.methodAllowedFor(payments.getMethod('pay_on_delivery'), { mode: 'delivery', zone: shipping.getZone(iffou.id) }).ok, true);

  // Moyen désactivé.
  assert.strictEqual(shipping.methodAllowedFor({ ...payments.getMethod('wave'), enabled: false }, { mode: 'pickup', zone: daoukro }).ok, false);
  // Mobile Money non configuré mais bac à sable actif hors production : utilisable pour tester.
  assert.strictEqual(shipping.methodAllowedFor(payments.getMethod('wave'), { mode: 'pickup', zone: daoukro }).ok, true);
  // Restriction de zones déclarée sur le moyen.
  const restricted = { ...payments.getMethod('wave'), zone_codes: ['iffou'] };
  assert.strictEqual(shipping.methodAllowedFor(restricted, { mode: 'pickup', zone: daoukro }).ok, false);
});

test('un Mobile Money sans identifiants marchands ne peut pas être activé hors bac à sable', () => {
  assert.throws(
    () => payments.saveMethod('mtn_momo', { enabled: true, simulated: false }, adminRow().id),
    (err) => err.code === 'NOT_CONFIGURED' && err.status === 409
  );
  assert.strictEqual(payments.getMethod('mtn_momo').enabled, false, 'le moyen reste désactivé');
});

/* ------------------------------------------------------------------ */
/* Notifications de paiement                                           */
/* ------------------------------------------------------------------ */

const notify = (payload, { signature = null, rawBody = null } = {}) => {
  const built = rawBody === null ? simulated.buildNotification(payload) : { body: rawBody, signature: simulated.buildNotification(payload).signature };
  const headers = signature === null ? { 'x-signature': built.signature } : (signature ? { 'x-signature': signature } : {});
  return T.webhook.handleNotification({ provider: 'sandbox', rawBody: built.body, headers, ip: '127.0.0.1' });
};

const waveOrder = (sku, qty = 1, price = 2500) => {
  const p = makeProduct(T, { sku, name: `Article ${sku}`, price, qty: 20 });
  return makeOrder(T, [{ productId: p.id, qty }], { paymentMethod: 'wave' });
};

test('notification signée et conforme : la commande passe à « payée » et le stock sort', () => {
  const order = waveOrder('PAY-OK', 2, 2500);
  assert.notStrictEqual(order.payment_status, 'paid');
  const before = stock.itemFor(order.items[0].product_id, null);

  const res = notify({ orderReference: order.reference, amount: order.total, currency: 'XOF', status: 'succeeded' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const after = orders.loadFull(order.id);
  assert.strictEqual(after.payment_status, 'paid');
  assert.strictEqual(after.status, 'confirmed', 'le paiement confirme la commande');
  assert.strictEqual(after.amount_paid, order.total);

  const item = stock.itemFor(order.items[0].product_id, null);
  assert.strictEqual(item.qty_on_hand, before.qty_on_hand - 2, 'la sortie de stock a lieu à l’encaissement');
  assert.strictEqual(item.qty_reserved, 0, 'les réservations sont consommées');

  const payment = db.get("SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded'", [order.id]);
  assert.ok(payment, 'une ligne de paiement réglée est enregistrée');
  assert.strictEqual(payment.provider, 'sandbox');
  const event = db.get('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 1');
  assert.strictEqual(event.signature_ok, 1);
});

test('signature invalide ou absente : refusée, aucun effet sur la commande', () => {
  const order = waveOrder('PAY-BADSIG');
  const bad = notify({ orderReference: order.reference, amount: order.total, status: 'succeeded' }, { signature: 'signature-forgée' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.body.ok, false);

  const missing = notify({ orderReference: order.reference, amount: order.total, status: 'succeeded' }, { signature: '' });
  assert.strictEqual(missing.status, 401, 'une notification non signée est refusée');

  assert.notStrictEqual(orders.getById(order.id).payment_status, 'paid',
    'ni capture d’écran, ni message client, ni notification non signée ne valident un paiement');
  const item = stock.itemFor(order.items[0].product_id, null);
  assert.strictEqual(item.qty_on_hand, 20, 'aucun stock n’est sorti');
});

test('notification répétée : dédupliquée, aucun double encaissement', () => {
  const order = waveOrder('PAY-DUP');
  const eventId = 'evt-duplique-0001';
  const payload = { orderReference: order.reference, amount: order.total, status: 'succeeded', eventId };

  const first = notify(payload);
  assert.strictEqual(first.status, 200);
  const second = notify(payload);
  assert.strictEqual(second.status, 200, 'le prestataire reçoit un accusé, pas une erreur');
  assert.strictEqual(second.body.duplicate, true);
  const third = notify(payload);
  assert.strictEqual(third.body.duplicate, true);

  assert.strictEqual(db.all('SELECT * FROM payments WHERE order_id = ? AND status = ?', [order.id, 'succeeded']).length, 1,
    'une seule ligne de paiement réglée');
  assert.strictEqual(db.all('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]).length, 1,
    'un seul événement journalisé');
  assert.strictEqual(orders.getById(order.id).amount_paid, order.total, 'le montant n’est pas cumulé');
});

test('deux événements différents pour une commande déjà réglée : le second est ignoré', () => {
  const order = waveOrder('PAY-TWICE');
  assert.strictEqual(notify({ orderReference: order.reference, amount: order.total, status: 'succeeded', eventId: 'evt-a' }).status, 200);
  const res = notify({ orderReference: order.reference, amount: order.total, status: 'succeeded', eventId: 'evt-b' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.result, 'already_paid');
  assert.strictEqual(orders.getById(order.id).amount_paid, order.total);
});

test('montant ou devise erroné : la notification est rejetée', () => {
  const order = waveOrder('PAY-AMOUNT', 1, 5000);
  const wrongAmount = notify({ orderReference: order.reference, amount: 4000, currency: 'XOF', status: 'succeeded' });
  assert.strictEqual(wrongAmount.status, 422);
  assert.strictEqual(orders.getById(order.id).payment_status !== 'paid', true, 'un paiement partiel ne solde pas la commande');

  const wrongCurrency = notify({ orderReference: order.reference, amount: order.total, currency: 'EUR', status: 'succeeded' });
  assert.strictEqual(wrongCurrency.status, 422);
  assert.notStrictEqual(orders.getById(order.id).payment_status, 'paid');

  const tooMuch = notify({ orderReference: order.reference, amount: order.total + 1000, currency: 'XOF', status: 'succeeded' });
  assert.strictEqual(tooMuch.status, 422, 'un montant supérieur n’est pas accepté silencieusement');
});

test('commande inconnue : 404 sans rien écrire', () => {
  const res = notify({ orderReference: 'PRV-1999-999999', amount: 1000, status: 'succeeded' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.ok, false);
});

test('paiement échoué ou annulé : la commande n’est pas réglée, l’échec est tracé', () => {
  const order = waveOrder('PAY-FAIL');
  const res = notify({ orderReference: order.reference, amount: order.total, status: 'failed', reason: 'Solde insuffisant' });
  assert.strictEqual(res.status, 200, 'l’accusé de réception est technique, pas métier');
  const full = orders.loadFull(order.id);
  assert.notStrictEqual(full.payment_status, 'paid');
  assert.strictEqual(full.status, 'pending', 'la commande reste à traiter');
  const failed = db.all("SELECT * FROM payments WHERE order_id = ? AND status = 'failed'", [order.id]);
  assert.strictEqual(failed.length, 1, 'l’échec est enregistré');
  assert.match(String(failed[0].failure_reason || ''), /Solde/);
  assert.strictEqual(stock.itemFor(order.items[0].product_id, null).qty_on_hand, 20, 'aucune sortie de stock');
});

test('passerelle inconnue, passerelle sans webhook, corps vide ou illisible', () => {
  const order = waveOrder('PAY-EDGE');
  const payload = { orderReference: order.reference, amount: order.total, status: 'succeeded' };
  const built = simulated.buildNotification(payload);

  const unknownProvider = T.webhook.handleNotification({ provider: 'inconnu', rawBody: built.body, headers: { 'x-signature': built.signature } });
  assert.strictEqual(unknownProvider.status, 404);

  // Adaptateur réel non branché : il ne reçoit pas de notification.
  const noWebhook = T.webhook.handleNotification({ provider: 'generic', rawBody: built.body, headers: { 'x-signature': built.signature } });
  assert.strictEqual(noWebhook.status, 405);
  const manual = T.webhook.handleNotification({ provider: 'manual', rawBody: built.body, headers: { 'x-signature': built.signature } });
  assert.strictEqual(manual.status, 404, 'l’encaissement manuel ne passe jamais par un webhook');

  const empty = T.webhook.handleNotification({ provider: 'sandbox', rawBody: '', headers: { 'x-signature': built.signature } });
  assert.strictEqual(empty.status, 400);

  const unreadable = T.webhook.handleNotification({ provider: 'sandbox', rawBody: '{pas-du-json', headers: { 'x-signature': built.signature } });
  assert.strictEqual(unreadable.status, 400);

  const huge = T.webhook.handleNotification({ provider: 'sandbox', rawBody: JSON.stringify({ order_reference: order.reference, pad: 'x'.repeat(70 * 1024) }), headers: { 'x-signature': built.signature } });
  assert.strictEqual(huge.status, 413, 'une notification surdimensionnée est refusée');
});

test('initier un paiement renvoie une redirection de bac à sable, jamais une validation', () => {
  const order = waveOrder('PAY-INIT');
  const intent = payments.initiateForOrder(order.id, { source: 'test' });
  assert.strictEqual(intent.ok, true);
  assert.strictEqual(intent.type, 'redirect');
  assert.match(intent.url, /^\/paiements\/simuler\//);
  assert.notStrictEqual(orders.getById(order.id).payment_status, 'paid', 'initier ne vaut pas encaisser');

  const again = payments.initiateForOrder(order.id, { source: 'test' });
  assert.strictEqual(again.ok, true, 'relancer un paiement non abouti est possible');
});

test('statuts séparés : commande, paiement et livraison évoluent indépendamment', () => {
  const order = waveOrder('PAY-STATUSES');
  notify({ orderReference: order.reference, amount: order.total, status: 'succeeded' });
  const paid = orders.getById(order.id);
  assert.strictEqual(paid.payment_status, 'paid');
  assert.strictEqual(paid.delivery_status, 'to_prepare', 'payée ne veut pas dire livrée : la préparation démarre');

  orders.setStatus(order.id, 'preparing', { userId: adminRow().id, note: 'Préparation' });
  const preparing = orders.getById(order.id);
  assert.strictEqual(preparing.status, 'preparing');
  assert.strictEqual(preparing.payment_status, 'paid', 'le statut de paiement ne suit pas le statut de commande');

  orders.setTracking(order.id, { trackingReference: 'LIV-2026-0001', userId: adminRow().id });
  orders.addDeliveryEvent(order.id, { label: 'Remis au livreur', detail: 'Départ Daoukro', userId: adminRow().id });
  orders.setDeliveryStatus(order.id, 'in_transit', { userId: adminRow().id, note: 'En route' });
  const shipped = orders.getById(order.id);
  assert.strictEqual(shipped.delivery_status, 'in_transit');
  assert.strictEqual(shipped.tracking_reference, 'LIV-2026-0001', 'la référence de suivi est enregistrée');
  assert.strictEqual(shipped.payment_status, 'paid');
  assert.ok(orders.deliveryEventsOf(order.id).length >= 1, 'les étapes de livraison sont historisées');
});

test('espèces : un client ne peut pas « payer » sa commande lui-même', () => {
  const p = makeProduct(T, { sku: 'CASH-SELF', name: 'Auto-paiement impossible', price: 2000, qty: 5 });
  const order = makeOrder(T, [{ productId: p.id, qty: 1 }]);
  assert.strictEqual(order.payment_status, 'awaiting_confirmation');
  assert.throws(
    () => payments.confirmCashCollection(order.id, {}),
    (err) => err.code === 'UNAUTHENTICATED' && err.status === 401
  );
  assert.throws(
    () => payments.confirmCashCollection(order.id, { user: { id: 999, role: 'vendor', canConfirmCash: false } }),
    (err) => err.code === 'NOT_AUTHORIZED'
  );
  assert.notStrictEqual(orders.getById(order.id).payment_status, 'paid');
});
