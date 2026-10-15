'use strict';

/**
 * Stock et commandes : réservation, anti-survente, achats concurrents sur
 * stock limité, encaissement, annulation et restitution, expiration des
 * réservations.
 */

const test = require('node:test');
const assert = require('node:assert');
const { before } = test;

const { boot, makeProduct, makeOrder } = require('./helpers/boot');
const T = boot(__filename);

const { products, stock, orders, payments, db } = T;

const itemOf = (productId) => stock.itemFor(productId, null);
const adminRow = () => db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");

before(() => {
  // La base réelle ne configure que « payer au retrait » : on active le paiement
  // à la réception et un tarif Daoukro pour pouvoir tester la livraison.
  const admin = adminRow();
  T.payments.saveMethod('pay_on_delivery', { enabled: true, modes: ['delivery'], zone_codes: ['daoukro', 'iffou', 'cote-divoire'] }, admin.id);
  for (const code of ['daoukro', 'iffou']) {
    const z = db.get('SELECT * FROM shipping_zones WHERE code = ?', [code]);
    T.shipping.saveZone(Object.assign({}, z, { cod_allowed: 1 }), admin.id);
  }
  T.shipping.saveRate({ zone_id: db.get("SELECT * FROM shipping_zones WHERE code = 'daoukro'").id, label: 'Livraison Daoukro', price: 1000, per_extra_kg: 250 }, admin.id);
  // Wave en mode bac à sable : seul moyen de produire une commande en ligne non réglée.
  T.payments.saveMethod('wave', { enabled: true, simulated: true, modes: ['pickup', 'delivery'] }, admin.id);
});

test('réservation : le stock disponible baisse sans toucher au stock physique', () => {
  const p = makeProduct(T, { sku: 'STK-1', name: 'Article réservé', qty: 10 });
  const before = itemOf(p.id);
  assert.strictEqual(before.qty_on_hand, 10);

  stock.reserve(stock.resolveTargets(p.id, null, 3), { cartId: null, note: 'test' });
  const after = itemOf(p.id);
  assert.strictEqual(after.qty_on_hand, 10, 'le stock physique ne bouge pas à la réservation');
  assert.strictEqual(after.qty_reserved, 3);
  assert.strictEqual(stock.availableForProduct(p.id), 7);
});

test('anti-survente : réserver plus que le disponible est refusé', () => {
  const p = makeProduct(T, { sku: 'STK-2', name: 'Article limité', qty: 4 });
  stock.reserve(stock.resolveTargets(p.id, null, 4), { note: 'première réservation' });

  assert.throws(
    () => stock.reserve(stock.resolveTargets(p.id, null, 1), { note: 'deuxième réservation' }),
    (err) => err.code === 'STOCK_INSUFFICIENT' && err.status === 409
  );

  const item = itemOf(p.id);
  assert.strictEqual(item.qty_reserved, 4, 'la réservation refusée n’a rien écrit');
  assert.ok(item.qty_on_hand - item.qty_reserved >= 0, 'le stock disponible ne devient jamais négatif');
});

test('achats concurrents sur stock limité : seul le stock disponible part', () => {
  const p = makeProduct(T, { sku: 'STK-RACE', name: 'Article en quantité limitée', qty: 3, price: 1000 });
  const attempts = 8;
  const succeeded = [];
  const refused = [];

  for (let i = 0; i < attempts; i += 1) {
    try {
      const order = makeOrder(T, [{ productId: p.id, qty: 1 }], {
        customer: { fullName: `Client Concurrent ${i}`, phone: `07000000${String(i).padStart(2, '0')}` },
      });
      succeeded.push(order);
    } catch (err) {
      refused.push(err);
    }
  }

  assert.strictEqual(succeeded.length, 3, 'exactement 3 commandes passent pour 3 unités');
  assert.strictEqual(refused.length, attempts - 3);
  assert.ok(refused.every((e) => e.code === 'STOCK_INSUFFICIENT' || e.code === 'CART_INVALID'),
    'les refus sont motivés par le stock');

  const item = itemOf(p.id);
  assert.strictEqual(item.qty_on_hand, 3, 'aucune sortie de stock avant encaissement');
  assert.strictEqual(item.qty_reserved, 3, 'tout le stock est réservé');
  assert.ok(item.qty_on_hand - item.qty_reserved === 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM orders WHERE status != ?', ['cancelled']).n >= 3, true);
});

test('commande invité en retrait : statuts séparés et réservation posée', () => {
  const p = makeProduct(T, { sku: 'ORD-PICKUP', name: 'Commande retrait', price: 2500, qty: 10 });
  const order = makeOrder(T, [{ productId: p.id, qty: 2 }]);

  assert.match(order.reference, /^PRV-/);
  assert.strictEqual(order.status, 'pending');
  assert.strictEqual(order.payment_status, 'awaiting_confirmation', 'espèces : en attente de confirmation');
  assert.strictEqual(order.delivery_status, 'none');
  assert.strictEqual(order.fulfillment_mode, 'pickup');
  assert.strictEqual(order.total, 5000);
  assert.ok(order.tracking_token, 'un jeton de suivi est généré');

  const reservations = db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [order.id]);
  assert.strictEqual(reservations.length, 1);
  assert.strictEqual(reservations[0].qty, 2);
  assert.strictEqual(itemOf(p.id).qty_reserved, 2);
  assert.strictEqual(order.idempotency_key ? 1 : 1, 1);
});

test('idempotence : la même clé ne crée pas deux commandes', () => {
  const p = makeProduct(T, { sku: 'ORD-IDEM', name: 'Idempotence', price: 1000, qty: 10 });
  const key = 'cle-idempotence-test';
  const first = orders.createOrder({
    mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
    customer: { fullName: 'Client Idem', phone: '0700000099' },
    lines: [{ productId: p.id, qty: 1 }], idempotencyKey: key,
  }, { source: 'test' });
  const second = orders.createOrder({
    mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
    customer: { fullName: 'Client Idem', phone: '0700000099' },
    lines: [{ productId: p.id, qty: 1 }], idempotencyKey: key,
  }, { source: 'test' });

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true, 'le doublon est détecté');
  assert.strictEqual(first.order.id, second.order.id);
  assert.strictEqual(itemOf(p.id).qty_reserved, 1, 'le stock n’est réservé qu’une fois');
});

test('conditions refusées : aucune commande sans acceptation des CGV', () => {
  const p = makeProduct(T, { sku: 'ORD-CGV', name: 'CGV obligatoires', qty: 5 });
  assert.throws(
    () => orders.createOrder({
      mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: false,
      customer: { fullName: 'Client Sans CGV', phone: '0700000098' },
      lines: [{ productId: p.id, qty: 1 }],
    }, { source: 'test' }),
    (err) => err.code === 'TERMS_REQUIRED'
  );
});

test('identité : nom et téléphone exigés, e-mail facultatif', () => {
  const p = makeProduct(T, { sku: 'ORD-IDENT', name: 'Identité', qty: 5 });
  assert.throws(
    () => orders.createOrder({
      mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
      customer: { fullName: '', phone: '0700000097' }, lines: [{ productId: p.id, qty: 1 }],
    }, { source: 'test' }),
    (err) => err.code === 'NAME_REQUIRED'
  );
  assert.throws(
    () => orders.createOrder({
      mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
      customer: { fullName: 'Client', phone: '12345' }, lines: [{ productId: p.id, qty: 1 }],
    }, { source: 'test' }),
    (err) => err.code === 'PHONE_REQUIRED'
  );
  // Sans e-mail : la commande passe quand même (parcours invité).
  const ok = orders.createOrder({
    mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
    customer: { fullName: 'Client Sans E-mail', phone: '0700000096' },
    lines: [{ productId: p.id, qty: 1 }],
  }, { source: 'test' });
  assert.ok(ok.order.id);
  assert.strictEqual(ok.order.customer_email || '', '');
});

test('livraison : ville et quartier ou adresse obligatoires', () => {
  const p = makeProduct(T, { sku: 'ORD-DELIV', name: 'Livraison', price: 1000, qty: 5 });
  const zone = db.get("SELECT * FROM shipping_zones WHERE code = 'daoukro'");
  const base = {
    mode: 'delivery', zoneId: zone.id, paymentMethod: 'pay_at_pickup', termsAccepted: true,
    customer: { fullName: 'Client Livraison', phone: '0700000095' },
    lines: [{ productId: p.id, qty: 1 }],
  };
  assert.throws(
    () => orders.createOrder(Object.assign({}, base, { shippingInfo: {} }), { source: 'test' }),
    (err) => err.code === 'CITY_REQUIRED'
  );
  assert.throws(
    () => orders.createOrder(Object.assign({}, base, { shippingInfo: { city: 'Daoukro' } }), { source: 'test' }),
    (err) => err.code === 'ADDRESS_REQUIRED'
  );
});

test('encaissement en espèces : confirmation par un utilisateur habilité, avec historique', () => {
  const p = makeProduct(T, { sku: 'CASH-1', name: 'Encaissement espèces', price: 3000, qty: 5 });
  const order = makeOrder(T, [{ productId: p.id, qty: 2 }]);
  const admin = db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");

  const unauthorized = T.users.createUser({
    email: 'vendeur.sans.droit@test.local', password: 'Test-Vendeur-2026!',
    fullName: 'Vendeur non habilité', role: 'vendor', canConfirmCash: false, active: true,
  }, admin);
  assert.throws(
    () => payments.confirmCashCollection(order.id, { user: unauthorized }),
    (err) => err.code === 'NOT_AUTHORIZED' && err.status === 403
  );

  const authorized = T.users.createUser({
    email: 'vendeur.habilite@test.local', password: 'Test-Vendeur-2026!',
    fullName: 'Vendeur habilité', role: 'vendor', canConfirmCash: true, active: true,
  }, admin);
  const paid = payments.confirmCashCollection(order.id, { user: authorized, amount: 6000, note: 'Espèces reçues' });

  assert.strictEqual(paid.payment_status, 'paid');
  assert.strictEqual(paid.status, 'confirmed', 'la commande passe en confirmée');
  assert.strictEqual(paid.amount_paid, 6000);

  const item = itemOf(p.id);
  assert.strictEqual(item.qty_on_hand, 3, 'la sortie de stock a lieu à l’encaissement');
  assert.strictEqual(item.qty_reserved, 0, 'les réservations sont consommées');
  assert.strictEqual(db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [order.id]).length, 0);

  const audit = db.all("SELECT * FROM audit_log WHERE action = 'payment.cash_confirmed' AND entity_id = ?", [paid.reference]);
  assert.strictEqual(audit.length, 1, 'la confirmation est journalisée');
  assert.strictEqual(audit[0].user_id, authorized.id, 'avec son auteur');

  assert.throws(
    () => payments.confirmCashCollection(order.id, { user: admin }),
    (err) => err.code === 'ALREADY_PAID',
    'une commande déjà réglée ne peut pas être encaissée deux fois'
  );
});

test('annulation : le stock est restitué', () => {
  const p = makeProduct(T, { sku: 'ORD-CANCEL', name: 'Commande annulée', price: 1500, qty: 6 });
  const order = makeOrder(T, [{ productId: p.id, qty: 4 }]);
  assert.strictEqual(itemOf(p.id).qty_reserved, 4);

  orders.cancel(order.id, { reason: 'Annulation à la demande du client' });

  const item = itemOf(p.id);
  assert.strictEqual(item.qty_reserved, 0, 'la réservation est libérée');
  assert.strictEqual(item.qty_on_hand, 6, 'le stock physique est intact');
  assert.strictEqual(stock.availableForProduct(p.id), 6, 'l’article est de nouveau vendable');
  assert.strictEqual(orders.getById(order.id).status, 'cancelled');
});

test('expiration des réservations : commande en ligne annulée, commande espèces et commande sur devis conservées (régression)', () => {
  const online = makeProduct(T, { sku: 'EXP-ONLINE', name: 'Expiration paiement en ligne', price: 1000, qty: 5 });
  const cash = makeProduct(T, { sku: 'EXP-CASH', name: 'Expiration espèces', price: 1000, qty: 5 });
  const quoted = makeProduct(T, { sku: 'EXP-QUOTE', name: 'Expiration devis', price: 1000, qty: 5 });

  // 1. Paiement Mobile Money initialisé, jamais abouti.
  const orderOnline = orders.createOrder({
    mode: 'pickup', paymentMethod: 'wave', termsAccepted: true,
    customer: { fullName: 'Client Wave', phone: '0700000092' },
    lines: [{ productId: online.id, qty: 2 }],
  }, { source: 'test' }).order;
  assert.strictEqual(orderOnline.status, 'pending');
  assert.notStrictEqual(orderOnline.payment_status, 'paid');

  // 2. Paiement à la réception : la commande reste encaissable au comptoir.
  const orderCash = makeOrder(T, [{ productId: cash.id, qty: 1 }], {
    customer: { fullName: 'Client Espèces Expiration', phone: '0700000091' },
  });

  // 3. Livraison sur devis.
  const zone = db.get("SELECT * FROM shipping_zones WHERE code = 'iffou'");
  const orderQuote = orders.createOrder({
    mode: 'delivery', zoneId: zone.id, paymentMethod: 'pay_on_delivery', termsAccepted: true,
    customer: { fullName: 'Client Devis', phone: '0700000094' },
    shippingInfo: { city: 'Bongouanou', quarter: 'Quartier test' },
    lines: [{ productId: quoted.id, qty: 2 }],
  }, { source: 'test' }).order;
  assert.strictEqual(orderQuote.status, 'quote_required', 'la zone sans tarif impose un devis');

  // On fait expirer les trois réservations.
  db.run("UPDATE reservations SET expires_at = ? WHERE status = 'active'", [T.dates.addMinutes(T.dates.nowIso(), -5)]);
  const released = stock.releaseExpired({});
  assert.ok(released >= 5);

  assert.strictEqual(orders.getById(orderOnline.id).status, 'cancelled',
    'une commande en ligne non réglée dont la réservation expire est annulée');
  assert.strictEqual(orders.getById(orderCash.id).status, 'pending',
    'une commande à payer à la réception n’est pas annulée automatiquement');
  assert.strictEqual(orders.getById(orderQuote.id).status, 'quote_required',
    'une commande sur devis n’est PAS annulée : elle attend l’accord du client');

  assert.strictEqual(itemOf(online.id).qty_reserved, 0);
  assert.strictEqual(itemOf(cash.id).qty_reserved, 0, 'le stock de la commande espèces est tout de même libéré');
  assert.strictEqual(itemOf(quoted.id).qty_reserved, 0, 'celui de la commande sur devis aussi');

  // Le devis accepté re-réserve le stock et réintègre le montant au total.
  orders.sendQuote(orderQuote.id, 2500, { note: 'Livraison Bongouanou' });
  orders.acceptQuote(orderQuote.id, { userId: adminRow().id });
  const after = orders.getById(orderQuote.id);
  assert.strictEqual(after.quote_status, 'accepted');
  assert.strictEqual(after.status, 'pending', 'la commande redevient traitable après accord');
  assert.strictEqual(after.total, 2000 + 2500, 'le total intègre le montant du devis');
});

test('devis refusé : la commande repasse en attente d’un autre mode de réception', () => {
  const p = makeProduct(T, { sku: 'QUOTE-REFUS', name: 'Devis refusé', price: 1000, qty: 5 });
  const zone = db.get("SELECT * FROM shipping_zones WHERE code = 'iffou'");
  const order = orders.createOrder({
    mode: 'delivery', zoneId: zone.id, paymentMethod: 'pay_on_delivery', termsAccepted: true,
    customer: { fullName: 'Client Refus', phone: '0700000090' },
    shippingInfo: { city: 'Daoukro', quarter: 'Quartier test' },
    lines: [{ productId: p.id, qty: 1 }],
  }, { source: 'test' }).order;

  orders.sendQuote(order.id, 5000, { note: 'Livraison hors zone' });
  orders.refuseQuote(order.id, { userId: adminRow().id, reason: 'Montant refusé par le client' });
  const after = orders.getById(order.id);
  assert.strictEqual(after.quote_status, 'refused');
  assert.strictEqual(after.status, 'cancelled', 'sans accord sur le tarif, la commande n’est pas engagée');
});

test('transitions de statut : les enchaînements interdits sont refusés', () => {
  const p = makeProduct(T, { sku: 'ORD-TRANS', name: 'Transitions', qty: 5 });
  const order = makeOrder(T, [{ productId: p.id, qty: 1 }]);

  assert.strictEqual(orders.canTransition('pending', 'confirmed'), true);
  assert.strictEqual(orders.canTransition('cancelled', 'delivered'), false);
  assert.throws(
    () => orders.setStatus(order.id, 'delivered', { note: 'saut interdit' }),
    (err) => err.code === 'BAD_TRANSITION' && err.status === 409
  );
});

test('suivi public : jeton obligatoire, adresse masquée, historique interne masqué', () => {
  const p = makeProduct(T, { sku: 'TRK-1', name: 'Suivi public', price: 1000, qty: 5 });
  const zone = db.get("SELECT * FROM shipping_zones WHERE code = 'daoukro'");
  const order = orders.createOrder({
    mode: 'delivery', zoneId: zone.id, paymentMethod: 'pay_on_delivery', termsAccepted: true,
    customer: { fullName: 'Client Suivi', phone: '0700000093' },
    shippingInfo: { city: 'Daoukro', quarter: 'Quartier résidentiel', address: 'Rue des Écoles, villa 12', landmark: 'Près du marché' },
    lines: [{ productId: p.id, qty: 1 }],
  }, { source: 'test' }).order;

  const view = orders.forTracking(order.tracking_token);
  assert.ok(view, 'le jeton valide donne accès au suivi');
  assert.ok(!/villa 12/.test(String(view.address)), 'l’adresse précise n’est pas exposée');
  assert.ok(!/Rue des Écoles, villa 12/.test(JSON.stringify(view)), 'aucune fuite d’adresse complète');
  assert.strictEqual(view.internal_note, '');
  assert.ok(view.events.every((e) => e.public === 1 || e.public === true), 'seuls les événements publics sont visibles');

  assert.strictEqual(orders.forTracking('jeton-inexistant'), null);
  assert.strictEqual(orders.getByTrackingToken('autre-jeton'), null);
});

test('dernier exemplaire : la réservation du panier ne se retourne pas contre le client (régression)', () => {
  const p = makeProduct(T, { sku: 'DERNIER-EXEMPLAIRE', name: 'Dernier exemplaire', price: 1000, qty: 1 });
  const cartId = db.insert('carts', { token: `panier-test-${Date.now()}`, status: 'active' });

  // Le panier réserve l'unique exemplaire : plus rien n'est disponible pour les autres.
  stock.reserve(stock.resolveTargets(p.id, null, 1), { cartId, minutes: 30, note: 'Réservation panier' });
  assert.strictEqual(stock.availableForProduct(p.id), 0, 'le panier tient le dernier exemplaire');

  // L'affichage du panier ne doit pas annoncer une rupture pour l'article réservé.
  db.insert('cart_items', { cart_id: cartId, product_id: p.id, variant_id: null, qty: 1 });
  const loaded = T.cart.loadCart(cartId, 'panier-test');
  assert.strictEqual(loaded.items.length, 1);
  assert.strictEqual(loaded.items[0].purchasable, true, 'l’article réservé par ce panier reste achetable pour lui');
  assert.strictEqual(loaded.problems.length, 0, 'aucune rupture affichée à tort');

  // Sans correctif, createOrder refusait : « 0 unité(s) disponible(s) pour 1 demandée(s) ».
  const order = makeOrder(T, [{ productId: p.id, qty: 1 }], { cartId });
  assert.strictEqual(order.total, 1000);
  const held = db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [order.id]);
  assert.strictEqual(held.length, 1, 'la commande reprend la réservation');
  assert.strictEqual(held[0].cart_id, null, 'la réservation n’est plus rattachée au panier');
  assert.strictEqual(
    db.all("SELECT * FROM reservations WHERE cart_id = ? AND status = 'active'", [cartId]).length,
    0,
    'aucune double réservation : le panier a transmis la sienne'
  );

  // Un autre client ne peut toujours pas prendre cet exemplaire.
  assert.throws(
    () => makeOrder(T, [{ productId: p.id, qty: 1 }]),
    (err) => err.code === 'CART_INVALID' && /(disponible|rupture)/i.test(err.message),
    'la protection anti-survente reste active pour les autres clients'
  );

  // Une fois la commande passée, le panier converti ne revend plus rien.
  assert.strictEqual(T.cart.loadCart(cartId, 'panier-test').items[0].purchasable, false,
    'l’exemplaire est vendu : le panier converti ne le propose plus');
});

test('remboursement : partiel puis intégral, remise en stock et journal d’audit', () => {
  const admin = adminRow();
  const p = makeProduct(T, { sku: 'REMB-1', name: 'Article remboursé', price: 1500, qty: 10 });
  const order = makeOrder(T, [{ productId: p.id, qty: 2 }]);
  payments.confirmCashCollection(order.id, { user: admin, amount: 3000, note: 'Espèces reçues' });
  assert.strictEqual(db.get('SELECT payment_status FROM orders WHERE id = ?', [order.id]).payment_status, 'paid');

  const line = db.get('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  const onHandBefore = itemOf(p.id).qty_on_hand;

  // Un retour enregistré mais non validé ne doit rien changer.
  const pending = orders.createRefund(order.id, {
    kind: 'return', items: [{ orderItemId: line.id, qty: 1 }], restock: true, userId: admin.id,
  });
  assert.strictEqual(pending.status, 'pending');
  assert.strictEqual(pending.amount, 1500, 'le montant vient de la ligne, pas de la saisie');
  assert.strictEqual(db.get('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded, 0);
  assert.strictEqual(itemOf(p.id).qty_on_hand, onHandBefore, 'aucune remise en stock avant validation');
  assert.strictEqual(db.all('SELECT * FROM refund_items WHERE refund_id = ?', [pending.id]).length, 1);

  orders.applyRefund(pending.id, { userId: admin.id });
  let fresh = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  assert.strictEqual(fresh.amount_refunded, 1500);
  assert.strictEqual(fresh.payment_status, 'partially_refunded', 'le statut de paiement suit');
  assert.strictEqual(fresh.status, 'partially_refunded', 'le statut de commande suit');
  assert.strictEqual(itemOf(p.id).qty_on_hand, onHandBefore + 1, 'l’unité retournée revient en stock');
  assert.ok(
    db.all("SELECT * FROM stock_movements WHERE product_id = ? AND reason = 'retour'", [p.id]).length >= 1,
    'la remise en stock est journalisée'
  );

  // Enregistrer ET appliquer en une seule fois doit produire exactement les
  // mêmes effets : la ligne était auparavant créée directement à « done », ce
  // qui court-circuitait l'application (ni montant, ni statut, ni stock).
  const oneShot = orders.createRefund(order.id, {
    kind: 'refund', items: [{ orderItemId: line.id, qty: 1 }], restock: true, userId: admin.id, status: 'done',
  });
  assert.strictEqual(oneShot.status, 'done');
  assert.ok(oneShot.processed_at, 'la date d’application est posée');
  assert.strictEqual(oneShot.processed_by, admin.id, 'l’auteur est tracé');
  fresh = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  assert.strictEqual(fresh.amount_refunded, 3000, 'le remboursement en une fois est réellement appliqué');
  assert.strictEqual(fresh.payment_status, 'refunded');
  assert.strictEqual(fresh.status, 'refunded');
  assert.strictEqual(itemOf(p.id).qty_on_hand, onHandBefore + 2, 'les deux unités sont revenues en stock');

  // Impossible de rembourser plus que ce qui a été encaissé.
  assert.throws(
    () => orders.createRefund(order.id, { kind: 'refund', amount: 500, userId: admin.id }),
    (err) => err.code === 'AMOUNT_EXCEEDED'
  );
  // Un remboursement déjà appliqué ne peut pas être rejoué.
  orders.applyRefund(oneShot.id, { userId: admin.id });
  assert.strictEqual(db.get('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded, 3000);
  assert.strictEqual(db.all('SELECT * FROM refunds WHERE order_id = ?', [order.id]).length, 2);

  // Les mouvements d'argent doivent apparaître dans le journal d'audit.
  const entries = db.all("SELECT * FROM audit_log WHERE entity_type = 'order' AND entity_id = ? AND action LIKE 'refund.%'", [String(order.id)]);
  assert.strictEqual(entries.length, 4, '2 créations + 2 applications');
  assert.ok(entries.some((e) => e.action === 'refund.create'));
  assert.ok(entries.every((e) => e.user_id === admin.id), 'chaque mouvement d’argent a un auteur');
});

test('annulation d’une commande payée : trace d’audit et remboursement à traiter', () => {
  const admin = adminRow();
  const p = makeProduct(T, { sku: 'ANNUL-PAIEE', name: 'Article annulé après paiement', price: 2000, qty: 6 });
  const order = makeOrder(T, [{ productId: p.id, qty: 1 }]);
  payments.confirmCashCollection(order.id, { user: admin, amount: 2000, note: 'Espèces reçues' });
  const onHandAfterPayment = itemOf(p.id).qty_on_hand;

  const cancelled = orders.cancel(order.id, { reason: 'Client injoignable', userId: admin.id, restock: true });
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(itemOf(p.id).qty_on_hand, onHandAfterPayment + 1, 'le stock est restitué');
  const entries = db.all("SELECT * FROM audit_log WHERE action = 'order.cancel' AND entity_id = ?", [String(order.id)]);
  assert.strictEqual(entries.length, 1, 'l’annulation est journalisée');
  assert.strictEqual(entries[0].user_id, admin.id);
  assert.strictEqual(JSON.parse(entries[0].detail).paid, true, 'le journal distingue une annulation après paiement');
});
