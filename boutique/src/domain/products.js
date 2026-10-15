'use strict';

/**
 * Catalogue : produits, variantes, caractéristiques, images, marques, recherche.
 *
 * La recherche et les filtres sont exécutés côté serveur (FTS5 + SQL) avec
 * pagination : le catalogue complet n'est jamais chargé ni envoyé au navigateur,
 * et il n'existe AUCUN plafond codé en dur sur le nombre d'articles.
 */

const db = require('../db');
const dates = require('../lib/dates');
const config = require('../config');
const { slugify, uniqueSlug, normalizeText, stripHtml, excerpt } = require('../lib/slug');
const { sanitizeHtml } = require('../lib/validate');
const stock = require('./stock');
const categories = require('./categories');

const SALE_UNITS = [
  { value: 'piece', label: 'Pièce' },
  { value: 'lot', label: 'Lot' },
  { value: 'paquet', label: 'Paquet' },
  { value: 'rame', label: 'Rame' },
  { value: 'carton', label: 'Carton' },
  { value: 'boite', label: 'Boîte' },
  { value: 'paire', label: 'Paire' },
  { value: 'kit', label: 'Kit' },
  { value: 'autre', label: 'Autre (libellé personnalisé)' },
];

const CONDITIONS = [
  { value: 'neuf', label: 'Neuf' },
  { value: 'reconditionne', label: 'Reconditionné' },
  { value: 'occasion', label: 'Occasion' },
  { value: 'lot', label: 'Lot / déstockage' },
];

const STATUSES = [
  { value: 'draft', label: 'Brouillon' },
  { value: 'published', label: 'Publié' },
  { value: 'archived', label: 'Archivé' },
];

const SORTS = {
  pertinence: null, // tri par score FTS
  nouveaute: 'p.published_at DESC, p.created_at DESC',
  prix_asc: 'sale_price ASC, p.name ASC',
  prix_desc: 'sale_price DESC, p.name ASC',
  nom_asc: 'p.name ASC',
  nom_desc: 'p.name DESC',
  promotions: 'has_promo DESC, sale_price ASC',
  meilleures_ventes: 'sold_qty DESC, p.name ASC',
};

class CatalogError extends Error {
  constructor(message, code = 'CATALOG_ERROR', status = 400) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Marques                                                             */
/* ------------------------------------------------------------------ */
function listBrands({ includeArchived = false, withCounts = false } = {}) {
  const counts = withCounts
    ? ', (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.status = \'published\') AS product_count'
    : '';
  return db.all(
    `SELECT b.* ${counts} FROM brands b WHERE (? = 1 OR b.archived = 0) ORDER BY b.name ASC`,
    [includeArchived ? 1 : 0]
  );
}

function getBrand(id) {
  return db.get('SELECT * FROM brands WHERE id = ?', [id]);
}

function findOrCreateBrand(name) {
  const clean = normalizeText(name);
  if (!clean) return null;
  const existing = db.get('SELECT * FROM brands WHERE name = ?', [clean]);
  if (existing) return existing;
  const slug = uniqueSlug(slugify(clean), (s) => Boolean(db.get('SELECT id FROM brands WHERE slug = ?', [s])));
  const id = db.insert('brands', { name: clean, slug });
  return getBrand(id);
}

/* ------------------------------------------------------------------ */
/* Prix et disponibilité                                               */
/* ------------------------------------------------------------------ */
function promoActive(product, at = new Date()) {
  if (!product || !product.promo_price || product.promo_price <= 0) return false;
  return dates.isWithin(product.promo_starts_at, product.promo_ends_at, at);
}

/** Prix de vente effectif d'un produit (ou d'une variante). */
function priceOf(product, variant = null) {
  const base = variant && variant.price != null ? Number(variant.price) : Number(product.price || 0);
  const promoRaw = variant && variant.promo_price != null ? Number(variant.promo_price) : Number(product.promo_price || 0);
  const inPromo = promoActive({ promo_price: promoRaw || null, promo_starts_at: product.promo_starts_at, promo_ends_at: product.promo_ends_at });
  const sale = inPromo && promoRaw > 0 && promoRaw < base ? promoRaw : base;
  const compareAt = variant && variant.compare_at_price != null ? Number(variant.compare_at_price) : product.compare_at_price;
  return {
    base,
    sale,
    promo: inPromo && sale < base ? promoRaw : null,
    compareAt: compareAt && compareAt > sale ? Number(compareAt) : null,
    discountPercent: compareAt && compareAt > sale ? Math.round(((compareAt - sale) / compareAt) * 100) : null,
  };
}

/** Fourchette de prix pour un produit à variantes. */
function priceRange(product) {
  const row = db.get(
    `SELECT MIN(COALESCE(v.price, ?)) AS min_price, MAX(COALESCE(v.price, ?)) AS max_price, COUNT(*) AS n
       FROM product_variants v WHERE v.product_id = ? AND v.active = 1`,
    [product.price, product.price, product.id]
  );
  if (!row || !row.n) return { min: Number(product.price || 0), max: Number(product.price || 0), single: true };
  return { min: Number(row.min_price), max: Number(row.max_price), single: Number(row.min_price) === Number(row.max_price) };
}

/**
 * @param {number} [options.ownReservation] unités déjà réservées par le panier du
 *   client qui consulte : elles restent disponibles POUR LUI (tunnel de commande).
 */
function availabilityOf(product, variant = null, { ownReservation = 0 } = {}) {
  if (!product) return { status: 'unknown', available: 0, label: 'Indisponible' };
  const own = Math.max(0, Number(ownReservation) || 0);
  if (product.is_kit) {
    const avail = stock.kitAvailable(product.id);
    return describeAvailability(product, avail + own);
  }
  if (!product.track_stock) {
    return { status: 'untracked', available: Infinity, label: 'Disponible sur commande', untracked: true };
  }
  const item = stock.itemFor(product.id, variant ? variant.id : null);
  let avail = stock.available(item);
  if (!variant && product.has_variants) {
    avail = stock.availableForProduct(product.id);
  }
  return describeAvailability(product, avail + own);
}

function describeAvailability(product, avail) {
  const threshold = Number(product.low_stock_threshold || 0);
  if (avail === Infinity) return { status: 'untracked', available: Infinity, label: 'Disponible sur commande', untracked: true };
  if (avail <= 0) return { status: 'out', available: 0, label: 'Rupture de stock' };
  if (threshold > 0 && avail <= threshold) {
    return { status: 'low', available: avail, label: `Plus que ${avail} en stock`, low: true };
  }
  return { status: 'in_stock', available: avail, label: 'En stock' };
}

/**
 * Un article n'est achetable que si : publié, prix > 0, données confirmées par
 * l'exploitant et stock disponible. Aucune de ces conditions n'est contournable
 * côté client : le tunnel de commande revérifie tout au moment de la validation.
 */
function purchasability(product, variant = null, { ownReservation = 0 } = {}) {
  const reasons = [];
  if (!product) return { ok: false, reasons: ['Produit introuvable'] };
  if (product.status !== 'published') reasons.push("L'article n'est pas publié.");
  const price = priceOf(product, variant);
  if (!(price.sale > 0)) reasons.push("Aucun prix n'est renseigné pour cet article.");
  if (!product.data_confirmed) reasons.push("Le prix et la disponibilité n'ont pas encore été confirmés par la boutique.");
  const avail = availabilityOf(product, variant, { ownReservation });
  if (avail.status === 'out') reasons.push('Article en rupture de stock.');
  if (product.is_kit && avail.status !== 'untracked' && avail.available <= 0) {
    reasons.push('Composants du kit indisponibles.');
  }
  if (!product.sku) reasons.push("Référence manquante : l'article ne peut pas être vendu en l'état.");
  return { ok: reasons.length === 0, reasons, price, availability: avail };
}

/* ------------------------------------------------------------------ */
/* Index de recherche (FTS5)                                           */
/* ------------------------------------------------------------------ */
function indexProduct(productId) {
  const p = db.get(
    `SELECT p.*, b.name AS brand_name, c.name AS category_name,
            (SELECT GROUP_CONCAT(v.options, ' ') FROM product_variants v WHERE v.product_id = p.id) AS variant_options
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?`,
    [productId]
  );
  db.run('DELETE FROM products_fts WHERE product_id = ?', [String(productId)]);
  if (!p) return false;
  if (p.status === 'archived') return true;
  db.run(
    `INSERT INTO products_fts (product_id, name, sku, brand, category, short_description, description, variants)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(p.id),
      p.name || '',
      p.sku || '',
      p.brand_name || '',
      p.category_name || '',
      stripHtml(p.short_description || ''),
      stripHtml(p.description || ''),
      (p.variant_options || '').replace(/[{}"]/g, ' '),
    ]
  );
  return true;
}

function reindexAll() {
  const ids = db.all('SELECT id FROM products').map((r) => r.id);
  db.transaction(() => {
    db.run('DELETE FROM products_fts');
    for (const id of ids) indexProduct(id);
  });
  return ids.length;
}

/** Transforme une saisie utilisateur en requête FTS5 sûre. */
function buildMatchQuery(q) {
  const tokens = String(q || '')
    .replace(/["()*:^]/g, ' ')
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens
    .map((t) => {
      const clean = t.replace(/[-+]/g, ' ').trim();
      if (!clean) return null;
      return clean.length >= 3 ? `"${clean}"*` : `"${clean}"`;
    })
    .filter(Boolean)
    .join(' AND ');
}

/* ------------------------------------------------------------------ */
/* Requêtes de liste                                                   */
/* ------------------------------------------------------------------ */
const SELECT_BASE = `
  SELECT p.id, p.sku, p.name, p.slug, p.short_description, p.price, p.compare_at_price,
         p.promo_price, p.promo_starts_at, p.promo_ends_at, p.status, p.is_kit,
         p.track_stock, p.low_stock_threshold, p.qty, p.has_variants, p.featured,
         p.product_condition, p.sale_unit, p.sale_unit_label, p.data_confirmed,
         p.created_at, p.updated_at, p.published_at, p.position,
         c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
         b.id AS brand_id, b.name AS brand_name,
         CASE
           WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
            AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            AND (p.promo_ends_at   IS NULL OR p.promo_ends_at   >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           THEN p.promo_price ELSE p.price
         END AS sale_price,
         CASE
           WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
            AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            AND (p.promo_ends_at   IS NULL OR p.promo_ends_at   >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           THEN 1 ELSE 0
         END AS has_promo,
         COALESCE((SELECT MIN(COALESCE(v.price, p.price)) FROM product_variants v
                    WHERE v.product_id = p.id AND v.active = 1), p.price) AS min_price,
         COALESCE((SELECT MAX(COALESCE(v.price, p.price)) FROM product_variants v
                    WHERE v.product_id = p.id AND v.active = 1), p.price) AS max_price,
         COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si
                    WHERE si.product_id = p.id), 0) AS stock_available,
         COALESCE((SELECT SUM(si.qty_on_hand) FROM stock_items si WHERE si.product_id = p.id), 0) AS stock_on_hand,
         COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.product_id = p.id
                      AND o.payment_status IN ('paid','partially_refunded','refunded')), 0) AS sold_qty
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN brands b ON b.id = p.brand_id
`;

/**
 * Construit la clause WHERE et les paramètres POSITIONNELS associés.
 * SQLite n'autorise pas de mélanger paramètres nommés et positionnels dans une
 * même requête : tout est donc positionnel.
 */
function buildWhere(filters) {
  const where = [];
  const params = [];
  const inList = (column, values, notIn = false) => {
    const list = (values || []).filter((v) => v !== null && v !== undefined && v !== '');
    if (!list.length) return;
    where.push(`${column} ${notIn ? 'NOT ' : ''}IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  };

  const statuses = filters.statuses || (filters.status ? [filters.status] : null);
  inList('p.status', statuses);
  inList('p.id', (filters.ids || []).map(Number));
  inList('p.id', (filters.excludeIds || []).map(Number), true);
  inList('p.category_id', (filters.categoryIds || []).map(Number));
  inList('p.brand_id', (filters.brandIds || []).map(Number));

  if (filters.condition) {
    where.push('p.product_condition = ?');
    params.push(String(filters.condition));
  }
  if (filters.featured) where.push('p.featured = 1');
  if (filters.onPromo) where.push('has_promo = 1');

  if (filters.priceMin != null && filters.priceMin !== '') {
    where.push('sale_price >= ?');
    params.push(Number(filters.priceMin));
  }
  if (filters.priceMax != null && filters.priceMax !== '') {
    where.push('sale_price <= ?');
    params.push(Number(filters.priceMax));
  }
  if (filters.inStock) where.push('(p.track_stock = 0 OR stock_available > 0)');
  if (filters.purchasableOnly) {
    where.push("p.status = 'published' AND p.data_confirmed = 1 AND sale_price > 0 AND (p.track_stock = 0 OR stock_available > 0)");
  }
  if (filters.lowStock) {
    where.push('p.track_stock = 1 AND p.low_stock_threshold > 0 AND stock_available <= p.low_stock_threshold');
  }
  if (filters.notConfirmed) where.push('p.data_confirmed = 0');
  if (filters.noImage) {
    where.push('NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)');
  }
  if (filters.sku) {
    where.push('p.sku LIKE ?');
    params.push(`%${String(filters.sku).trim()}%`);
  }
  if (filters.like) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.short_description LIKE ?)');
    const like = `%${String(filters.like).trim()}%`;
    params.push(like, like, like);
  }
  return { where, params };
}

/**
 * Liste paginée de produits. `filters.q` utilise l'index FTS5.
 * Retourne {items, pagination, facets}.
 */
function list(filters = {}, { page = 1, perPage = config.commerce.catalogPageSize } = {}) {
  const match = filters.q ? buildMatchQuery(filters.q) : null;
  const { where, params } = buildWhere(filters);

  let joins = '';
  const queryParams = [...params];
  if (match) {
    joins = 'JOIN products_fts ON products_fts.product_id = CAST(p.id AS TEXT)';
    where.unshift('products_fts MATCH ?');
    queryParams.unshift(match);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortKey = Object.prototype.hasOwnProperty.call(SORTS, filters.sort) ? filters.sort : 'pertinence';
  const orderSql =
    match && sortKey === 'pertinence'
      ? 'ORDER BY rank ASC, p.name ASC'
      : `ORDER BY ${SORTS[sortKey] || SORTS.nouveaute}`;

  // Le décompte s'appuie sur la même projection que la liste : les colonnes
  // calculées (sale_price, stock_available, has_promo…) n'existent pas dans la
  // table `products`, il faut donc compter sur une sous-requête.
  const total =
    db.get(`SELECT COUNT(*) AS total FROM (${SELECT_BASE} ${joins} ${whereSql})`, queryParams)?.total || 0;

  const size = Math.max(1, Math.min(120, Number(perPage) || config.commerce.catalogPageSize));
  const pagination = { page: Math.max(1, Number(page) || 1), perPage: size, total };
  pagination.pages = Math.max(1, Math.ceil(total / size));
  pagination.page = Math.min(pagination.page, pagination.pages);
  pagination.offset = (pagination.page - 1) * size;
  pagination.hasNext = pagination.page < pagination.pages;
  pagination.hasPrev = pagination.page > 1;
  pagination.from = total === 0 ? 0 : pagination.offset + 1;
  pagination.to = Math.min(pagination.offset + size, total);

  const rows = db.all(`${SELECT_BASE} ${joins} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, [
    ...queryParams,
    size,
    pagination.offset,
  ]);

  const items = rows.map(hydrateRow);
  attachImages(items);
  attachKitAvailability(items);

  return { items, pagination, facets: facets(filters) };
}

function hydrateRow(row) {
  const product = { ...row };
  product.price_info = {
    base: Number(row.price || 0),
    sale: Number(row.sale_price ?? row.price ?? 0),
    promo: row.has_promo ? Number(row.promo_price) : null,
    compareAt: row.compare_at_price && Number(row.compare_at_price) > Number(row.sale_price ?? row.price) ? Number(row.compare_at_price) : null,
    range: Number(row.min_price) !== Number(row.max_price) ? { min: Number(row.min_price), max: Number(row.max_price) } : null,
  };
  product.price_info.discountPercent = product.price_info.compareAt
    ? Math.round(((product.price_info.compareAt - product.price_info.sale) / product.price_info.compareAt) * 100)
    : null;

  const avail = Number(row.stock_available || 0);
  if (!row.track_stock) {
    product.availability = { status: 'untracked', available: Infinity, label: 'Disponible sur commande', untracked: true };
  } else if (avail <= 0) {
    product.availability = { status: 'out', available: 0, label: 'Rupture de stock' };
  } else if (row.low_stock_threshold > 0 && avail <= row.low_stock_threshold) {
    product.availability = { status: 'low', available: avail, label: `Plus que ${avail} en stock`, low: true };
  } else {
    product.availability = { status: 'in_stock', available: avail, label: 'En stock' };
  }
  product.purchasable =
    row.status === 'published' &&
    Number(row.data_confirmed) === 1 &&
    product.price_info.sale > 0 &&
    product.availability.status !== 'out';
  product.excerpt = excerpt(row.short_description || stripHtml(row.description || ''), 150);
  product.unit_label = row.sale_unit_label || (SALE_UNITS.find((u) => u.value === row.sale_unit)?.label || 'Pièce');
  return product;
}

function attachImages(items) {
  if (!items.length) return;
  const ids = items.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT pi.product_id, pi.position, pi.is_primary, pi.alt, m.file_key, m.width, m.height
       FROM product_images pi JOIN media_files m ON m.id = pi.media_id
      WHERE pi.product_id IN (${placeholders})
      ORDER BY pi.product_id ASC, pi.is_primary DESC, pi.position ASC`,
    ids
  );
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, r);
  }
  for (const item of items) {
    const img = byProduct.get(item.id);
    item.image = img ? { fileKey: img.file_key, alt: img.alt || item.name, width: img.width, height: img.height } : null;
  }
}

function attachKitAvailability(items) {
  for (const item of items) {
    if (!item.is_kit) continue;
    const avail = stock.kitAvailable(item.id);
    item.availability = describeAvailability(item, avail);
    item.purchasable =
      item.status === 'published' &&
      Number(item.data_confirmed) === 1 &&
      item.price_info.sale > 0 &&
      item.availability.status !== 'out';
  }
}

/** Facettes de filtrage calculées sur le jeu filtré (hors facette elle-même). */
function facets(filters) {
  const base = { ...filters, q: filters.q };
  const categoryRows = db.all(
    `SELECT c.id, c.name, c.slug, COUNT(p.id) AS n
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'published'
      GROUP BY c.id ORDER BY c.name ASC`
  );
  const brandRows = db.all(
    `SELECT b.id, b.name, b.slug, COUNT(p.id) AS n
       FROM products p JOIN brands b ON b.id = p.brand_id
      WHERE p.status = 'published'
      GROUP BY b.id ORDER BY b.name ASC`
  );
  const priceRow = db.get(
    `SELECT MIN(CASE WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
                      AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= ?)
                      AND (p.promo_ends_at IS NULL OR p.promo_ends_at >= ?)
                 THEN p.promo_price ELSE p.price END) AS min_price,
            MAX(CASE WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
                      AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= ?)
                      AND (p.promo_ends_at IS NULL OR p.promo_ends_at >= ?)
                 THEN p.promo_price ELSE p.price END) AS max_price
       FROM products p WHERE p.status = 'published' AND p.price > 0`,
    [dates.nowIso(), dates.nowIso(), dates.nowIso(), dates.nowIso()]
  );
  const totalPublished = db.get("SELECT COUNT(*) AS n FROM products WHERE status = 'published'").n;
  void base;
  return {
    categories: categoryRows,
    brands: brandRows,
    priceBounds: { min: Number(priceRow?.min_price || 0), max: Number(priceRow?.max_price || 0) },
    totalPublished,
  };
}

/* ------------------------------------------------------------------ */
/* Lecture unitaire                                                    */
/* ------------------------------------------------------------------ */
function getById(id, { anyStatus = true } = {}) {
  const row = db.get(
    `${SELECT_BASE} WHERE p.id = ? ${anyStatus ? '' : "AND p.status = 'published'"}`,
    [Number(id)]
  );
  if (!row) return null;
  const product = hydrateRow(row);
  attachImages([product]);
  attachKitAvailability([product]);
  return product;
}

function getBySlug(slug, { anyStatus = false } = {}) {
  const row = db.get(
    `${SELECT_BASE} WHERE p.slug = ? ${anyStatus ? '' : "AND p.status = 'published'"}`,
    [String(slug)]
  );
  if (!row) return null;
  const product = hydrateRow(row);
  attachImages([product]);
  attachKitAvailability([product]);
  return product;
}

function rawProduct(id) {
  return db.get('SELECT * FROM products WHERE id = ?', [Number(id)]);
}

function variantsOf(productId) {
  const rows = db.all(
    `SELECT v.*, si.qty_on_hand, si.qty_reserved, (si.qty_on_hand - si.qty_reserved) AS available
       FROM product_variants v
       LEFT JOIN stock_items si ON si.variant_id = v.id
      WHERE v.product_id = ?
      ORDER BY v.position ASC, v.id ASC`,
    [productId]
  );
  return rows.map((v) => {
    const options = safeParse(v.options, {});
    const label = Object.values(options).filter(Boolean).join(' · ');
    return { ...v, options, options_label: label, price_info: null };
  });
}

function getVariant(variantId) {
  const v = db.get('SELECT * FROM product_variants WHERE id = ?', [Number(variantId)]);
  if (!v) return null;
  return { ...v, options: safeParse(v.options, {}) };
}

function attributesOf(productId) {
  return db.all('SELECT * FROM product_attributes WHERE product_id = ? ORDER BY position ASC, label ASC', [productId]);
}

function imagesOf(productId) {
  return db.all(
    `SELECT pi.*, m.file_key, m.width, m.height, m.bytes, m.mime
       FROM product_images pi JOIN media_files m ON m.id = pi.media_id
      WHERE pi.product_id = ?
      ORDER BY pi.is_primary DESC, pi.position ASC, pi.id ASC`,
    [productId]
  );
}

function related(product, limit = 8) {
  if (!product) return [];
  const params = [product.id];
  let orderSql;
  if (product.category_id) {
    orderSql = 'ORDER BY (CASE WHEN p.category_id = ? THEN 0 ELSE 1 END) ASC, p.featured DESC, p.published_at DESC';
    params.push(product.category_id);
  } else {
    orderSql = 'ORDER BY p.featured DESC, p.published_at DESC';
  }
  params.push(Number(limit));
  const rows = db.all(
    `${SELECT_BASE} WHERE p.id != ? AND p.status = 'published' ${orderSql} LIMIT ?`,
    params
  );
  const items = rows.map(hydrateRow);
  attachImages(items);
  return items;
}

function safeParse(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */
const WRITABLE = [
  'sku', 'name', 'slug', 'category_id', 'brand_id', 'short_description', 'description',
  'price', 'compare_at_price', 'promo_price', 'promo_starts_at', 'promo_ends_at',
  'product_condition', 'warranty', 'box_contents', 'sale_unit', 'sale_unit_label',
  'weight_g', 'length_cm', 'width_cm', 'height_cm', 'status', 'is_kit', 'track_stock',
  'low_stock_threshold', 'qty', 'has_variants', 'position', 'featured', 'meta_title',
  'meta_description', 'data_confirmed', 'published_at',
];

function normalizeInput(input, { partial = false } = {}) {
  const data = {};
  const set = (k, v) => { if (v !== undefined) data[k] = v; };

  set('name', input.name !== undefined ? normalizeText(input.name) : undefined);
  if (!partial && !data.name) throw new CatalogError('Le nom du produit est obligatoire.');

  set('sku', input.sku !== undefined ? normalizeText(input.sku).toUpperCase() : undefined);
  set('short_description', input.short_description !== undefined ? normalizeText(input.short_description).slice(0, 500) : undefined);
  set('description', input.description !== undefined ? sanitizeHtml(input.description) : undefined);
  set('warranty', input.warranty !== undefined ? normalizeText(input.warranty).slice(0, 300) : undefined);
  set('box_contents', input.box_contents !== undefined ? sanitizeHtml(input.box_contents) : undefined);
  set('meta_title', input.meta_title !== undefined ? normalizeText(input.meta_title).slice(0, 160) : undefined);
  set('meta_description', input.meta_description !== undefined ? normalizeText(input.meta_description).slice(0, 400) : undefined);

  // Colonnes numériques déclarées NOT NULL en base : « vide » y signifie 0, pas NULL.
  // Les autres (prix barré, prix promotionnel, dimensions) restent réellement NULL.
  const NON_NULLABLE = ['price', 'low_stock_threshold', 'qty', 'weight_g', 'position'];
  for (const key of ['price', 'compare_at_price', 'promo_price', 'low_stock_threshold', 'qty', 'weight_g', 'position']) {
    if (input[key] === undefined) continue;
    // `''` (formulaire) et `null` (ligne de base, duplication, effacement explicite
    // à l'import) signifient « vide ». Ce test doit précéder la conversion numérique :
    // Number(String(null)) vaut NaN.
    if (input[key] === '' || input[key] === null) {
      set(key, NON_NULLABLE.includes(key) ? 0 : null);
      continue;
    }
    const n = Math.round(Number(String(input[key]).replace(/\s/g, '')));
    if (!Number.isFinite(n)) throw new CatalogError(`Valeur numérique attendue pour « ${key} ».`);
    if (n < 0) throw new CatalogError(`« ${key} » ne peut pas être négatif.`);
    set(key, n);
  }
  for (const key of ['length_cm', 'width_cm', 'height_cm']) {
    if (input[key] === undefined) continue;
    if (input[key] === '' || input[key] === null) {
      set(key, null);
      continue;
    }
    const n = Number(String(input[key]).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new CatalogError(`Dimension invalide pour « ${key} ».`);
    set(key, n);
  }

  if (input.sale_unit !== undefined) {
    const unit = String(input.sale_unit || 'piece');
    set('sale_unit', SALE_UNITS.some((u) => u.value === unit) ? unit : 'autre');
  }
  if (input.sale_unit_label !== undefined) set('sale_unit_label', normalizeText(input.sale_unit_label).slice(0, 40));
  if (input.product_condition !== undefined) {
    const c = String(input.product_condition || 'neuf');
    set('product_condition', CONDITIONS.some((x) => x.value === c) ? c : 'neuf');
  }
  if (input.status !== undefined) {
    const s = String(input.status || 'draft');
    if (!STATUSES.some((x) => x.value === s)) throw new CatalogError('Statut de produit invalide.');
    set('status', s);
  }
  for (const flag of ['is_kit', 'track_stock', 'featured', 'data_confirmed']) {
    if (input[flag] !== undefined) set(flag, input[flag] ? 1 : 0);
  }
  for (const key of ['promo_starts_at', 'promo_ends_at', 'published_at']) {
    if (input[key] !== undefined) {
      set(key, input[key] ? dates.fromInput(input[key], { endOfDay: key === 'promo_ends_at' }) : null);
    }
  }
  if (input.category_id !== undefined) {
    set('category_id', input.category_id ? Number(input.category_id) : null);
  }
  if (input.brand !== undefined || input.brand_id !== undefined) {
    if (input.brand_id) set('brand_id', Number(input.brand_id));
    else if (input.brand === '') set('brand_id', null);
    else {
      const brand = findOrCreateBrand(input.brand);
      set('brand_id', brand ? brand.id : null);
    }
  }
  if (input.slug !== undefined || input.name !== undefined) {
    const base = slugify(input.slug || data.name || input.name || 'produit');
    set('slug', base);
  }

  // Cohérence promotion
  if ((data.promo_price || input.promo_price) && data.promo_ends_at === undefined && input.promo_ends_at === undefined) {
    // rien à faire : dates conservées
  }
  return data;
}

function skuExists(sku, excludeId = null) {
  if (!sku) return false;
  return Boolean(db.get('SELECT id FROM products WHERE sku = ? AND id IS NOT ?', [sku, excludeId]));
}

function slugExists(slug, excludeId = null) {
  return Boolean(db.get('SELECT id FROM products WHERE slug = ? AND id IS NOT ?', [slug, excludeId]));
}

/**
 * Crée un produit.
 * `input.variants`, `input.attributes`, `input.kit_components` sont optionnels.
 */
function create(input, { userId = null, skipIndex = false } = {}) {
  const data = normalizeInput(input);
  if (!data.name) throw new CatalogError('Le nom du produit est obligatoire.');
  if (data.sku && skuExists(data.sku)) {
    throw Object.assign(new CatalogError(`La référence « ${data.sku} » existe déjà.`), { code: 'DUPLICATE_SKU' });
  }

  const id = db.transaction(() => {
    data.slug = uniqueSlug(data.slug || slugify(data.name), (s) => slugExists(s));
    if (data.status === 'published' && !data.published_at) data.published_at = dates.nowIso();
    data.updated_at = dates.nowIso();
    data.created_at = dates.nowIso();
    const productId = db.insert('products', {
      sku: data.sku || null,
      name: data.name,
      slug: data.slug,
      category_id: data.category_id ?? null,
      brand_id: data.brand_id ?? null,
      short_description: data.short_description || '',
      description: data.description || '',
      price: data.price || 0,
      compare_at_price: data.compare_at_price ?? null,
      promo_price: data.promo_price ?? null,
      promo_starts_at: data.promo_starts_at ?? null,
      promo_ends_at: data.promo_ends_at ?? null,
      product_condition: data.product_condition || 'neuf',
      warranty: data.warranty || '',
      box_contents: data.box_contents || '',
      sale_unit: data.sale_unit || 'piece',
      sale_unit_label: data.sale_unit_label || '',
      weight_g: data.weight_g ?? null,
      length_cm: data.length_cm ?? null,
      width_cm: data.width_cm ?? null,
      height_cm: data.height_cm ?? null,
      status: data.status || 'draft',
      is_kit: data.is_kit || 0,
      track_stock: data.track_stock === undefined ? 1 : data.track_stock,
      low_stock_threshold: data.low_stock_threshold || 0,
      qty: data.qty || 0,
      has_variants: 0,
      position: data.position || 0,
      featured: data.featured || 0,
      meta_title: data.meta_title || '',
      meta_description: data.meta_description || '',
      data_confirmed: data.data_confirmed || 0,
      published_at: data.published_at ?? null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });

    if (Array.isArray(input.variants) && input.variants.length) saveVariants(productId, input.variants);
    if (Array.isArray(input.attributes)) saveAttributes(productId, input.attributes);
    if (Array.isArray(input.kit_components)) stock.saveKitComponents(productId, input.kit_components);

    stock.syncItems(productId, { userId });
    // Même garde-fou qu'en modification et qu'à la publication manuelle : un
    // article publié doit avoir un prix et des données confirmées. Sans cela il
    // repasse en brouillon — invisible en vitrine et absent du sitemap — tant
    // que le propriétaire n'a pas confirmé le prix et la disponibilité.
    const fresh = rawProduct(productId);
    if (fresh && fresh.status === 'published' && (!fresh.price || fresh.price <= 0 || !fresh.data_confirmed)) {
      db.run("UPDATE products SET status = 'draft' WHERE id = ?", [productId]);
    }
    if (!skipIndex) indexProduct(productId);
    audit(userId, 'product.create', productId, { sku: data.sku, name: data.name });
    return productId;
  });

  return getById(id);
}

function update(id, input, { userId = null, skipIndex = false } = {}) {
  const existing = rawProduct(id);
  if (!existing) throw new CatalogError('Produit introuvable.', 'NOT_FOUND', 404);
  const data = normalizeInput(input, { partial: true });

  if (data.sku && skuExists(data.sku, id)) {
    throw Object.assign(new CatalogError(`La référence « ${data.sku} » existe déjà.`), { code: 'DUPLICATE_SKU' });
  }

  const result = db.transaction(() => {
    if (data.slug) data.slug = uniqueSlug(slugify(data.slug), (s) => slugExists(s, id));
    const statusBefore = existing.status;
    if (data.status && data.status === 'published' && statusBefore !== 'published' && !data.published_at) {
      data.published_at = dates.nowIso();
    }
    data.updated_at = dates.nowIso();
    for (const key of Object.keys(data)) {
      if (!WRITABLE.includes(key) && key !== 'updated_at') delete data[key];
    }
    if (Object.keys(data).length) db.update('products', id, data);

    if (input.variants !== undefined) saveVariants(id, input.variants);
    if (input.attributes !== undefined) saveAttributes(id, input.attributes);
    if (input.kit_components !== undefined) stock.saveKitComponents(id, input.kit_components);

    const fresh = rawProduct(id);
    // Un article publié sans prix ni confirmation repasse en brouillon.
    if (fresh.status === 'published' && (!fresh.price || fresh.price <= 0 || !fresh.data_confirmed)) {
      db.run("UPDATE products SET status = 'draft', updated_at = ? WHERE id = ?", [dates.nowIso(), id]);
    }
    stock.syncItems(id, { userId });
    if (!skipIndex) indexProduct(id);
    audit(userId, 'product.update', id, data);
    return id;
  });

  return getById(result);
}

function duplicate(id, { userId = null, publish = false } = {}) {
  const source = rawProduct(id);
  if (!source) throw new CatalogError('Produit introuvable.', 'NOT_FOUND', 404);
  const variants = variantsOf(id);
  const attributes = attributesOf(id);
  const images = imagesOf(id);
  const kit = db.all('SELECT * FROM kit_items WHERE kit_product_id = ?', [id]);

  const copy = {
    ...source,
    name: `${source.name} (copie)`,
    sku: source.sku ? nextSku(source.sku) : null,
    slug: `${source.slug}-copie`,
    status: publish ? 'published' : 'draft',
    published_at: null,
    view_count: 0,
    qty: 0,
    created_at: null,
    updated_at: null,
  };
  delete copy.id;

  const newId = db.transaction(() => {
    const productId = create(copy, { userId, skipIndex: true });
    if (variants.length) {
      saveVariants(
        productId.id,
        variants.map((v) => ({
          sku: v.sku ? nextSku(v.sku) : '',
          options: v.options,
          price: v.price,
          promo_price: v.promo_price,
          compare_at_price: v.compare_at_price,
          weight_g: v.weight_g,
          barcode: '',
          active: v.active,
          position: v.position,
        }))
      );
    }
    if (attributes.length) {
      saveAttributes(productId.id, attributes.map((a) => ({ key: a.key, label: a.label, value: a.value, unit: a.unit, position: a.position })));
    }
    if (kit.length) {
      stock.saveKitComponents(productId.id, kit.map((k) => ({
        component_product_id: k.component_product_id,
        component_variant_id: k.component_variant_id,
        quantity: k.quantity,
      })));
    }
    // Les photos sont partagées (même média) : pas de duplication de fichiers.
    for (const img of images) {
      db.insert('product_images', {
        product_id: productId.id,
        media_id: img.media_id,
        position: img.position,
        is_primary: img.is_primary,
        alt: img.alt,
      });
    }
    stock.syncItems(productId.id, { userId });
    indexProduct(productId.id);
    audit(userId, 'product.duplicate', productId.id, { from: id });
    return productId.id;
  });
  return getById(newId);
}

/** Génère une référence dérivée sans collision : ABC-123 -> ABC-123-C1. */
function nextSku(sku) {
  const base = String(sku || '').toUpperCase();
  let candidate = `${base}-C1`;
  let i = 1;
  while (skuExists(candidate)) {
    i += 1;
    candidate = `${base}-C${i}`;
    if (i > 500) return `${base}-${Date.now().toString(36).toUpperCase()}`;
  }
  return candidate;
}

function setStatus(id, status, userId = null) {
  if (!STATUSES.some((s) => s.value === status)) throw new CatalogError('Statut invalide.');
  const product = rawProduct(id);
  if (!product) throw new CatalogError('Produit introuvable.', 'NOT_FOUND', 404);
  if (status === 'published') {
    const problems = [];
    if (!product.price || product.price <= 0) problems.push('un prix');
    if (!product.data_confirmed) problems.push('la confirmation du prix et de la disponibilité');
    if (!product.sku) problems.push('une référence');
    if (problems.length) {
      throw new CatalogError(`Publication impossible : il manque ${problems.join(', ')}.`, 'NOT_PUBLISHABLE');
    }
  }
  db.transaction(() => {
    db.run('UPDATE products SET status = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?', [
      status,
      status === 'published' ? dates.nowIso() : null,
      dates.nowIso(),
      id,
    ]);
    indexProduct(id);
    audit(userId, 'product.status', id, { from: product.status, to: status });
  });
  return getById(id);
}

function archive(id, userId = null) {
  return setStatus(id, 'archived', userId);
}

function remove(id, userId = null) {
  const product = rawProduct(id);
  if (!product) return false;
  const usedInOrders = db.get('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?', [id]).c;
  db.transaction(() => {
    if (usedInOrders > 0) {
      // Les lignes de commande doivent rester lisibles : archivage au lieu de suppression.
      db.run("UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?", [dates.nowIso(), id]);
      indexProduct(id);
    } else {
      db.run('DELETE FROM products_fts WHERE product_id = ?', [String(id)]);
      db.run('DELETE FROM products WHERE id = ?', [id]);
    }
    audit(userId, usedInOrders ? 'product.archive' : 'product.delete', id, { used_in_orders: usedInOrders });
  });
  return true;
}

/** Modifications en masse : prix, catégories, stocks, statuts. */
function bulkUpdate(ids, changes, { userId = null } = {}) {
  const targets = (ids || []).map(Number).filter(Boolean);
  const report = { count: 0, skipped: 0, demoted: 0, details: [] };
  // Rien à faire si aucune cible ou aucun changement demandé : sans ce contrôle,
  // la fonction annonçait « 1 produit modifié » pour un appel vide (et
  // réindexait l'article pour rien).
  const asked = Object.keys(changes || {}).filter((key) => changes[key] !== undefined);
  if (!targets.length || !asked.length) return report;

  db.transaction(() => {
    for (const id of targets) {
      const product = rawProduct(id);
      if (!product) { report.skipped += 1; continue; }
      try {
        if (changes.category_id !== undefined) {
          db.run('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?', [
            changes.category_id ? Number(changes.category_id) : null, dates.nowIso(), id,
          ]);
        }
        if (changes.status !== undefined) {
          setStatus(id, changes.status, userId);
        }
        if (changes.brand !== undefined) {
          const brand = changes.brand ? findOrCreateBrand(changes.brand) : null;
          db.run('UPDATE products SET brand_id = ?, updated_at = ? WHERE id = ?', [brand ? brand.id : null, dates.nowIso(), id]);
        }
        // Prix : absolu ou variation
        if (changes.price_set !== undefined && changes.price_set !== '') {
          db.run('UPDATE products SET price = ?, updated_at = ? WHERE id = ?', [
            Math.max(0, Math.round(Number(changes.price_set))), dates.nowIso(), id,
          ]);
        }
        if (changes.price_delta !== undefined && changes.price_delta !== '' && Number(changes.price_delta) !== 0) {
          db.run('UPDATE products SET price = MAX(0, price + ?), updated_at = ? WHERE id = ?', [
            Math.round(Number(changes.price_delta)), dates.nowIso(), id,
          ]);
        }
        if (changes.price_percent !== undefined && changes.price_percent !== '' && Number(changes.price_percent) !== 0) {
          db.run('UPDATE products SET price = MAX(0, CAST(ROUND(price * (1 + ? / 100.0)) AS INTEGER)), updated_at = ? WHERE id = ?', [
            Number(changes.price_percent), dates.nowIso(), id,
          ]);
        }
        if (changes.round_to !== undefined && changes.price_delta !== undefined) {
          // Arrondi commercial optionnel (ex. 50 FCFA) appliqué après variation.
          const unit = Math.max(1, Math.round(Number(changes.round_to) || 1));
          db.run(`UPDATE products SET price = CAST(ROUND(price * 1.0 / ?) AS INTEGER) * ?, updated_at = ? WHERE id = ?`, [
            unit, unit, dates.nowIso(), id,
          ]);
        }
        if (changes.low_stock_threshold !== undefined && changes.low_stock_threshold !== '') {
          db.run('UPDATE products SET low_stock_threshold = ?, updated_at = ? WHERE id = ?', [
            Math.max(0, Math.round(Number(changes.low_stock_threshold))), dates.nowIso(), id,
          ]);
        }
        if (changes.track_stock !== undefined) {
          db.run('UPDATE products SET track_stock = ?, updated_at = ? WHERE id = ?', [changes.track_stock ? 1 : 0, dates.nowIso(), id]);
        }
        if (changes.stock_delta !== undefined && changes.stock_delta !== '' && Number(changes.stock_delta) !== 0) {
          for (const item of stock.itemsForProduct(id)) {
            try {
              stock.adjust(item.id, Number(changes.stock_delta), {
                reason: 'ajustement',
                note: 'Modification en masse',
                userId,
                reference: product.sku || `P${id}`,
              });
            } catch (err) {
              report.details.push({ id, error: err.message });
            }
          }
        }
        if (changes.featured !== undefined) {
          db.run('UPDATE products SET featured = ?, updated_at = ? WHERE id = ?', [changes.featured ? 1 : 0, dates.nowIso(), id]);
        }
        if (changes.data_confirmed !== undefined) {
          db.run('UPDATE products SET data_confirmed = ?, updated_at = ? WHERE id = ?', [changes.data_confirmed ? 1 : 0, dates.nowIso(), id]);
        }

        // Même garde-fou que la fiche produit : un article publié sans prix
        // confirmé ne doit pas rester en vitrine (ni dans le sitemap). Sans ce
        // contrôle, une modification en masse pouvait laisser publié un article
        // ramené à 0 FCFA ou dont la confirmation venait d'être retirée.
        const fresh = rawProduct(id);
        if (fresh && fresh.status === 'published' && (!fresh.price || fresh.price <= 0 || !fresh.data_confirmed)) {
          db.run("UPDATE products SET status = 'draft', updated_at = ? WHERE id = ?", [dates.nowIso(), id]);
          report.demoted += 1;
          report.details.push({ id, sku: product.sku, demoted: true });
        }

        indexProduct(id);
        report.count += 1;
      } catch (err) {
        report.skipped += 1;
        report.details.push({ id, sku: product.sku, error: err.message });
      }
    }
    audit(userId, 'product.bulk_update', '', { ids: targets.length, changes: Object.keys(changes) });
  });
  return report;
}

/* ------------------------------------------------------------------ */
/* Variantes, attributs, images                                        */
/* ------------------------------------------------------------------ */
function saveVariants(productId, variants) {
  const list = Array.isArray(variants) ? variants : [];
  const keptIds = [];
  db.transaction(() => {
    for (const [index, v] of list.entries()) {
      const options = typeof v.options === 'string' ? safeParse(v.options, {}) : (v.options || {});
      const cleanOptions = {};
      for (const [k, val] of Object.entries(options)) {
        const key = normalizeText(k);
        const value = normalizeText(val);
        if (key && value) cleanOptions[key] = value;
      }
      if (!Object.keys(cleanOptions).length && list.length > 1) continue;
      const sku = v.sku ? normalizeText(v.sku).toUpperCase() : null;
      if (sku && db.get('SELECT id FROM product_variants WHERE sku = ? AND product_id IS NOT ?', [sku, productId])) {
        throw new CatalogError(`La référence de variante « ${sku} » est déjà utilisée.`);
      }
      const data = {
        product_id: productId,
        sku,
        options: JSON.stringify(cleanOptions),
        price: v.price === '' || v.price === null || v.price === undefined ? null : Math.max(0, Math.round(Number(v.price) || 0)),
        promo_price: v.promo_price === '' || v.promo_price == null ? null : Math.max(0, Math.round(Number(v.promo_price) || 0)),
        compare_at_price: v.compare_at_price === '' || v.compare_at_price == null ? null : Math.max(0, Math.round(Number(v.compare_at_price) || 0)),
        weight_g: v.weight_g === '' || v.weight_g == null ? null : Math.max(0, Math.round(Number(v.weight_g) || 0)),
        barcode: normalizeText(v.barcode || '').slice(0, 60),
        active: v.active === undefined || v.active === '' ? 1 : (v.active ? 1 : 0),
        position: Number.isFinite(Number(v.position)) ? Number(v.position) : index,
        updated_at: dates.nowIso(),
      };
      let variantId = v.id ? Number(v.id) : null;
      if (variantId && db.get('SELECT id FROM product_variants WHERE id = ? AND product_id = ?', [variantId, productId])) {
        db.update('product_variants', variantId, data);
      } else {
        variantId = db.insert('product_variants', data);
      }
      keptIds.push(variantId);
      if (v.stock !== undefined && v.stock !== '') {
        const item = stock.itemFor(productId, variantId);
        if (item) {
          try {
            stock.setOnHand(item.id, Math.max(0, Math.round(Number(v.stock) || 0)), {
              reason: 'ajustement',
              note: 'Stock variante',
              reference: sku || `V${variantId}`,
            });
          } catch { /* réservation active : ignoré, signalé par l'interface */ }
        }
      }
    }
    // Supprime les variantes retirées (sans réservation active).
    const rows = db.all('SELECT id FROM product_variants WHERE product_id = ?', [productId]);
    for (const r of rows) {
      if (keptIds.includes(r.id)) continue;
      const reserved = db.get('SELECT COALESCE(SUM(qty),0) AS q FROM reservations WHERE stock_item_id IN (SELECT id FROM stock_items WHERE variant_id = ?) AND status = \'active\'', [r.id]);
      if (Number(reserved?.q || 0) > 0) continue;
      db.run('DELETE FROM product_variants WHERE id = ?', [r.id]);
    }
    db.run('UPDATE products SET has_variants = ?, updated_at = ? WHERE id = ?', [
      db.get('SELECT COUNT(*) AS c FROM product_variants WHERE product_id = ?', [productId]).c > 0 ? 1 : 0,
      dates.nowIso(),
      productId,
    ]);
  });
  stock.syncItems(productId);
  return variantsOf(productId);
}

function saveAttributes(productId, attributes) {
  const list = Array.isArray(attributes) ? attributes : [];
  db.transaction(() => {
    db.run('DELETE FROM product_attributes WHERE product_id = ?', [productId]);
    list.forEach((a, index) => {
      const key = normalizeText(a.key || slugify(a.label || ''));
      const value = normalizeText(a.value === undefined || a.value === null ? '' : String(a.value));
      if (!key || value === '') return;
      db.insert('product_attributes', {
        product_id: productId,
        key,
        label: normalizeText(a.label || key).slice(0, 120),
        value: value.slice(0, 500),
        unit: normalizeText(a.unit || '').slice(0, 20),
        position: Number.isFinite(Number(a.position)) ? Number(a.position) : index,
      });
    });
  });
  indexProduct(productId);
  return attributesOf(productId);
}

function attachImage(productId, mediaId, { alt = '', primary = false, userId = null } = {}) {
  const media = db.get('SELECT * FROM media_files WHERE id = ?', [mediaId]);
  if (!media) throw new CatalogError('Média introuvable.', 'NOT_FOUND', 404);
  const hasPrimary = db.get('SELECT id FROM product_images WHERE product_id = ? AND is_primary = 1', [productId]);
  const position = (db.get('SELECT COALESCE(MAX(position),0)+1 AS p FROM product_images WHERE product_id = ?', [productId])?.p) || 0;
  db.transaction(() => {
    const id = db.insert('product_images', {
      product_id: productId,
      media_id: mediaId,
      position,
      is_primary: primary || !hasPrimary ? 1 : 0,
      alt: normalizeText(alt).slice(0, 250),
    });
    if (primary || !hasPrimary) {
      db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ? AND id != ?', [productId, id]);
    }
    audit(userId, 'product.image_add', productId, { media_id: mediaId });
    return id;
  });
  indexProduct(productId);
  return imagesOf(productId);
}

function setPrimaryImage(productId, imageId) {
  db.transaction(() => {
    db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ?', [productId]);
    db.run('UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ?', [imageId, productId]);
  });
  return imagesOf(productId);
}

function reorderImages(productId, imageIds) {
  db.transaction(() => {
    imageIds.forEach((imgId, index) => {
      db.run('UPDATE product_images SET position = ? WHERE id = ? AND product_id = ?', [index, Number(imgId), productId]);
      if (index === 0) db.run('UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ?', [Number(imgId), productId]);
      else db.run('UPDATE product_images SET is_primary = 0 WHERE id = ? AND product_id = ?', [Number(imgId), productId]);
    });
  });
  return imagesOf(productId);
}

function removeImage(imageId, { userId = null } = {}) {
  const row = db.get('SELECT * FROM product_images WHERE id = ?', [imageId]);
  if (!row) return false;
  db.transaction(() => {
    db.run('DELETE FROM product_images WHERE id = ?', [imageId]);
    const stillUsed = db.get('SELECT COUNT(*) AS c FROM product_images WHERE media_id = ?', [row.media_id]).c;
    if (!stillUsed) {
      // La clé de fichier doit être lue AVANT la suppression de la ligne,
      // sinon le fichier reste orphelin sur le disque.
      const fileKey = db.get('SELECT file_key FROM media_files WHERE id = ?', [row.media_id])?.file_key;
      db.run('DELETE FROM media_files WHERE id = ?', [row.media_id]);
      if (fileKey) require('../lib/images').removeMedia(fileKey);
    }
    const next = db.get('SELECT id FROM product_images WHERE product_id = ? ORDER BY position ASC LIMIT 1', [row.product_id]);
    if (next) db.run('UPDATE product_images SET is_primary = 1 WHERE id = ?', [next.id]);
    audit(userId, 'product.image_remove', row.product_id, { image_id: imageId });
    indexProduct(row.product_id);
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Statistiques utiles à l'administration                              */
/* ------------------------------------------------------------------ */
function counts() {
  const rows = db.all('SELECT status, COUNT(*) AS n FROM products GROUP BY status');
  const out = { draft: 0, published: 0, archived: 0, total: 0, notConfirmed: 0, withoutImage: 0, lowStock: 0, outOfStock: 0 };
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  out.notConfirmed = db.get('SELECT COUNT(*) AS n FROM products WHERE data_confirmed = 0').n;
  out.withoutImage = db.get(
    "SELECT COUNT(*) AS n FROM products p WHERE p.status != 'archived' AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)"
  ).n;
  out.lowStock = stock.lowStockList(1000).length;
  out.outOfStock = db.get(
    `SELECT COUNT(*) AS n FROM products p
      WHERE p.status = 'published' AND p.track_stock = 1
        AND COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si WHERE si.product_id = p.id),0) <= 0`
  ).n;
  return out;
}

/** Fourchette de prix réellement constatée (utile aux filtres). */
function priceBounds(status = 'published') {
  const row = db.get(
    `SELECT MIN(price) AS min_price, MAX(price) AS max_price FROM products WHERE status = ? AND price > 0`,
    [status]
  );
  return { min: Number(row?.min_price || 0), max: Number(row?.max_price || 0) };
}

function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'system',
      action,
      entity_type: 'product',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* noop */ }
}

module.exports = {
  SALE_UNITS,
  CONDITIONS,
  STATUSES,
  SORTS,
  CatalogError,
  listBrands,
  getBrand,
  findOrCreateBrand,
  promoActive,
  priceOf,
  priceRange,
  availabilityOf,
  describeAvailability,
  purchasability,
  indexProduct,
  reindexAll,
  buildMatchQuery,
  list,
  facets,
  getById,
  getBySlug,
  rawProduct,
  variantsOf,
  getVariant,
  attributesOf,
  imagesOf,
  related,
  create,
  update,
  duplicate,
  nextSku,
  setStatus,
  archive,
  remove,
  bulkUpdate,
  saveVariants,
  saveAttributes,
  attachImage,
  setPrimaryImage,
  reorderImages,
  removeImage,
  counts,
  priceBounds,
  skuExists,
  slugExists,
  categories,
};
