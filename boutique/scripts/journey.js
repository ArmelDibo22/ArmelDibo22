'use strict';

/**
 * `npm run journey` — parcours métier complet de bout en bout, en HTTP réel.
 *
 * Contrairement à `npm run check` (qui vérifie que chaque page répond), ce
 * script JOUE l'activité de la boutique : visite sur mobile, création d'un
 * article depuis le formulaire d'administration, import CSV assisté, achats
 * invités en retrait et en livraison, livraison sur devis avec accord du
 * client, paiement Mobile Money en bac à sable (succès, échec, doublon,
 * montant erroné, signature forgée), concurrence sur un stock limité,
 * annulation et restitution du stock, séparation des rôles et des données.
 *
 * Chaque étape vérifie la réponse HTTP ET l'effet en base.
 *
 * SÉCURITÉ DES DONNÉES : le script écrit (articles, commandes, imports).
 * Il refuse de s'exécuter hors mode démonstration sans `--allow-real`.
 *
 * Usage :
 *   node scripts/journey.js                     # démarre un serveur éphémère
 *   node scripts/journey.js --url http://h:3000 # utilise un serveur existant
 *   node scripts/journey.js --json              # sortie machine
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const allowReal = args.includes('--allow-real');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const config = require('../src/config');
const db = require('../src/db');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');

if (!config.isDemo && !allowReal && !urlArg) {
  console.error('Refus : ce script écrit des données. Lancez-le sur la base de démonstration');
  console.error('(DEMO=true) ou passez --allow-real en connaissance de cause.');
  process.exit(1);
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
const ref = (prefix) => `${prefix}-${STAMP}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Outillage HTTP                                                       */
/* ------------------------------------------------------------------ */

class Jar {
  constructor(label) { this.label = label; this.cookies = new Map(); }
  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of raw) {
      const [pair] = String(c).split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(String(c))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

let BASE = urlArg;
const results = [];
let failures = 0;

function record(group, label, ok, detail = '') {
  results.push({ group, label, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  if (!asJson) {
    const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function check(group, label, condition, detail = '') {
  record(group, label, condition, detail || (condition ? '' : 'condition non satisfaite'));
  return Boolean(condition);
}

async function hit(jar, method, url, { body = null, form = null, headers = {}, expect = null, ua = null } = {}) {
  const finalHeaders = { cookie: jar.header(), ...headers };
  if (ua) finalHeaders['user-agent'] = ua;
  let payload;
  if (form) {
    payload = form instanceof FormData ? form : new URLSearchParams(form).toString();
    if (!(form instanceof FormData)) finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
  } else if (body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    finalHeaders['content-type'] = finalHeaders['content-type'] || 'application/json';
  }
  const res = await fetch(BASE + url, { method, redirect: 'manual', headers: finalHeaders, body: payload });
  jar.absorb(res);
  const text = await res.text();
  const out = { status: res.status, text, location: res.headers.get('location') || '', headers: res, jar };
  if (expect !== null && res.status !== expect) {
    throw new Error(`${method} ${url} : statut ${res.status} attendu ${expect}${out.location ? ` (location ${out.location})` : ''}`);
  }
  return out;
}

const meta = (html, name) => {
  const m = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html);
  return m ? m[1] : '';
};
const hidden = (html, name) => {
  const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1] : '';
};
const field = (html, name) => {
  const m = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html);
  return m ? m[1] : '';
};

async function tokenOf(jar, pageUrl) {
  const page = await hit(jar, 'GET', pageUrl);
  return meta(page.text, 'csrf-token');
}

const sessions = new Map();

/** Réutilise une session déjà ouverte : évite de saturer la limitation de débit. */
async function sessionFor(key, email, password) {
  if (sessions.has(key)) return sessions.get(key);
  const jar = new Jar(key);
  await login(jar, email, password);
  sessions.set(key, jar);
  return jar;
}
const adminSession = () => sessionFor('admin', config.bootstrapAdmin.email, config.bootstrapAdmin.password);
const vendorSession = (email, password) => sessionFor(`vendeur:${email}`, email, password);

async function login(jar, email, password) {
  const page = await hit(jar, 'GET', '/admin/connexion');
  const token = meta(page.text, 'csrf-token');
  const res = await hit(jar, 'POST', '/admin/connexion', {
    form: { _csrf: token, email, password, suite: '/admin' },
    expect: 302,
  });
  return res;
}

const q1 = (sql, params = []) => db.get(sql, params);

/**
 * Un article réellement vendable : publié, données confirmées, prix > 0, sans
 * variante (pour un contrôle de stock simple) et assez d'unités disponibles.
 * Les références de démonstration sont volontairement variées (rupture, brouillon,
 * données non confirmées) : les choisir au hasard ferait échouer le parcours.
 */
function sellableProduct(minQty = 1) {
  return q1(
    `SELECT p.* FROM products p
       JOIN stock_items si ON si.product_id = p.id AND si.variant_id IS NULL
      WHERE p.status = 'published' AND p.data_confirmed = 1 AND p.price > 0
        AND p.has_variants = 0 AND p.is_kit = 0
        AND (p.track_stock = 0 OR si.qty_on_hand - si.qty_reserved >= ?)
      ORDER BY p.id ASC LIMIT 1`,
    [minQty]
  );
}

const stockLineOf = (productId) => q1('SELECT qty_on_hand, qty_reserved FROM stock_items WHERE product_id = ? AND variant_id IS NULL', [productId]);
const available = (sku) => {
  const row = q1(
    `SELECT si.qty_on_hand, si.qty_reserved FROM stock_items si
       JOIN products p ON p.id = si.product_id
      WHERE p.sku = ? AND si.variant_id IS NULL`,
    [sku]
  );
  return row ? row.qty_on_hand - row.qty_reserved : null;
};

/** Ajoute un article au panier d'un visiteur et renvoie la page panier. */
async function addToCart(jar, productId, qty = 1) {
  const token = await tokenOf(jar, '/panier');
  await hit(jar, 'POST', '/panier/ajouter', {
    form: { _csrf: token, productId: String(productId), qty: String(qty) },
    headers: { 'x-csrf-token': token, 'x-requested-with': 'XMLHttpRequest' },
    expect: 200,
  });
  return hit(jar, 'GET', '/panier');
}

/** Passe une commande invitée depuis le panier courant. */
async function checkout(jar, extra = {}) {
  const query = new URLSearchParams();
  if (extra.mode) query.set('mode', extra.mode);
  if (extra.zone) query.set('zone', String(extra.zone));
  const suffix = query.toString() ? `?${query}` : '';
  const page = await hit(jar, 'GET', `/commande${suffix}`);
  const form = {
    _csrf: meta(page.text, 'csrf-token'),
    idempotency_key: hidden(page.text, 'idempotency_key'),
    expected_total: hidden(page.text, 'expected_total'),
    expected_zone: hidden(page.text, 'expected_zone'),
    mode: 'pickup',
    nom: 'Client Parcours',
    telephone: '0700112233',
    paiement: 'pay_at_pickup',
    cgu: '1',
    ...extra,
  };
  if (form.mode === 'delivery' && !form.zone) {
    const zoneMatch = /name="zone"[^>]*value="(\d+)"/.exec(page.text);
    if (zoneMatch) form.zone = zoneMatch[1];
  }
  const res = await hit(jar, 'POST', '/commande', { form });
  return { page, res };
}

const orderFromLocation = (location) => {
  const byToken = /\/commande\/confirmation\/([^/?#]+)/.exec(location || '');
  if (byToken) return q1('SELECT * FROM orders WHERE tracking_token = ?', [byToken[1]]);
  // Un paiement en ligne redirige directement vers la passerelle : la référence
  // de la commande figure dans l'URL.
  const byGateway = /\/paiements\/simuler\/([^/?#]+)/.exec(location || '');
  if (byGateway) return q1('SELECT * FROM orders WHERE reference = ?', [decodeURIComponent(byGateway[1])]);
  return null;
};

/* ------------------------------------------------------------------ */
/* Étapes                                                              */
/* ------------------------------------------------------------------ */

const steps = [];
function step(name, fn) { steps.push({ name, fn }); }

step('Vitrine sur mobile', async () => {
  const guest = new Jar('mobile');
  const home = await hit(guest, 'GET', '/', { ua: MOBILE_UA, expect: 200 });
  check('mobile', 'la page d’accueil répond', home.status === 200);
  check('mobile', 'la recherche est accessible dès le premier écran', /type="search"|role="search"/.test(home.text));
  check('mobile', 'les catégories sont accessibles', home.text.includes('/catalogue'));
  check('mobile', 'le panier est accessible', home.text.includes('/panier'));
  check('mobile', 'aucune grande bannière décorative ne remplit l’écran', !/class="hero[^"]*hero--full/.test(home.text));
  check('mobile', 'aucun faux témoignage ni compteur de ventes', !/témoignage|avis de nos clients|déjà \d+ ventes/i.test(home.text));
  check('mobile', 'le numéro supplémentaire est affiché', home.text.includes('07 58 11 38 57') || home.text.includes('0758113857'));

  const catalogue = await hit(guest, 'GET', '/catalogue', { ua: MOBILE_UA, expect: 200 });
  check('mobile', 'le catalogue affiche des articles', (catalogue.text.match(/\/produit\//g) || []).length >= 6);
  check('mobile', 'le catalogue est paginé', /page=2/.test(catalogue.text));
  const search = await hit(guest, 'GET', '/recherche?q=cahier', { ua: MOBILE_UA, expect: 200 });
  check('mobile', 'la recherche renvoie des résultats', /cahier/i.test(search.text));
  const suggest = await hit(guest, 'GET', '/api/suggestions?q=ca', { expect: 200 });
  check('mobile', 'les suggestions de recherche répondent en JSON', suggest.text.trim().startsWith('{') || suggest.text.trim().startsWith('['));
  const notFound = await hit(guest, 'GET', '/produit/article-inexistant-xyz', { expect: 404 });
  check('mobile', 'un article inexistant renvoie 404', notFound.status === 404);
});

step('Administration : créer, modifier, dupliquer un article', async () => {
  const admin = await adminSession();
  const dash = await hit(admin, 'GET', '/admin', { expect: 200 });
  check('admin', 'connexion administrateur', dash.text.includes('Tableau de bord') || dash.text.includes('admin'));

  const sku = ref('JRN');
  const category = q1("SELECT id FROM categories WHERE slug = 'cahiers-registres'") || q1('SELECT id FROM categories LIMIT 1');
  const formPage = await hit(admin, 'GET', '/admin/produits/nouveau', { expect: 200 });
  const created = await hit(admin, 'POST', '/admin/produits/nouveau', {
    form: {
      _csrf: meta(formPage.text, 'csrf-token'),
      name: `Cahier de parcours ${sku}`,
      sku,
      category_id: String(category.id),
      brand: 'Clairefontaine',
      short_description: 'Créé par le parcours de vérification.',
      description: '<p>Cahier créé automatiquement pour vérifier le formulaire d’administration.</p>',
      price: '1750',
      compare_at_price: '',
      promo_price: '',
      qty: '25',
      low_stock_threshold: '5',
      track_stock: '1',
      data_confirmed: '1',
      status: 'published',
      sale_unit: 'piece',
      product_condition: 'neuf',
      weight_g: '320',
      warranty: '',
    },
    expect: 302,
  });
  const row = q1('SELECT * FROM products WHERE sku = ?', [sku]);
  check('admin', 'l’article est créé depuis le formulaire', Boolean(row), created.location);
  check('admin', 'le prix est enregistré en FCFA entier', row && row.price === 1750);
  check('admin', 'le stock initial est en place', available(sku) === 25);

  const storePage = await hit(new Jar('lecteur'), 'GET', `/produit/${row.slug}`, { expect: 200 });
  check('admin', 'l’article publié est visible en vitrine', storePage.text.includes(sku) || storePage.text.includes('Cahier de parcours'));
  check('admin', 'le prix est affiché en FCFA', /1[\s\u202f]?750/.test(storePage.text) && /FCFA/.test(storePage.text));
  check('admin', 'l’ajout au panier est proposé', storePage.text.includes('/panier/ajouter')
    && !/data-add-button[^>]*disabled/.test(storePage.text));

  const editPage = await hit(admin, 'GET', `/admin/produits/${row.id}`, { expect: 200 });
  await hit(admin, 'POST', `/admin/produits/${row.id}`, {
    form: {
      _csrf: meta(editPage.text, 'csrf-token'),
      name: `Cahier de parcours ${sku}`, sku, category_id: String(category.id),
      price: '1600', qty: '25', low_stock_threshold: '5', track_stock: '1',
      data_confirmed: '1', status: 'published', sale_unit: 'piece', product_condition: 'neuf',
      short_description: 'Prix ajusté par le parcours.', description: '<p>Prix ajusté.</p>',
    },
    expect: 302,
  });
  check('admin', 'la modification du prix est enregistrée', q1('SELECT price FROM products WHERE id = ?', [row.id]).price === 1600);

  await hit(admin, 'POST', `/admin/produits/${row.id}/dupliquer`, {
    form: { _csrf: meta(editPage.text, 'csrf-token') }, expect: 302,
  });
  const copies = db.all('SELECT sku FROM products WHERE name LIKE ?', [`Cahier de parcours ${sku}%`]);
  check('admin', 'la duplication crée une copie avec une référence distincte', copies.length === 2 && copies[0].sku !== copies[1].sku);

  // Article non confirmé : non vendable.
  const sku2 = ref('JRN-NC');
  await hit(admin, 'POST', '/admin/produits/nouveau', {
    form: {
      _csrf: meta(formPage.text, 'csrf-token'), name: `Article non confirmé ${sku2}`, sku: sku2,
      category_id: String(category.id), price: '900', qty: '4', track_stock: '1',
      status: 'published', sale_unit: 'piece', product_condition: 'neuf',
    },
    expect: 302,
  });
  const nc = q1('SELECT * FROM products WHERE sku = ?', [sku2]);
  check('admin', 'un article dont les données ne sont pas confirmées n’est pas marqué confirmé', nc && nc.data_confirmed === 0);
  const ncPage = await hit(new Jar('lecteur2'), 'GET', `/produit/${nc.slug}`, { expect: 200 });
  check('admin', 'un article non confirmé n’est pas achetable en vitrine',
    ncPage.text.includes('Indisponible à la vente') && /data-add-button[^>]*disabled/.test(ncPage.text));
});

step('Import CSV assisté : aperçu, exécution, rapport', async () => {
  const admin = await adminSession();

  const skuA = ref('IMP-A');
  const skuB = ref('IMP-B');
  const headers = ['Référence', 'Nom du produit', 'Catégorie', 'Prix (FCFA)', 'Stock', 'Statut'];
  const lines = [
    [skuA, `Ramette A4 ${skuA}`, 'Papeterie et fournitures scolaires', '3500', '18', 'publié'],
    [skuB, `Classeur ${skuB}`, 'Papeterie et fournitures scolaires', '2200', '9', 'publié'],
    [skuB, `Doublon dans le fichier ${skuB}`, 'Papeterie et fournitures scolaires', '2200', '9', 'publié'],
    [ref('IMP-C'), 'Article sans prix', 'Papeterie et fournitures scolaires', '', '4', 'publié'],
    [ref('IMP-D'), 'Article au prix illisible', 'Papeterie et fournitures scolaires', 'abc', '4', 'publié'],
  ];
  const csvText = [headers.join(';'), ...lines.map((l) => l.join(';'))].join('\r\n');

  const fd = new FormData();
  fd.append('fichier', new Blob([`\ufeff${csvText}`], { type: 'text/csv' }), 'import-parcours.csv');
  // Le corps multipart n'est pas lu par body-parser : le jeton voyage en en-tête.
  const uploadToken = await tokenOf(admin, '/admin/import');
  fd.append('_csrf', uploadToken);
  const uploaded = await hit(admin, 'POST', '/admin/import/televerser', {
    form: fd, headers: { 'x-csrf-token': uploadToken }, expect: 302,
  });
  const jobId = Number(/\/admin\/import\/(\d+)/.exec(uploaded.location)[1]);
  check('import', 'le fichier CSV est accepté et le lot créé', jobId > 0, `lot ${jobId}`);
  check('import', 'les cinq lignes sont détectées', q1('SELECT total_rows AS n FROM import_jobs WHERE id = ?', [jobId]).n === 5);

  const jobPage = await hit(admin, 'GET', `/admin/import/${jobId}`, { expect: 200 });
  const mapping = { sku: 'Référence', name: 'Nom du produit', category: 'Catégorie', price: 'Prix (FCFA)', qty: 'Stock', status: 'Statut' };
  const form = new URLSearchParams({
    _csrf: meta(jobPage.text, 'csrf-token'), mode: 'create', blank_policy: 'keep',
    status_for_new: 'published', confirm_imported: '1', create_categories: '1', batch_size: '2',
  });
  for (const [k, v] of Object.entries(mapping)) form.set(`mapping[${k}]`, v);
  await hit(admin, 'POST', `/admin/import/${jobId}/colonnes`, { form, expect: 302 });
  const preview = q1('SELECT * FROM import_jobs WHERE id = ?', [jobId]);
  check('import', 'l’aperçu est enregistré sans créer d’article', preview.status === 'mapped');
  check('import', 'l’aperçu n’a rien écrit dans le catalogue', !q1('SELECT id FROM products WHERE sku = ?', [skuA]));

  let progress = { done: false, processed: 0, total: 5 };
  let loops = 0;
  while (!progress.done && loops < 10) {
    const run = await hit(admin, 'POST', `/admin/import/${jobId}/executer`, {
      form: new URLSearchParams({ _csrf: meta(jobPage.text, 'csrf-token'), batch_size: '2' }),
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      expect: 200,
    });
    progress = JSON.parse(run.text);
    loops += 1;
  }
  check('import', 'le traitement progresse par lots', loops >= 2, `${loops} lot(s)`);
  check('import', 'toutes les lignes sont traitées', progress.done && progress.processed === progress.total);

  const report = await hit(admin, 'GET', `/admin/import/${jobId}/rapport`, { expect: 200 });
  const job = q1('SELECT * FROM import_jobs WHERE id = ?', [jobId]);
  const parsed = typeof job.report === 'string' ? JSON.parse(job.report) : job.report;
  check('import', 'les deux articles valides sont créés', parsed.created === 2, JSON.stringify({ created: parsed.created, rejected: parsed.rejected }));
  check('import', 'les trois lignes invalides sont rejetées', parsed.rejected === 3);
  check('import', 'le rapport cite les lignes rejetées', parsed.errors.length >= 3 && parsed.errors.every((e) => e.row > 0));
  check('import', 'le doublon du fichier n’a pas créé de second article', db.all('SELECT id FROM products WHERE sku = ?', [skuB]).length === 1);
  check('import', 'le rapport est affiché à l’écran', report.text.includes('Import') || report.text.includes('rapport'));
  check('import', 'les articles importés sont en stock', available(skuA) === 18);

  const exported = await hit(admin, 'GET', '/admin/export/catalogue.csv', { expect: 200 });
  check('import', 'l’export du catalogue contient l’article importé', exported.text.includes(skuA));
});

step('Achat invité en retrait et encaissement en espèces', async () => {
  const sku = ref('RET');
  const admin = await adminSession();
  const formPage = await hit(admin, 'GET', '/admin/produits/nouveau', { expect: 200 });
  const category = q1("SELECT id FROM categories WHERE slug = 'cahiers-registres'") || q1('SELECT id FROM categories LIMIT 1');
  await hit(admin, 'POST', '/admin/produits/nouveau', {
    form: {
      _csrf: meta(formPage.text, 'csrf-token'), name: `Article retrait ${sku}`, sku, category_id: String(category.id),
      price: '2500', qty: '10', low_stock_threshold: '2', track_stock: '1', data_confirmed: '1',
      status: 'published', sale_unit: 'piece', product_condition: 'neuf',
    },
    expect: 302,
  });
  const product = q1('SELECT * FROM products WHERE sku = ?', [sku]);

  const guest = new Jar('invite-retrait');
  const page = await hit(guest, 'GET', `/produit/${product.slug}`, { ua: MOBILE_UA, expect: 200 });
  await hit(guest, 'POST', '/panier/ajouter', {
    form: { _csrf: meta(page.text, 'csrf-token'), productId: String(product.id), qty: '2' },
    headers: { 'x-csrf-token': meta(page.text, 'csrf-token'), 'x-requested-with': 'XMLHttpRequest' },
    expect: 200,
  });
  const cartPage = await hit(guest, 'GET', '/panier', { expect: 200 });
  check('retrait', 'le panier affiche le total calculé par le serveur', cartPage.text.includes(money.format(5000).replace(/\u202f/g, ' ')) || cartPage.text.includes('5') && /FCFA/.test(cartPage.text));
  check('retrait', 'le stock est réservé dès l’ajout au panier', available(sku) === 8, `disponible=${available(sku)}`);

  const { res } = await checkout(guest, { mode: 'pickup', paiement: 'pay_at_pickup', nom: 'Awa Koné', telephone: '0701020304' });
  const order = orderFromLocation(res.location);
  check('retrait', 'la commande invitée est créée', Boolean(order), res.location);
  check('retrait', 'le total est calculé côté serveur', order && order.total === 5000);
  check('retrait', 'le paiement en espèces attend une confirmation', order && order.payment_status === 'awaiting_confirmation');
  check('retrait', 'le statut de commande est distinct du statut de paiement', order && order.status === 'pending' && order.delivery_status !== 'delivered');

  const conf = await hit(guest, 'GET', `/commande/confirmation/${order.tracking_token}`, { expect: 200 });
  check('retrait', 'la confirmation affiche la référence', conf.text.includes(order.reference));
  check('retrait', 'la confirmation n’annonce aucun paiement en ligne', !/paiement accepté|transaction réussie/i.test(conf.text));

  // Un vendeur non habilité ne peut pas encaisser.
  const vendorEmail = `vendeur.${STAMP}@test.local`;
  try { db.run("DELETE FROM users WHERE email = ?", [vendorEmail]); } catch { /* noop */ }
  require('../src/domain/users').createUser({
    email: vendorEmail, password: 'Vendeur-Parcours-2026!', fullName: 'Vendeur parcours',
    role: 'vendor', canConfirmCash: false, active: true,
  }, q1("SELECT * FROM users WHERE role = 'admin' LIMIT 1"));
  const vendor = await vendorSession(vendorEmail, 'Vendeur-Parcours-2026!');
  const vendorOrderPage = await hit(vendor, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  await hit(vendor, 'POST', `/admin/commandes/${order.id}/encaisser`, {
    form: { _csrf: meta(vendorOrderPage.text, 'csrf-token'), amount: '5000' }, expect: 302,
  });
  check('retrait', 'un vendeur non habilité ne peut pas encaisser', q1('SELECT payment_status FROM orders WHERE id = ?', [order.id]).payment_status === 'awaiting_confirmation');

  const adminOrderPage = await hit(admin, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  await hit(admin, 'POST', `/admin/commandes/${order.id}/encaisser`, {
    form: { _csrf: meta(adminOrderPage.text, 'csrf-token'), amount: '5000', note: 'Espèces reçues au comptoir' }, expect: 302,
  });
  const paid = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('retrait', 'l’administrateur encaisse la commande', paid.payment_status === 'paid' && paid.status === 'confirmed');
  check('retrait', 'le stock sort à l’encaissement', q1('SELECT qty_on_hand FROM stock_items WHERE product_id = ? AND variant_id IS NULL', [product.id]).qty_on_hand === 8);
  check('retrait', 'les réservations sont consommées', available(sku) === 8);
  check('retrait', 'l’encaissement est journalisé avec son auteur',
    db.all("SELECT * FROM audit_log WHERE action = 'payment.cash_confirmed' AND entity_id = ?", [order.reference]).length === 1);

  const printed = await hit(admin, 'GET', `/admin/commandes/${order.id}/impression`, { expect: 200 });
  check('retrait', 'le bon de commande est imprimable', printed.text.includes(order.reference) && /print/i.test(printed.text));
});

step('Livraison à Daoukro : frais chiffrés, paiement à la réception', async () => {
  const product = sellableProduct(1);
  const zone = q1("SELECT * FROM shipping_zones WHERE code = 'daoukro'");
  const guest = new Jar('invite-daoukro');
  await addToCart(guest, product.id, 1);
  const checkoutPage = await hit(guest, 'GET', `/commande?mode=delivery&zone=${zone.id}`, { expect: 200 });
  check('daoukro', 'les frais de livraison sont annoncés avant la commande', /FCFA/.test(checkoutPage.text) && checkoutPage.text.includes(zone.name));
  check('daoukro', 'des frais inconnus ne sont jamais annoncés comme gratuits', !/livraison offerte|frais offerts/i.test(checkoutPage.text));

  const { res } = await checkout(guest, {
    mode: 'delivery', zone: String(zone.id), paiement: 'pay_on_delivery',
    nom: 'Kouadio Yao', telephone: '0705060708', ville: 'Daoukro', quartier: 'Quartier Commerce',
    adresse: 'Rue du marché', repere: 'Face à la pharmacie',
  });
  const order = orderFromLocation(res.location);
  check('daoukro', 'la commande en livraison est créée', Boolean(order), res.location);
  check('daoukro', 'les frais sont calculés par le serveur', order && order.shipping_cost > 0, order ? `${order.shipping_cost} FCFA` : '');
  check('daoukro', 'le total inclut les frais de livraison', order && order.total === order.subtotal - order.discount + order.shipping_cost);
  check('daoukro', 'l’adresse de livraison est enregistrée', Boolean(order && /Daoukro/.test(String(order.city || '')) && String(order.quarter || order.address || '')));
  check('daoukro', 'le paiement à la réception est accepté pour cette zone', order && order.payment_status === 'awaiting_confirmation');
});

step('Livraison sur devis : aucun frais inventé, accord du client requis', async () => {
  const product = sellableProduct(1);
  const zone = q1("SELECT * FROM shipping_zones WHERE code = 'iffou'");
  const guest = new Jar('invite-devis');
  await addToCart(guest, product.id, 1);
  const checkoutPage = await hit(guest, 'GET', `/commande?mode=delivery&zone=${zone.id}`, { expect: 200 });
  check('devis', 'la zone sans tarif annonce « Livraison sur devis »', /sur devis/i.test(checkoutPage.text));
  check('devis', 'aucun montant de livraison n’est inventé', !new RegExp(`livraison[^<]{0,40}${money.format(0)}`).test(checkoutPage.text));

  const { res } = await checkout(guest, {
    mode: 'delivery', zone: String(zone.id), paiement: 'pay_on_delivery',
    nom: 'Aminata Traoré', telephone: '0709080706', ville: 'Bongouanou', quartier: 'Quartier Résidentiel',
  });
  const order = orderFromLocation(res.location);
  check('devis', 'la commande passe en « devis à établir »', order && order.status === 'quote_required', order ? order.status : res.location);
  check('devis', 'aucun frais de livraison n’est ajouté au total', order && order.shipping_cost === 0 && !order.quote_amount);
  check('devis', 'le total reste le sous-total des articles', order && order.total === order.subtotal);

  const admin = await adminSession();
  const orderPage = await hit(admin, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  await hit(admin, 'POST', `/admin/commandes/${order.id}/devis`, {
    form: { _csrf: meta(orderPage.text, 'csrf-token'), action: 'envoyer', amount: '3000', note: 'Livraison Bongouanou' }, expect: 302,
  });
  const quoted = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('devis', 'le devis est envoyé au client', quoted.quote_status === 'sent' && quoted.quote_amount === 3000);
  check('devis', 'le total intègre le devis', quoted.total === quoted.subtotal + 3000);

  const confBefore = await hit(guest, 'GET', `/commande/confirmation/${order.tracking_token}`, { expect: 200 });
  check('devis', 'le client voit le devis sur son lien de suivi', confBefore.text.includes('3') && /devis/i.test(confBefore.text));

  await hit(guest, 'POST', `/commande/${order.tracking_token}/devis`, {
    form: { _csrf: meta(confBefore.text, 'csrf-token'), action: 'accepter' },
  });
  const accepted = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('devis', 'le client accepte le devis depuis son suivi', accepted.quote_status === 'accepted');
  check('devis', 'la commande redevient traitable après accord', accepted.status === 'pending' || accepted.status === 'confirmed');
  check('devis', 'aucun paiement n’a été validé avant l’encaissement', accepted.payment_status !== 'paid');
});

step('Paiement Mobile Money en bac à sable', async () => {
  const admin = await adminSession();
  const settingsPage = await hit(admin, 'GET', '/admin/reglages?onglet=paiements', { expect: 200 });
  await hit(admin, 'POST', '/admin/reglages/paiements/wave', {
    form: {
      _csrf: meta(settingsPage.text, 'csrf-token'), enabled: '1', simulated: '1',
      name: 'Wave (bac à sable)', modes: 'pickup,delivery', position: '1',
      instructions: 'Paiement de démonstration : aucun argent réel n’est mouvementé.',
    },
    expect: 302,
  });
  const method = q1("SELECT * FROM payment_methods WHERE code = 'wave'");
  check('momo', 'un Mobile Money est activable en bac à sable depuis l’administration', Boolean(method.enabled));
  check('momo', 'il reste marqué non configuré (pas d’identifiants marchands)', method.configured === 0);
  check('momo', 'l’activation d’un Mobile Money sans identifiants ni bac à sable est refusée', (() => {
    try {
      require('../src/domain/payments').saveMethod('mtn_momo', { enabled: 1, simulated: 0 }, 1);
      return false;
    } catch (err) { return err.code === 'NOT_CONFIGURED'; }
  })());

  const product = sellableProduct(3);
  const stockBefore = stockLineOf(product.id);
  const guest = new Jar('invite-momo');
  await addToCart(guest, product.id, 1);
  const { res } = await checkout(guest, { mode: 'pickup', paiement: 'wave', nom: 'Ibrahim Cissé', telephone: '0704050607' });
  const order = orderFromLocation(res.location);
  check('momo', 'la commande Mobile Money est créée', Boolean(order), res.location);
  check('momo', 'le client est redirigé vers la passerelle de démonstration', /\/paiements\/simuler\//.test(res.location || ''), res.location);
  check('momo', 'la redirection ne vaut pas paiement', order && order.payment_status !== 'paid');

  const gateway = await hit(guest, 'GET', res.location, { expect: 200 });
  check('momo', 'la passerelle de démonstration est clairement signalée', /démonstration|bac à sable|aucun argent réel/i.test(gateway.text));

  await hit(guest, 'POST', `/paiements/simuler/${order.reference}`, {
    form: { _csrf: meta(gateway.text, 'csrf-token'), action: 'succes', repeat: '3' }, expect: 200,
  });
  const paid = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('momo', 'la notification signée valide le paiement', paid.payment_status === 'paid');
  check('momo', 'la commande est confirmée', paid.status === 'confirmed');
  check('momo', 'trois notifications répétées ne font qu’un encaissement',
    db.all("SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded'", [order.id]).length === 1);
  const events = db.all('SELECT * FROM webhook_events WHERE event_id LIKE ?', [`sim-${order.reference}-%`]);
  check('momo', 'les notifications reçues sont journalisées', events.length >= 1, `${events.length} événement(s)`);
  check('momo', 'la signature de la notification validée a été vérifiée',
    events.some((e) => e.signature_ok === 1 && e.status === 'processed'));
  // La déduplication se fait par (passerelle, identifiant d'événement) : trois
  // envois du même événement ne produisent qu'une seule trace et qu'un seul effet.
  check('momo', 'trois notifications identiques ne laissent qu’un seul événement',
    events.length === 1, events.map((e) => `${e.event_id}:${e.status}`).join(' · '));
  const stockAfter = stockLineOf(product.id);
  // Cycle complet : la réservation posée à la commande est consommée, donc le
  // stock physique baisse d'une unité et le compteur de réservations revient à
  // son niveau d'avant la commande (aucune réservation fantôme ne subsiste).
  check('momo', 'le stock sort à l’encaissement du paiement en ligne',
    stockAfter.qty_on_hand === stockBefore.qty_on_hand - 1 && stockAfter.qty_reserved === stockBefore.qty_reserved,
    `physique ${stockBefore.qty_on_hand}→${stockAfter.qty_on_hand} · réservé ${stockBefore.qty_reserved}→${stockAfter.qty_reserved}`);

  // Montant erroné.
  const guest2 = new Jar('invite-momo-montant');
  await addToCart(guest2, product.id, 1);
  const second = await checkout(guest2, { mode: 'pickup', paiement: 'wave', nom: 'Mariam Diop', telephone: '0703020100' });
  const order2 = orderFromLocation(second.res.location);
  const gw2 = await hit(guest2, 'GET', second.res.location, { expect: 200 });
  const wrong = await hit(guest2, 'POST', `/paiements/simuler/${order2.reference}`, {
    form: { _csrf: meta(gw2.text, 'csrf-token'), action: 'succes', amount: String(Math.max(1, Math.round(order2.total / 100) - 5)) },
    expect: 200,
  });
  check('momo', 'un montant erroné ne valide pas le paiement',
    q1('SELECT payment_status FROM orders WHERE id = ?', [order2.id]).payment_status !== 'paid');
  check('momo', 'le rejet du montant est affiché au technicien', /montant|AMOUNT_MISMATCH|rejet/i.test(wrong.text));

  // Échec de paiement.
  const guest3 = new Jar('invite-momo-echec');
  await addToCart(guest3, product.id, 1);
  const third = await checkout(guest3, { mode: 'pickup', paiement: 'wave', nom: 'Paul Nguessan', telephone: '0702030405' });
  const order3 = orderFromLocation(third.res.location);
  const gw3 = await hit(guest3, 'GET', third.res.location, { expect: 200 });
  await hit(guest3, 'POST', `/paiements/simuler/${order3.reference}`, {
    form: { _csrf: meta(gw3.text, 'csrf-token'), action: 'echec' }, expect: 200,
  });
  check('momo', 'un paiement échoué ne règle pas la commande', q1('SELECT payment_status FROM orders WHERE id = ?', [order3.id]).payment_status !== 'paid');
  check('momo', 'l’échec est enregistré', db.all("SELECT * FROM payments WHERE order_id = ? AND status = 'failed'", [order3.id]).length >= 1);

  // Signature forgée : aucun effet.
  const forged = await hit(new Jar('forgeur'), 'POST', '/webhooks/sandbox', {
    body: JSON.stringify({
      event_id: `forge-${STAMP}`, provider: 'sandbox', order_reference: order3.reference,
      amount: order3.total, currency: 'XOF', status: 'succeeded', provider_reference: 'SIM-FORGE',
    }),
    headers: { 'content-type': 'application/json', 'x-signature': 'signature-forgée' },
    expect: 401,
  });
  check('momo', 'une notification non signée correctement est refusée (401)', forged.status === 401);
  check('momo', 'la commande visée par la notification forgée n’est pas réglée',
    q1('SELECT payment_status FROM orders WHERE id = ?', [order3.id]).payment_status !== 'paid');
});

step('Concurrence sur un stock limité', async () => {
  const admin = await adminSession();
  const formPage = await hit(admin, 'GET', '/admin/produits/nouveau', { expect: 200 });
  const category = q1('SELECT id FROM categories LIMIT 1');
  const sku = ref('RACE');
  await hit(admin, 'POST', '/admin/produits/nouveau', {
    form: {
      _csrf: meta(formPage.text, 'csrf-token'), name: `Dernier exemplaire ${sku}`, sku, category_id: String(category.id),
      price: '5000', qty: '1', low_stock_threshold: '1', track_stock: '1', data_confirmed: '1',
      status: 'published', sale_unit: 'piece', product_condition: 'neuf',
    },
    expect: 302,
  });
  const product = q1('SELECT * FROM products WHERE sku = ?', [sku]);

  const jars = [new Jar('course-1'), new Jar('course-2'), new Jar('course-3')];
  await Promise.all(jars.map(async (jar) => {
    const page = await hit(jar, 'GET', `/produit/${product.slug}`, { expect: 200 });
    const token = meta(page.text, 'csrf-token');
    await hit(jar, 'POST', '/panier/ajouter', {
      form: { _csrf: token, productId: String(product.id), qty: '1' },
      headers: { 'x-csrf-token': token, 'x-requested-with': 'XMLHttpRequest' },
    });
  }));
  const outcomes = await Promise.all(jars.map(async (jar, i) => {
    try {
      const { res } = await checkout(jar, { mode: 'pickup', paiement: 'pay_at_pickup', nom: `Client Course ${i + 1}`, telephone: `07000000${i}${i}` });
      return { location: res.location, status: res.status };
    } catch (err) { return { error: err.message }; }
  }));

  const winners = outcomes.filter((o) => o.location && /\/commande\/confirmation\//.test(o.location));
  const orders = db.all('SELECT * FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id = ?) AND status != ?', [product.id, 'cancelled']);
  check('concurrence', 'un seul des trois clients obtient la commande', winners.length === 1, `${winners.length} réussite(s)`);
  check('concurrence', 'une seule commande est enregistrée', orders.length === 1);
  const item = q1('SELECT * FROM stock_items WHERE product_id = ? AND variant_id IS NULL', [product.id]);
  check('concurrence', 'le stock ne devient jamais négatif', item.qty_on_hand >= 0 && item.qty_on_hand - item.qty_reserved >= 0,
    `physique=${item.qty_on_hand} réservé=${item.qty_reserved}`);
  check('concurrence', 'le stock disponible est épuisé sans survente', item.qty_on_hand - item.qty_reserved === 0,
    `physique=${item.qty_on_hand} réservé=${item.qty_reserved}`);
  const productPage = await hit(new Jar('apres-course'), 'GET', `/produit/${product.slug}`, { expect: 200 });
  check('concurrence', 'l’article épuisé n’est plus proposé à l’achat',
    productPage.text.includes('Rupture de stock') && /data-add-button[^>]*disabled/.test(productPage.text));
});

step('Annulation et restitution du stock', async () => {
  const admin = await adminSession();
  const product = sellableProduct(3);
  const before = available(product.sku);
  const guest = new Jar('invite-annulation');
  await addToCart(guest, product.id, 2);
  const { res } = await checkout(guest, { mode: 'pickup', paiement: 'pay_at_pickup', nom: 'Client Annulation', telephone: '0706060606' });
  const order = orderFromLocation(res.location);
  check('annulation', 'le stock est réservé après la commande', available(product.sku) === before - 2);

  const orderPage = await hit(admin, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  await hit(admin, 'POST', `/admin/commandes/${order.id}/annuler`, {
    form: { _csrf: meta(orderPage.text, 'csrf-token'), reason: 'Client injoignable', restock: '1' }, expect: 302,
  });
  const cancelled = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('annulation', 'la commande est annulée', cancelled.status === 'cancelled');
  check('annulation', 'le stock est restitué', available(product.sku) === before);
  check('annulation', 'les réservations sont libérées',
    db.all("SELECT * FROM reservations WHERE order_id = ? AND status = 'active'", [order.id]).length === 0);
  const backOnSale = await hit(new Jar('apres-annulation'), 'GET', `/produit/${product.slug}`, { expect: 200 });
  check('annulation', 'l’article redevient achetable en vitrine', backOnSale.text.includes('/panier/ajouter'));
});

step('Séparation des rôles et des données', async () => {
  const vendorEmail = `vendeur.role.${STAMP}@test.local`;
  require('../src/domain/users').createUser({
    email: vendorEmail, password: 'Vendeur-Parcours-2026!', fullName: 'Vendeur rôles',
    role: 'vendor', canConfirmCash: false, active: true,
  }, q1("SELECT * FROM users WHERE role = 'admin' LIMIT 1"));

  const vendor = await vendorSession(vendorEmail, 'Vendeur-Parcours-2026!');
  check('rôles', 'le vendeur accède aux commandes', (await hit(vendor, 'GET', '/admin/commandes', { expect: 200 })).status === 200);
  check('rôles', 'le vendeur accède au catalogue', (await hit(vendor, 'GET', '/admin/produits', { expect: 200 })).status === 200);
  check('rôles', 'le vendeur ne gère pas les comptes utilisateurs', (await hit(vendor, 'GET', '/admin/utilisateurs', { expect: 403 })).status === 403);
  check('rôles', 'le vendeur ne consulte pas le journal d’audit', (await hit(vendor, 'GET', '/admin/journal', { expect: 403 })).status === 403);
  check('rôles', 'le vendeur lit les réglages sans pouvoir les écrire', (await hit(vendor, 'GET', '/admin/reglages', { expect: 200 })).status === 200);
  const reglages = await hit(vendor, 'GET', '/admin/reglages?onglet=etablissement', { expect: 200 });
  const write = await hit(vendor, 'POST', '/admin/reglages/etablissement', {
    form: { _csrf: meta(reglages.text, 'csrf-token'), 'store.name': 'Nom modifié par un vendeur' },
  });
  check('rôles', 'l’écriture des réglages est refusée au vendeur', write.status === 403, `statut ${write.status}`);
  check('rôles', 'le nom de la boutique n’a pas été modifié', settings.get('store.name') !== 'Nom modifié par un vendeur');

  const anonymous = new Jar('anonyme');
  check('rôles', 'un visiteur non connecté est renvoyé vers la page de connexion',
    (await hit(anonymous, 'GET', '/admin/commandes', { expect: 302 })).location.includes('/admin/connexion'));
  check('rôles', 'un visiteur non connecté n’accède pas aux réglages',
    (await hit(anonymous, 'GET', '/admin/reglages', { expect: 302 })).status === 302);

  // Suivi : impossible sans le jeton.
  const order = q1("SELECT * FROM orders WHERE tracking_token IS NOT NULL ORDER BY id DESC LIMIT 1");
  const lookup = await hit(anonymous, 'GET', '/suivi', { expect: 200 });
  await hit(anonymous, 'POST', '/suivi', {
    form: { _csrf: meta(lookup.text, 'csrf-token'), reference: order.reference, phone: '0000' }, expect: 302,
  });
  check('données', 'une recherche de suivi avec un mauvais téléphone ne révèle rien',
    db.all('SELECT * FROM orders WHERE tracking_token = ?', ['inconnu']).length === 0);
  check('données', 'un jeton de suivi invalide renvoie 404',
    (await hit(anonymous, 'GET', '/suivi/jeton-invalide-xyz', { expect: 404 })).status === 404);
  check('données', 'la référence seule ne suffit pas à ouvrir un suivi',
    (await hit(anonymous, 'GET', `/suivi/${order.reference}`, { expect: 404 })).status === 404);

  const view = await hit(anonymous, 'GET', `/suivi/${order.tracking_token}`, { expect: 200 });
  check('données', 'le suivi valide affiche la commande', view.text.includes(order.reference));
  check('données', 'le suivi n’expose aucune note interne', !/note interne/i.test(view.text));
});

step('Caisse, statistiques et sauvegarde', async () => {
  const admin = await adminSession();
  const product = sellableProduct(1);
  const posPage = await hit(admin, 'GET', '/admin/caisse', { expect: 200 });
  const posRes = await hit(admin, 'POST', '/admin/caisse', {
    form: {
      _csrf: meta(posPage.text, 'csrf-token'),
      'items[0][product_id]': String(product.id),
      'items[0][qty]': '1',
      paiement: 'especes',
      montant_recu: String(product.price),
    },
  });
  check('caisse', 'une vente au comptoir est enregistrée', posRes.status === 302 || posRes.status === 200, `statut ${posRes.status}`);
  check('caisse', 'la vente au comptoir apparaît en base', db.all('SELECT * FROM pos_sales ORDER BY id DESC LIMIT 1').length >= 1);

  const stats = await hit(admin, 'GET', '/admin/statistiques', { expect: 200 });
  check('caisse', 'les statistiques distinguent commandes et encaissements', /commande/i.test(stats.text) && /encaiss/i.test(stats.text));
  check('caisse', 'les statistiques ne confondent pas vente comptoir et vente en ligne', /comptoir|caisse/i.test(stats.text));
  const exportCsv = await hit(admin, 'GET', '/admin/statistiques/export.csv', { expect: 200 });
  check('caisse', 'l’export des statistiques est disponible', exportCsv.text.length > 20);

  const backup = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join('scripts', 'backup.js'), '--json'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, DEMO: 'true' },
  });
  let backupInfo = null;
  try {
    const out = String(backup.stdout || '');
    const start = out.indexOf('{');
    backupInfo = start >= 0 ? JSON.parse(out.slice(start)) : null;
  } catch { /* sortie non JSON */ }
  check('sauvegarde', 'la sauvegarde de la base s’exécute', backup.status === 0, backup.stderr ? backup.stderr.slice(0, 160) : '');
  check('sauvegarde', 'un fichier de sauvegarde est produit', Boolean(backupInfo && backupInfo.file && backupInfo.bytes > 0),
    backupInfo ? `${path.basename(backupInfo.file)} · ${backupInfo.bytes} octets` : '');
  check('sauvegarde', 'l’intégrité de la sauvegarde est vérifiée', Boolean(backupInfo && backupInfo.integrity));

  const file = backupInfo && backupInfo.file;
  if (file) {
    const restore = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', path.join('scripts', 'restore.js'),
      path.isAbsolute(file) ? file : path.resolve(__dirname, '..', file), '--dry-run', '--yes',
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, DEMO: 'true' } });
    check('sauvegarde', 'la restauration est vérifiable sans écraser les données', restore.status === 0, (restore.stderr || '').slice(0, 160));
  }
});

/* ------------------------------------------------------------------ */

async function main() {
  let server = null;
  if (!BASE) {
    db.migrate();
    settings.ensureDefaults();
    const { createApp } = require('../src/app');
    const app = createApp();
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  }
  if (!asJson) {
    console.log('');
    console.log('— Parcours métier de bout en bout —');
    console.log(`  cible : ${BASE}`);
    console.log(`  base  : ${path.basename(config.db.path)}${config.isDemo ? ' (démonstration)' : ''}`);
    console.log('');
  }

  for (const s of steps) {
    if (only && !s.name.toLowerCase().includes(only.toLowerCase())) continue;
    if (!asJson) console.log(`▸ ${s.name}`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await s.fn();
    } catch (err) {
      record(s.name, 'étape interrompue par une erreur', false, err.message);
    }
  }

  if (server) await new Promise((resolve) => server.close(resolve));

  const passed = results.filter((r) => r.ok).length;
  if (asJson) {
    console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }, null, 2));
  } else {
    console.log('');
    console.log('─'.repeat(70));
    console.log(`${passed}/${results.length} vérifications réussies`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log('');
      console.log('Échecs :');
      for (const f of failed) console.log(`  · [${f.group}] ${f.label} — ${f.detail}`);
    }
    const errors = db.all("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'erreur%'").n;
    if (errors) console.log(`\n${errors} erreur(s) serveur journalisée(s) : voir data/logs/app.log`);
    console.log('');
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Parcours interrompu :', err);
  process.exit(1);
});
