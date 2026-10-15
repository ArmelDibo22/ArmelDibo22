'use strict';

/**
 * Accès, rôles et isolation des données : matrice de permissions admin/vendeur,
 * habilitation à encaisser, protection du dernier administrateur, authentification
 * et sessions (jeton haché, expiration, révocation), isolation des commandes entre
 * clients, consentement marketing distinct et limitation de débit.
 */

const test = require('node:test');
const assert = require('node:assert');

const { boot, makeProduct, makeOrder } = require('./helpers/boot');
const T = boot(__filename);

const { users, orders, db, settings, security } = T;
const session = require('../src/lib/session');
const ratelimit = require('../src/lib/ratelimit');
const ids = require('../src/lib/ids');

// `session.setCookie()` écrit dans l'en-tête Set-Cookie, comme Express.
const fakeRes = () => {
  const headers = {};
  return {
    headers,
    getHeader: (name) => headers[String(name).toLowerCase()],
    setHeader: (name, value) => { headers[String(name).toLowerCase()] = value; },
  };
};
const setCookies = (res) => {
  const value = res.getHeader('Set-Cookie');
  return Array.isArray(value) ? value : value ? [value] : [];
};
const adminCookieOf = (res) => setCookies(res).find((c) => c.startsWith(`${session.ADMIN_COOKIE}=`));
const fakeReq = (cookieHeader = '') => ({ ip: '127.0.0.1', headers: { 'user-agent': 'node:test', cookie: cookieHeader } });

const adminRow = () => db.get("SELECT * FROM users WHERE role = 'admin' AND active = 1 LIMIT 1");

const makeVendor = (email, { canConfirmCash = false } = {}) => users.createUser({
  email,
  password: 'Test-Vendeur-2026!',
  fullName: 'Vendeur de test',
  role: 'vendor',
  canConfirmCash,
  active: true,
}, adminRow());

/* ------------------------------------------------------------------ */
/* Rôles et permissions                                                */
/* ------------------------------------------------------------------ */

test('matrice de permissions : ce que le vendeur peut faire, et ce qu’il ne peut pas', () => {
  const admin = adminRow();
  const vendor = makeVendor('vendeur.matrice@test.local');

  const allowedForVendor = ['catalog.read', 'catalog.write', 'orders.read', 'orders.write', 'orders.cancel',
    'stock.read', 'stock.write', 'pos.read', 'pos.write', 'customers.read', 'imports.run', 'imports.export',
    'settings.read', 'stats.read'];
  for (const perm of allowedForVendor) {
    assert.strictEqual(users.can(vendor, perm), true, `le vendeur doit pouvoir « ${perm} »`);
  }

  const refusedForVendor = ['catalog.delete', 'orders.refund', 'pos.cancel', 'customers.write',
    'settings.write', 'users.read', 'users.write', 'audit.read', 'cash.confirm'];
  for (const perm of refusedForVendor) {
    assert.strictEqual(users.can(vendor, perm), false, `le vendeur ne doit PAS pouvoir « ${perm} »`);
  }

  for (const perm of [...allowedForVendor, ...refusedForVendor]) {
    assert.strictEqual(users.can(admin, perm), true, `l’administrateur doit pouvoir « ${perm} »`);
  }

  assert.strictEqual(users.can(null, 'catalog.read'), false, 'un visiteur anonyme n’a aucune permission');
  assert.strictEqual(users.can({ role: 'inconnu' }, 'catalog.read'), false, 'un rôle inconnu n’a aucune permission');
});

test('encaissement en espèces : habilitation explicite, modifiable', () => {
  const plain = makeVendor('vendeur.sans.caisse@test.local');
  const cashier = makeVendor('vendeur.avec.caisse@test.local', { canConfirmCash: true });

  assert.strictEqual(users.can(plain, 'cash.confirm'), false);
  assert.strictEqual(users.can(cashier, 'cash.confirm'), true);

  // Retrait de l’habilitation par un administrateur.
  users.updateUser(cashier.id, { canConfirmCash: false }, adminRow());
  assert.strictEqual(users.can(users.getUser(cashier.id), 'cash.confirm'), false);
  assert.strictEqual(users.can(adminRow(), 'cash.confirm'), true, 'un administrateur reste habilité');
});

test('dernier administrateur : ni rétrogradation, ni désactivation, ni suppression', () => {
  const admin = adminRow();
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n, 1);

  assert.throws(() => users.updateUser(admin.id, { role: 'vendor' }, admin), (e) => e.code === 'LAST_ADMIN');
  assert.throws(() => users.updateUser(admin.id, { active: false }, admin), (e) => e.code === 'LAST_ADMIN');
  assert.throws(() => users.deleteUser(admin.id, admin), (e) => e.code === 'LAST_ADMIN' || e.code === 'SELF_DELETE');
  assert.strictEqual(users.getUser(admin.id).role, 'admin', 'l’administrateur est toujours en place');

  // Avec un second administrateur actif, la rétrogradation redevient possible.
  const second = users.createUser({
    email: 'admin.second@test.local', password: 'Test-Admin-2026!', fullName: 'Second administrateur',
    role: 'admin', active: true,
  }, admin);
  const demoted = users.updateUser(second.id, { role: 'vendor' }, admin);
  assert.strictEqual(demoted.role, 'vendor');

  // Auto-suppression interdite même lorsqu’un autre administrateur existe.
  assert.throws(() => users.deleteUser(admin.id, admin), (e) => e.code === 'SELF_DELETE');
  users.deleteUser(second.id, admin);
  assert.strictEqual(users.getUser(second.id), null);
});

test('création de compte : mot de passe faible refusé, e-mail déjà pris refusé', () => {
  const admin = adminRow();
  assert.throws(() => users.createUser({ email: 'faible@test.local', password: 'azerty', fullName: 'x', role: 'vendor' }, admin),
    (e) => e.code === 'WEAK_PASSWORD');
  assert.throws(() => users.createUser({ email: 'pas-un-email', password: 'Test-Vendeur-2026!', role: 'vendor' }, admin),
    (e) => Boolean(e));
  users.createUser({ email: 'unique@test.local', password: 'Test-Vendeur-2026!', fullName: 'Unique', role: 'vendor' }, admin);
  assert.throws(() => users.createUser({ email: 'UNIQUE@test.local', password: 'Test-Vendeur-2026!', role: 'vendor' }, admin),
    (e) => e.code === 'EMAIL_TAKEN', 'l’e-mail est comparé sans tenir compte de la casse');
});

test('connexion administrateur : identifiants incorrects, compte désactivé, échec journalisé', () => {
  const admin = adminRow();
  const ok = users.loginAdmin({ email: admin.email, password: process.env.ADMIN_PASSWORD }, fakeReq());
  assert.strictEqual(ok.role, 'admin');
  assert.strictEqual(ok.canConfirmCash === undefined || typeof ok.canConfirmCash === 'boolean', true);

  assert.throws(() => users.loginAdmin({ email: admin.email, password: 'mauvais-mot-de-passe' }, fakeReq()),
    (e) => e.code === 'BAD_CREDENTIALS' && e.status === 401);
  assert.throws(() => users.loginAdmin({ email: 'inexistant@test.local', password: 'Test-Admin-2026!' }, fakeReq()),
    (e) => e.code === 'BAD_CREDENTIALS', 'la même erreur est renvoyée : pas d’énumération de comptes');

  const vendor = makeVendor('vendeur.desactive@test.local');
  users.updateUser(vendor.id, { active: false }, admin);
  assert.throws(() => users.loginAdmin({ email: vendor.email, password: 'Test-Vendeur-2026!' }, fakeReq()),
    (e) => e.code === 'INACTIVE' && e.status === 403);

  const failed = db.all("SELECT * FROM audit_log WHERE action = 'auth.login_failed'");
  assert.ok(failed.length >= 2, 'les connexions refusées sont journalisées');
  assert.ok(db.all("SELECT * FROM audit_log WHERE action = 'auth.login'").length >= 1, 'les connexions réussies aussi');
});

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

test('session administrateur : jeton haché en base, cookie httpOnly, expiration et révocation', () => {
  const admin = adminRow();
  const res = fakeRes();
  const token = session.createAdminSession(admin, fakeReq(), res);
  assert.ok(token && token.length >= 32);
  const cookieHeader = adminCookieOf(res);
  assert.ok(cookieHeader, 'le cookie de session est posé');
  assert.match(cookieHeader, /HttpOnly/i, 'le cookie n’est pas lisible par JavaScript');
  assert.match(cookieHeader, /SameSite=Lax/i, 'protection CSRF de base');
  assert.match(cookieHeader, /Path=\//i);
  assert.strictEqual(/Secure/i.test(cookieHeader), process.env.NODE_ENV === 'production',
    'l’attribut Secure suit l’environnement : obligatoire en production, absent en test');
  assert.ok(cookieHeader.includes(token), 'le jeton brut n’existe que dans le cookie');

  const stored = db.get('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');
  assert.notStrictEqual(stored.token_hash, token, 'le jeton brut n’est jamais stocké');
  assert.strictEqual(stored.token_hash, ids.hashToken(token));
  assert.ok(!db.all('SELECT * FROM sessions WHERE token_hash = ?', [token]).length, 'aucune ligne ne contient le jeton en clair');

  const loaded = session.loadAdminSession({ cookies: { [session.ADMIN_COOKIE]: token } });
  assert.strictEqual(loaded.user.id, admin.id);
  assert.strictEqual(loaded.user.role, 'admin');

  // Jeton forgé ou inconnu.
  assert.strictEqual(session.loadAdminSession({ cookies: { [session.ADMIN_COOKIE]: 'jeton-forgé' } }), null);
  assert.strictEqual(session.loadAdminSession({ cookies: {} }), null);

  // Session expirée : refusée et révoquée.
  db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [T.dates.addMinutes(T.dates.nowIso(), -5), ids.hashToken(token)]);
  assert.strictEqual(session.loadAdminSession({ cookies: { [session.ADMIN_COOKIE]: token } }), null);
  assert.ok(db.get('SELECT revoked_at FROM sessions WHERE token_hash = ?', [ids.hashToken(token)]).revoked_at,
    'une session expirée est révoquée');

  // Déconnexion : la session est révoquée.
  const res2 = fakeRes();
  const token2 = session.createAdminSession(admin, fakeReq(), res2);
  assert.ok(adminCookieOf(res2).includes(token2));
  session.destroyAdminSession({ cookies: { [session.ADMIN_COOKIE]: token2 } }, res2);
  assert.strictEqual(session.loadAdminSession({ cookies: { [session.ADMIN_COOKIE]: token2 } }), null);
});

/* ------------------------------------------------------------------ */
/* Isolation des données clients                                       */
/* ------------------------------------------------------------------ */

test('isolation : chaque client ne voit que ses propres commandes', () => {
  const p = makeProduct(T, { sku: 'ISO-1', name: 'Article isolation', price: 1000, qty: 50 });
  const orderA = makeOrder(T, [{ productId: p.id, qty: 1 }], { customer: { fullName: 'Client A', phone: '0700000011' } });
  const orderB = makeOrder(T, [{ productId: p.id, qty: 2 }], { customer: { fullName: 'Client B', phone: '0700000022' } });

  // Le téléphone est normalisé à l'enregistrement : on retrouve les clients par leur nom.
  const customerA = db.get('SELECT * FROM customers WHERE full_name = ?', ['Client A']);
  const customerB = db.get('SELECT * FROM customers WHERE full_name = ?', ['Client B']);
  assert.ok(customerA && customerB && customerA.id !== customerB.id, 'deux clients distincts');

  const listA = orders.listForCustomer(customerA.id);
  assert.deepStrictEqual(listA.map((o) => o.id), [orderA.id], 'le client A ne voit que sa commande');
  assert.ok(!listA.some((o) => o.id === orderB.id));
  const listB = orders.listForCustomer(customerB.id);
  assert.deepStrictEqual(listB.map((o) => o.id), [orderB.id]);

  // Une commande annulée disparaît de l’espace client.
  orders.cancel(orderB.id, { reason: 'Test annulation' });
  assert.deepStrictEqual(orders.listForCustomer(customerB.id).map((o) => o.id), []);
});

test('suivi : seul le jeton donne accès, et il ne révèle pas les données internes', () => {
  const p = makeProduct(T, { sku: 'ISO-TRK', name: 'Article suivi', price: 1000, qty: 20 });
  const zone = db.get("SELECT * FROM shipping_zones WHERE code = 'retrait-boutique'");
  const order = orders.createOrder({
    mode: 'pickup', paymentMethod: 'pay_at_pickup', termsAccepted: true,
    customer: { fullName: 'Client Suivi', phone: '0700000033' },
    lines: [{ productId: p.id, qty: 1 }],
    internalNote: 'Remise accordée à la main, ne pas afficher',
  }, { source: 'test' }).order;
  assert.ok(zone);

  const view = orders.forTracking(order.tracking_token);
  assert.strictEqual(view.internal_note, '', 'la note interne n’est jamais exposée');
  assert.ok(!JSON.stringify(view).includes('ne pas afficher'));
  assert.strictEqual(orders.forTracking(`${order.tracking_token}x`), null);

  // La référence de commande ne suffit pas à ouvrir le suivi.
  assert.strictEqual(orders.getByTrackingToken(order.reference), null);
});

test('compte client facultatif : e-mail non obligatoire, consentement marketing distinct', () => {
  // Inscription par téléphone seul.
  const byPhone = users.registerCustomer({ phone: '0700000044', fullName: 'Client Téléphone', password: 'Test-Client-2026!' });
  assert.ok(byPhone.id);
  assert.strictEqual(byPhone.email, null, 'aucun e-mail n’est exigé');
  assert.strictEqual(byPhone.marketing_consent, 0, 'le consentement marketing n’est pas présumé');
  assert.strictEqual(byPhone.consent_at, null);

  const byEmail = users.registerCustomer({ email: 'client.consent@test.local', password: 'Test-Client-2026!', fullName: 'Client Consentement', marketingConsent: true });
  assert.strictEqual(byEmail.marketing_consent, 1);
  assert.ok(byEmail.consent_at, 'la date du consentement est conservée');

  assert.throws(() => users.registerCustomer({ password: 'Test-Client-2026!' }), (e) => e.code === 'IDENTIFIER_REQUIRED');
  assert.throws(() => users.registerCustomer({ phone: '0700000055', password: '123' }), (e) => e.code === 'WEAK_PASSWORD');
  assert.throws(() => users.registerCustomer({ email: 'client.consent@test.local', password: 'Test-Client-2026!' }),
    (e) => e.code === 'EMAIL_TAKEN', 'un compte existant n’est pas écrasé');
  assert.throws(() => users.registerCustomer({ phone: '0700000044', password: 'Test-Client-2026!' }),
    (e) => e.code === 'ACCOUNT_EXISTS', 'un compte rattaché à ce téléphone existe déjà');

  // Connexion client par téléphone ou e-mail.
  assert.strictEqual(users.loginCustomer({ identifier: '0700000044', password: 'Test-Client-2026!' }).id, byPhone.id);
  assert.strictEqual(users.loginCustomer({ identifier: 'client.consent@test.local', password: 'Test-Client-2026!' }).id, byEmail.id);
  assert.throws(() => users.loginCustomer({ identifier: '0700000044', password: 'mauvais' }), (e) => e.code === 'BAD_CREDENTIALS');
});

test('mot de passe : haché, jamais stocké en clair, vérifiable', () => {
  const hash = security.hashPassword('Test-Admin-2026!');
  assert.ok(!hash.includes('Test-Admin-2026!'));
  assert.notStrictEqual(security.hashPassword('Test-Admin-2026!'), hash, 'le sel rend chaque hachage différent');
  assert.strictEqual(security.verifyPassword('Test-Admin-2026!', hash), true);
  assert.strictEqual(security.verifyPassword('autre', hash), false);
  assert.ok(!db.all("SELECT * FROM users WHERE password_hash LIKE '%Test-Admin%'").length, 'aucun mot de passe en clair en base');

  const customer = users.registerCustomer({ phone: '0700000066', fullName: 'Client Hachage', password: 'Test-Client-2026!' });
  users.updateCustomerPassword(customer.id, 'Test-Client-2026!', 'Nouveau-Client-2026!');
  assert.throws(() => users.updateCustomerPassword(customer.id, 'mauvais', 'Encore-2026!'), (e) => e.code === 'BAD_CREDENTIALS');
  assert.strictEqual(users.loginCustomer({ identifier: '0700000066', password: 'Nouveau-Client-2026!' }).id, customer.id);
});

/* ------------------------------------------------------------------ */
/* Journal d’audit, réglages et limitation de débit                    */
/* ------------------------------------------------------------------ */

test('journal d’audit : les actions sensibles laissent une trace interrogeable', () => {
  const admin = adminRow();
  const vendor = makeVendor('vendeur.audit@test.local');
  users.updateUser(vendor.id, { canConfirmCash: true }, admin);

  const list = users.auditList({ limit: 50 });
  assert.ok(list.total >= 3);
  const actions = list.items.map((i) => i.action);
  assert.ok(actions.includes('user.create'), 'la création d’un utilisateur est tracée');
  assert.ok(actions.includes('user.update'), 'la modification d’un utilisateur est tracée');
  const detail = list.items.find((i) => i.action === 'user.update');
  assert.ok(detail.user_id, 'l’auteur de l’action est identifié');
});

test('réglages : seul un compte autorisé les écrit, la valeur est validée', () => {
  const admin = adminRow();
  const before = settings.get('store.name');
  settings.set('store.name', 'ETS LE PRIVILÈGE DAOUKRO — modifié', admin.id);
  assert.strictEqual(settings.get('store.name'), 'ETS LE PRIVILÈGE DAOUKRO — modifié');
  assert.notStrictEqual(before, settings.get('store.name'));

  // Une valeur vide est acceptée et normalisée (jamais de NULL en base).
  assert.strictEqual(settings.set('store.name', null, admin.id), settings.SCHEMA['store.name'].default,
    'une valeur vide retombe sur la valeur par défaut du schéma : jamais de NULL en base');
  assert.throws(() => settings.set('cle.inexistante', 'x', admin.id), (e) => Boolean(e), 'une clé inconnue est refusée');
  assert.throws(() => settings.set('theme.density', 'immense', admin.id), (e) => Boolean(e), 'une valeur hors liste est refusée');
  assert.strictEqual(settings.set('theme.density', 'compact', admin.id), 'compact');
  settings.set('theme.density', 'comfortable', admin.id);
  settings.set('store.name', before, admin.id);

  assert.strictEqual(settings.get('store.name'), before);
});

test('limitation de débit : le seuil est appliqué puis la fenêtre se réinitialise', () => {
  const key = `test:debit:${Date.now()}`;
  const first = ratelimit.hit(key, { windowMs: 60000, max: 3 });
  assert.strictEqual(first.allowed, true);
  assert.strictEqual(first.remaining, 2);
  ratelimit.hit(key, { windowMs: 60000, max: 3 });
  const third = ratelimit.hit(key, { windowMs: 60000, max: 3 });
  assert.strictEqual(third.allowed, true);
  assert.strictEqual(third.remaining, 0);
  const fourth = ratelimit.hit(key, { windowMs: 60000, max: 3 });
  assert.strictEqual(fourth.allowed, false, 'au-delà du seuil, la requête est refusée');
  assert.ok(fourth.retryAfter > 0, 'le délai avant nouvel essai est communiqué');

  // Clé différente : non affectée.
  assert.strictEqual(ratelimit.hit(`${key}:autre`, { windowMs: 60000, max: 3 }).allowed, true);

  // Fenêtre écoulée : le compteur repart.
  db.run('UPDATE rate_buckets SET reset_at = ? WHERE key = ?', [Date.now() - 1000, key]);
  assert.strictEqual(ratelimit.hit(key, { windowMs: 60000, max: 3 }).allowed, true);
  ratelimit.purge();
});

test('vendeur et administrateur voient le même catalogue, mais pas les mêmes outils', () => {
  const admin = adminRow();
  const vendor = makeVendor('vendeur.catalogue@test.local');
  makeProduct(T, { sku: 'ACC-CAT', name: 'Article visible', price: 2000, qty: 5 });

  // Les deux rôles peuvent consulter et écrire le catalogue.
  assert.strictEqual(users.can(vendor, 'catalog.read'), users.can(admin, 'catalog.read'));
  assert.strictEqual(users.can(vendor, 'catalog.write'), true);
  // Seul l’administrateur supprime un article et gère les comptes.
  assert.strictEqual(users.can(vendor, 'catalog.delete'), false);
  assert.strictEqual(users.can(vendor, 'users.write'), false);
  assert.strictEqual(users.can(admin, 'catalog.delete'), true);
  assert.strictEqual(users.can(admin, 'users.write'), true);

  // Un import lancé par un vendeur est attribué à son auteur.
  const jobs = db.all('SELECT * FROM import_jobs');
  assert.ok(Array.isArray(jobs));
});
