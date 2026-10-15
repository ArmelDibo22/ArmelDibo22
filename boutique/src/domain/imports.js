'use strict';

/**
 * Import et export du catalogue (.xlsx et .csv).
 *
 * Cycle complet :
 *   1. téléversement du fichier (type et taille contrôlés côté serveur) ;
 *   2. détection puis confirmation de l'association colonnes ↔ champs ;
 *   3. aperçu : toutes les lignes sont validées SANS rien écrire ;
 *   4. exécution par lots avec progression (aucun traitement monolithique) ;
 *   5. rapport : lignes créées, mises à jour, ignorées, rejetées et pourquoi.
 *
 * Règle importante : dans un fichier de MISE À JOUR, une cellule vide ne
 * supprime jamais une donnée existante, sauf choix explicite
 * (`blankPolicy = 'clear'`, global ou par colonne).
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const dates = require('../lib/dates');
const config = require('../config');
const csv = require('../lib/csv');
const money = require('../lib/money');
const { normalizeText, stripHtml } = require('../lib/slug');
const products = require('./products');
const categories = require('./categories');
const stock = require('./stock');

const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS || 50000);
const MAX_FILE_BYTES = Number(process.env.IMPORT_MAX_BYTES || 10 * 1024 * 1024);
const DEFAULT_BATCH = 50;

/** Champs importables : libellé, alias reconnus, type et contraintes. */
const COLUMNS = [
  { key: 'sku', label: 'Référence', type: 'text', required: true, aliases: ['reference', 'ref', 'code', 'sku', 'code article', 'code produit', 'reference unique', 'référence unique', 'article', 'ref article'] },
  { key: 'name', label: 'Nom du produit', type: 'text', required: true, aliases: ['nom', 'designation', 'désignation', 'produit', 'libelle', 'libellé', 'title', 'nom produit', 'article nom'] },
  { key: 'category', label: 'Catégorie', type: 'text', aliases: ['categorie', 'catégorie', 'famille', 'rayon', 'category', 'cat'] },
  { key: 'subcategory', label: 'Sous-catégorie', type: 'text', aliases: ['souscategorie', 'sous categorie', 'sous-catégorie', 'sous_categorie', 'sub_category', 'sous famille', 'sous-famille'] },
  { key: 'brand', label: 'Marque', type: 'text', aliases: ['marque', 'brand', 'fabricant', 'manufacturer', 'fournisseur'] },
  { key: 'short_description', label: 'Description courte', type: 'text', aliases: ['description courte', 'resume', 'résumé', 'accroche', 'short_description', 'descriptif court'] },
  { key: 'description', label: 'Description détaillée', type: 'richtext', aliases: ['description', 'description detaillee', 'description détaillée', 'details', 'détails', 'description longue'] },
  { key: 'price', label: 'Prix (FCFA)', type: 'amount', required: true, aliases: ['prix', 'price', 'pu', 'prix unitaire', 'prix fcfa', 'prix (fcfa)', 'montant', 'prix de vente', 'pv', 'prix ttc'] },
  { key: 'compare_at_price', label: 'Prix de référence barré (FCFA)', type: 'amount', aliases: ['prix barre', 'prix barré', 'prix avant', 'ancien prix', 'compare_at_price', 'prix normal'] },
  { key: 'promo_price', label: 'Prix promotionnel (FCFA)', type: 'amount', aliases: ['prix promo', 'promotion', 'prix promotionnel', 'promo', 'prix solde', 'prix réduit'] },
  { key: 'promo_starts_at', label: 'Promotion début', type: 'date', aliases: ['promo debut', 'promo début', 'debut promotion', 'début promotion', 'date debut', 'date début'] },
  { key: 'promo_ends_at', label: 'Promotion fin', type: 'date', aliases: ['promo fin', 'fin promotion', 'date fin', 'valable jusqu au'] },
  { key: 'qty', label: 'Stock', type: 'integer', aliases: ['stock', 'quantite', 'quantité', 'qte', 'qty', 'stock disponible', 'quantité en stock', 'disponible'] },
  { key: 'low_stock_threshold', label: 'Seuil d’alerte', type: 'integer', aliases: ['seuil', 'seuil alerte', "seuil d'alerte", 'alerte stock', 'stock minimum', 'seuil bas'] },
  { key: 'track_stock', label: 'Suivi du stock (oui/non)', type: 'boolean', aliases: ['suivi stock', 'suivre le stock', 'track_stock', 'gerer stock', 'gérer stock'] },
  { key: 'sale_unit', label: 'Unité de vente', type: 'unit', aliases: ['unite', 'unité', 'unite de vente', 'unité de vente', 'uom', 'conditionnement', 'type de vente'] },
  { key: 'product_condition', label: 'État (neuf / reconditionné)', type: 'condition', aliases: ['etat', 'état', 'condition', 'neuf', 'etat produit', 'état produit'] },
  { key: 'warranty', label: 'Garantie', type: 'text', aliases: ['garantie', 'warranty', 'garantie constructeur'] },
  { key: 'box_contents', label: 'Contenu fourni', type: 'richtext', aliases: ['contenu', 'contenu fourni', 'contenu du carton', 'fourni avec', 'dans la boite', 'dans la boîte', 'accessoires inclus'] },
  { key: 'weight_g', label: 'Poids (g)', type: 'integer', aliases: ['poids', 'poids (g)', 'poids g', 'weight', 'poids en grammes'] },
  { key: 'length_cm', label: 'Longueur (cm)', type: 'number', aliases: ['longueur', 'longueur (cm)', 'long', 'length'] },
  { key: 'width_cm', label: 'Largeur (cm)', type: 'number', aliases: ['largeur', 'largeur (cm)', 'width', 'larg'] },
  { key: 'height_cm', label: 'Hauteur (cm)', type: 'number', aliases: ['hauteur', 'hauteur (cm)', 'height', 'epaisseur', 'épaisseur'] },
  { key: 'status', label: 'Statut (brouillon / publié / archivé)', type: 'status', aliases: ['statut', 'status', 'etat publication', 'publication', 'visibilite', 'visibilité'] },
  { key: 'data_confirmed', label: 'Prix et disponibilité confirmés (oui/non)', type: 'boolean', aliases: ['confirme', 'confirmé', 'donnees confirmees', 'données confirmées', 'confirmation', 'valide'] },
  { key: 'variants', label: 'Variantes', type: 'variants', aliases: ['variantes', 'options', 'declinaisons', 'déclinaisons', 'variants'] },
  { key: 'attributes', label: 'Caractéristiques', type: 'attributes', aliases: ['caracteristiques', 'caractéristiques', 'attributs', 'specs', 'specifications', 'spécifications', 'fiche technique'] },
  { key: 'kit_components', label: 'Composants du kit', type: 'kit', aliases: ['kit', 'composants', 'composants du kit', 'contenu du kit', 'lot', 'composition'] },
  { key: 'meta_title', label: 'Titre SEO', type: 'text', aliases: ['titre seo', 'meta_title', 'title seo'] },
  { key: 'meta_description', label: 'Description SEO', type: 'text', aliases: ['description seo', 'meta_description', 'resume seo'] },
];

const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** Exemple de lignes fournies dans le modèle téléchargeable. */
const TEMPLATE_ROWS = [
  {
    sku: 'PAP-CAH-200',
    name: 'Cahier 200 pages grands carreaux',
    category: 'Papeterie et fournitures scolaires',
    subcategory: 'Cahiers et registres',
    brand: '',
    short_description: 'Cahier format A4, couverture cartonnée.',
    description: 'Cahier 200 pages, réglure Seyès, couverture cartonnée plastifiée. Adapté au collège et au lycée.',
    price: 1500,
    compare_at_price: '',
    promo_price: '',
    promo_starts_at: '',
    promo_ends_at: '',
    qty: 120,
    low_stock_threshold: 20,
    track_stock: 'oui',
    sale_unit: 'piece',
    product_condition: 'neuf',
    warranty: '',
    box_contents: '1 cahier',
    weight_g: 350,
    length_cm: 29.7,
    width_cm: 21,
    height_cm: 1,
    status: 'brouillon',
    data_confirmed: 'non',
    variants: '',
    attributes: 'Format:A4;Nombre de pages:200;Réglure:Seyès',
    kit_components: '',
    meta_title: '',
    meta_description: '',
  },
  {
    sku: 'TEL-CHG-20W',
    name: 'Chargeur rapide 20 W',
    category: 'Téléphones et accessoires',
    subcategory: 'Chargeurs et câbles',
    brand: '',
    short_description: 'Chargeur mural USB-C 20 W.',
    description: 'Chargeur mural USB-C, puissance 20 W, compatible charge rapide.',
    price: 5000,
    qty: 25,
    low_stock_threshold: 5,
    track_stock: 'oui',
    sale_unit: 'piece',
    product_condition: 'neuf',
    box_contents: '1 chargeur',
    weight_g: 60,
    status: 'brouillon',
    data_confirmed: 'non',
    attributes: 'Puissance:20 W;Connectique:USB-C',
  },
  {
    sku: 'KIT-SCOL-CP',
    name: 'Kit scolaire CP (exemple de lot)',
    category: 'Papeterie et fournitures scolaires',
    subcategory: 'Kits scolaires',
    short_description: 'Kit complet de rentrée : composants à renseigner.',
    description: 'Kit de rentrée scolaire. Les composants et leurs quantités sont listés dans la colonne « Composants du kit » au format REFERENCE:QUANTITE séparées par des points-virgules.',
    price: 12000,
    qty: 0,
    track_stock: 'non',
    sale_unit: 'kit',
    status: 'brouillon',
    data_confirmed: 'non',
    kit_components: 'PAP-CAH-200:6;PAP-STY-BIC:4',
  },
];

/* ------------------------------------------------------------------ */
/* Lecture des fichiers                                                */
/* ------------------------------------------------------------------ */
function assertImportFile(file) {
  if (!file) throw Object.assign(new Error('Aucun fichier reçu.'), { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    throw Object.assign(
      new Error(`Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite : ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} Mo. Découpez le fichier en plusieurs lots.`),
      { status: 413 }
    );
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  const format = ['.xlsx', '.xlsm'].includes(ext) ? 'xlsx' : ext === '.csv' ? 'csv' : null;
  if (!format) {
    throw Object.assign(new Error("Format non pris en charge. Utilisez un fichier .xlsx ou .csv."), { status: 415 });
  }
  return format;
}

/** Lit un fichier .xlsx en tableau de tableaux (première feuille). */
async function readXlsx(filePath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const values = ws.getSheetValues(); // index 0 inutilisé
  const matrix = values.slice(1).filter((r) => Array.isArray(r) && r.some((c) => cellText(c) !== ''));
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = matrix[0].map((h, i) => cellText(h) || `colonne_${i + 1}`);
  const rows = matrix.slice(1).map((r) => headers.map((_, i) => cellText(r[i + 1] !== undefined ? r[i + 1] : r[i])));
  return { headers, rows };
}

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'object') {
    if ('text' in cell) return normalizeText(String(cell.text ?? ''));
    if ('result' in cell) return cellText(cell.result);
    if ('richText' in cell && Array.isArray(cell.richText)) return normalizeText(cell.richText.map((t) => t.text).join(''));
    if ('hyperlink' in cell) return normalizeText(String(cell.text || cell.hyperlink || ''));
    return normalizeText(String(cell.valueOf?.() ?? ''));
  }
  return normalizeText(String(cell));
}

function readCsvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const { headers, rows } = csv.parse(text, { maxRows: MAX_ROWS + 10 });
  return { headers, rows };
}

async function readFile(filePath, format) {
  const out = format === 'xlsx' ? await readXlsx(filePath) : readCsvFile(filePath);
  if (!out.headers.length) throw Object.assign(new Error('Aucune colonne détectée dans le fichier.'), { status: 400 });
  if (out.rows.length > MAX_ROWS) {
    throw Object.assign(new Error(`Fichier trop volumineux : ${out.rows.length} lignes (limite ${MAX_ROWS}). Découpez-le en plusieurs lots.`), { status: 413 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Association des colonnes                                            */
/* ------------------------------------------------------------------ */
function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\u0000-\u007f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Propose une association automatique colonne → champ. */
function suggestMapping(headers) {
  const suggestions = headers.map((header) => {
    const norm = normalizeHeader(header);
    let best = null;
    for (const col of COLUMNS) {
      const candidates = [col.key, col.label, ...col.aliases].map(normalizeHeader);
      if (candidates.includes(norm)) {
        best = { key: col.key, score: 3, reason: 'correspondance exacte' };
        break;
      }
      const partial = candidates.find((c) => c && (norm.includes(c) || c.includes(norm)) && Math.min(norm.length, c.length) > 3);
      if (partial && (!best || best.score < 2)) {
        best = { key: col.key, score: 2, reason: 'correspondance partielle' };
      }
    }
    return { header, index: headers.indexOf(header), suggestion: best ? best.key : '', confidence: best ? best.score : 0, reason: best ? best.reason : 'non reconnu' };
  });
  // Évite d'affecter deux colonnes au même champ : la plus précise gagne.
  const used = new Map();
  for (const s of suggestions) {
    if (!s.suggestion) continue;
    const current = used.get(s.suggestion);
    if (!current || current.confidence < s.confidence) {
      if (current) current.suggestion = '';
      used.set(s.suggestion, s);
    } else {
      s.suggestion = '';
      s.reason = `déjà associé à « ${current.header} »`;
    }
  }
  return suggestions;
}

/* ------------------------------------------------------------------ */
/* Création du lot d'import                                            */
/* ------------------------------------------------------------------ */
async function createJob({ file, userId = null }) {
  const format = assertImportFile(file);
  fs.mkdirSync(config.storage.importDir, { recursive: true });
  const stored = path.join(config.storage.importDir, `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname || '')}`);
  fs.writeFileSync(stored, file.buffer);

  const { headers, rows } = await readFile(stored, format);
  if (!rows.length) {
    fs.rmSync(stored, { force: true });
    throw Object.assign(new Error('Le fichier ne contient aucune ligne de données.'), { status: 400 });
  }

  const jobId = db.insert('import_jobs', {
    filename: path.basename(file.originalname || 'import'),
    stored_path: stored,
    format,
    mode: 'preview',
    mapping: JSON.stringify({}),
    options: JSON.stringify({}),
    status: 'uploaded',
    total_rows: rows.length,
    batch_size: DEFAULT_BATCH,
    created_by: userId,
  });

  rows.forEach((row, index) => {
    db.insert('import_rows', {
      job_id: jobId,
      row_number: index + 2, // +2 : en-tête en ligne 1, index 0 => ligne 2
      data: JSON.stringify(Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))),
      status: 'pending',
    });
  });

  return {
    job: getJob(jobId),
    headers,
    sample: rows.slice(0, 10).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    mapping: suggestMapping(headers),
    rowCount: rows.length,
  };
}

/**
 * Relit les en-têtes et un échantillon du fichier conservé sur le disque.
 * Utile après l'aperçu : les lignes stockées ont alors été normalisées et ne
 * contiennent plus les intitulés d'origine des colonnes.
 */
async function headersFor(jobId, { sampleSize = 5 } = {}) {
  const job = getJob(jobId);
  if (!job || !job.stored_path || !fs.existsSync(job.stored_path)) {
    return { headers: [], sample: [], available: false };
  }
  try {
    const { headers, rows } = await readFile(job.stored_path, job.format);
    return {
      headers,
      available: true,
      sample: rows.slice(0, sampleSize).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    };
  } catch (err) {
    return { headers: [], sample: [], available: false, error: err.message };
  }
}

/**
 * Bilan de l'aperçu, recalculé depuis les lignes stockées (l'aperçu n'écrit
 * aucun produit : il qualifie chaque ligne et prépare l'exécution).
 */
function previewSummary(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const rows = db.all('SELECT status, action, message FROM import_rows WHERE job_id = ?', [Number(jobId)]);
  const out = {
    total: rows.length,
    create: 0,
    update: 0,
    skip: 0,
    duplicate: 0,
    invalid: 0,
    ready: 0,
    missingCategories: [],
    missingSkus: [],
    warnings: 0,
  };
  const missingCategories = new Set();
  const missingSkus = new Set();
  for (const r of rows) {
    const meta = safeParse(r.message, {});
    const previewStatus = meta.previewStatus || r.status;
    if (previewStatus === 'error') out.invalid += 1;
    else if (previewStatus === 'duplicate') out.duplicate += 1;
    else if (r.action === 'skip') out.skip += 1;
    else if (r.action === 'update') out.update += 1;
    else out.create += 1;
    if (previewStatus !== 'error') out.ready += 1;
    for (const e of meta.errors || []) {
      if (/catégorie/i.test(e.message)) missingCategories.add(e.message);
      if (/introuvable/i.test(e.message)) missingSkus.add(e.message);
    }
    out.warnings += (meta.warnings || []).length;
  }
  out.missingCategories = [...missingCategories].slice(0, 20);
  out.missingSkus = [...missingSkus].slice(0, 20);
  return out;
}

function getJob(id) {
  const job = db.get('SELECT * FROM import_jobs WHERE id = ?', [Number(id)]);
  if (!job) return null;
  return {
    ...job,
    mapping: safeParse(job.mapping, {}),
    options: safeParse(job.options, {}),
    report: safeParse(job.report, {}),
  };
}

function listJobs(limit = 30) {
  return db.all(
    `SELECT j.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM import_rows r WHERE r.job_id = j.id AND r.status = 'error') AS errors
       FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by
      ORDER BY j.id DESC LIMIT ?`,
    [Number(limit)]
  ).map((j) => ({ ...j, mapping: safeParse(j.mapping, {}), options: safeParse(j.options, {}), report: safeParse(j.report, {}) }));
}

function jobRows(jobId, { status = null, limit = 200, offset = 0 } = {}) {
  const where = ['job_id = ?'];
  const params = [Number(jobId)];
  if (status) { where.push('status = ?'); params.push(status); }
  return db.all(
    `SELECT * FROM import_rows WHERE ${where.join(' AND ')} ORDER BY row_number ASC LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  ).map((r) => ({ ...r, data: safeParse(r.data, {}) }));
}

/* ------------------------------------------------------------------ */
/* Normalisation d'une ligne selon l'association choisie               */
/* ------------------------------------------------------------------ */
function applyMapping(rawRow, mapping) {
  const out = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (!column) continue;
    // Après un premier aperçu, les lignes stockées sont déjà normalisées : les
    // intitulés d'origine des colonnes ont disparu. On retombe alors sur la clé du
    // champ, pour qu'un second aperçu (autre mode, autre association) reste fidèle
    // au fichier au lieu de produire des lignes vides.
    if (rawRow[column] !== undefined) out[field] = rawRow[column];
    else if (rawRow[field] !== undefined) out[field] = rawRow[field];
    else out[field] = '';
  }
  return out;
}

function parseBoolean(value, fallback = null) {
  const s = normalizeText(String(value ?? '')).toLowerCase();
  if (!s) return fallback;
  if (['oui', 'o', 'yes', 'y', '1', 'true', 'vrai', 'actif', 'x'].includes(s)) return true;
  if (['non', 'n', 'no', '0', 'false', 'faux', 'inactif'].includes(s)) return false;
  return fallback;
}

/**
 * "Couleur:Bleu|Capacité:128 Go;Couleur:Rouge|Capacité:64 Go"
 *   -> [{Couleur:'Bleu',Capacité:'128 Go'},{Couleur:'Rouge',Capacité:'64 Go'}]
 * « ; » sépare les variantes, « | » les options d'une même variante. Si une même
 * option est répétée dans un groupe (« Couleur:Bleu|Couleur:Rouge »), on comprend
 * qu'il s'agit de deux variantes et on découpe en conséquence.
 */
function parseVariants(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (v && typeof v === 'object' ? v : null))
      .filter((o) => o && Object.keys(o).length);
  }
  const s = normalizeText(String(value ?? ''));
  if (!s) return [];
  const groups = [];
  for (const part of s.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const bits = part
      .split(/[|/]+/)
      .map((b) => b.trim())
      .filter(Boolean)
      .map((bit) => {
        const [k, ...rest] = bit.split(':');
        return { key: normalizeText(k), val: normalizeText(rest.join(':')) };
      })
      .filter((o) => o.key && o.val);
    if (!bits.length) continue;
    let current = {};
    for (const bit of bits) {
      if (Object.prototype.hasOwnProperty.call(current, bit.key)) {
        groups.push(current);
        current = {};
      }
      current[bit.key] = bit.val;
    }
    if (Object.keys(current).length) groups.push(current);
  }
  return groups;
}

/** "Format:A4;Pages:200" -> [{label:'Format', value:'A4'}, ...] */
function parseAttributes(value) {
  if (Array.isArray(value)) {
    return value.filter((a) => a && typeof a === 'object' && a.label && a.value);
  }
  const s = normalizeText(String(value ?? ''));
  if (!s) return [];
  return s
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [k, ...rest] = part.split(':');
      return { label: normalizeText(k), value: normalizeText(rest.join(':')) };
    })
    .filter((a) => a.label && a.value);
}

/** "REF1:2;REF2:1" -> [{sku, qty}] */
function parseKit(value) {
  if (Array.isArray(value)) {
    return value.filter((k) => k && typeof k === 'object' && k.sku);
  }
  const s = normalizeText(String(value ?? ''));
  if (!s) return [];
  return s
    .split(/[;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [sku, qty] = p.split(':');
      return { sku: normalizeText(sku).toUpperCase(), qty: Math.max(1, Math.round(Number(qty) || 1)) };
    })
    .filter((k) => k.sku);
}

const UNIT_ALIASES = {
  piece: 'piece', pièces: 'piece', piece: 'piece', unite: 'piece', 'unité': 'piece', pc: 'piece',
  lot: 'lot', lots: 'lot',
  paquet: 'paquet', paquets: 'paquet',
  rame: 'rame', rames: 'rame',
  carton: 'carton', cartons: 'carton',
  boite: 'boite', boîte: 'boite',
  paire: 'paire', paires: 'paire',
  kit: 'kit', kits: 'kit',
};

const STATUS_ALIASES = {
  brouillon: 'draft', draft: 'draft', 'non publié': 'draft', 'non publie': 'draft', invisible: 'draft',
  publie: 'published', publié: 'published', published: 'published', actif: 'published', visible: 'published', en_ligne: 'published',
  archive: 'archived', archivé: 'archived', archived: 'archived', inactif: 'archived',
};

const CONDITION_ALIASES = {
  neuf: 'neuf', new: 'neuf',
  reconditionne: 'reconditionne', reconditionné: 'reconditionne', refurbished: 'reconditionne', 'comme neuf': 'reconditionne',
  occasion: 'occasion', used: 'occasion', 'seconde main': 'occasion',
};

function normalizeRow(mapped, options) {
  const out = {};
  const errors = [];
  const warnings = [];

  out.sku = normalizeText(String(mapped.sku ?? '')).toUpperCase().slice(0, 80);
  out.name = normalizeText(String(mapped.name ?? '')).slice(0, 250);
  if (!out.name) errors.push({ field: 'name', message: 'Le nom du produit est obligatoire.' });

  out.category = normalizeText(mapped.category || '');
  out.subcategory = normalizeText(mapped.subcategory || '');
  out.brand = normalizeText(mapped.brand || '');
  out.short_description = normalizeText(mapped.short_description || '').slice(0, 500);
  out.description = String(mapped.description || '').trim();

  // Prix
  for (const key of ['price', 'compare_at_price', 'promo_price']) {
    const raw = mapped[key];
    if (raw === undefined || normalizeText(String(raw ?? '')) === '') {
      out[key] = null;
      continue;
    }
    const value = money.toCents(raw);
    if (value === null) errors.push({ field: key, message: `Montant illisible : « ${raw} ».` });
    else if (value < 0) errors.push({ field: key, message: 'Un montant ne peut pas être négatif.' });
    else out[key] = value;
  }
  if (out.price === null && !options.allowMissingPrice) {
    // En mise à jour, un prix absent ne bloque pas la ligne : avec la politique par
    // défaut il signifie « ne pas modifier » (sinon aucun fichier de stock seul ne
    // passerait), et avec l'effacement explicite il vide le prix — l'article repasse
    // alors en brouillon, ce que l'avertissement suivant annonce.
    if (options.mode === 'update') {
      warnings.push({
        field: 'price',
        message: options.blankPolicy === 'clear'
          ? 'Prix non renseigné : le prix existant sera effacé (choix explicite) et l’article repassera en brouillon.'
          : 'Prix non renseigné : le prix existant sera conservé.',
      });
    } else {
      errors.push({ field: 'price', message: 'Prix manquant. Sans prix, l’article ne peut pas être publié (il sera importé en brouillon).' });
    }
  }
  if (out.promo_price !== null && out.price !== null && out.promo_price >= out.price) {
    warnings.push({ field: 'promo_price', message: 'Le prix promotionnel est supérieur ou égal au prix normal : promotion ignorée.' });
    out.promo_price = null;
  }
  out.promo_starts_at = mapped.promo_starts_at ? dates.fromInput(mapped.promo_starts_at) : null;
  out.promo_ends_at = mapped.promo_ends_at ? dates.fromInput(mapped.promo_ends_at, { endOfDay: true }) : null;
  if (out.promo_starts_at && out.promo_ends_at && out.promo_ends_at < out.promo_starts_at) {
    errors.push({ field: 'promo_ends_at', message: 'La fin de promotion précède son début.' });
  }

  // Stock
  for (const key of ['qty', 'low_stock_threshold', 'weight_g']) {
    const raw = mapped[key];
    if (raw === undefined || normalizeText(String(raw ?? '')) === '') { out[key] = null; continue; }
    const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) errors.push({ field: key, message: `Valeur numérique illisible : « ${raw} ».` });
    else if (n < 0) errors.push({ field: key, message: 'Valeur négative interdite.' });
    else out[key] = Math.round(n);
  }
  for (const key of ['length_cm', 'width_cm', 'height_cm']) {
    const raw = mapped[key];
    if (raw === undefined || normalizeText(String(raw ?? '')) === '') { out[key] = null; continue; }
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) errors.push({ field: key, message: `Dimension illisible : « ${raw} ».` });
    else out[key] = n;
  }

  const track = parseBoolean(mapped.track_stock);
  out.track_stock = track === null ? undefined : track;

  out.sale_unit = UNIT_ALIASES[normalizeText(mapped.sale_unit || '').toLowerCase()] || undefined;
  if (mapped.sale_unit && !out.sale_unit) warnings.push({ field: 'sale_unit', message: `Unité « ${mapped.sale_unit} » non reconnue : « autre » sera utilisé.` });

  out.product_condition = CONDITION_ALIASES[normalizeText(mapped.product_condition || '').toLowerCase()] || undefined;
  out.status = STATUS_ALIASES[normalizeText(mapped.status || '').toLowerCase()] || undefined;
  if (mapped.status && !out.status) warnings.push({ field: 'status', message: `Statut « ${mapped.status} » non reconnu : « brouillon » sera utilisé.` });

  const confirmed = parseBoolean(mapped.data_confirmed);
  out.data_confirmed = confirmed === null ? undefined : confirmed;

  out.warranty = normalizeText(mapped.warranty || '').slice(0, 300);
  out.box_contents = String(mapped.box_contents || '').trim();
  out.meta_title = normalizeText(mapped.meta_title || '').slice(0, 160);
  out.meta_description = normalizeText(mapped.meta_description || '').slice(0, 400);
  out.variants = parseVariants(mapped.variants);
  out.attributes = parseAttributes(mapped.attributes);
  out.kit_components = parseKit(mapped.kit_components);

  return { data: out, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* Aperçu : validation complète sans écriture                          */
/* ------------------------------------------------------------------ */
function preview(jobId, { mapping, mode = 'create', options = {}, limit = 20 } = {}) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Lot d’import introuvable.'), { status: 404 });
  if (!mapping || !Object.keys(mapping).length) {
    throw Object.assign(new Error('Aucune association de colonnes fournie.'), { status: 400 });
  }
  if (!mapping.name) throw Object.assign(new Error('La colonne « Nom du produit » doit être associée.'), { status: 400 });

  const opts = {
    mode: ['create', 'update', 'upsert'].includes(mode) ? mode : 'create',
    blankPolicy: options.blankPolicy === 'clear' ? 'clear' : 'keep',
    clearColumns: Array.isArray(options.clearColumns) ? options.clearColumns : [],
    statusForNew: ['draft', 'published'].includes(options.statusForNew) ? options.statusForNew : 'draft',
    createMissingCategories: options.createMissingCategories !== false,
    createMissingBrands: options.createMissingBrands !== false,
    generateMissingSku: Boolean(options.generateMissingSku),
    confirmImported: Boolean(options.confirmImported),
    allowMissingPrice: Boolean(options.allowMissingPrice),
    batchSize: Math.max(1, Math.min(500, Number(options.batchSize) || DEFAULT_BATCH)),
  };

  const rows = db.all('SELECT * FROM import_rows WHERE job_id = ? ORDER BY row_number ASC', [Number(jobId)]);
  const existingSkus = new Set(db.all('SELECT sku FROM products WHERE sku IS NOT NULL').map((r) => String(r.sku).toUpperCase()));
  const existingCategories = new Map(db.all('SELECT id, name, slug FROM categories').map((c) => [normalizeText(c.name).toLowerCase(), c]));
  const seenInFile = new Map();

  const summary = { total: rows.length, valid: 0, invalid: 0, duplicate: 0, willCreate: 0, willUpdate: 0, willSkip: 0, missingCategories: new Set(), missingSkus: new Set() };
  const previewRows = [];

  for (const row of rows) {
    const raw = safeParse(row.data, {});
    const mapped = applyMapping(raw, mapping);
    const { data, errors, warnings } = normalizeRow(mapped, opts);
    const rowResult = {
      rowNumber: row.row_number,
      sku: data.sku,
      name: data.name,
      errors,
      warnings,
      action: 'create',
      status: 'ok',
    };

    // Référence
    if (!data.sku) {
      if (opts.generateMissingSku) {
        data.sku = `IMP-${String(row.row_number).padStart(5, '0')}`;
        warnings.push({ field: 'sku', message: `Référence absente : « ${data.sku} » sera générée.` });
      } else if (opts.mode !== 'create') {
        errors.push({ field: 'sku', message: 'Une référence est obligatoire pour mettre à jour un article.' });
      } else {
        errors.push({ field: 'sku', message: 'Référence absente. Renseignez-la ou activez la génération automatique.' });
      }
    }

    // Doublons dans le fichier
    if (data.sku) {
      if (seenInFile.has(data.sku)) {
        rowResult.status = 'duplicate';
        errors.push({ field: 'sku', message: `Référence déjà présente à la ligne ${seenInFile.get(data.sku)} du fichier.` });
      } else {
        seenInFile.set(data.sku, row.row_number);
      }
    }

    // Doublons en base
    const existsInDb = data.sku ? existingSkus.has(data.sku) : false;
    if (existsInDb) {
      if (opts.mode === 'create') {
        rowResult.status = 'duplicate';
        rowResult.action = 'skip';
        warnings.push({ field: 'sku', message: 'Référence déjà présente dans le catalogue : ligne ignorée (mode « création uniquement »).' });
      } else {
        rowResult.action = 'update';
      }
    } else if (opts.mode === 'update') {
      rowResult.status = 'skipped';
      rowResult.action = 'skip';
      warnings.push({ field: 'sku', message: 'Référence absente du catalogue : ligne ignorée (mode « mise à jour uniquement »).' });
    } else {
      rowResult.action = 'create';
    }

    // Catégories
    const categoryNames = [data.category, data.subcategory].filter(Boolean);
    for (const name of categoryNames) {
      const key = normalizeText(name).toLowerCase();
      if (!existingCategories.has(key)) {
        if (opts.createMissingCategories) warnings.push({ field: 'category', message: `Catégorie « ${name} » absente : elle sera créée.` });
        else errors.push({ field: 'category', message: `Catégorie « ${name} » introuvable et création désactivée.` });
        summary.missingCategories.add(name);
      }
    }

    // Composants de kit
    for (const comp of data.kit_components || []) {
      if (!existingSkus.has(comp.sku) && !(comp.sku && seenInFile.has(comp.sku))) {
        errors.push({ field: 'kit_components', message: `Composant de kit « ${comp.sku} » introuvable.` });
        summary.missingSkus.add(comp.sku);
      }
    }

    // Publication
    const priceIsKept = rowResult.action === 'update' && data.price === null && opts.blankPolicy !== 'clear';
    if ((data.status === 'published' || (rowResult.action === 'create' && opts.statusForNew === 'published'))) {
      if (!priceIsKept && (!data.price || data.price <= 0)) {
        errors.push({ field: 'status', message: 'Publication impossible sans prix. L’article restera en brouillon.' });
        data.status = 'draft';
      } else if (!data.sku) {
        errors.push({ field: 'status', message: 'Publication impossible sans référence.' });
        data.status = 'draft';
      }
    }
    // En upsert, une ligne qui va être CRÉÉE sans prix reste invalide.
    if (opts.mode === 'upsert' && !existsInDb && rowResult.action === 'create' && !data.price) {
      errors.push({ field: 'price', message: 'Prix manquant : nécessaire pour créer un nouvel article.' });
    }

    rowResult.status = errors.length ? 'error' : rowResult.status === 'duplicate' ? 'duplicate' : rowResult.action === 'skip' ? 'skipped' : 'ok';
    if (errors.length) summary.invalid += 1;
    else if (rowResult.status === 'duplicate') summary.duplicate += 1;
    else {
      summary.valid += 1;
      if (rowResult.action === 'update') summary.willUpdate += 1;
      else if (rowResult.action === 'skip') summary.willSkip += 1;
      else summary.willCreate += 1;
    }

    if (previewRows.length < limit) {
      previewRows.push({ ...rowResult, data });
    }
    // Met à jour la ligne stockée pour l'exécution.
    db.run('UPDATE import_rows SET sku = ?, data = ?, status = ?, action = ?, message = ? WHERE id = ?', [
      data.sku || '',
      JSON.stringify(data),
      'pending',
      rowResult.action,
      JSON.stringify({ errors, warnings, previewStatus: rowResult.status }),
      row.id,
    ]);
  }

  db.run('UPDATE import_jobs SET mapping = ?, mode = ?, options = ?, status = ?, batch_size = ? WHERE id = ?', [
    JSON.stringify(mapping),
    opts.mode,
    JSON.stringify(opts),
    'mapped',
    opts.batchSize,
    Number(jobId),
  ]);

  return {
    job: getJob(jobId),
    summary: {
      ...summary,
      missingCategories: [...summary.missingCategories],
      missingSkus: [...summary.missingSkus],
    },
    rows: previewRows,
    options: opts,
  };
}

/* ------------------------------------------------------------------ */
/* Exécution par lots                                                  */
/* ------------------------------------------------------------------ */
function runBatch(jobId, { userId = null, batchSize = null } = {}) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Lot d’import introuvable.'), { status: 404 });
  if (job.status === 'done') return progress(jobId);
  if (job.status === 'cancelled') {
    throw Object.assign(new Error('Ce lot d’import a été annulé : aucune ligne ne sera traitée.'), { status: 409 });
  }
  if (job.status === 'uploaded') throw Object.assign(new Error('Associez les colonnes et lancez l’aperçu avant l’import.'), { status: 409 });

  const opts = job.options || {};
  const size = Math.max(1, Number(batchSize || job.batch_size || DEFAULT_BATCH));
  if (job.status !== 'running') db.run("UPDATE import_jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", [dates.nowIso(), jobId]);

  const rows = db.all(
    "SELECT * FROM import_rows WHERE job_id = ? AND status = 'pending' ORDER BY row_number ASC LIMIT ?",
    [Number(jobId), size]
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const previewMeta = safeParse(row.message, { errors: [], warnings: [] });
    const data = safeParse(row.data, {});
    try {
      if (previewMeta.errors && previewMeta.errors.length) {
        const isBlocking = previewMeta.errors.some((e) => !/publication impossible|restera en brouillon/.test(e.message));
        if (isBlocking) {
          db.run("UPDATE import_rows SET status = 'error', message = ? WHERE id = ?", [
            JSON.stringify({ ...previewMeta, errors: previewMeta.errors.filter((e) => !/publication impossible/.test(e.message)) }),
            row.id,
          ]);
          failed += 1;
          continue;
        }
      }
      const result = applyRow(data, row.action || (opts.mode === 'update' ? 'update' : 'create'), opts, userId);
      db.run("UPDATE import_rows SET status = ?, product_id = ?, action = ?, message = ? WHERE id = ?", [
        result.status,
        result.productId || null,
        result.action,
        JSON.stringify({ ...previewMeta, result: result.message }),
        row.id,
      ]);
      if (result.status === 'ok') {
        if (result.action === 'update') updated += 1;
        else created += 1;
      } else skipped += 1;
    } catch (err) {
      db.run("UPDATE import_rows SET status = 'error', message = ? WHERE id = ?", [
        JSON.stringify({ ...previewMeta, fatal: err.message }),
        row.id,
      ]);
      failed += 1;
    }
  }

  db.run(
    `UPDATE import_jobs
        SET processed = processed + ?,
            created_count = created_count + ?,
            updated_count = updated_count + ?,
            skipped_count = skipped_count + ?,
            error_count = error_count + ?
      WHERE id = ?`,
    [rows.length, created, updated, skipped, failed, Number(jobId)]
  );

  const progressState = progress(jobId);
  if (progressState.done) finalize(jobId, { userId });
  return progress(jobId);
}

/** Applique une ligne validée. Retourne {status, action, productId, message}. */
function applyRow(data, action, opts, userId) {
  if (action === 'skip') return { status: 'skipped', action, productId: null, message: 'Ligne ignorée selon le mode choisi.' };

  const existing = data.sku ? db.get('SELECT * FROM products WHERE sku = ?', [data.sku]) : null;
  const isUpdate = Boolean(existing) && action !== 'create';

  // Catégorie
  let categoryId = null;
  const categoryNames = [data.category, data.subcategory].filter(Boolean);
  if (categoryNames.length) {
    let parentId = null;
    for (const name of categoryNames) {
      const found = db.get('SELECT * FROM categories WHERE LOWER(name) = LOWER(?)', [normalizeText(name)]);
      if (found) {
        categoryId = found.id;
        if (parentId && found.parent_id !== parentId) {
          categories.update(found.id, { parentId }, userId);
        }
        parentId = found.id;
      } else if (opts.createMissingCategories) {
        const created = categories.create({ name, parentId }, userId);
        categoryId = created.id;
        parentId = created.id;
      }
    }
  }

  // Politique des cellules vides
  const keep = (key, currentValue) => {
    const incoming = data[key];
    if (incoming === null || incoming === undefined || incoming === '') {
      if (!isUpdate) return undefined;
      const shouldClear = opts.blankPolicy === 'clear' || (opts.clearColumns || []).includes(key);
      return shouldClear ? null : undefined;
    }
    return incoming;
  };

  const status = data.status || (isUpdate ? undefined : opts.statusForNew);
  const confirmed = opts.confirmImported ? true : keep('data_confirmed', existing?.data_confirmed);

  const payload = {
    sku: data.sku || undefined,
    name: data.name,
    category_id: categoryId ?? (isUpdate ? undefined : null),
    brand: data.brand ? data.brand : (isUpdate ? undefined : ''),
    short_description: keep('short_description'),
    description: keep('description'),
    price: keep('price'),
    compare_at_price: keep('compare_at_price'),
    promo_price: keep('promo_price'),
    promo_starts_at: keep('promo_starts_at'),
    promo_ends_at: keep('promo_ends_at'),
    qty: keep('qty'),
    low_stock_threshold: keep('low_stock_threshold'),
    track_stock: data.track_stock === undefined ? undefined : data.track_stock,
    sale_unit: data.sale_unit || undefined,
    product_condition: data.product_condition || undefined,
    warranty: keep('warranty'),
    box_contents: keep('box_contents'),
    weight_g: keep('weight_g'),
    length_cm: keep('length_cm'),
    width_cm: keep('width_cm'),
    height_cm: keep('height_cm'),
    meta_title: keep('meta_title'),
    meta_description: keep('meta_description'),
    data_confirmed: confirmed === undefined ? undefined : confirmed,
    status: status || undefined,
    attributes: data.attributes && data.attributes.length ? data.attributes : undefined,
    variants: data.variants && data.variants.length ? data.variants.map((options) => ({ options })) : undefined,
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];

  let product;
  if (isUpdate) {
    product = products.update(existing.id, payload, { userId });
    // Le stock est traité explicitement : une valeur fournie remplace l'existant.
    if (data.qty !== null && data.qty !== undefined && !product.has_variants) {
      const item = stock.itemFor(product.id, null);
      if (item) {
        try {
          stock.setOnHand(item.id, data.qty, {
            reason: 'import',
            note: `Import — ligne ${data.sku}`,
            userId,
            reference: data.sku,
          });
        } catch (err) {
          return { status: 'ok', action: 'update', productId: product.id, message: `Mis à jour, stock non ajusté : ${err.message}` };
        }
      }
    }
  } else {
    product = products.create({ ...payload, status: payload.status || 'draft' }, { userId });
    if (data.kit_components && data.kit_components.length) {
      const components = data.kit_components
        .map((c) => {
          const comp = db.get('SELECT id FROM products WHERE sku = ?', [c.sku]);
          return comp ? { component_product_id: comp.id, quantity: c.qty } : null;
        })
        .filter(Boolean);
      if (components.length) stock.saveKitComponents(product.id, components);
    }
  }

  // Un article importé sans prix confirmé ne peut pas être acheté : on le repasse en brouillon.
  const fresh = products.rawProduct(product.id);
  if (fresh.status === 'published' && (!fresh.price || fresh.price <= 0 || !fresh.data_confirmed)) {
    products.setStatus(fresh.id, 'draft', userId);
  }

  return {
    status: 'ok',
    action: isUpdate ? 'update' : 'create',
    productId: product.id,
    message: isUpdate ? 'Article mis à jour.' : 'Article créé.',
  };
}

function progress(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const counts = db.get(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicate
     FROM import_rows WHERE job_id = ?`,
    [Number(jobId)]
  );
  const processed = job.processed || 0;
  const total = job.total_rows || 0;
  return {
    jobId: Number(jobId),
    total,
    processed,
    percent: total ? Math.round((processed / total) * 100) : 0,
    done: processed >= total && total > 0,
    status: job.status,
    counts: {
      pending: Number(counts?.pending || 0),
      ok: Number(counts?.ok || 0),
      error: Number(counts?.error || 0),
      skipped: Number(counts?.skipped || 0),
      duplicate: Number(counts?.duplicate || 0),
    },
    created: job.created_count,
    updated: job.updated_count,
    errors: job.error_count,
    skippedTotal: job.skipped_count,
  };
}

function finalize(jobId, { userId = null } = {}) {
  const job = getJob(jobId);
  if (!job) return null;
  const p = progress(jobId);
  const errors = db.all(
    "SELECT row_number, sku, message FROM import_rows WHERE job_id = ? AND status = 'error' ORDER BY row_number ASC LIMIT 500",
    [Number(jobId)]
  ).map((r) => ({ row: r.row_number, sku: r.sku, message: safeParse(r.message, {}).fatal || (safeParse(r.message, {}).errors || []).map((e) => e.message).join(' ') }));

  const report = {
    finishedAt: dates.nowIso(),
    mode: job.mode,
    totalRows: job.total_rows,
    created: job.created_count,
    updated: job.updated_count,
    skipped: job.skipped_count,
    rejected: job.error_count,
    errors: errors.slice(0, 200),
    errorCount: errors.length,
  };
  db.run("UPDATE import_jobs SET status = 'done', finished_at = ?, report = ? WHERE id = ?", [
    dates.nowIso(), JSON.stringify(report), Number(jobId),
  ]);
  audit(userId, 'import.finalize', jobId, { created: report.created, updated: report.updated, rejected: report.rejected });
  return getJob(jobId);
}

function cancelJob(jobId, userId = null) {
  db.run("UPDATE import_jobs SET status = 'cancelled' WHERE id = ?", [Number(jobId)]);
  audit(userId, 'import.cancel', jobId, {});
  return getJob(jobId);
}

/* ------------------------------------------------------------------ */
/* Modèle et export                                                    */
/* ------------------------------------------------------------------ */
async function buildTemplate(format = 'xlsx') {
  const headers = COLUMNS.map((c) => c.label);
  const rows = TEMPLATE_ROWS.map((row) =>
    COLUMNS.map((c) => {
      const v = row[c.key];
      if (v === undefined || v === null) return '';
      if (c.key === 'kit_components') return v;
      if (c.key === 'attributes') return v;
      return typeof v === 'object' ? JSON.stringify(v) : v;
    })
  );

  if (format === 'csv') {
    return { filename: 'modele-import-catalogue.csv', mime: 'text/csv; charset=utf-8', buffer: Buffer.from(csv.stringify(headers, rows), 'utf8') };
  }

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ETS LE PRIVILÈGE DAOUKRO';
  wb.created = new Date();

  const ws = wb.addWorksheet('Catalogue');
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14294F' } };
  ws.getRow(1).height = 28;
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((col) => { col.width = 22; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const help = wb.addWorksheet('Notice');
  help.addRow(['Champ', 'Obligatoire', 'Type', 'Explication et valeurs acceptées']);
  help.getRow(1).font = { bold: true };
  for (const c of COLUMNS) {
    help.addRow([c.label, c.required ? 'oui' : 'non', c.type, describeColumn(c)]);
  }
  help.addRow([]);
  help.addRow(['Règle importante', '', '', 'Dans un fichier de mise à jour, une cellule vide ne supprime jamais la valeur existante, sauf si vous choisissez explicitement « vider les cellules vides » dans l’assistant d’import.']);
  help.addRow(['Variantes', '', '', 'Format : Couleur:Bleu|Capacité:128 Go;Couleur:Rouge|Capacité:128 Go (point-virgule entre les variantes, barre verticale entre les options).']);
  help.addRow(['Caractéristiques', '', '', 'Format : Format:A4;Nombre de pages:200 (point-virgule entre les caractéristiques).']);
  help.addRow(['Composants du kit', '', '', 'Format : REF1:2;REF2:1 (référence du composant puis quantité). Les composants doivent exister dans le catalogue.']);
  help.columns.forEach((col) => { col.width = 34; });

  const buffer = await wb.xlsx.writeBuffer();
  return { filename: 'modele-import-catalogue.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buffer) };
}

function describeColumn(col) {
  const base = {
    sku: 'Référence unique de l’article. Sert à retrouver un produit lors d’une mise à jour.',
    name: 'Nom affiché dans la boutique.',
    category: 'Famille principale. Créée automatiquement si elle n’existe pas (option activable).',
    subcategory: 'Sous-famille, rattachée à la catégorie.',
    brand: 'Marque. Créée automatiquement si elle n’existe pas.',
    price: 'Prix de vente en FCFA, sans décimale (ex. 1500 ou 1 500).',
    compare_at_price: 'Prix de référence affiché barré. Doit être réellement pratiqué auparavant.',
    promo_price: 'Prix promotionnel. Utilisez les dates de validité.',
    qty: 'Quantité en stock. Pour un produit à variantes, saisissez le stock par variante ou ajustez-le ensuite.',
    low_stock_threshold: 'Seuil à partir duquel l’article apparaît en alerte de stock.',
    track_stock: 'oui / non. « non » = article vendu sans suivi de quantité (disponible sur commande).',
    sale_unit: `piece, lot, paquet, rame, carton, boite, paire, kit.`,
    product_condition: 'neuf, reconditionne, occasion.',
    status: 'brouillon, publie, archive. Un article sans prix confirmé reste en brouillon.',
    data_confirmed: 'oui / non. À « oui » uniquement quand le prix et la disponibilité sont sûrs : sans cela l’article n’est pas achetable.',
    description: 'Description détaillée. Texte simple ou balises autorisées (p, strong, em, ul, li).',
    warranty: 'Garantie telle qu’elle sera affichée (ex. 12 mois).',
    box_contents: 'Contenu du carton / éléments fournis.',
    weight_g: 'Poids en grammes, utilisé pour le calcul des frais de livraison.',
  };
  return base[col.key] || '';
}

/** Export du catalogue filtré. */
async function exportCatalog({ format = 'xlsx', filters = {} } = {}) {
  const { items } = products.list(
    { statuses: filters.statuses || ['published', 'draft', 'archived'], ...filters },
    { page: 1, perPage: 100000 }
  );
  const headers = COLUMNS.map((c) => c.label);
  const rows = items.map((p) => {
    const raw = db.get('SELECT * FROM products WHERE id = ?', [p.id]);
    const attrs = products.attributesOf(p.id);
    const variants = products.variantsOf(p.id);
    const kit = stock.kitComponents(p.id);
    const item = products.getById(p.id);
    const stockItem = stock.itemFor(p.id, null);
    const values = {
      sku: raw.sku || '',
      name: raw.name,
      category: item?.category_name || '',
      subcategory: '',
      brand: item?.brand_name || '',
      short_description: raw.short_description,
      description: stripHtml(raw.description),
      price: raw.price,
      compare_at_price: raw.compare_at_price ?? '',
      promo_price: raw.promo_price ?? '',
      promo_starts_at: raw.promo_starts_at ? dates.toDateInput(raw.promo_starts_at) : '',
      promo_ends_at: raw.promo_ends_at ? dates.toDateInput(raw.promo_ends_at) : '',
      qty: variants.length ? '' : (stockItem ? stockItem.qty_on_hand : raw.qty),
      low_stock_threshold: raw.low_stock_threshold,
      track_stock: raw.track_stock ? 'oui' : 'non',
      sale_unit: raw.sale_unit,
      product_condition: raw.product_condition,
      warranty: raw.warranty,
      box_contents: stripHtml(raw.box_contents),
      weight_g: raw.weight_g ?? '',
      length_cm: raw.length_cm ?? '',
      width_cm: raw.width_cm ?? '',
      height_cm: raw.height_cm ?? '',
      status: raw.status === 'published' ? 'publie' : raw.status === 'archived' ? 'archive' : 'brouillon',
      data_confirmed: raw.data_confirmed ? 'oui' : 'non',
      variants: variants
        .map((v) => Object.entries(v.options).map(([k, val]) => `${k}:${val}`).join('|'))
        .filter(Boolean)
        .join(';'),
      attributes: attrs.map((a) => `${a.label || a.key}:${a.value}`).join(';'),
      kit_components: kit.map((k) => `${k.product_sku || k.component_product_id}:${k.quantity}`).join(';'),
      meta_title: raw.meta_title,
      meta_description: raw.meta_description,
    };
    return headers.map((h) => {
      const col = COLUMNS.find((c) => c.label === h);
      const v = values[col.key];
      return csv.safeCell(v === undefined || v === null ? '' : v);
    });
  });

  const stamp = dates.todayInTz();
  if (format === 'csv') {
    return {
      filename: `catalogue-privilege-${stamp}.csv`,
      mime: 'text/csv; charset=utf-8',
      buffer: Buffer.from(csv.stringify(headers, rows), 'utf8'),
      count: rows.length,
    };
  }

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Catalogue');
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14294F' } };
  rows.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c) => { c.width = 20; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } };
  const buffer = await wb.xlsx.writeBuffer();
  return {
    filename: `catalogue-privilege-${stamp}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(buffer),
    count: rows.length,
  };
}

function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'system',
      action,
      entity_type: 'import',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* noop */ }
}

function safeParse(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Purge les fichiers d'import anciens. */
function purgeOldFiles(days = 14) {
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(config.storage.importDir)) {
      const full = path.join(config.storage.importDir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    }
  } catch { /* dossier absent */ }
  return removed;
}

module.exports = {
  COLUMNS,
  MAX_ROWS,
  MAX_FILE_BYTES,
  suggestMapping,
  createJob,
  headersFor,
  previewSummary,
  getJob,
  listJobs,
  jobRows,
  preview,
  runBatch,
  progress,
  finalize,
  cancelJob,
  buildTemplate,
  exportCatalog,
  purgeOldFiles,
  normalizeRow,
  parseVariants,
  parseAttributes,
  parseKit,
};
