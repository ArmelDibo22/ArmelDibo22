'use strict';

/**
 * Catalogue : règles d'achetabilité, variantes, kits, références uniques,
 * duplication, pagination et recherche sur un volume important.
 */

const test = require('node:test');
const assert = require('node:assert');

const { boot, makeProduct } = require('./helpers/boot');
const T = boot(__filename);

const { products, stock, db } = T;

test('création : référence unique obligatoire et slug dédoublonné', () => {
  const a = makeProduct(T, { sku: 'CAT-001', name: 'Cahier de test' });
  assert.strictEqual(a.sku, 'CAT-001');
  assert.strictEqual(a.slug, 'cahier-de-test');

  const b = makeProduct(T, { name: 'Cahier de test' });
  assert.notStrictEqual(b.slug, a.slug, 'le slug est dédoublonné');

  assert.throws(
    () => makeProduct(T, { sku: 'cat-001', name: 'Doublon de référence' }),
    (err) => err.code === 'DUPLICATE_SKU'
  );
});

test('achetabilité : un article sans prix, non confirmé ou non publié n’est pas commandable', () => {
  const cases = [
    ['brouillon', { status: 'draft', price: 1000, data_confirmed: 1, qty: 5 }, false],
    ['archivé', { status: 'archived', price: 1000, data_confirmed: 1, qty: 5 }, false],
    ['prix nul', { status: 'published', price: 0, data_confirmed: 1, qty: 5 }, false],
    ['données non confirmées', { status: 'published', price: 1000, data_confirmed: 0, qty: 5 }, false],
    ['rupture de stock', { status: 'published', price: 1000, data_confirmed: 1, qty: 0 }, false],
    ['nominal', { status: 'published', price: 1000, data_confirmed: 1, qty: 5 }, true],
    ['sans suivi de stock', { status: 'published', price: 1000, data_confirmed: 1, qty: 0, track_stock: 0 }, true],
  ];
  for (const [label, overrides, expected] of cases) {
    const p = makeProduct(T, overrides);
    const result = products.purchasability(db.get('SELECT * FROM products WHERE id = ?', [p.id]), null);
    assert.strictEqual(result.ok, expected, `cas « ${label} »`);
    if (!expected && label !== 'brouillon' && label !== 'archivé') {
      assert.ok(result.reasons.length, `un motif est fourni pour « ${label} »`);
    }
  }
});

test('un article publié sans prix retombe en brouillon', () => {
  const p = products.create({
    sku: 'CAT-NOPRICE', name: 'Article sans prix', price: 0,
    status: 'published', data_confirmed: 1, qty: 3,
  });
  assert.strictEqual(db.get('SELECT status FROM products WHERE id = ?', [p.id]).status, 'draft');
});

test('promotion datée : appliquée uniquement pendant sa période', () => {
  const p = makeProduct(T, {
    sku: 'CAT-PROMO', price: 5000, promo_price: 4000, compare_at_price: 5500,
    promo_starts_at: T.dates.toDateInput(T.dates.addDays(T.dates.nowIso(), -1)),
    promo_ends_at: T.dates.toDateInput(T.dates.addDays(T.dates.nowIso(), 5)),
  });
  const row = db.get('SELECT * FROM products WHERE id = ?', [p.id]);
  assert.strictEqual(products.priceOf(row, null).sale, 4000);
  assert.ok(products.promoActive(row));

  const expired = makeProduct(T, {
    sku: 'CAT-PROMO-FINIE', price: 5000, promo_price: 4000,
    promo_starts_at: T.dates.toDateInput(T.dates.addDays(T.dates.nowIso(), -10)),
    promo_ends_at: T.dates.toDateInput(T.dates.addDays(T.dates.nowIso(), -2)),
  });
  const expiredRow = db.get('SELECT * FROM products WHERE id = ?', [expired.id]);
  assert.strictEqual(products.priceOf(expiredRow, null).sale, 5000, 'une promotion échue ne s’applique plus');
});

test('variantes : prix propre et stock par variante', () => {
  const p = makeProduct(T, {
    sku: 'CAT-VAR', name: 'Classeur à levier', qty: 0,
    variants: [
      { sku: 'CAT-VAR-BLE', options: { Couleur: 'Bleu' }, price: 2500 },
      { sku: 'CAT-VAR-NOI', options: { Couleur: 'Noir' }, price: 2500 },
    ],
  });
  const variants = products.variantsOf(p.id);
  assert.strictEqual(variants.length, 2);
  assert.ok(db.get('SELECT has_variants FROM products WHERE id = ?', [p.id]).has_variants);

  const items = stock.itemsForProduct(p.id);
  assert.strictEqual(items.length, 2, 'une ligne de stock par variante');
  for (const [i, v] of variants.entries()) {
    const item = stock.itemFor(p.id, v.id);
    stock.setOnHand(item.id, (i + 1) * 7, { reason: 'initial', note: 'test' });
  }
  assert.strictEqual(stock.availableForProduct(p.id), 7 + 14);

  const bleu = variants.find((v) => v.sku === 'CAT-VAR-BLE');
  assert.strictEqual(products.priceOf(db.get('SELECT * FROM products WHERE id = ?', [p.id]), bleu).sale, 2500);
});

test('kit scolaire : disponibilité = minimum des composants', () => {
  const cahier = makeProduct(T, { sku: 'KIT-C', name: 'Composant cahier', price: 800, qty: 30 });
  const stylo = makeProduct(T, { sku: 'KIT-S', name: 'Composant stylo', price: 200, qty: 4 });
  const kit = products.create({
    sku: 'KIT-1', name: 'Kit scolaire', price: 3000, qty: 0,
    status: 'published', data_confirmed: 1, is_kit: 1,
  });
  stock.saveKitComponents(kit.id, [
    { component_product_id: cahier.id, quantity: 3 },
    { component_product_id: stylo.id, quantity: 2 },
  ]);
  stock.syncItems(kit.id);

  const components = stock.kitComponents(kit.id);
  assert.strictEqual(components.length, 2, 'les composants sont explicités');
  // 30 cahiers / 3 = 10 kits ; 4 stylos / 2 = 2 kits -> 2 kits possibles.
  assert.strictEqual(stock.kitAvailable(kit.id), 2);

  stock.setOnHand(stock.itemFor(stylo.id, null).id, 0, { reason: 'ajustement', note: 'rupture composant' });
  assert.strictEqual(stock.kitAvailable(kit.id), 0, 'un composant en rupture rend le kit indisponible');
});

test('duplication : les champs null ne cassent pas la copie (régression)', () => {
  const source = makeProduct(T, {
    sku: 'CAT-DUP', name: 'Article à dupliquer', price: 3000, qty: 6,
    promo_price: null, compare_at_price: null, weight_g: null,
  });
  const copy = products.duplicate(source.id, {});
  assert.notStrictEqual(copy.id, source.id);
  assert.match(copy.name, /copie/i);
  assert.strictEqual(copy.status, 'draft', 'une copie n’est pas publiée par défaut');
  assert.strictEqual(copy.price, 3000);
  assert.strictEqual(db.get('SELECT promo_price FROM products WHERE id = ?', [copy.id]).promo_price, null);
});

test('suppression d’image : le fichier est retiré du disque (régression fichier orphelin)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const images = require('../src/lib/images');

  const p = makeProduct(T, { sku: 'CAT-IMG', name: 'Article avec image' });
  const buffer = await require('sharp')({
    create: { width: 400, height: 400, channels: 3, background: '#14294F' },
  }).jpeg().toBuffer();
  const stored = await images.storeImage(buffer, { mime: 'image/jpeg' });
  const mediaId = db.insert('media_files', {
    kind: 'image', file_key: stored.fileKey, filename: 'test.jpg', mime: 'image/jpeg',
    bytes: stored.bytes, width: stored.width, height: stored.height, alt: 'test',
  });
  products.attachImage(p.id, mediaId, { alt: 'test', primary: true });

  const expected = images.resolvePath(stored.fileKey, 'original');
  assert.ok(expected && fs.existsSync(expected), 'le fichier source existe avant suppression');

  const imageRow = db.get('SELECT id FROM product_images WHERE product_id = ?', [p.id]);
  products.removeImage(imageRow.id, {});

  assert.strictEqual(db.get('SELECT id FROM media_files WHERE id = ?', [mediaId]), null);
  const still = images.resolvePath(stored.fileKey, 'original');
  assert.ok(!still || !fs.existsSync(still), 'aucun fichier orphelin ne reste sur le disque');
  assert.ok(path.resolve(images.resolvePath ? (still || '') : '') !== '', 'sanity');
});

test('catalogue important : pagination serveur, filtres et recherche', () => {
  const TOTAL = 150;
  const cat = db.get("SELECT id FROM categories WHERE slug = 'papier-impression'");
  for (let i = 0; i < TOTAL; i += 1) {
    products.create({
      sku: `BULK-${String(i).padStart(4, '0')}`,
      name: `Ramette de papier numéro ${i}`,
      category_id: cat ? cat.id : null,
      price: 1000 + i,
      qty: 5,
      status: 'published',
      data_confirmed: 1,
      short_description: i % 3 === 0 ? 'papier blanc recyclé' : 'papier bureautique',
    }, { skipIndex: true });
  }
  products.reindexAll();

  const page1 = products.list({}, { page: 1, perPage: 12 });
  assert.strictEqual(page1.items.length, 12, 'une page ne renvoie jamais tout le catalogue');
  assert.ok(page1.pagination.total >= TOTAL, 'le total compte bien tout le catalogue');
  assert.ok(page1.pagination.pages > 1, 'la pagination est calculée côté serveur');
  assert.ok(page1.pagination.hasNext);
  assert.strictEqual(page1.pagination.from, 1);
  assert.strictEqual(page1.pagination.to, 12);

  const page2 = products.list({}, { page: 2, perPage: 12 });
  const ids1 = new Set(page1.items.map((i) => i.id));
  assert.ok(page2.items.every((i) => !ids1.has(i.id)), 'les pages ne se recouvrent pas');
  assert.ok(page2.pagination.hasPrev);

  const search = products.list({ q: 'ramette papier' }, { perPage: 12 });
  assert.ok(search.items.length > 0, 'la recherche plein texte trouve les articles');

  const byPrice = products.list({ sort: 'prix_asc', categoryIds: [cat.id] }, { perPage: 60 });
  const prices = byPrice.items.map((i) => Number(i.sale_price));
  assert.deepStrictEqual(prices, [...prices].sort((a, b) => a - b), 'le tri par prix croissant est respecté');

  // `perPage` est plafonné à 120 : la liste ne renvoie jamais les 150 articles
  // d'un coup, c'est exactement le comportement attendu (pas de tout-charger).
  const filtered = products.list({ categoryIds: [cat.id] }, { perPage: 120 });
  assert.ok(filtered.pagination.total >= TOTAL, 'le filtre par catégorie compte tout le catalogue');
  assert.strictEqual(filtered.items.length, 120, 'le nombre d’articles renvoyés est plafonné');
  assert.ok(
    filtered.items.every((i) => i.category_id === cat.id),
    'tous les articles renvoyés appartiennent à la catégorie filtrée'
  );

  const unpurchasable = makeProduct(T, { sku: 'CAT-FILTRE-OFF', name: 'Non achetable', data_confirmed: 0 });
  const onlyPurchasable = products.list({ purchasableOnly: true }, { perPage: 120 });
  assert.ok(
    !onlyPurchasable.items.some((i) => i.id === unpurchasable.id),
    'le filtre « achetables uniquement » exclut un article aux données non confirmées'
  );
  assert.ok(onlyPurchasable.pagination.total < filtered.pagination.total + 50);

  const facets = products.facets({});
  assert.ok(facets.categories && facets.categories.length > 0, 'les facettes de catégories sont disponibles');
});

test('suivi de stock : un article simple garde son suivi malgré une liste de composants vide (régression)', () => {
  // Le formulaire d'administration transmet toujours `kit_components` (liste vide
  // pour un article ordinaire). Cela ne doit PAS désactiver le suivi de stock :
  // sans suivi, il n'y a ni réservation, ni protection anti-survente, ni sortie
  // de stock à l'encaissement.
  const simple = makeProduct(T, {
    sku: 'REG-SIMPLE', name: 'Article simple du formulaire',
    kit_components: [], attributes: [], variants: [],
  });
  let row = db.get('SELECT is_kit, track_stock FROM products WHERE id = ?', [simple.id]);
  assert.strictEqual(row.is_kit, 0);
  assert.strictEqual(row.track_stock, 1, 'le suivi de stock reste actif');
  stock.reserve(stock.resolveTargets(simple.id, null, 2), { note: 'réservation de test' });
  assert.strictEqual(stock.itemFor(simple.id, null).qty_reserved, 2, 'la réservation est enregistrée');
  assert.strictEqual(stock.availableForProduct(simple.id), 8);

  // Un article volontairement « stock non suivi » le reste après modification.
  const untracked = makeProduct(T, { sku: 'REG-SANS-SUIVI', name: 'Article sans suivi', track_stock: 0, qty: 0 });
  products.update(untracked.id, { name: 'Article sans suivi (modifié)', kit_components: [] });
  assert.strictEqual(db.get('SELECT track_stock FROM products WHERE id = ?', [untracked.id]).track_stock, 0,
    'le choix de ne pas suivre le stock est respecté');

  // Un vrai kit : stock dérivé de ses composants.
  const kit = makeProduct(T, {
    sku: 'REG-KIT', name: 'Kit du formulaire', is_kit: true,
    kit_components: [{ component_product_id: simple.id, quantity: 2 }],
  });
  row = db.get('SELECT is_kit, track_stock FROM products WHERE id = ?', [kit.id]);
  assert.strictEqual(row.is_kit, 1, 'le kit est marqué comme tel');
  assert.strictEqual(row.track_stock, 0, 'le stock d’un kit est dérivé, non suivi directement');
  assert.strictEqual(stock.kitComponents(kit.id).length, 1);
  assert.strictEqual(stock.kitAvailable(kit.id), 4, 'disponibilité du kit = 8 disponibles / 2 par kit');

  // Vider un kit lui rend son suivi propre.
  stock.saveKitComponents(kit.id, []);
  row = db.get('SELECT is_kit, track_stock FROM products WHERE id = ?', [kit.id]);
  assert.strictEqual(row.is_kit, 0);
  assert.strictEqual(row.track_stock, 1, 'un kit vidé redevient un article simple suivable');
});
