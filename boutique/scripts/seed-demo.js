'use strict';

/**
 * Jeu de données de DÉMONSTRATION.
 *
 * Règles :
 *   - base et médias strictement séparés des données réelles
 *     (`data/demo.sqlite`, `data/demo-media`) ;
 *   - refusé si NODE_ENV=production ;
 *   - tous les articles, prix et stocks sont FICTIFS : ils servent à essayer
 *     l'interface, pas à décrire le stock réel de l'établissement ;
 *   - le bandeau « données de démonstration » est activé et `meta.environment`
 *     vaut `demo`, pour qu'aucune confusion ne soit possible.
 *
 * Usage :
 *   npm run seed:demo                 # crée/complète la base de démonstration
 *   node scripts/seed-demo.js --fresh # repart de zéro
 *   node scripts/seed-demo.js --orders # ajoute aussi des commandes de démonstration
 */

const fs = require('node:fs');
const path = require('node:path');

/* --- Bascule en mode démonstration AVANT tout chargement de configuration --- */
const argv = process.argv.slice(2);
if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  console.error('seed-demo est interdit lorsque NODE_ENV=production.');
  console.error('Les données de démonstration ne doivent jamais côtoyer les données réelles.');
  process.exit(1);
}
process.env.DEMO = 'true';
// `src/config` résout lui-même les cibles de démonstration (DEMO_DATABASE_PATH,
// DEMO_MEDIA_DIR, DEMO_IMPORT_DIR, DEMO_BACKUP_DIR) et IGNORE les variables de
// stockage réelles dans ce mode. Les réécrire ici ferait croire au garde-fou
// d'isolement que la démo pointe sur la base réelle.

const config = require('../src/config');
const db = require('../src/db');
const settings = require('../src/lib/settings');
const products = require('../src/domain/products');
const stock = require('../src/domain/stock');
const users = require('../src/domain/users');
const pos = require('../src/domain/pos');
const images = require('../src/lib/images');
const dates = require('../src/lib/dates');
const { seedCore } = require('../src/seed/core');

if (!config.isDemo) {
  console.error('Le mode démonstration n’a pas pu être activé : abandon.');
  process.exit(1);
}
if (path.resolve(config.db.path) === path.resolve('data/boutique.sqlite')) {
  console.error('La base cible est la base RÉELLE : abandon.');
  process.exit(1);
}

const fresh = argv.includes('--fresh');
const withOrders = argv.includes('--orders');

if (fresh) {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = config.db.path + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  for (const dir of [config.storage.mediaDir, config.storage.importDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('Base et médias de démonstration supprimés.');
}

/* ------------------------------------------------------------------ */
/* Catalogue fictif                                                     */
/* ------------------------------------------------------------------ */
const COULEURS = {
  papeterie: ['#EAF0F9', '#14294F'],
  informatique: ['#E8F1EC', '#1F7A4D'],
  telephones: ['#FBF3E1', '#B8892B'],
};

/**
 * `qty` : stock de l'article simple. `variants[].stock` : stock par variante.
 * `confirmed: false` démontre la règle « sans données confirmées, non achetable ».
 */
const CATALOGUE = [
  // --- Papeterie et fournitures scolaires ---------------------------------
  { sku: 'DEMO-CAH-200', name: 'Cahier 200 pages — format A4 (démonstration)', cat: 'cahiers-registres', family: 'papeterie', price: 1500, qty: 120, low: 20, unit: 'piece', weight: 380,
    short: 'Cahier grands carreaux, couverture rigide.', attributes: { Format: 'A4', 'Nombre de pages': '200', Réglure: 'Seyès (grands carreaux)' } },
  { sku: 'DEMO-CAH-096', name: 'Cahier 96 pages — format A5 (démonstration)', cat: 'cahiers-registres', family: 'papeterie', price: 800, qty: 8, low: 15, unit: 'piece', weight: 190,
    short: 'Format réduit, pratique pour les cours.', attributes: { Format: 'A5', 'Nombre de pages': '96' } },
  { sku: 'DEMO-REG-300', name: 'Registre comptable 300 pages (démonstration)', cat: 'cahiers-registres', family: 'papeterie', price: 4500, qty: 30, low: 5, unit: 'piece', weight: 900,
    short: 'Registre relié, colonnes débit/crédit.', attributes: { Format: 'A4', 'Nombre de pages': '300' } },
  { sku: 'DEMO-STY-BLE', name: 'Stylo bille bleu — lot de 10 (démonstration)', cat: 'ecriture-correction', family: 'papeterie', price: 2000, qty: 45, low: 10, unit: 'lot', unitLabel: 'lot de 10', weight: 120,
    short: 'Pointe moyenne 1 mm, encre bleue.' },
  { sku: 'DEMO-COR-001', name: 'Correcteur liquide (démonstration)', cat: 'ecriture-correction', family: 'papeterie', price: 700, qty: 60, low: 12, unit: 'piece', weight: 40 },
  { sku: 'DEMO-RAM-A4', name: 'Ramette papier A4 — 500 feuilles (démonstration)', cat: 'papier-impression', family: 'papeterie', price: 3500, qty: 25, low: 8, unit: 'rame', unitLabel: 'rame de 500', weight: 2300,
    short: 'Papier blanc 80 g/m², impression recto verso.', attributes: { Format: 'A4', Grammage: '80', 'Quantité par paquet': '500' } },
  { sku: 'DEMO-CLA-A4', name: 'Classeur à levier A4 (démonstration)', cat: 'classement-archives', family: 'papeterie', price: 2500, low: 6, unit: 'piece', weight: 420, hasVariants: true,
    variants: [
      { sku: 'DEMO-CLA-A4-BLE', options: { Couleur: 'Bleu' }, stock: 18 },
      { sku: 'DEMO-CLA-A4-NOI', options: { Couleur: 'Noir' }, stock: 12 },
      { sku: 'DEMO-CLA-A4-ROU', options: { Couleur: 'Rouge' }, stock: 0 },
    ] },
  { sku: 'DEMO-CAL-12', name: 'Calculatrice scientifique (démonstration)', cat: 'fournitures-scolaires', family: 'papeterie', price: 8500, qty: 14, low: 4, unit: 'piece', weight: 130 },
  { sku: 'DEMO-CRA-12', name: 'Craies blanches — boîte de 12 (démonstration)', cat: 'dessin-travaux-manuels', family: 'papeterie', price: 600, qty: 50, low: 10, unit: 'piece', weight: 150 },
  { sku: 'DEMO-ATT-001', name: 'Article en attente de confirmation (démonstration)', cat: 'fournitures-scolaires', family: 'papeterie', price: 2500, qty: 5, unit: 'piece', confirmed: false,
    short: 'Prix et disponibilité non confirmés : cet article n’est pas commandable.' },
  { sku: 'DEMO-BROU-01', name: 'Article en brouillon (démonstration)', cat: 'fournitures-scolaires', family: 'papeterie', price: 1000, qty: 3, unit: 'piece', status: 'draft',
    short: 'Non publié : invisible sur le site.' },
  { sku: 'DEMO-ARCH-01', name: 'Article archivé (démonstration)', cat: 'fournitures-scolaires', family: 'papeterie', price: 1200, qty: 0, unit: 'piece', status: 'archived' },

  // --- Informatique et accessoires ----------------------------------------
  { sku: 'DEMO-CLE-USB', name: 'Clé USB 2.0 (démonstration)', cat: 'cles-usb-stockage', family: 'informatique', price: 5000, low: 5, unit: 'piece', weight: 20, hasVariants: true,
    variants: [
      { sku: 'DEMO-CLE-16', options: { Capacité: '16 Go' }, price: 4000, stock: 22 },
      { sku: 'DEMO-CLE-32', options: { Capacité: '32 Go' }, price: 5500, stock: 17 },
      { sku: 'DEMO-CLE-64', options: { Capacité: '64 Go' }, price: 8000, stock: 4 },
    ], attributes: { Connectique: 'USB-A 2.0' } },
  { sku: 'DEMO-SOU-SF', name: 'Souris filaire USB (démonstration)', cat: 'claviers-souris', family: 'informatique', price: 3500, qty: 26, low: 6, unit: 'piece', weight: 110 },
  { sku: 'DEMO-CLA-USB', name: 'Clavier filaire USB — AZERTY (démonstration)', cat: 'claviers-souris', family: 'informatique', price: 7500, qty: 11, low: 4, unit: 'piece', weight: 620 },
  { sku: 'DEMO-CAB-HDMI', name: 'Câble HDMI 2 mètres (démonstration)', cat: 'reseaux-connectique', family: 'informatique', price: 3000, qty: 0, low: 5, unit: 'piece', weight: 90,
    short: 'Rupture de stock volontaire, pour tester l’affichage « indisponible ».' },
  { sku: 'DEMO-TON-001', name: 'Consommable imprimante — sur commande (démonstration)', cat: 'imprimantes-consommables', family: 'informatique', price: 12000, unit: 'piece', trackStock: false,
    short: 'Suivi de stock désactivé : toujours commandable, délai à confirmer.' },
  { sku: 'DEMO-TAP-SOU', name: 'Tapis de souris (démonstration)', cat: 'accessoires-pc', family: 'informatique', price: 1500, qty: 40, low: 10, unit: 'piece', weight: 80 },
  { sku: 'DEMO-OND-650', name: 'Onduleur 650 VA (démonstration)', cat: 'accessoires-pc', family: 'informatique', price: 32000, qty: 6, low: 2, unit: 'piece', weight: 4200 },
  { sku: 'DEMO-PC-REC', name: 'Ordinateur portable reconditionné (démonstration)', cat: 'ordinateurs-portables', family: 'informatique', price: 165000, promo: 145000, compare: 175000, qty: 3, low: 1, unit: 'piece', weight: 2100,
    condition: 'reconditionne', warranty: 'Garantie boutique 3 mois (démonstration)', boxContents: 'Ordinateur, chargeur (démonstration)',
    short: 'Promotion datée et produit reconditionné, pour tester ces deux cas.',
    attributes: { 'Mémoire vive': '8 Go', 'Capacité de stockage': '256 Go SSD', "Taille d'écran": '14' } },

  // --- Téléphones et accessoires ------------------------------------------
  { sku: 'DEMO-TCH-FT1', name: 'Téléphone portable double SIM (démonstration)', cat: 'telephones-smartphones', family: 'telephones', price: 15000, qty: 19, low: 5, unit: 'piece', weight: 95,
    attributes: { 'Nombre de SIM': '2 SIM (double SIM)', Réseau: '2G', Batterie: '1200' } },
  { sku: 'DEMO-SMA-DEMO', name: 'Smartphone (démonstration)', cat: 'telephones-smartphones', family: 'telephones', price: 95000, low: 2, unit: 'piece', weight: 210, hasVariants: true,
    variants: [
      { sku: 'DEMO-SMA-64-N', options: { Capacité: '64 Go', Couleur: 'Noir' }, price: 95000, stock: 5 },
      { sku: 'DEMO-SMA-128-N', options: { Capacité: '128 Go', Couleur: 'Noir' }, price: 115000, stock: 3 },
      { sku: 'DEMO-SMA-128-B', options: { Capacité: '128 Go', Couleur: 'Bleu' }, price: 115000, stock: 1 },
    ], attributes: { Réseau: '4G', 'Nombre de SIM': '2 SIM (double SIM)' } },
  { sku: 'DEMO-CHA-2A', name: 'Chargeur secteur 2 A + câble (démonstration)', cat: 'chargeurs-cables', family: 'telephones', price: 4500, qty: 34, low: 8, unit: 'piece', weight: 120,
    attributes: { Puissance: '10' } },
  { sku: 'DEMO-ECO-FIL', name: 'Écouteurs filaires (démonstration)', cat: 'ecouteurs-audio', family: 'telephones', price: 3000, qty: 28, low: 8, unit: 'piece', weight: 45 },
  { sku: 'DEMO-COQ-DEMO', name: 'Coque de protection (démonstration)', cat: 'coques-protections', family: 'telephones', price: 2000, qty: 7, low: 10, unit: 'piece', weight: 35 },
  { sku: 'DEMO-FIL-VER', name: 'Verre trempé (démonstration)', cat: 'coques-protections', family: 'telephones', price: 2500, qty: 21, low: 6, unit: 'piece', weight: 30 },
  { sku: 'DEMO-BAT-10K', name: 'Batterie externe 10 000 mAh (démonstration)', cat: 'batteries-externes', family: 'telephones', price: 14000, promo: 11500, qty: 9, low: 3, unit: 'piece', weight: 240,
    attributes: { Batterie: '10000', Puissance: '12' } },
  { sku: 'DEMO-ACC-SUP', name: 'Accessoire téléphone (démonstration)', cat: 'accessoires-telephone', family: 'telephones', price: 1800, qty: 15, low: 5, unit: 'piece', weight: 25 },
];

/* --- Kit scolaire : composants explicités et stock géré par composant ------ */
const KIT = {
  sku: 'DEMO-KIT-PRIM', name: 'Kit scolaire primaire (démonstration)', cat: 'kits-scolaires', family: 'papeterie',
  price: 6500, qty: 10, low: 3, unit: 'lot', unitLabel: 'kit complet', isKit: true,
  short: 'Kit composé : la disponibilité dépend du stock de chaque composant.',
  components: [
    { sku: 'DEMO-CAH-200', quantity: 3 },
    { sku: 'DEMO-STY-BLE', quantity: 1 },
    { sku: 'DEMO-COR-001', quantity: 1 },
  ],
};

/* ------------------------------------------------------------------ */
/* Aides                                                                */
/* ------------------------------------------------------------------ */
function categorySlugToId(slug) {
  const row = db.get('SELECT id FROM categories WHERE slug = ?', [slug]);
  return row ? row.id : null;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** Image de remplacement générée localement : aucune photo réelle n'est inventée. */
async function demoImage(label, family, second = false) {
  const [bg, fg] = COULEURS[family] || COULEURS.papeterie;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
  <rect width="900" height="900" fill="${second ? '#FFFFFF' : bg}"/>
  <rect x="24" y="24" width="852" height="852" fill="none" stroke="${fg}" stroke-opacity=".25" stroke-width="4"/>
  <text x="450" y="430" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" font-weight="bold" fill="${fg}" text-anchor="middle">${escapeXml(label)}</text>
  <text x="450" y="500" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" fill="${fg}" fill-opacity=".7" text-anchor="middle">image de démonstration</text>
</svg>`;
  return images.storeImage(await require('sharp')(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer(), { mime: 'image/jpeg' });
}

async function addImage(productId, label, family, { primary = false, alt = '', userId = null } = {}) {
  const stored = await demoImage(label, family, !primary);
  const mediaId = db.insert('media_files', {
    kind: 'image', file_key: stored.fileKey, filename: `demo-${stored.fileKey.replace(/\//g, '-')}.jpg`,
    mime: stored.sourceMime, bytes: stored.bytes, width: stored.width, height: stored.height,
    alt: alt || label, created_by: userId,
  });
  products.attachImage(productId, mediaId, { alt: alt || label, primary, userId });
}

function setVariantStock(productId, wanted) {
  const variants = db.all('SELECT * FROM product_variants WHERE product_id = ?', [productId]);
  for (const v of variants) {
    const expected = wanted.find((w) => w.sku === v.sku);
    if (!expected) continue;
    const item = stock.itemFor(productId, v.id);
    if (item) stock.setOnHand(item.id, expected.stock, { reason: 'initial', note: 'Stock de démonstration' });
  }
}

/* ------------------------------------------------------------------ */
/* Exécution                                                            */
/* ------------------------------------------------------------------ */
async function main() {
  console.log('— Jeu de données de démonstration —');
  console.log(`Base  : ${config.db.path}`);
  console.log(`Médias: ${config.storage.mediaDir}`);
  console.log('');

  db.migrate();
  seedCore({ verbose: false });

  // Marqueurs de démonstration : visibles sur le site et dans l'administration.
  db.setMeta('environment', 'demo');
  const admin = users.getByEmail(config.bootstrapAdmin.email) || users.listUsers()[0];
  const adminId = admin ? admin.id : null;

  settings.set('ui.demo_banner', true, adminId);
  settings.set('ui.home_intro', 'Boutique de démonstration : articles, prix et stocks fictifs, destinés à essayer l’interface.', adminId);
  settings.set('store.hours_status', 'confirmed', adminId);
  settings.set('store.hours', [
    { day: 'Lundi – Vendredi', open: '08:00', close: '18:00', closed: false, note: 'Horaires de démonstration' },
    { day: 'Samedi', open: '08:00', close: '16:00', closed: false, note: '' },
    { day: 'Dimanche', open: '', close: '', closed: true, note: 'Fermé' },
  ], adminId);

  // Un tarif de livraison réel pour Daoukro : la zone n'est plus « sur devis ».
  // La région et le reste du pays restent volontairement sur devis.
  const localZone = db.get("SELECT * FROM shipping_zones WHERE code = 'daoukro'");
  if (localZone && !db.get('SELECT id FROM shipping_rates WHERE zone_id = ?', [localZone.id])) {
    const shipping = require('../src/domain/shipping');
    shipping.saveRate({
      zone_id: localZone.id, label: 'Livraison Daoukro (démonstration)',
      min_weight_g: 0, max_weight_g: null, min_subtotal: 0, max_subtotal: null,
      price: 1000, per_extra_kg: 250, enabled: 1, position: 1,
      note: 'Tarif fictif destiné à la démonstration.',
    }, adminId);
    shipping.saveZone({
      id: localZone.id, code: localZone.code, name: localZone.name, kind: localZone.kind,
      enabled: 1, position: localZone.position, requires_quote: false, free_over: 100000,
      eta_text: 'Sous 24 à 48 h (démonstration).', conditions_text: localZone.conditions_text,
      cod_allowed: 1, default_carrier_id: null,
    }, adminId);
    settings.set('shipping.rates_confirmed', true, adminId);
    console.log('Tarif de livraison Daoukro : créé (fictif) — gratuit à partir de 100 000 FCFA.');
  }

  // Un vendeur, pour tester la séparation des rôles.
  if (!users.getByEmail('vendeur.demo@leprivilege.ci')) {
    try {
      users.createUser({
        email: 'vendeur.demo@leprivilege.ci', password: 'Vendeur-Demo-2026!',
        fullName: 'Vendeur de démonstration', phone: '', role: 'vendor',
        canConfirmCash: true, active: true,
      }, admin);
      console.log('Vendeur de démonstration : vendeur.demo@leprivilege.ci / Vendeur-Demo-2026!');
    } catch (err) {
      console.log('Vendeur de démonstration non créé :', err.message);
    }
  }

  // --- Articles ------------------------------------------------------------
  let created = 0;
  let skipped = 0;
  for (const item of CATALOGUE.concat([KIT])) {
    if (db.get('SELECT id FROM products WHERE sku = ?', [item.sku])) { skipped += 1; continue; }
    const categoryId = categorySlugToId(item.cat);
    // Dates au format YYYY-MM-DD : `dates.fromInput` applique alors 00:00 / 23:59:59.
    const promoStart = item.promo ? dates.toDateInput(dates.addDays(dates.nowIso(), -2)) : null;
    const promoEnd = item.promo ? dates.toDateInput(dates.addDays(dates.nowIso(), 20)) : null;

    const product = products.create({
      sku: item.sku,
      name: item.name,
      category_id: categoryId,
      short_description: item.short || 'Article de démonstration : caractéristiques fictives.',
      description: `<p>${escapeXml(item.short || 'Article de démonstration.')}</p><p>Cet article fait partie du jeu de données de démonstration : son prix, sa référence et sa disponibilité sont fictifs et ne décrivent pas le stock réel de l'établissement.</p>`,
      price: item.price || 0,
      compare_at_price: item.compare ?? null,
      promo_price: item.promo ?? null,
      promo_starts_at: promoStart,
      promo_ends_at: promoEnd,
      product_condition: item.condition || 'neuf',
      warranty: item.warranty || '',
      box_contents: item.boxContents || '',
      sale_unit: item.unit || 'piece',
      sale_unit_label: item.unitLabel || '',
      weight_g: item.weight ?? null,
      status: item.status || 'published',
      is_kit: item.isKit ? 1 : 0,
      track_stock: item.trackStock === false ? 0 : 1,
      low_stock_threshold: item.low || 0,
      qty: item.qty || 0,
      data_confirmed: item.confirmed === false ? 0 : 1,
      featured: item.sku === 'DEMO-CAH-200' || item.sku === 'DEMO-SMA-DEMO' || item.sku === 'DEMO-BAT-10K' ? 1 : 0,
      attributes: item.attributes
        ? Object.entries(item.attributes).map(([label, value]) => ({ label, value }))
        : [],
      variants: item.hasVariants
        ? item.variants.map((v, i) => ({ sku: v.sku, options: v.options, price: v.price ?? null, position: i, active: 1 }))
        : [],
    }, { userId: adminId });

    if (item.hasVariants) setVariantStock(product.id, item.variants);

    if (item.isKit && item.components) {
      const comps = item.components
        .map((c) => {
          const row = db.get('SELECT id FROM products WHERE sku = ?', [c.sku]);
          return row ? { component_product_id: row.id, quantity: c.quantity } : null;
        })
        .filter(Boolean);
      stock.saveKitComponents(product.id, comps);
      stock.syncItems(product.id, { userId: adminId });
    }

    const label = item.name.replace(/\s*\(démonstration\)\s*$/, '').slice(0, 34);
    await addImage(product.id, label, item.family, { primary: true, alt: `${label} — image de démonstration`, userId: adminId });
    if (!item.hasVariants && item.status === 'published') {
      await addImage(product.id, label, item.family, { primary: false, alt: `${label} — seconde image de démonstration`, userId: adminId });
    }
    created += 1;
  }

  console.log(`Articles : ${created} créé(s), ${skipped} déjà présent(s).`);

  // --- Vente au comptoir ----------------------------------------------------
  const seller = users.getByEmail('vendeur.demo@leprivilege.ci') || admin;
  const cahier = db.get("SELECT id FROM products WHERE sku = 'DEMO-CAH-200'");
  const stylo = db.get("SELECT id FROM products WHERE sku = 'DEMO-STY-BLE'");
  if (seller && cahier && stylo && !db.get('SELECT id FROM pos_sales LIMIT 1')) {
    pos.recordSale({
      lines: [{ productId: cahier.id, qty: 3 }, { productId: stylo.id, qty: 1 }],
      discount: 0, methodCode: 'pay_at_pickup', amountPaid: null,
      customerName: 'Client de démonstration', customerPhone: '0700000001',
      note: 'Vente de démonstration', user: seller,
    });
    console.log('Vente au comptoir : 1 enregistrée (statistiques non vides).');
  }

  // --- Commandes ------------------------------------------------------------
  if (withOrders) await seedDemoOrders(adminId);

  products.reindexAll();

  const counts = {
    articles: db.get('SELECT COUNT(*) AS n FROM products').n,
    publies: db.get("SELECT COUNT(*) AS n FROM products WHERE status='published'").n,
    images: db.get('SELECT COUNT(*) AS n FROM media_files').n,
    lignes_stock: db.get('SELECT COUNT(*) AS n FROM stock_items').n,
    commandes: db.get('SELECT COUNT(*) AS n FROM orders').n,
    ventes_comptoir: db.get('SELECT COUNT(*) AS n FROM pos_sales').n,
  };

  console.log('');
  console.log('Récapitulatif :');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('');
  console.log('Démarrer la boutique de démonstration (port 3100, base séparée) :');
  console.log('  DEMO=true PORT=3100 npm start');
  console.log('');
  console.log('Administration de démonstration :');
  console.log(`  ${config.bootstrapAdmin.email} / ${config.bootstrapAdmin.password}`);
  console.log('  vendeur.demo@leprivilege.ci / Vendeur-Demo-2026!');
  db.close();
}

/** Quelques commandes, créées via le vrai parcours métier (pas d'insertion directe). */
async function seedDemoOrders(adminId) {
  const orders = require('../src/domain/orders');
  const shipping = require('../src/domain/shipping');
  const payments = require('../src/domain/payments');
  const byRef = (sku) => db.get('SELECT id FROM products WHERE sku = ?', [sku]);
  const localZone = db.get("SELECT * FROM shipping_zones WHERE code = 'daoukro'");
  const iffouZone = db.get("SELECT * FROM shipping_zones WHERE code = 'iffou'");

  // Le retrait se règle en boutique ; une livraison se règle à la remise.
  // `pay_at_pickup` est refusé en livraison : c'est le comportement attendu.
  const cod = payments.getMethod('pay_on_delivery');
  if (cod && !cod.enabled) {
    payments.saveMethod('pay_on_delivery', {
      name: cod.name, enabled: true, simulated: true, position: cod.position,
      instructions: 'Vous réglez à la remise du colis. Démonstration : aucun encaissement réel.',
      merchant_ref: cod.merchant_ref, color: cod.color,
      modes: ['delivery'], zone_codes: [],
    }, adminId);
    console.log('Paiement à la livraison : activé pour la démonstration.');
  }

  // La région de l'Iffou reste « sur devis » (aucun tarif) mais autorise le
  // règlement à la remise, pour pouvoir montrer le parcours de devis.
  if (iffouZone && !iffouZone.cod_allowed) {
    shipping.saveZone(Object.assign({}, iffouZone, { cod_allowed: true }), adminId);
    console.log('Zone Iffou : règlement à la remise autorisé pour la démonstration (tarif toujours sur devis).');
  }

  const base = {
    paymentMethod: 'pay_at_pickup',
    termsAccepted: true,
    marketingConsent: false,
    customer: { fullName: 'Client de démonstration', phone: '0700000002' },
  };

  const made = [];
  try {
    const a = byRef('DEMO-CAH-200'); const b = byRef('DEMO-RAM-A4');
    if (a && b) {
      const r = orders.createOrder(Object.assign({}, base, {
        mode: 'pickup', idempotencyKey: 'demo-pickup-1',
        lines: [{ productId: a.id, qty: 4 }, { productId: b.id, qty: 2 }],
      }), { actorId: adminId, source: 'demo' });
      made.push(`retrait en boutique (${r.order.reference})`);
    }
  } catch (err) { made.push(`retrait échoué : ${err.message}`); }

  try {
    const c = byRef('DEMO-SOU-SF');
    if (c && localZone) {
      const r = orders.createOrder(Object.assign({}, base, {
        mode: 'delivery', zoneId: localZone.id, idempotencyKey: 'demo-local-1', paymentMethod: 'pay_on_delivery',
        shippingInfo: { city: 'Daoukro', quarter: 'Quartier de démonstration', address: 'Rue de démonstration', landmark: 'Repère fictif' },
        lines: [{ productId: c.id, qty: 2 }],
      }), { actorId: adminId, source: 'demo' });
      made.push(`livraison Daoukro tarifée (${r.order.reference})`);
    }
  } catch (err) { made.push(`livraison Daoukro échouée : ${err.message}`); }

  try {
    const d = byRef('DEMO-CHA-2A');
    if (d && iffouZone) {
      const r = orders.createOrder(Object.assign({}, base, {
        mode: 'delivery', zoneId: iffouZone.id, idempotencyKey: 'demo-quote-1', paymentMethod: 'pay_on_delivery',
        shippingInfo: { city: 'Bongouanou', quarter: 'Quartier de démonstration', address: '', landmark: '' },
        lines: [{ productId: d.id, qty: 3 }],
      }), { actorId: adminId, source: 'demo' });
      made.push(`livraison sur devis région Iffou (${r.order.reference})`);
    }
  } catch (err) { made.push(`devis échoué : ${err.message}`); }

  console.log('Commandes de démonstration :');
  for (const m of made) console.log('  ·', m);
}

main().catch((err) => {
  console.error('Échec du jeu de démonstration :', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
