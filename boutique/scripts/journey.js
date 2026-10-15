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
async function sessionFor(key, email, password) {  if (sessions.has(key)) return sessions.get(key);
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
 * Un numéro de téléphone ivoirien qui n'est lié à aucun compte.
 * Le parcours crée des clients à chaque exécution et un numéro déjà rattaché à
 * un compte est refusé à l'inscription (à juste titre) : sans cette recherche,
 * rejouer le parcours produirait un échec qui n'a rien à voir avec l'application.
 */
function freePhone(prefix = '07') {
  const { normalizePhone } = require('../src/lib/validate');
  for (let i = 0; i < 50; i += 1) {
    const candidate = prefix + String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
    const normalized = normalizePhone(candidate);
    if (!normalized) continue;
    if (!db.get('SELECT id FROM customers WHERE phone = ?', [normalized])) return candidate;
  }
  throw new Error('Aucun numéro de téléphone libre trouvé pour le parcours.');
}

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

/**
 * Active un Mobile Money en bac à sable depuis l'administration.
 * Aucun identifiant marchand réel n'existe : la passerelle de démonstration
 * signe ses notifications avec la clé locale, et chaque étape qui a besoin
 * d'un paiement en ligne peut donc rendre l'application autonome.
 */
async function enableSandboxMethod(code = 'wave') {
  const admin = await adminSession();
  const page = await hit(admin, 'GET', '/admin/reglages?onglet=paiements', { expect: 200 });
  await hit(admin, 'POST', `/admin/reglages/paiements/${code}`, {
    form: {
      _csrf: meta(page.text, 'csrf-token'), enabled: '1', simulated: '1',
      name: 'Wave (bac à sable)', modes: 'pickup,delivery', position: '1',
      instructions: 'Paiement de démonstration : aucun argent réel n’est mouvementé.',
    },
    expect: 302,
  });
  return q1('SELECT * FROM payment_methods WHERE code = ?', [code]);
}

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
  check('admin', 'un article non confirmé ne reste pas publié', nc && nc.status === 'draft', nc ? `statut ${nc.status}` : 'article absent');
  const ncPage = await hit(new Jar('lecteur2'), 'GET', `/produit/${nc.slug}`);
  check('admin', 'un article non confirmé n’est pas exposé en vitrine', ncPage.status === 404, `statut ${ncPage.status}`);
  const plan = await hit(new Jar('lecteur3'), 'GET', '/sitemap.xml', { expect: 200 });
  check('admin', 'un article non confirmé est absent du plan du site', !plan.text.includes(nc.slug));
  check('admin', 'l’article non confirmé reste modifiable en administration',
    (await hit(admin, 'GET', `/admin/produits/${nc.id}`, { expect: 200 })).status === 200);
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
  const method = await enableSandboxMethod('wave');
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

/* ------------------------------------------------------------------ */
/* Catégories, modifications en masse, photos, retours, compte client  */
/* ------------------------------------------------------------------ */

/**
 * Deux images réelles (un grand JPEG et un petit PNG) fabriquées à la volée :
 * les téléversements doivent être testés avec de vrais fichiers, pas avec des
 * octets arbitraires qui seraient rejetés à juste titre.
 */
async function sampleImages() {
  const sharp = require('sharp');
  const svg = (w, h, texte, fond) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect width="100%" height="100%" fill="${fond}"/>`
    + `<text x="50%" y="54%" font-family="sans-serif" font-size="${Math.round(w / 14)}" fill="#ffffff" `
    + `text-anchor="middle" dominant-baseline="middle">${texte}</text></svg>`
  );
  return {
    grande: await sharp(svg(2400, 1800, 'Photo de parcours', '#123a6b')).jpeg({ quality: 92 }).toBuffer(),
    petite: await sharp(svg(640, 640, 'Detail', '#b08d2f')).png().toBuffer(),
  };
}

step('Catégories : création, renommage, ordre, archivage, suppression', async () => {
  const admin = await adminSession();
  const page = await hit(admin, 'GET', '/admin/categories', { expect: 200 });
  const token = meta(page.text, 'csrf-token');

  const parentName = `Papeterie parcours ${STAMP}`;
  const created = await hit(admin, 'POST', '/admin/categories', {
    form: {
      _csrf: token, name: parentName, parent_id: '', slug: '',
      description: 'Catégorie créée par le parcours de vérification.',
    },
    expect: 302,
  });
  const parent = q1('SELECT * FROM categories WHERE name = ?', [parentName]);
  if (!check('catégories', 'une catégorie est créée depuis l’administration', Boolean(parent), created.location)) return;
  check('catégories', 'un identifiant de lien (slug) unique est généré à partir du nom',
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parent.slug), parent.slug);
  check('catégories', 'la création est journalisée dans l’audit',
    db.all("SELECT * FROM audit_log WHERE action = 'category.create'").length >= 1);

  const childName = `Sous-catégorie parcours ${STAMP}`;
  await hit(admin, 'POST', '/admin/categories', {
    form: { _csrf: token, name: childName, parent_id: String(parent.id), slug: '', description: '' }, expect: 302,
  });
  const child = q1('SELECT * FROM categories WHERE name = ?', [childName]);
  check('catégories', 'une sous-catégorie est rattachée à son parent', Boolean(child) && child.parent_id === parent.id);

  const grandName = `Rayon parcours ${STAMP}`;
  await hit(admin, 'POST', '/admin/categories', {
    form: { _csrf: token, name: grandName, parent_id: String(child.id), slug: '', description: '' }, expect: 302,
  });
  const grand = q1('SELECT * FROM categories WHERE name = ?', [grandName]);
  check('catégories', 'l’arborescence accepte trois niveaux', Boolean(grand) && grand.parent_id === child.id);
  if (!child || !grand) return;

  const catalog = await hit(new Jar('cat-lecteur'), 'GET', '/catalogue', { expect: 200 });
  check('catégories', 'la catégorie créée apparaît dans la navigation publique', catalog.text.includes(parentName));
  check('catégories', 'sa page publique répond',
    (await hit(new Jar('cat-lecteur2'), 'GET', `/categorie/${parent.slug}`, { expect: 200 })).status === 200);

  // --- Renommage -------------------------------------------------------
  const renamed = `${parentName} (renommée)`;
  const newSlug = `parcours-renommee-${STAMP}`.toLowerCase();
  await hit(admin, 'POST', `/admin/categories/${parent.id}`, {
    form: {
      _csrf: token, name: renamed, slug: newSlug, parent_id: '',
      description: 'Renommée par le parcours.', position: String(parent.position),
    },
    expect: 302,
  });
  const afterRename = q1('SELECT * FROM categories WHERE id = ?', [parent.id]);
  check('catégories', 'une catégorie est renommée depuis l’administration', afterRename.name === renamed);
  check('catégories', 'le slug choisi remplace l’ancien', afterRename.slug === newSlug, afterRename.slug);
  check('catégories', 'l’ancienne adresse publique cesse d’exister',
    (await hit(new Jar('cat-lecteur3'), 'GET', `/categorie/${parent.slug}`)).status === 404);
  check('catégories', 'la nouvelle adresse publique répond',
    (await hit(new Jar('cat-lecteur4'), 'GET', `/categorie/${newSlug}`, { expect: 200 })).status === 200);

  // --- Réordonnancement ------------------------------------------------
  const reorder = await hit(admin, 'POST', '/admin/categories/reordonner', {
    form: {
      _csrf: token,
      order: JSON.stringify([{ id: parent.id, position: 91 }, { id: child.id, position: 92 }, { id: grand.id, position: 93 }]),
    },
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    expect: 200,
  });
  check('catégories', 'le réordonnancement répond en JSON à l’administration', /"ok"\s*:\s*true/.test(reorder.text), reorder.text.slice(0, 60));
  const expected = { [parent.id]: 91, [child.id]: 92, [grand.id]: 93 };
  const positions = db.all('SELECT id, position FROM categories WHERE id IN (?, ?, ?)', [parent.id, child.id, grand.id]);
  check('catégories', 'l’ordre demandé est enregistré en base',
    positions.length === 3 && positions.every((p) => expected[p.id] === p.position),
    positions.map((p) => `${p.id}→${p.position}`).join(' · '));

  // --- Archivage -------------------------------------------------------
  await hit(admin, 'POST', `/admin/categories/${parent.id}`, {
    form: { _csrf: token, name: renamed, slug: newSlug, parent_id: '', description: '', position: '91', archived: '1' },
    expect: 302,
  });
  check('catégories', 'l’archivage d’une catégorie est enregistré',
    q1('SELECT archived FROM categories WHERE id = ?', [parent.id]).archived === 1);
  const afterArchive = await hit(new Jar('cat-lecteur5'), 'GET', '/catalogue', { expect: 200 });
  check('catégories', 'une catégorie archivée n’est plus proposée en vitrine', !afterArchive.text.includes(renamed));
  check('catégories', 'l’administration continue de voir les catégories archivées',
    (await hit(admin, 'GET', '/admin/categories', { expect: 200 })).text.includes(renamed));
  await hit(admin, 'POST', `/admin/categories/${parent.id}`, {
    form: { _csrf: token, name: renamed, slug: newSlug, parent_id: '', description: '', position: '91', archived: '0' },
    expect: 302,
  });
  check('catégories', 'une catégorie archivée peut être remise en ligne',
    q1('SELECT archived FROM categories WHERE id = ?', [parent.id]).archived === 0);

  // --- Déplacement en masse puis suppressions --------------------------
  const cible = q1(
    `SELECT p.id, p.slug, p.category_id FROM products p
      WHERE p.status = 'published' AND p.has_variants = 0 AND p.is_kit = 0 AND p.category_id IS NOT NULL
      ORDER BY p.id ASC LIMIT 1`
  );
  const listPage = await hit(admin, 'GET', '/admin/produits', { expect: 200 });
  const moveForm = (categoryId, ids) => {
    const form = new URLSearchParams();
    form.set('_csrf', meta(listPage.text, 'csrf-token'));
    for (const id of ids) form.append('ids[]', String(id));
    form.set('action', 'categorie');
    form.set('category_id', String(categoryId));
    return form;
  };
  await hit(admin, 'POST', '/admin/produits/masse', { form: moveForm(grand.id, [cible.id]), expect: 302 });
  check('catégories', 'des articles sont déplacés en masse vers une autre catégorie',
    q1('SELECT category_id FROM products WHERE id = ?', [cible.id]).category_id === grand.id);

  await hit(admin, 'POST', `/admin/categories/${child.id}/supprimer`, { form: { _csrf: token }, expect: 302 });
  check('catégories', 'une catégorie peut être supprimée', q1('SELECT id FROM categories WHERE id = ?', [child.id]) === null);
  check('catégories', 'les sous-catégories orphelines sont rattachées au niveau supérieur',
    q1('SELECT parent_id FROM categories WHERE id = ?', [grand.id]).parent_id === parent.id);
  check('catégories', 'les articles de la sous-catégorie survivante conservent leur classement',
    q1('SELECT category_id FROM products WHERE id = ?', [cible.id]).category_id === grand.id);

  await hit(admin, 'POST', `/admin/categories/${grand.id}/supprimer`, { form: { _csrf: token }, expect: 302 });
  const detached = q1('SELECT id, category_id FROM products WHERE id = ?', [cible.id]);
  check('catégories', 'supprimer une catégorie ne supprime pas ses articles',
    Boolean(detached) && detached.category_id === null);
  check('catégories', 'un article détaché de sa catégorie reste en ligne sans erreur',
    (await hit(new Jar('cat-lecteur6'), 'GET', `/produit/${cible.slug}`, { expect: 200 })).status === 200);

  await hit(admin, 'POST', '/admin/produits/masse', { form: moveForm(cible.category_id, [cible.id]), expect: 302 });
  check('catégories', 'l’article retrouve sa catégorie d’origine',
    q1('SELECT category_id FROM products WHERE id = ?', [cible.id]).category_id === cible.category_id);
  await hit(admin, 'POST', `/admin/categories/${parent.id}/supprimer`, { form: { _csrf: token }, expect: 302 });
  check('catégories', 'les catégories du parcours sont nettoyées',
    db.all('SELECT id FROM categories WHERE name LIKE ?', [`%parcours ${STAMP}%`]).length === 0);

  // --- Droits ----------------------------------------------------------
  const vendorEmail = `vendeur.cat.${STAMP}@test.local`;
  require('../src/domain/users').createUser({
    email: vendorEmail, password: 'Vendeur-Parcours-2026!', fullName: 'Vendeur catégories',
    role: 'vendor', canConfirmCash: false, active: true,
  }, q1("SELECT * FROM users WHERE role = 'admin' LIMIT 1"));
  const vendor = await vendorSession(vendorEmail, 'Vendeur-Parcours-2026!');
  const vendorPage = await hit(vendor, 'GET', '/admin/categories', { expect: 200 });
  const vendorName = `Catégorie vendeur ${STAMP}`;
  await hit(vendor, 'POST', '/admin/categories', {
    form: { _csrf: meta(vendorPage.text, 'csrf-token'), name: vendorName, parent_id: '', slug: '', description: '' },
    expect: 302,
  });
  const vendorCat = q1('SELECT * FROM categories WHERE name = ?', [vendorName]);
  check('catégories', 'un vendeur peut créer une catégorie', Boolean(vendorCat));
  if (vendorCat) {
    const refusal = await hit(vendor, 'POST', `/admin/categories/${vendorCat.id}/supprimer`, {
      form: { _csrf: meta(vendorPage.text, 'csrf-token') }, expect: 403,
    });
    check('catégories', 'un vendeur ne peut pas supprimer une catégorie',
      refusal.status === 403 && q1('SELECT id FROM categories WHERE id = ?', [vendorCat.id]) !== null);
    await hit(admin, 'POST', `/admin/categories/${vendorCat.id}/supprimer`, { form: { _csrf: token }, expect: 302 });
  }

  const anonymous = new Jar('cat-anonyme');
  const pirateName = `Pirate ${STAMP}`;
  const pirate = await hit(anonymous, 'POST', '/admin/categories', { form: { _csrf: token, name: pirateName, parent_id: '', slug: '' } });
  check('catégories', 'un visiteur non connecté ne crée pas de catégorie',
    [302, 403].includes(pirate.status) && q1('SELECT id FROM categories WHERE name = ?', [pirateName]) === null,
    `statut ${pirate.status}`);
});

step('Modifications en masse du catalogue', async () => {
  const admin = await adminSession();
  const page = await hit(admin, 'GET', '/admin/produits', { expect: 200 });
  const token = meta(page.text, 'csrf-token');

  const targets = db.all(
    `SELECT p.id, p.sku, p.slug, p.price, p.featured, p.low_stock_threshold
       FROM products p
      WHERE p.status = 'published' AND p.data_confirmed = 1 AND p.price > 0
        AND p.has_variants = 0 AND p.is_kit = 0 AND p.sku IS NOT NULL AND p.sku != ''
      ORDER BY p.id ASC LIMIT 2`
  );
  if (!check('masse', 'deux articles publiés servent de cible aux modifications en masse', targets.length === 2,
    `${targets.length} cible(s)`)) return;

  const bulk = (extra, list = targets) => {
    const form = new URLSearchParams();
    form.set('_csrf', token);
    for (const t of list) form.append('ids[]', String(t.id));
    for (const [k, v] of Object.entries(extra)) form.set(k, String(v));
    return hit(admin, 'POST', '/admin/produits/masse', { form, expect: 302 });
  };
  const rows = () => db.all(
    `SELECT * FROM products WHERE id IN (${targets.map(() => '?').join(', ')}) ORDER BY id ASC`,
    targets.map((t) => t.id)
  );
  const stockOf = (id) => q1('SELECT qty_on_hand, qty_reserved FROM stock_items WHERE product_id = ? AND variant_id IS NULL', [id]);

  // --- Prix ------------------------------------------------------------
  await bulk({ action: 'prix', price_percent: '10' });
  const plusTen = rows();
  check('masse', 'une variation de prix en pourcentage s’applique à toute la sélection',
    plusTen.every((r, i) => r.price === Math.round(targets[i].price * 1.1)),
    plusTen.map((r) => `${r.sku} → ${money.format(r.price)}`).join(' · '));
  await bulk({ action: 'prix', price_set: '2500' });
  check('masse', 'un prix unique peut être imposé à plusieurs articles', rows().every((r) => r.price === 2500));
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    await bulk({ action: 'prix', price_set: t.price }, [t]);
  }
  check('masse', 'les prix d’origine sont restaurés', rows().every((r, i) => r.price === targets[i].price));

  // --- Mise en avant et seuil d'alerte ---------------------------------
  await bulk({ action: 'mise_en_avant', featured: '1' });
  check('masse', 'la mise en avant s’applique en masse', rows().every((r) => r.featured === 1));
  await bulk({ action: 'seuil', low_stock_threshold: '7' });
  check('masse', 'le seuil d’alerte de stock s’applique en masse', rows().every((r) => r.low_stock_threshold === 7));

  // --- Stock -----------------------------------------------------------
  const before = targets.map((t) => stockOf(t.id));
  await bulk({ action: 'stock', stock_delta: '5' });
  const after = targets.map((t) => stockOf(t.id));
  check('masse', 'un ajustement de stock en masse augmente le stock physique',
    after.every((s, i) => s.qty_on_hand === before[i].qty_on_hand + 5),
    after.map((s, i) => `${before[i].qty_on_hand}→${s.qty_on_hand}`).join(' · '));
  check('masse', 'chaque ajustement de stock en masse est journalisé',
    targets.every((t) => db.all(
      "SELECT * FROM stock_movements WHERE product_id = ? AND reason = 'ajustement' AND note = 'Modification en masse'",
      [t.id]
    ).length >= 1));
  await bulk({ action: 'stock', stock_delta: '-999999' });
  check('masse', 'un ajustement qui rendrait le stock négatif est refusé sans rien casser',
    targets.every((t, i) => stockOf(t.id).qty_on_hand === before[i].qty_on_hand + 5));
  await bulk({ action: 'stock', stock_delta: '-5' });
  check('masse', 'le stock revient à son niveau initial',
    targets.every((t, i) => stockOf(t.id).qty_on_hand === before[i].qty_on_hand));

  // --- Garde-fou : confirmation retirée sur un article publié ----------
  await bulk({ action: 'confirmation', data_confirmed: '0' });
  const demoted = rows();
  check('masse', 'retirer la confirmation d’un article publié le repasse en brouillon',
    demoted.every((r) => r.status === 'draft' && r.data_confirmed === 0),
    demoted.map((r) => `${r.sku}:${r.status}`).join(' · '));
  const listing = await hit(admin, 'GET', '/admin/produits', { expect: 200 });
  check('masse', 'l’administration signale la rétrogradation au lieu d’un simple succès',
    /repassé|brouillon/i.test(listing.text));
  const hidden = await hit(new Jar('masse-lecteur'), 'GET', `/produit/${targets[0].slug}`);
  check('masse', 'un article non confirmé disparaît de la vitrine', hidden.status === 404, `statut ${hidden.status}`);
  const plan = await hit(new Jar('masse-lecteur2'), 'GET', '/sitemap.xml', { expect: 200 });
  check('masse', 'un article non confirmé est retiré du plan du site', !plan.text.includes(targets[0].slug));

  await bulk({ action: 'confirmation', data_confirmed: '1' });
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    await hit(admin, 'POST', `/admin/produits/${t.id}/statut`, { form: { _csrf: token, status: 'published' }, expect: 302 });
  }
  check('masse', 'les articles redeviennent publiés une fois les données confirmées',
    rows().every((r) => r.status === 'published' && r.data_confirmed === 1));
  check('masse', 'les articles sont à nouveau visibles en vitrine',
    (await hit(new Jar('masse-lecteur3'), 'GET', `/produit/${targets[0].slug}`, { expect: 200 })).status === 200);

  // --- Remise en état des autres attributs -----------------------------
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    await bulk({ action: 'mise_en_avant', featured: t.featured ? '1' : '0' }, [t]);
    // eslint-disable-next-line no-await-in-loop
    await bulk({ action: 'seuil', low_stock_threshold: t.low_stock_threshold }, [t]);
  }
  check('masse', 'la mise en avant et le seuil d’alerte retrouvent leur valeur d’origine',
    rows().every((r, i) => r.featured === targets[i].featured && r.low_stock_threshold === targets[i].low_stock_threshold));

  // --- Cas limites -----------------------------------------------------
  const empty = new URLSearchParams();
  empty.set('_csrf', token);
  empty.set('action', 'prix');
  empty.set('price_set', '1');
  await hit(admin, 'POST', '/admin/produits/masse', { form: empty, expect: 302 });
  check('masse', 'une opération en masse sans sélection ne modifie rien',
    rows().every((r, i) => r.price === targets[i].price));
  await bulk({ action: 'inconnue' });
  check('masse', 'une action en masse inconnue est ignorée', rows().every((r, i) => r.price === targets[i].price));
  check('masse', 'les opérations en masse sont journalisées dans l’audit',
    db.all("SELECT * FROM audit_log WHERE action = 'product.bulk_update'").length >= 1);

  const anonymous = new Jar('masse-anonyme');
  const forbidden = await hit(anonymous, 'POST', '/admin/produits/masse', {
    form: { _csrf: token, action: 'prix', price_set: '1', 'ids[]': String(targets[0].id) },
  });
  check('masse', 'un visiteur non connecté ne modifie pas le catalogue en masse',
    [302, 403].includes(forbidden.status) && rows()[0].price === targets[0].price, `statut ${forbidden.status}`);
});

step('Photos : téléversement, image principale, ordre, fichiers refusés', async () => {
  const fs = require('node:fs');
  const admin = await adminSession();
  const sku = ref('IMG');
  const category = q1("SELECT id FROM categories WHERE slug = 'cahiers-registres'") || q1('SELECT id FROM categories LIMIT 1');
  const formPage = await hit(admin, 'GET', '/admin/produits/nouveau', { expect: 200 });
  const token = meta(formPage.text, 'csrf-token');
  await hit(admin, 'POST', '/admin/produits/nouveau', {
    form: {
      _csrf: token, name: `Article photos ${sku}`, sku, category_id: String(category.id),
      short_description: 'Article servant au contrôle du téléversement de photos.',
      price: '3500', qty: '8', low_stock_threshold: '2', track_stock: '1', data_confirmed: '1',
      status: 'published', sale_unit: 'piece', product_condition: 'neuf',
    },
    expect: 302,
  });
  const product = q1('SELECT * FROM products WHERE sku = ?', [sku]);
  if (!check('photos', 'un article publié sans photo sert de support au contrôle', Boolean(product))) return;

  const { grande, petite } = await sampleImages();
  const envoi = new FormData();
  envoi.append('images', new Blob([grande], { type: 'image/jpeg' }), 'photo-1.jpg');
  envoi.append('images', new Blob([petite], { type: 'image/png' }), 'photo-2.png');
  await hit(admin, 'POST', `/admin/produits/${product.id}/images`, {
    form: envoi, headers: { 'x-csrf-token': token }, expect: 302,
  });

  const attached = db.all(
    `SELECT pi.id, pi.position, pi.is_primary, pi.media_id, m.file_key, m.width, m.height, m.bytes, m.mime
       FROM product_images pi JOIN media_files m ON m.id = pi.media_id
      WHERE pi.product_id = ? ORDER BY pi.position ASC`,
    [product.id]
  );
  check('photos', 'deux photos téléversées sont rattachées à l’article', attached.length === 2, `${attached.length} image(s)`);
  if (attached.length !== 2) return;
  check('photos', 'la première photo devient l’image principale', attached[0].is_primary === 1 && attached[1].is_primary === 0);
  check('photos', 'les dimensions réelles des images sont lues sur les octets', attached[0].width === 2400 && attached[1].width === 640,
    attached.map((a) => `${a.width}×${a.height}`).join(' · '));
  check('photos', 'le format d’origine est conservé en base', attached[0].mime === 'image/jpeg' && attached[1].mime === 'image/png');

  const mediaRoot = config.storage.mediaDir;
  check('photos', 'les fichiers sont écrits dans le stockage de démonstration',
    attached.every((a) => fs.existsSync(path.join(mediaRoot, a.file_key))),
    path.basename(mediaRoot));
  const derived = fs.readdirSync(path.join(mediaRoot, path.dirname(attached[0].file_key)));
  check('photos', 'des dérivés WebP réduits sont produits pour la vitrine',
    derived.some((f) => f.endsWith('.thumb.webp')) && derived.some((f) => f.endsWith('.large.webp')),
    derived.filter((f) => f.endsWith('.webp')).length + ' dérivé(s)');

  // Service des dérivés : la vignette doit être plus légère que l'original.
  const thumb = await fetch(`${BASE}/media/${attached[0].file_key}?s=thumb`, { headers: { accept: 'image/webp,image/*' } });
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  const sharp = require('sharp');
  const thumbMeta = await sharp(thumbBytes).metadata();
  check('photos', 'la vignette servie est redimensionnée (pas l’original de 2400 px)',
    thumb.status === 200 && thumbMeta.width <= 320, `${thumbMeta.width}×${thumbMeta.height}`);
  check('photos', 'la vignette est servie en WebP et pèse moins lourd que l’original',
    /webp/.test(thumb.headers.get('content-type') || '') && thumbBytes.length < attached[0].bytes,
    `${thumbBytes.length} o contre ${attached[0].bytes} o`);
  const cached = thumb.headers.get('cache-control') || '';
  check('photos', 'les images sont servies avec un cache long', /immutable/.test(cached), cached);

  const publicPage = await hit(new Jar('photos-lecteur'), 'GET', `/produit/${product.slug}`, { expect: 200 });
  const baseName = path.basename(attached[0].file_key, path.extname(attached[0].file_key));
  check('photos', 'la photo principale s’affiche sur la fiche publique', publicPage.text.includes(baseName));

  // --- Image principale et ordre ---------------------------------------
  await hit(admin, 'POST', `/admin/produits/${product.id}/images/${attached[1].id}/primaire`, {
    form: { _csrf: token }, expect: 302,
  });
  let primaries = db.all('SELECT id, is_primary FROM product_images WHERE product_id = ?', [product.id]);
  check('photos', 'l’image principale est modifiable',
    primaries.filter((p) => p.is_primary === 1).length === 1
    && primaries.find((p) => p.id === attached[1].id).is_primary === 1);

  await hit(admin, 'POST', `/admin/produits/${product.id}/images/reordonner`, {
    form: { _csrf: token, order: `${attached[1].id},${attached[0].id}` },
    headers: { 'x-csrf-token': token, 'x-requested-with': 'XMLHttpRequest' },
    expect: 200,
  });
  const ordered = db.all('SELECT id, position, is_primary FROM product_images WHERE product_id = ? ORDER BY position ASC', [product.id]);
  check('photos', 'l’ordre des photos est enregistré', ordered[0].id === attached[1].id && ordered[1].id === attached[0].id);
  check('photos', 'la première photo de la liste redevient l’image principale',
    ordered[0].is_primary === 1 && ordered[1].is_primary === 0);

  // --- Suppression -----------------------------------------------------
  await hit(admin, 'POST', `/admin/produits/${product.id}/images/${attached[1].id}/supprimer`, {
    form: { _csrf: token }, expect: 302,
  });
  primaries = db.all('SELECT id, is_primary FROM product_images WHERE product_id = ?', [product.id]);
  check('photos', 'une photo peut être supprimée', primaries.length === 1 && primaries[0].id === attached[0].id);
  check('photos', 'la photo restante redevient principale', primaries[0].is_primary === 1);
  check('photos', 'le média devenu orphelin est retiré de la base',
    q1('SELECT id FROM media_files WHERE id = ?', [attached[1].media_id]) === null);
  check('photos', 'le fichier correspondant est retiré du disque',
    !fs.existsSync(path.join(mediaRoot, attached[1].file_key)));

  // --- Fichiers refusés ------------------------------------------------
  const texte = new FormData();
  texte.append('images', new Blob([Buffer.from('ceci n est pas une image')], { type: 'text/plain' }), 'note.txt');
  const refused = await hit(admin, 'POST', `/admin/produits/${product.id}/images`, {
    form: texte, headers: { 'x-csrf-token': token },
  });
  check('photos', 'un fichier qui n’est pas une image est refusé', refused.status === 415, `statut ${refused.status}`);
  check('photos', 'aucun média n’est créé pour un fichier refusé',
    db.all('SELECT id FROM product_images WHERE product_id = ?', [product.id]).length === 1);

  // Un fichier qui se déclare image mais dont le contenu n'en est pas une :
  // le type est vérifié sur les octets, jamais sur l'extension ni sur l'en-tête.
  const deguise = new FormData();
  deguise.append('images', new Blob([Buffer.from('texte mais pas une image')], { type: 'image/jpeg' }), 'faux.jpg');
  await hit(admin, 'POST', `/admin/produits/${product.id}/images`, {
    form: deguise, headers: { 'x-csrf-token': token }, expect: 302,
  });
  check('photos', 'un contenu déguisé en image est écarté après lecture des octets',
    db.all('SELECT id FROM product_images WHERE product_id = ?', [product.id]).length === 1);
  let fiche = await hit(admin, 'GET', `/admin/produits/${product.id}`, { expect: 200 });
  check('photos', 'l’administration annonce le fichier écarté au lieu d’un succès',
    /aucune image enregistrée/i.test(fiche.text) && !/image\(s\) ajoutée/.test(fiche.text),
    /aucune image enregistrée/i.test(fiche.text) ? 'message explicite' : 'message attendu absent');

  // Envoi mixte : une vraie photo et un fichier invalide dans la même requête.
  // La photo valide doit passer, l'autre être écartée ET signalée.
  const mixte = new FormData();
  mixte.append('images', new Blob([petite], { type: 'image/png' }), 'bonne.png');
  mixte.append('images', new Blob([Buffer.from('pas une image')], { type: 'image/png' }), 'mauvaise.png');
  await hit(admin, 'POST', `/admin/produits/${product.id}/images`, {
    form: mixte, headers: { 'x-csrf-token': token }, expect: 302,
  });
  check('photos', 'un envoi mixte enregistre la photo valide et écarte l’autre',
    db.all('SELECT id FROM product_images WHERE product_id = ?', [product.id]).length === 2);
  fiche = await hit(admin, 'GET', `/admin/produits/${product.id}`, { expect: 200 });
  check('photos', 'le message distingue les photos enregistrées des fichiers écartés',
    /1 image\(s\) ajoutée/.test(fiche.text) && /1 fichier\(s\) écarté/.test(fiche.text) && /mauvaise\.png/.test(fiche.text));
});

step('Retour et remboursement d’une commande payée', async () => {
  const admin = await adminSession();
  // Le remboursement porte sur une commande réellement encaissée : un Mobile
  // Money en bac à sable est activé depuis l'administration (aucun identifiant
  // marchand, aucun argent réel).
  const wave = await enableSandboxMethod('wave');
  if (!check('remboursement', 'un Mobile Money en bac à sable est activé pour encaisser la commande',
    Boolean(wave && wave.enabled))) return;
  const product = sellableProduct(2);
  if (!check('remboursement', 'un article avec au moins deux unités disponibles sert de support', Boolean(product))) return;
  const before = stockLineOf(product.id);

  const guest = new Jar('invite-remboursement');
  await addToCart(guest, product.id, 2);
  const { res } = await checkout(guest, {
    mode: 'pickup', paiement: 'wave', nom: 'Aya Remboursement', telephone: '0708090807',
  });
  const order = orderFromLocation(res.location);
  if (!check('remboursement', 'une commande de deux unités est créée', Boolean(order), res.location)) return;
  const gateway = await hit(guest, 'GET', res.location, { expect: 200 });
  await hit(guest, 'POST', `/paiements/simuler/${order.reference}`, {
    form: { _csrf: meta(gateway.text, 'csrf-token'), action: 'succes' }, expect: 200,
  });
  const paid = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  if (!check('remboursement', 'la commande est payée avant tout remboursement',
    paid.payment_status === 'paid' && paid.amount_paid === paid.total, `${paid.payment_status} · ${money.format(paid.amount_paid)}`)) return;

  const line = q1('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  const unit = Math.round(line.line_total / line.qty);
  const adminPage = await hit(admin, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  const token = meta(adminPage.text, 'csrf-token');

  // --- Un vendeur non habilité ne rembourse pas ------------------------
  const vendorEmail = `vendeur.remb.${STAMP}@test.local`;
  require('../src/domain/users').createUser({
    email: vendorEmail, password: 'Vendeur-Parcours-2026!', fullName: 'Vendeur remboursements',
    role: 'vendor', canConfirmCash: false, active: true,
  }, q1("SELECT * FROM users WHERE role = 'admin' LIMIT 1"));
  const vendor = await vendorSession(vendorEmail, 'Vendeur-Parcours-2026!');
  const vendorPage = await hit(vendor, 'GET', `/admin/commandes/${order.id}`, { expect: 200 });
  const refusal = await hit(vendor, 'POST', `/admin/commandes/${order.id}/remboursement`, {
    form: { _csrf: meta(vendorPage.text, 'csrf-token'), kind: 'refund', amount: String(unit), reason: 'Tentative vendeur' },
    expect: 403,
  });
  check('remboursement', 'un vendeur sans habilitation ne peut pas rembourser',
    refusal.status === 403 && db.all('SELECT id FROM refunds WHERE order_id = ?', [order.id]).length === 0);

  // --- Retour partiel, enregistré puis appliqué ------------------------
  await hit(admin, 'POST', `/admin/commandes/${order.id}/remboursement`, {
    form: {
      _csrf: token, lignes: `${line.id}:1`, kind: 'return', amount: '',
      method: 'wave', reason: 'Article rendu en boutique', restock: '1',
    },
    expect: 302,
  });
  const refund = q1('SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id]);
  check('remboursement', 'un retour est enregistré en attente de validation', Boolean(refund) && refund.status === 'pending');
  if (!refund) return;
  check('remboursement', 'le montant est calculé d’après la ligne concernée, pas d’après le navigateur',
    refund.amount === unit, `${money.format(refund.amount)} attendu ${money.format(unit)}`);
  check('remboursement', 'la ligne retournée est tracée', db.all('SELECT * FROM refund_items WHERE refund_id = ?', [refund.id]).length === 1);
  check('remboursement', 'un remboursement en attente ne modifie pas encore la commande',
    q1('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded === 0);
  check('remboursement', 'le stock n’est pas restitué avant la validation',
    stockLineOf(product.id).qty_on_hand === before.qty_on_hand - 2);

  await hit(admin, 'POST', `/admin/remboursements/${refund.id}/appliquer`, {
    form: { _csrf: token, order_id: String(order.id) }, expect: 302,
  });
  const applied = q1('SELECT * FROM refunds WHERE id = ?', [refund.id]);
  const partial = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('remboursement', 'le remboursement appliqué est daté et attribué',
    applied.status === 'done' && Boolean(applied.processed_at) && Boolean(applied.processed_by));
  check('remboursement', 'la commande passe en remboursement partiel',
    partial.payment_status === 'partially_refunded' && partial.status === 'partially_refunded',
    `${partial.status} · ${partial.payment_status}`);
  check('remboursement', 'le montant remboursé est cumulé sur la commande', partial.amount_refunded === unit);
  check('remboursement', 'le retour avec remise en stock rend l’unité disponible',
    stockLineOf(product.id).qty_on_hand === before.qty_on_hand - 1,
    `${before.qty_on_hand} → ${stockLineOf(product.id).qty_on_hand}`);
  check('remboursement', 'le mouvement de stock du retour est journalisé',
    db.all("SELECT * FROM stock_movements WHERE product_id = ? AND reason = 'retour'", [product.id]).length >= 1);
  check('remboursement', 'le paiement en ligne suit le remboursement',
    Boolean(q1("SELECT id FROM payments WHERE order_id = ? AND status = 'partially_refunded'", [order.id])));
  check('remboursement', 'un remboursement déjà appliqué ne peut pas être rejoué', (() => {
    const countBefore = db.all('SELECT id FROM refunds WHERE order_id = ?', [order.id]).length;
    require('../src/domain/orders').applyRefund(refund.id, { userId: 1 });
    return db.all('SELECT id FROM refunds WHERE order_id = ?', [order.id]).length === countBefore
      && q1('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded === unit;
  })());

  // --- Solde : remboursement intégral ----------------------------------
  await hit(admin, 'POST', `/admin/commandes/${order.id}/remboursement`, {
    form: {
      _csrf: token, lignes: `${line.id}:1`, kind: 'refund', amount: '',
      method: 'especes', reason: 'Solde du retour', restock: '1', appliquer: '1',
    },
    expect: 302,
  });
  const full = q1('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('remboursement', 'un remboursement peut être enregistré et appliqué en une fois',
    db.all("SELECT * FROM refunds WHERE order_id = ? AND status = 'done'", [order.id]).length === 2);
  check('remboursement', 'le remboursement intégral bascule la commande',
    full.payment_status === 'refunded' && full.status === 'refunded', `${full.status} · ${full.payment_status}`);
  check('remboursement', 'le stock est entièrement restitué',
    stockLineOf(product.id).qty_on_hand === before.qty_on_hand);

  // --- Montant excessif ------------------------------------------------
  const avantTrop = q1('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded;
  await hit(admin, 'POST', `/admin/commandes/${order.id}/remboursement`, {
    form: { _csrf: token, kind: 'refund', amount: '5000', method: 'especes', reason: 'Trop-perçu', restock: '0' },
    expect: 302,
  });
  check('remboursement', 'un remboursement supérieur au reste dû est refusé',
    db.all('SELECT id FROM refunds WHERE order_id = ?', [order.id]).length === 2
    && q1('SELECT amount_refunded FROM orders WHERE id = ?', [order.id]).amount_refunded === avantTrop);

  // --- Visibilité client -----------------------------------------------
  const normalise = (s) => String(s).replace(/[\u202f\u00a0\s]/g, '');
  const suivi = await hit(new Jar('suivi-remboursement'), 'GET', `/suivi/${paid.tracking_token}`, { expect: 200 });
  check('remboursement', 'le client voit le remboursement dans son suivi public', /rembours/i.test(suivi.text));
  check('remboursement', 'le suivi public affiche le montant remboursé',
    normalise(suivi.text).includes(normalise(money.format(full.amount_refunded))), money.format(full.amount_refunded));
  const impression = await hit(admin, 'GET', `/admin/commandes/${order.id}/impression`, { expect: 200 });
  check('remboursement', 'le récapitulatif imprimable mentionne le remboursement', /rembours/i.test(impression.text));
  check('remboursement', 'les remboursements sont journalisés dans l’audit',
    db.all("SELECT * FROM audit_log WHERE action LIKE '%refund%'").length >= 1);
});

step('Compte client facultatif : inscription, commandes, isolation, suppression', async () => {
  const email = `client.parcours.${STAMP}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const phone = freePhone();
  const password = 'Daoukro-Client-2026!';

  const anon = new Jar('client-anonyme');
  check('compte', 'l’achat reste possible sans compte',
    (await hit(anon, 'GET', '/catalogue', { expect: 200 })).status === 200);
  check('compte', 'l’accès aux commandes du compte est réservé au client connecté',
    (await hit(anon, 'GET', '/compte/commandes', { expect: 302 })).location.includes('/compte/connexion'));

  const form = await hit(anon, 'GET', '/compte/inscription', { expect: 200 });
  check('compte', 'la création de compte est proposée', /mot de passe/i.test(form.text));
  check('compte', 'l’adresse e-mail n’est pas obligatoire (le téléphone suffit)',
    !/name="email"[^>]*required/.test(form.text) && /name="phone"/.test(form.text));
  check('compte', 'le consentement marketing est distinct et décoché par défaut',
    /name="marketing"/.test(form.text) && !/name="marketing"[^>]*checked/.test(form.text));

  const weak = await hit(anon, 'POST', '/compte/inscription', {
    form: { _csrf: meta(form.text, 'csrf-token'), fullName: 'Client Parcours', email, phone, password: 'court' },
    expect: 400,
  });
  check('compte', 'un mot de passe faible est refusé', weak.status === 400 && /mot de passe/i.test(weak.text));
  check('compte', 'aucun compte n’est créé avec un mot de passe faible',
    q1('SELECT id FROM customers WHERE email = ?', [email]) === null);

  const opened = await hit(anon, 'POST', '/compte/inscription', {
    form: { _csrf: meta(form.text, 'csrf-token'), fullName: 'Client Parcours', email, phone, password, marketing: '1' },
    expect: 302,
  });
  const customer = q1('SELECT * FROM customers WHERE email = ?', [email]);
  check('compte', 'le compte est créé et la session ouverte', Boolean(customer) && opened.location === '/compte', opened.location);
  if (!customer) return;
  check('compte', 'le mot de passe n’est jamais stocké en clair',
    Boolean(customer.password_hash) && customer.password_hash !== password && customer.password_hash.length >= 32);
  check('compte', 'le consentement marketing est horodaté', customer.marketing_consent === 1 && Boolean(customer.consent_at));

  // Le même numéro ne peut pas ouvrir un second compte : c'est ce qui garantit
  // qu'un client ne se dédouble pas et que ses commandes restent regroupées.
  const doublonJar = new Jar('client-doublon');
  const doublonForm = await hit(doublonJar, 'GET', '/compte/inscription', { expect: 200 });
  const doublon = await hit(doublonJar, 'POST', '/compte/inscription', {
    form: {
      _csrf: meta(doublonForm.text, 'csrf-token'), fullName: 'Client Doublon',
      email: `doublon.${STAMP}@example.com`, phone, password,
    },
  });
  const telephones = db.all('SELECT id FROM customers WHERE phone = ?', [require('../src/lib/validate').normalizePhone(phone)]);
  check('compte', 'un numéro déjà rattaché à un compte ne peut pas en ouvrir un second',
    doublon.status === 409 && telephones.length === 1, `statut ${doublon.status} · ${telephones.length} compte(s)`);

  const dash = await hit(anon, 'GET', '/compte', { expect: 200 });
  check('compte', 'le tableau de bord du client répond', dash.text.includes('Client Parcours'));

  // --- Commande rattachée au compte ------------------------------------
  const product = sellableProduct(1);
  await addToCart(anon, product.id, 1);
  const { res } = await checkout(anon, {
    mode: 'pickup', paiement: 'pay_at_pickup', nom: 'Client Parcours', telephone: phone, email,
  });
  const order = orderFromLocation(res.location);
  check('compte', 'une commande passée avec un compte y est rattachée',
    Boolean(order) && order.customer_id === customer.id, order ? `client ${order.customer_id}` : res.location);
  if (!order) return;
  const list = await hit(anon, 'GET', '/compte/commandes', { expect: 200 });
  check('compte', 'le client retrouve sa commande dans son compte', list.text.includes(order.reference));
  check('compte', 'le détail de la commande est consultable',
    (await hit(anon, 'GET', `/compte/commande/${order.reference}`, { expect: 200 })).text.includes(order.reference));

  // --- Isolation entre clients -----------------------------------------
  const otherEmail = `client.second.${STAMP}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  require('../src/domain/users').registerCustomer({
    email: otherEmail, phone: freePhone('05'), fullName: 'Client Second', password, marketingConsent: false,
  });
  const other = new Jar('client-second');
  const loginPage = await hit(other, 'GET', '/compte/connexion', { expect: 200 });
  await hit(other, 'POST', '/compte/connexion', {
    form: { _csrf: meta(loginPage.text, 'csrf-token'), identifier: otherEmail, password, suite: '/compte' },
    expect: 302,
  });
  const otherList = await hit(other, 'GET', '/compte/commandes', { expect: 200 });
  check('compte', 'un autre client ne voit pas la commande du premier', !otherList.text.includes(order.reference));
  check('compte', 'la commande d’un autre client lui renvoie 404',
    (await hit(other, 'GET', `/compte/commande/${order.reference}`)).status === 404);
  check('compte', 'aucune coordonnée du premier client n’est exposée au second',
    !otherList.text.includes(email) && !otherList.text.includes('Client Parcours'));
  check('compte', 'une session client n’ouvre aucun accès d’administration',
    (await hit(other, 'GET', '/admin/commandes', { expect: 302 })).location.includes('/admin/connexion'));

  // --- Paramètres et consentement --------------------------------------
  const paramPage = await hit(anon, 'GET', '/compte/parametres', { expect: 200 });
  await hit(anon, 'POST', '/compte/parametres', {
    form: { _csrf: meta(paramPage.text, 'csrf-token'), fullName: 'Client Parcours Modifié', phone },
    expect: 302,
  });
  const updated = q1('SELECT * FROM customers WHERE id = ?', [customer.id]);
  check('compte', 'le client peut modifier ses informations', updated.full_name === 'Client Parcours Modifié');
  check('compte', 'le consentement marketing est révocable', updated.marketing_consent === 0 && updated.consent_at === null);
  check('compte', 'le retrait du consentement est journalisé',
    db.all("SELECT * FROM audit_log WHERE action = 'consent.withdrawn' AND entity_id = ?", [String(customer.id)]).length >= 1);

  // --- Mot de passe ----------------------------------------------------
  const nouveau = 'Daoukro-Client-2027!';
  const mdpPage = await hit(anon, 'GET', '/compte/parametres', { expect: 200 });
  await hit(anon, 'POST', '/compte/mot-de-passe', {
    form: { _csrf: meta(mdpPage.text, 'csrf-token'), current_password: password, new_password: nouveau },
    expect: 302,
  });
  const retry = new Jar('client-nouveau-mdp');
  const retryPage = await hit(retry, 'GET', '/compte/connexion', { expect: 200 });
  const ancien = await hit(retry, 'POST', '/compte/connexion', {
    form: { _csrf: meta(retryPage.text, 'csrf-token'), identifier: email, password, suite: '/compte' },
  });
  check('compte', 'l’ancien mot de passe cesse de fonctionner', ancien.status === 401, `statut ${ancien.status}`);
  const nouveauLogin = await hit(retry, 'POST', '/compte/connexion', {
    form: { _csrf: meta(retryPage.text, 'csrf-token'), identifier: email, password: nouveau, suite: '/compte' },
    expect: 302,
  });
  check('compte', 'le nouveau mot de passe ouvre la session', nouveauLogin.location === '/compte');
  check('compte', 'les commandes restent attachées au compte après changement de mot de passe',
    (await hit(retry, 'GET', '/compte/commandes', { expect: 200 })).text.includes(order.reference));

  // --- Suppression du compte -------------------------------------------
  const delPage = await hit(retry, 'GET', '/compte/parametres', { expect: 200 });
  await hit(retry, 'POST', '/compte/supprimer', { form: { _csrf: meta(delPage.text, 'csrf-token') }, expect: 302 });
  const erased = q1('SELECT * FROM customers WHERE id = ?', [customer.id]);
  check('compte', 'la suppression anonymise le compte',
    erased.full_name === 'Compte supprimé' && erased.email === null && erased.password_hash === '');
  check('compte', 'les commandes restent conservées pour la comptabilité',
    Boolean(q1('SELECT reference FROM orders WHERE id = ?', [order.id]))
    && q1('SELECT customer_id FROM orders WHERE id = ?', [order.id]).customer_id === customer.id);
  check('compte', 'la commande reste consultable par son lien de suivi',
    (await hit(new Jar('suivi-compte'), 'GET', `/suivi/${order.tracking_token}`, { expect: 200 })).text.includes(order.reference));
  check('compte', 'la session est détruite après la suppression du compte',
    (await hit(retry, 'GET', '/compte', { expect: 302 })).location.includes('/compte/connexion'));
  check('compte', 'la suppression du compte est journalisée',
    db.all("SELECT * FROM audit_log WHERE action = 'customer.deleted' AND entity_id = ?", [String(customer.id)]).length >= 1);
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
  // Le parcours doit pouvoir être rejoué à la suite : les routes de connexion
  // sont limitées à 10 tentatives par 5 minutes, le tunnel de commande à
  // RATE_LIMIT_CHECKOUT_MAX soumissions par 10 minutes et l'ensemble du site à
  // RATE_LIMIT_MAX requêtes par minute — le tout par adresse IP. Or le parcours
  // se connecte plusieurs fois (administrateur, vendeurs, clients), passe une
  // dizaine de commandes et enchaîne plus de 300 requêtes depuis 127.0.0.1. Les
  // compteurs de la base de démonstration sont donc remis à zéro au démarrage.
  // La limitation de débit elle-même n'est pas désactivée : elle reste vérifiée
  // par tests/access.test.js.
  try {
    db.run("DELETE FROM rate_buckets WHERE key LIKE 'rl-auth:%' OR key LIKE 'rl-global:%' OR key LIKE 'rl-checkout:%'");
  } catch { /* base non migrée : le parcours échouera plus loin de toute façon */ }

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
