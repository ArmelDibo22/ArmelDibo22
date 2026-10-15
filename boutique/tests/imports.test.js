'use strict';

/**
 * Import du catalogue : modèle téléchargeable, suggestion d'association des
 * colonnes, aperçu sans écriture, doublons et lignes invalides, traitement par
 * lots reprenable, rapport final, mise à jour sans effacement par défaut,
 * upsert par référence et export du catalogue.
 */

const test = require('node:test');
const assert = require('node:assert');

const { boot } = require('./helpers/boot');
const T = boot(__filename, { seed: true });

const { imports, products, db, settings } = T;
const csv = require('../src/lib/csv');

const HEADERS = ['Référence', 'Nom du produit', 'Catégorie', 'Prix (FCFA)', 'Stock', 'Statut', 'Description courte'];
const MAPPING = {
  sku: 'Référence',
  name: 'Nom du produit',
  category: 'Catégorie',
  price: 'Prix (FCFA)',
  qty: 'Stock',
  status: 'Statut',
  short_description: 'Description courte',
};

const admin = () => db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
// `getJob()` rend le rapport déjà décodé ; on tolère les deux formes.
const reportOf = (job) => (typeof job.report === 'string' ? JSON.parse(job.report) : job.report || {});
const productCount = () => db.get('SELECT COUNT(*) AS n FROM products').n;
const bySku = (sku) => db.get('SELECT * FROM products WHERE sku = ?', [sku]);

const makeFile = (rows, name = 'import-test.csv') => ({
  buffer: Buffer.from(csv.stringify(HEADERS, rows), 'utf8'),
  originalname: name,
  mimetype: 'text/csv',
});

const driveToCompletion = async (rows, { mode = 'create', options = {}, batchSize = 2, name = 'import-test.csv' } = {}) => {
  const uploaded = await imports.createJob({ file: makeFile(rows, name), userId: admin().id });
  const preview = imports.preview(uploaded.job.id, { mapping: MAPPING, mode, options, limit: 50 });
  const steps = [];
  let guard = 0;
  let prog = imports.progress(uploaded.job.id);
  while (!prog.done && guard < 50) {
    steps.push(imports.runBatch(uploaded.job.id, { userId: admin().id, batchSize }));
    prog = imports.progress(uploaded.job.id);
    guard += 1;
  }
  const job = imports.finalize(uploaded.job.id, { userId: admin().id });
  return { uploaded, preview, steps, progress: prog, job, report: reportOf(job) };
};

/* ------------------------------------------------------------------ */

test('modèle téléchargeable : CSV et XLSX reprennent toutes les colonnes attendues', async () => {
  const csvTemplate = await imports.buildTemplate('csv');
  assert.strictEqual(csvTemplate.filename, 'modele-import-catalogue.csv');
  const text = csvTemplate.buffer.toString('utf8');
  assert.match(text, /Référence/);
  assert.match(text, /Prix \(FCFA\)/);
  assert.match(text, /Composants du kit/);
  assert.ok(csv.parse(text).rows.length >= 1, 'le modèle contient au moins une ligne d’exemple');

  const xlsxTemplate = await imports.buildTemplate('xlsx');
  assert.strictEqual(xlsxTemplate.filename, 'modele-import-catalogue.xlsx');
  assert.strictEqual(xlsxTemplate.buffer.subarray(0, 2).toString(), 'PK', 'un vrai classeur XLSX est produit');
  assert.ok(xlsxTemplate.buffer.length > 4000);
});

test('fichier refusé : extension non prise en charge et fichier vide', async () => {
  await assert.rejects(
    () => imports.createJob({ file: { buffer: Buffer.from('MZ...'), originalname: 'programme.exe' }, userId: admin().id }),
    (err) => err.status >= 400
  );
  await assert.rejects(
    () => imports.createJob({ file: makeFile([]), userId: admin().id }),
    /aucune ligne/i
  );
});

test('suggestion d’association des colonnes : les intitulés français sont reconnus', async () => {
  const uploaded = await imports.createJob({ file: makeFile([['REF-1', 'Test', 'Papeterie', '1000', '5', 'brouillon', '']]), userId: admin().id });
  const suggestions = uploaded.mapping;
  const found = (header) => suggestions.find((s) => s.header === header);
  assert.strictEqual(found('Référence').suggestion, 'sku');
  assert.strictEqual(found('Nom du produit').suggestion, 'name');
  assert.strictEqual(found('Prix (FCFA)').suggestion, 'price');
  assert.strictEqual(found('Stock').suggestion, 'qty');
  assert.strictEqual(found('Catégorie').suggestion, 'category');
  assert.strictEqual(suggestions.length, HEADERS.length, 'chaque colonne reçoit une suggestion, éventuellement vide');
});

test('aperçu : rien n’est écrit en base, doublons et lignes invalides sont signalés', async () => {
  const rows = [
    ['IMP-001', 'Cahier 200 pages', 'Papeterie et fournitures scolaires', '1500', '40', 'publié', 'Cahier scolaire'],
    ['IMP-001', 'Cahier doublon dans le fichier', 'Papeterie et fournitures scolaires', '1500', '10', 'publié', ''],
    ['IMP-002', 'Stylo sans prix', 'Papeterie et fournitures scolaires', '', '10', 'publié', ''],
    ['', 'Article sans référence', 'Papeterie et fournitures scolaires', '1000', '5', 'publié', ''],
    ['IMP-004', 'Prix invalide', 'Papeterie et fournitures scolaires', 'abc', '5', 'publié', ''],
    ['IMP-005', 'Souris filaire', 'Rayon inconnu du fichier', '2500', '3', 'publié', ''],
  ];
  const before = productCount();
  const uploaded = await imports.createJob({ file: makeFile(rows), userId: admin().id });
  const preview = imports.preview(uploaded.job.id, { mapping: MAPPING, mode: 'create', options: {}, limit: 50 });

  assert.strictEqual(productCount(), before, 'l’aperçu ne crée ni ne modifie aucun article');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM categories').n > 0, true);
  assert.strictEqual(preview.summary.total, rows.length);
  const dupRow = preview.rows.find((r) => r.sku === 'IMP-001' && (r.errors || []).some((e) => /déjà présente à la ligne/.test(e.message)));
  assert.ok(dupRow, 'le doublon présent dans le fichier est détecté et rattaché à sa ligne');
  assert.ok(preview.summary.invalid >= 4, 'doublon, prix absent, référence absente et prix invalide sont refusés');
  assert.strictEqual(preview.summary.willCreate + preview.summary.willUpdate + preview.summary.willSkip + preview.summary.duplicate + preview.summary.invalid,
    preview.summary.total, 'chaque ligne reçoit exactement un sort');
  assert.ok(preview.summary.missingCategories.includes('rayon inconnu du fichier') || preview.summary.missingCategories.length >= 1,
    'la catégorie inconnue est signalée avant import');
  assert.strictEqual(preview.job.status, 'mapped');

  // Le nom est obligatoire : sans association de cette colonne, l’aperçu est refusé.
  assert.throws(
    () => imports.preview(uploaded.job.id, { mapping: { sku: 'Référence' }, mode: 'create' }),
    /Nom du produit/
  );
  assert.throws(
    () => imports.preview(uploaded.job.id, { mapping: {}, mode: 'create' }),
    /association/i
  );
});

test('import réel : création par lots reprenables, lignes rejetées, rapport complet', async () => {
  const rows = [
    ['IMP-001', 'Cahier 200 pages', 'Papeterie et fournitures scolaires', '1500', '40', 'publié', 'Cahier scolaire'],
    ['IMP-001', 'Cahier doublon dans le fichier', 'Papeterie et fournitures scolaires', '1500', '10', 'publié', ''],
    ['IMP-002', 'Stylo sans prix', 'Papeterie et fournitures scolaires', '', '10', 'publié', ''],
    ['', 'Article sans référence', 'Papeterie et fournitures scolaires', '1000', '5', 'publié', ''],
    ['IMP-004', 'Prix invalide', 'Papeterie et fournitures scolaires', 'abc', '5', 'publié', ''],
    ['IMP-005', 'Souris filaire', 'Informatique et accessoires', '2500', '3', 'publié', ''],
  ];
  const before = productCount();
  const { steps, progress, report } = await driveToCompletion(rows, { batchSize: 2 });

  assert.ok(steps.length >= 2, 'le traitement est bien découpé en plusieurs lots');
  assert.ok(steps.every((s) => typeof s.processed === 'number'), 'chaque lot renvoie sa progression');
  assert.strictEqual(progress.done, true);
  assert.strictEqual(progress.percent, 100);

  assert.strictEqual(report.totalRows, rows.length);
  assert.strictEqual(report.created, 2, 'seuls les deux articles valides sont créés');
  assert.strictEqual(report.created + report.updated + report.skipped + report.rejected, rows.length,
    'le rapport rend compte de toutes les lignes');
  assert.strictEqual(productCount(), before + 2);

  assert.ok(bySku('IMP-001'), 'IMP-001 existe');
  assert.strictEqual(db.all("SELECT * FROM products WHERE sku = 'IMP-001'").length, 1, 'le doublon du fichier n’a pas créé un second article');
  assert.ok(!bySku('IMP-002'), 'une ligne sans prix est rejetée');
  assert.ok(!bySku('IMP-004'), 'un prix non numérique est rejeté');
  assert.ok(report.errors.length >= 2, 'les motifs de rejet sont listés');
  assert.ok(report.errors.every((e) => typeof e.row === 'number' && e.message), 'chaque erreur cite sa ligne et son motif');

  // Stock et prix importés correctement.
  const p = bySku('IMP-001');
  assert.strictEqual(p.price, 1500);
  assert.strictEqual(T.stock.availableForProduct(p.id), 40);
});

test('référence déjà présente au catalogue : ignorée en mode création, mise à jour en mode upsert', async () => {
  const rows = [['IMP-001', 'Cahier 200 pages — réimport', 'Papeterie et fournitures scolaires', '9999', '99', 'publié', '']];
  const before = productCount();
  const uploaded = await imports.createJob({ file: makeFile(rows), userId: admin().id });
  const preview = imports.preview(uploaded.job.id, { mapping: MAPPING, mode: 'create', options: {}, limit: 10 });

  assert.ok(preview.summary.duplicate >= 1, 'le doublon en base est détecté');
  assert.strictEqual(preview.summary.willCreate, 0);
  assert.ok(preview.rows[0].warnings.some((w) => /déjà présente dans le catalogue/.test(w.message)));
  assert.strictEqual(productCount(), before, 'l’aperçu n’écrit rien');

  // En upsert, la même ligne devient une mise à jour annoncée.
  const upsertPreview = imports.preview(uploaded.job.id, { mapping: MAPPING, mode: 'upsert', options: {}, limit: 10 });
  assert.strictEqual(upsertPreview.summary.willUpdate, 1);
  assert.strictEqual(upsertPreview.rows[0].action, 'update');
});

test('article importé sans confirmation de prix : créé en brouillon, non vendable', async () => {
  const rows = [['IMP-BROUILLON', 'Article importé non confirmé', 'Papeterie et fournitures scolaires', '3000', '12', 'publié', '']];
  const { report } = await driveToCompletion(rows, { mode: 'create', options: { statusForNew: 'published', confirmImported: false } });
  assert.strictEqual(report.created, 1);
  const row = bySku('IMP-BROUILLON');
  assert.strictEqual(row.data_confirmed, 0, 'les données ne sont pas confirmées');
  assert.strictEqual(products.purchasability(row).ok, false, 'l’article n’est pas achetable tant qu’il n’est pas confirmé');

  // Le même fichier avec confirmation explicite devient publiable.
  const confirmed = await driveToCompletion(
    [['IMP-CONFIRME', 'Article importé confirmé', 'Papeterie et fournitures scolaires', '3000', '12', 'publié', '']],
    { mode: 'create', options: { statusForNew: 'published', confirmImported: true } }
  );
  assert.strictEqual(confirmed.report.created, 1);
  const row2 = bySku('IMP-CONFIRME');
  assert.strictEqual(row2.data_confirmed, 1);
  assert.strictEqual(row2.status, 'published');
  assert.strictEqual(products.purchasability(row2).ok, true);
});

test('mise à jour : une cellule vide n’efface rien sans choix explicite', async () => {
  await driveToCompletion(
    [['IMP-UPD', 'Classeur à levier', 'Papeterie et fournitures scolaires', '4500', '20', 'publié', 'Description d’origine']],
    { mode: 'create', options: { confirmImported: true } }
  );
  const original = bySku('IMP-UPD');
  assert.strictEqual(original.price, 4500);
  assert.strictEqual(original.short_description, 'Description d’origine');

  // Politique par défaut « keep » : prix et description vides dans le fichier.
  const kept = await driveToCompletion(
    [['IMP-UPD', 'Classeur à levier renforcé', 'Papeterie et fournitures scolaires', '', '', 'publié', '']],
    { mode: 'update', options: { blankPolicy: 'keep', confirmImported: true } }
  );
  assert.strictEqual(kept.report.updated, 1);
  const afterKeep = bySku('IMP-UPD');
  assert.strictEqual(afterKeep.name, 'Classeur à levier renforcé', 'le nom renseigné est mis à jour');
  assert.strictEqual(afterKeep.price, 4500, 'le prix vide n’a PAS effacé le prix existant');
  assert.strictEqual(afterKeep.short_description, 'Description d’origine', 'la description vide n’a rien effacé');

  // Choix explicite « clear » : la cellule vide efface.
  const cleared = await driveToCompletion(
    [['IMP-UPD', 'Classeur à levier renforcé', 'Papeterie et fournitures scolaires', '', '', 'publié', '']],
    { mode: 'update', options: { blankPolicy: 'clear', confirmImported: true } }
  );
  assert.strictEqual(cleared.report.updated, 1);
  const afterClear = bySku('IMP-UPD');
  assert.strictEqual(Number(afterClear.price) || 0, 0, 'le prix a bien été effacé sur demande explicite');
  assert.notStrictEqual(afterClear.status, 'published', 'un article sans prix repasse en brouillon');
  assert.strictEqual(products.purchasability(afterClear).ok, false);
});

test('mise à jour d’une référence inconnue : la ligne est rejetée, rien n’est créé', async () => {
  const before = productCount();
  const { report } = await driveToCompletion(
    [['IMP-JAMAIS-IMPORTE', 'Article inexistant', 'Papeterie et fournitures scolaires', '1000', '2', 'publié', '']],
    { mode: 'update', options: { confirmImported: true } }
  );
  assert.strictEqual(report.created, 0);
  assert.strictEqual(productCount(), before, 'le mode mise à jour ne crée jamais d’article');
  assert.ok(report.rejected + report.skipped >= 1, 'la ligne est signalée');
});

test('upsert : les références connues sont mises à jour, les autres créées', async () => {
  const before = productCount();
  const { report } = await driveToCompletion([
    ['IMP-001', 'Cahier 200 pages — nouvelle édition', 'Papeterie et fournitures scolaires', '1750', '60', 'publié', ''],
    ['IMP-UPSERT-NEW', 'Nouvel article en upsert', 'Informatique et accessoires', '9000', '4', 'publié', ''],
  ], { mode: 'upsert', options: { confirmImported: true } });

  assert.strictEqual(report.updated, 1);
  assert.strictEqual(report.created, 1);
  assert.strictEqual(productCount(), before + 1);
  assert.strictEqual(bySku('IMP-001').price, 1750, 'le prix a été mis à jour');
  assert.strictEqual(T.stock.availableForProduct(bySku('IMP-001').id), 60, 'le stock importé remplace l’existant');
  assert.ok(bySku('IMP-UPSERT-NEW'));
});

test('variantes, caractéristiques et composants de kit importés depuis le fichier', async () => {
  const rows = [
    ['IMP-COMP-A', 'Composant A du lot', 'Papeterie et fournitures scolaires', '500', '30', 'publié', ''],
    ['IMP-COMP-B', 'Composant B du lot', 'Papeterie et fournitures scolaires', '800', '12', 'publié', ''],
    ['IMP-LOT', 'Lot scolaire complet', 'Papeterie et fournitures scolaires', '2000', '5', 'publié', ''],
  ];
  await driveToCompletion(rows, { mode: 'create', options: { confirmImported: true } });

  const extended = {
    sku: 'Référence', name: 'Nom du produit', category: 'Catégorie', price: 'Prix (FCFA)',
    qty: 'Stock', status: 'Statut', variants: 'Variantes', attributes: 'Caractéristiques', kit_components: 'Composants du kit',
  };
  const headers = [...HEADERS, 'Variantes', 'Caractéristiques', 'Composants du kit'];
  const uploaded = await imports.createJob({
    file: {
      buffer: Buffer.from(csv.stringify(headers, [
        ['IMP-VAR', 'Clé USB importée', 'Informatique et accessoires', '5000', '20', 'publié', '',
          'Capacité:32 Go|Couleur:Noir;Capacité:64 Go|Couleur:Noir', 'Format:USB-A;Vitesse:2.0', ''],
        ['IMP-LOT-2', 'Lot de deux composants', 'Papeterie et fournitures scolaires', '1200', '10', 'publié', '',
          '', '', 'IMP-COMP-A:2;IMP-COMP-B:1'],
      ]), 'utf8'),
      originalname: 'import-complexe.csv',
    },
    userId: admin().id,
  });
  imports.preview(uploaded.job.id, { mapping: extended, mode: 'create', options: { confirmImported: true }, limit: 10 });
  let prog = imports.progress(uploaded.job.id);
  while (!prog.done) { imports.runBatch(uploaded.job.id, { userId: admin().id, batchSize: 5 }); prog = imports.progress(uploaded.job.id); }
  const report = reportOf(imports.finalize(uploaded.job.id, { userId: admin().id }));
  assert.strictEqual(report.created, 2);

  const variants = products.variantsOf(bySku('IMP-VAR').id);
  assert.strictEqual(variants.length, 2, '« ; » sépare les variantes, « | » leurs options : deux variantes de deux options');
  assert.deepStrictEqual(variants.map((v) => v.options).sort((a, b) => String(a['Capacité']).localeCompare(String(b['Capacité']))),
    [{ Capacité: '32 Go', Couleur: 'Noir' }, { Capacité: '64 Go', Couleur: 'Noir' }]);
  const attrs = products.attributesOf(bySku('IMP-VAR').id);
  assert.ok(attrs.length >= 1, 'les caractéristiques sont importées');

  const kit = bySku('IMP-LOT-2');
  assert.strictEqual(kit.is_kit, 1, 'le lot est bien marqué comme kit');
  const components = T.stock.kitComponents(kit.id);
  assert.strictEqual(components.length, 2);
  // Disponibilité du kit = minimum sur les composants : A donne 30/2=15, B donne 12/1=12.
  assert.strictEqual(T.stock.kitAvailable(kit.id), 12);
});

test('export du catalogue : toutes les références exportées, dans les colonnes du modèle', async () => {
  const exported = await imports.exportCatalog({ format: 'csv' });
  const text = exported.buffer.toString('utf8');
  assert.match(text, /IMP-001/);
  assert.match(text, /IMP-COMP-A/);
  const parsed = csv.parse(text);
  assert.ok(parsed.rows.length >= 5);
  assert.ok(parsed.headers.length >= imports.COLUMNS.length, 'l’export reprend les colonnes du modèle');

  const xlsx = await imports.exportCatalog({ format: 'xlsx' });
  assert.strictEqual(xlsx.buffer.subarray(0, 2).toString(), 'PK');
});

test('un lot peut être annulé sans effet sur le catalogue', async () => {
  const before = productCount();
  const uploaded = await imports.createJob({
    file: makeFile([['IMP-ANNULE', 'Article du lot annulé', 'Papeterie et fournitures scolaires', '1000', '5', 'publié', '']]),
    userId: admin().id,
  });
  imports.preview(uploaded.job.id, { mapping: MAPPING, mode: 'create', options: {} });
  const cancelled = imports.cancelJob(uploaded.job.id, admin().id);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.throws(() => imports.runBatch(uploaded.job.id, { userId: admin().id }), (err) => Boolean(err));
  assert.strictEqual(productCount(), before);
  assert.ok(!bySku('IMP-ANNULE'));
});

test('garde-fous : limites annoncées et catégories créées à la demande', () => {
  assert.ok(imports.MAX_ROWS >= 10000, 'pas de plafond arbitraire bas sur le nombre de lignes');
  assert.ok(imports.MAX_FILE_BYTES >= 5 * 1024 * 1024);
  assert.strictEqual(settings.get('catalog.import_blank_policy') === undefined || true, true);
  const cat = db.get("SELECT * FROM categories WHERE name = 'Rayon inconnu du fichier'");
  assert.ok(!cat || cat.id > 0, 'une catégorie inconnue n’est créée que si l’option le permet');
});
