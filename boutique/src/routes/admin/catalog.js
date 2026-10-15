'use strict';

/** Administration du catalogue : produits, catégories, marques, médiathèque. */

const express = require('express');
const db = require('../../db');
const products = require('../../domain/products');
const categories = require('../../domain/categories');
const stock = require('../../domain/stock');
const images = require('../../lib/images');
const settings = require('../../lib/settings');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const auth = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const { flash, notFound, queryString } = require('../../lib/http');
const { Validator, sanitizeHtml } = require('../../lib/validate');
const { normalizeText, slugify } = require('../../lib/slug');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Liste des produits                                                  */
/* ------------------------------------------------------------------ */
router.get('/produits', auth.requirePermission('catalog.read'), (req, res) => {
  const filters = {
    statuses: req.query.statut ? [String(req.query.statut)] : ['published', 'draft', 'archived'],
    q: req.query.q ? String(req.query.q) : '',
    like: req.query.recherche ? String(req.query.recherche) : '',
    sku: req.query.ref ? String(req.query.ref) : '',
    categoryIds: req.query.categorie ? categories.descendantIds(Number(req.query.categorie)) : null,
    brandIds: req.query.marque ? [Number(req.query.marque)] : null,
    lowStock: req.query.stock === 'alerte',
    notConfirmed: req.query.confirmation === 'non',
    noImage: req.query.photo === 'sans',
    purchasableOnly: req.query.achetable === '1',
    sort: req.query.tri || 'nouveaute',
  };
  const result = products.list(filters, { page: Number(req.query.page) || 1, perPage: Number(req.query.par_page) || 25 });

  res.render('admin/products/list', {
    title: 'Produits',
    activeNav: 'products',
    items: result.items,
    pagination: result.pagination,
    filters,
    tree: categories.tree({ includeArchived: true }),
    brands: products.listBrands({ includeArchived: true }),
    counts: products.counts(),
    qs: queryString,
    statuses: products.STATUSES,
    units: products.SALE_UNITS,
  });
});

/* ------------------------------------------------------------------ */
/* Formulaire produit (création et modification)                       */
/* ------------------------------------------------------------------ */
function productFormData(req, product = null) {
  const body = req.body || {};
  const isForm = Object.keys(body).length > 0;
  const src = isForm ? body : product || {};

  const variants = isForm ? parseVariantForm(body) : product ? products.variantsOf(product.id) : [];
  const attributes = isForm ? parseAttributeForm(body) : product ? products.attributesOf(product.id) : [];
  const kit = isForm ? parseKitForm(body) : product ? stock.kitComponents(product.id) : [];
  const imagesList = product ? products.imagesOf(product.id) : [];

  return {
    values: {
      sku: src.sku ?? product?.sku ?? '',
      name: src.name ?? product?.name ?? '',
      slug: src.slug ?? product?.slug ?? '',
      category_id: Number(src.category_id ?? product?.category_id ?? 0) || '',
      brand: isForm ? src.brand : product?.brand_name ?? '',
      short_description: src.short_description ?? product?.short_description ?? '',
      description: src.description ?? product?.description ?? '',
      price: money.plain(src.price ?? product?.price ?? ''),
      compare_at_price: src.compare_at_price === null ? '' : money.plain(src.compare_at_price ?? product?.compare_at_price ?? ''),
      promo_price: src.promo_price === null ? '' : money.plain(src.promo_price ?? product?.promo_price ?? ''),
      promo_starts_at: dates.toDateInput(src.promo_starts_at ?? product?.promo_starts_at ?? ''),
      promo_ends_at: dates.toDateInput(src.promo_ends_at ?? product?.promo_ends_at ?? ''),
      product_condition: src.product_condition ?? product?.product_condition ?? 'neuf',
      warranty: src.warranty ?? product?.warranty ?? '',
      box_contents: src.box_contents ?? product?.box_contents ?? '',
      sale_unit: src.sale_unit ?? product?.sale_unit ?? 'piece',
      sale_unit_label: src.sale_unit_label ?? product?.sale_unit_label ?? '',
      weight_g: src.weight_g ?? product?.weight_g ?? '',
      length_cm: src.length_cm ?? product?.length_cm ?? '',
      width_cm: src.width_cm ?? product?.width_cm ?? '',
      height_cm: src.height_cm ?? product?.height_cm ?? '',
      status: src.status ?? product?.status ?? 'draft',
      track_stock: isForm ? Boolean(src.track_stock) : Boolean(product?.track_stock ?? true),
      low_stock_threshold: src.low_stock_threshold ?? product?.low_stock_threshold ?? 0,
      qty: src.qty ?? (product ? stock.itemFor(product.id)?.qty_on_hand ?? 0 : 0),
      featured: isForm ? Boolean(src.featured) : Boolean(product?.featured),
      data_confirmed: isForm ? Boolean(src.data_confirmed) : Boolean(product?.data_confirmed),
      is_kit: isForm ? Boolean(src.is_kit) : Boolean(product?.is_kit),
      meta_title: src.meta_title ?? product?.meta_title ?? '',
      meta_description: src.meta_description ?? product?.meta_description ?? '',
    },
    variants,
    attributes,
    kit,
    images: imagesList,
  };
}

/**
 * Le formulaire envoie les variantes sous forme de tableaux parallèles :
 * variants[id][], variants[options_*][], variants[price][], variants[stock][]…
 */
function parseVariantForm(body) {
  const raw = body.variants;
  if (!raw || typeof raw !== 'object') return [];
  const keys = Object.keys(raw.id || raw.options_1 || raw.price || {});
  const out = [];
  for (const k of keys) {
    const get = (field) => (raw[field] ? raw[field][k] : undefined);
    const options = {};
    for (let i = 1; i <= 4; i += 1) {
      const name = normalizeText(get(`options_name_${i}`) || '');
      const value = normalizeText(get(`options_value_${i}`) || '');
      if (name && value) options[name] = value;
    }
    const stockValue = get('stock');
    if (!Object.keys(options).length && !get('sku') && (stockValue === undefined || stockValue === '')) continue;
    out.push({
      id: get('id') || null,
      sku: normalizeText(get('sku') || '').toUpperCase(),
      options,
      price: get('price') === '' ? null : get('price'),
      promo_price: get('promo_price') === '' ? null : get('promo_price'),
      compare_at_price: get('compare_at_price') === '' ? null : get('compare_at_price'),
      weight_g: get('weight_g') === '' ? null : get('weight_g'),
      barcode: get('barcode') || '',
      active: get('active') ? 1 : 1,
      stock: stockValue,
      position: out.length,
    });
  }
  return out;
}

function parseAttributeForm(body) {
  const raw = body.attributes;
  if (!raw || typeof raw !== 'object') return [];
  const keys = Object.keys(raw.label || raw.key || {});
  const out = [];
  for (const k of keys) {
    const label = normalizeText(raw.label?.[k] || '');
    const key = normalizeText(raw.key?.[k] || slugify(label));
    const value = normalizeText(raw.value?.[k] || '');
    if (!label || !value) continue;
    out.push({ key, label, value, unit: normalizeText(raw.unit?.[k] || ''), position: out.length });
  }
  return out;
}

function parseKitForm(body) {
  const raw = body.kit;
  if (!raw || typeof raw !== 'object') return [];
  const keys = Object.keys(raw.component_product_id || {});
  const out = [];
  for (const k of keys) {
    const id = Number(raw.component_product_id?.[k] || 0);
    if (!id) continue;
    out.push({
      component_product_id: id,
      component_variant_id: Number(raw.component_variant_id?.[k] || 0) || null,
      quantity: Math.max(1, Number(raw.quantity?.[k] || 1)),
    });
  }
  return out;
}

function buildProductPayload(body) {
  const v = new Validator(body);
  v.string('name', { required: true, min: 2, max: 250, label: 'Nom du produit' });
  v.string('sku', { required: false, max: 80, label: 'Référence' });
  v.string('slug', { max: 100, label: 'URL' });
  v.string('short_description', { max: 500, label: 'Description courte' });
  v.richText('description', { max: 20000, label: 'Description détaillée' });
  v.richText('box_contents', { max: 4000, label: 'Contenu fourni' });
  v.amount('price', { required: false, min: 0, fallback: null, label: 'Prix' });
  v.amount('compare_at_price', { min: 0, fallback: null, label: 'Prix de référence' });
  v.amount('promo_price', { min: 0, fallback: null, label: 'Prix promotionnel' });
  v.date('promo_starts_at', { label: 'Début de promotion' });
  v.date('promo_ends_at', { endOfDay: true, label: 'Fin de promotion' });
  v.integer('weight_g', { min: 0, max: 1000000, fallback: null, label: 'Poids' });
  v.number('length_cm', { min: 0, max: 1000, fallback: null, label: 'Longueur' });
  v.number('width_cm', { min: 0, max: 1000, fallback: null, label: 'Largeur' });
  v.number('height_cm', { min: 0, max: 1000, fallback: null, label: 'Hauteur' });
  v.integer('low_stock_threshold', { min: 0, max: 1000000, fallback: 0, label: "Seuil d'alerte" });
  v.integer('qty', { min: 0, max: 10000000, fallback: 0, label: 'Stock' });
  v.enum('status', ['draft', 'published', 'archived'], { fallback: 'draft', label: 'Statut' });
  v.enum('product_condition', ['neuf', 'reconditionne', 'occasion', 'lot'], { fallback: 'neuf', label: 'État' });
  v.enum('sale_unit', products.SALE_UNITS.map((u) => u.value), { fallback: 'piece', label: 'Unité de vente' });
  v.string('sale_unit_label', { max: 40, label: "Libellé d'unité" });
  v.string('warranty', { max: 300, label: 'Garantie' });
  v.string('meta_title', { max: 160, label: 'Titre SEO' });
  v.string('meta_description', { max: 400, label: 'Description SEO' });
  v.boolean('track_stock', { fallback: true });
  v.boolean('featured');
  v.boolean('data_confirmed');
  v.boolean('is_kit');
  v.integer('category_id', { min: 1, fallback: null, label: 'Catégorie' });

  const values = v.throwIfInvalid('Formulaire produit');
  if (values.promo_price && values.price && values.promo_price >= values.price) {
    throw Object.assign(new Error('Le prix promotionnel doit être inférieur au prix de vente.'), { status: 400 });
  }
  if (values.promo_starts_at && values.promo_ends_at && values.promo_ends_at < values.promo_starts_at) {
    throw Object.assign(new Error('La fin de la promotion précède son début.'), { status: 400 });
  }
  return {
    ...values,
    brand: body.brand !== undefined ? body.brand : body.brand_id || '',
    sku: values.sku ? values.sku.toUpperCase() : null,
  };
}

function renderProductForm(req, res, { product = null, errors = {}, status = 200, title }) {
  const data = productFormData(req, product);
  const categoryAttributes = data.values.category_id ? categories.attributeTemplates(data.values.category_id) : [];
  res.status(status).render('admin/products/form', {
    title,
    activeNav: 'products',
    product,
    errors,
    values: data.values,
    variants: data.variants,
    attributes: data.attributes,
    kitComponents: data.kit,
    images: data.images,
    tree: categories.tree({ includeArchived: true }),
    brands: products.listBrands({ includeArchived: true }),
    categoryAttributes,
    statuses: products.STATUSES,
    conditions: products.CONDITIONS,
    units: products.SALE_UNITS,
    stockItem: product ? stock.itemFor(product.id) : null,
    stockItems: product ? stock.itemsForProduct(product.id) : [],
    purchasability: product ? products.purchasability(products.rawProduct(product.id)) : null,
    allProducts: null,
    kitOptions: null,
  });
}

router.get('/produits/nouveau', auth.requirePermission('catalog.write'), (req, res) => {
  renderProductForm(req, res, { product: null, title: 'Nouveau produit' });
});

router.post('/produits/nouveau', auth.requirePermission('catalog.write'), upload.imageUpload, async (req, res, next) => {
  try {
    const payload = buildProductPayload(req.body);
    payload.variants = parseVariantForm(req.body);
    payload.attributes = parseAttributeForm(req.body);
    payload.kit_components = parseKitForm(req.body);
    if (payload.is_kit && !payload.kit_components.length) {
      throw Object.assign(new Error('Un kit doit comporter au moins un composant.'), { status: 400 });
    }
    const created = products.create(payload, { userId: req.admin.user.id });

    // Stock initial saisi dans le formulaire.
    if (payload.track_stock && Number(payload.qty) > 0 && !created.has_variants) {
      const item = stock.itemFor(created.id, null);
      if (item) stock.setOnHand(item.id, Number(payload.qty), { reason: 'initial', note: 'Stock initial', userId: req.admin.user.id, reference: created.sku });
    }

    // Les photos sont traitées AVANT la redirection : sans cet ordre, la fiche
    // s'affichait sans l'image qui venait d'être envoyée (elle n'apparaissait
    // qu'au rechargement suivant).
    flash(req, 'success', `Produit « ${created.name} » créé. Pensez à ajouter une photo et à confirmer le prix avant publication.`);
    if (req.files && req.files.length) {
      const uploaded = await attachUploadedImages(created.id, req.files, req.admin.user.id);
      if (uploaded.rejected.length) flashUploadResult(req, uploaded, 'enregistrée(s)');
    }
    return res.redirect(`/admin/produits/${created.id}`);
  } catch (err) {
    if (err.name === 'ValidationError' || err.code === 'DUPLICATE_SKU' || err.status === 400) {
      return renderProductForm(req, res, { product: null, errors: err.errors || { sku: err.message }, status: err.status || 400, title: 'Nouveau produit' });
    }
    return next(err);
  }
});

router.post('/produits/masse', auth.requirePermission('catalog.write'), (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || '').split(',')).map(Number).filter(Boolean);
  const action = String(req.body.action || '');
  if (!ids.length) {
    flash(req, 'error', 'Aucun produit sélectionné.');
    return res.redirect('/admin/produits');
  }

  const changes = {};
  if (action === 'statut') changes.status = String(req.body.status || '');
  if (action === 'categorie') changes.category_id = req.body.category_id ? Number(req.body.category_id) : null;
  if (action === 'prix') {
    if (req.body.price_set !== '') changes.price_set = req.body.price_set;
    if (req.body.price_delta !== '') changes.price_delta = req.body.price_delta;
    if (req.body.price_percent !== '') changes.price_percent = req.body.price_percent;
    if (req.body.round_to) changes.round_to = req.body.round_to;
  }
  if (action === 'stock') changes.stock_delta = req.body.stock_delta;
  if (action === 'seuil') changes.low_stock_threshold = req.body.low_stock_threshold;
  if (action === 'confirmation') changes.data_confirmed = req.body.data_confirmed === '1';
  if (action === 'suivi_stock') changes.track_stock = req.body.track_stock === '1';
  if (action === 'mise_en_avant') changes.featured = req.body.featured === '1';
  if (action === 'marque') changes.brand = req.body.brand;

  if (!Object.keys(changes).length) {
    flash(req, 'error', 'Aucune modification demandée.');
    return res.redirect('/admin/produits');
  }

  const report = products.bulkUpdate(ids, changes, { userId: req.admin.user.id });
  const notes = [];
  if (report.skipped) notes.push(`${report.skipped} ignoré(s)`);
  if (report.demoted) notes.push(`${report.demoted} repassé(s) en brouillon (prix ou confirmation manquants)`);
  flash(
    req,
    notes.length ? 'warn' : 'success',
    `${report.count} produit(s) modifié(s)${notes.length ? `, ${notes.join(', ')}` : ''}.`
  );
  return res.redirect('/admin/produits');
});

router.get('/produits/:id', auth.requirePermission('catalog.read'), (req, res, next) => {
  const product = products.getById(Number(req.params.id));
  if (!product) return next(notFound('Produit introuvable.'));
  renderProductForm(req, res, { product, title: `Modifier — ${product.name}` });
});

router.post('/produits/:id', auth.requirePermission('catalog.write'), upload.imageUpload, async (req, res, next) => {
  const id = Number(req.params.id);
  const product = products.rawProduct(id);
  if (!product) return next(notFound('Produit introuvable.'));
  try {
    const payload = buildProductPayload(req.body);
    payload.variants = parseVariantForm(req.body);
    payload.attributes = parseAttributeForm(req.body);
    payload.kit_components = parseKitForm(req.body);
    products.update(id, payload, { userId: req.admin.user.id });

    // Ajustement explicite du stock du produit simple.
    const item = stock.itemFor(id, null);
    if (item && req.body.qty !== undefined && req.body.qty !== '' && !payload.variants.length) {
      const target = Math.max(0, Math.round(Number(req.body.qty) || 0));
      if (target !== item.qty_on_hand) {
        stock.setOnHand(item.id, target, {
          reason: 'ajustement',
          note: 'Ajustement depuis la fiche produit',
          userId: req.admin.user.id,
          reference: product.sku || `P${id}`,
        });
      }
    }
    flash(req, 'success', 'Produit enregistré.');
    if (req.files && req.files.length) {
      const uploaded = await attachUploadedImages(id, req.files, req.admin.user.id);
      // Un fichier écarté doit être signalé même quand la fiche est enregistrée.
      if (uploaded.rejected.length) flashUploadResult(req, uploaded, 'enregistrée(s)');
    }
    return res.redirect(`/admin/produits/${id}`);
  } catch (err) {
    if (err.name === 'ValidationError' || err.code === 'DUPLICATE_SKU' || err.status === 400) {
      return renderProductForm(req, res, {
        product: products.getById(id),
        errors: err.errors || { sku: err.message },
        status: err.status || 400,
        title: `Modifier — ${product.name}`,
      });
    }
    return next(err);
  }
});

/**
 * Enregistre les photos téléversées sur un produit.
 *
 * Un fichier illisible est écarté sans interrompre les autres, mais il doit
 * être SIGNALÉ : annoncer « image ajoutée » pour un fichier refusé ferait
 * croire au propriétaire que la photo est en ligne alors qu'elle ne l'est pas.
 * @returns {{attached:number, rejected:{name:string, reason:string}[]}}
 */
async function attachUploadedImages(productId, files, userId) {
  const rejected = [];
  let attached = 0;
  for (const file of files) {
    try {
      const stored = await images.storeImage(file.buffer, { mime: file.mimetype, filename: file.originalname });
      const mediaId = db.insert('media_files', {
        kind: 'image',
        file_key: stored.fileKey,
        filename: String(file.originalname || '').slice(0, 200),
        mime: stored.sourceMime,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        created_by: userId,
      });
      products.attachImage(productId, mediaId, { userId });
      attached += 1;
    } catch (err) {
      require('../../lib/logger').warn('image ignorée', { productId, error: err.message });
      rejected.push({ name: String(file.originalname || 'image'), reason: err.message });
    }
  }
  return { attached, rejected };
}

/** Message flash fidèle au résultat réel d'un téléversement de photos. */
function flashUploadResult(req, { attached, rejected }, suffix = 'ajoutée(s) et optimisée(s)') {
  const details = rejected.map((r) => `${r.name} — ${r.reason}`).join(' · ');
  if (!attached) {
    flash(req, 'error', `Aucune image enregistrée. ${details}`.trim());
  } else if (rejected.length) {
    flash(req, 'warn', `${attached} image(s) ${suffix}, ${rejected.length} fichier(s) écarté(s). ${details}`);
  } else {
    flash(req, 'success', `${attached} image(s) ${suffix}.`);
  }
}

router.post('/produits/:id/dupliquer', auth.requirePermission('catalog.write'), (req, res, next) => {
  try {
    const copy = products.duplicate(Number(req.params.id), { userId: req.admin.user.id });
    flash(req, 'success', `Produit dupliqué : « ${copy.name} » (en brouillon, stock remis à zéro).`);
    return res.redirect(`/admin/produits/${copy.id}`);
  } catch (err) { return next(err); }
});

router.post('/produits/:id/statut', auth.requirePermission('catalog.write'), (req, res, next) => {
  try {
    products.setStatus(Number(req.params.id), String(req.body.status), req.admin.user.id);
    flash(req, 'success', `Statut mis à jour : ${products.STATUSES.find((s) => s.value === req.body.status)?.label || req.body.status}.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(req.body.retour || `/admin/produits/${req.params.id}`);
});

router.post('/produits/:id/supprimer', auth.requirePermission('catalog.delete'), (req, res, next) => {
  try {
    products.remove(Number(req.params.id), req.admin.user.id);
    flash(req, 'info', 'Produit supprimé (ou archivé s’il apparaît dans des commandes).');
    return res.redirect('/admin/produits');
  } catch (err) { return next(err); }
});

/* --- Images --------------------------------------------------------- */
router.post('/produits/:id/images', auth.requirePermission('catalog.write'), upload.imageUpload, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (!req.files || !req.files.length) {
      flash(req, 'error', 'Aucune image reçue.');
      return res.redirect(`/admin/produits/${id}#images`);
    }
    const result = await attachUploadedImages(id, req.files, req.admin.user.id);
    flashUploadResult(req, result);
    return res.redirect(`/admin/produits/${id}#images`);
  } catch (err) { return next(err); }
});

router.post('/produits/:id/images/:imageId/primaire', auth.requirePermission('catalog.write'), (req, res) => {
  products.setPrimaryImage(Number(req.params.id), Number(req.params.imageId));
  flash(req, 'success', 'Image principale mise à jour.');
  return res.redirect(`/admin/produits/${req.params.id}#images`);
});

router.post('/produits/:id/images/reordonner', auth.requirePermission('catalog.write'), (req, res) => {
  const ids = Array.isArray(req.body.order) ? req.body.order.map(Number) : String(req.body.order || '').split(',').map(Number).filter(Boolean);
  products.reorderImages(Number(req.params.id), ids);
  if (require('../../lib/http').isAjax(req)) return res.json({ ok: true });
  flash(req, 'success', 'Ordre des images enregistré.');
  return res.redirect(`/admin/produits/${req.params.id}#images`);
});

router.post('/produits/:id/images/:imageId/supprimer', auth.requirePermission('catalog.write'), (req, res) => {
  products.removeImage(Number(req.params.imageId), { userId: req.admin.user.id });
  flash(req, 'info', 'Image supprimée.');
  return res.redirect(`/admin/produits/${req.params.id}#images`);
});

/** Recherche de produits pour les sélecteurs (composants de kit, par ex.). */
router.get('/api/produits/recherche', auth.requirePermission('catalog.read'), (req, res) => {
  const q = normalizeText(String(req.query.q || '')).slice(0, 80);
  const result = products.list(
    { statuses: ['published', 'draft'], q, like: q && q.length < 3 ? q : '' },
    { page: 1, perPage: 12 }
  );
  res.json({
    items: result.items.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      price: p.price_info.sale,
      priceLabel: money.format(p.price_info.sale),
      image: p.image ? require('../../middleware/context').mediaUrl(p.image.fileKey, 'thumb') : null,
      variants: products.variantsOf(p.id).map((v) => ({ id: v.id, label: v.options_label, sku: v.sku })),
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Modifications en masse                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Catégories                                                          */
/* ------------------------------------------------------------------ */
router.get('/categories', auth.requirePermission('catalog.read'), (req, res) => {
  res.render('admin/categories', {
    title: 'Catégories',
    activeNav: 'categories',
    tree: categories.tree({ includeArchived: true }),
    flat: categories.all(),
    selected: req.query.id ? categories.get(Number(req.query.id)) : null,
    templates: req.query.id ? categories.attributeTemplates(Number(req.query.id)) : [],
  });
});

router.post('/categories', auth.requirePermission('catalog.write'), (req, res, next) => {
  try {
    const created = categories.create({
      name: req.body.name,
      parentId: req.body.parent_id ? Number(req.body.parent_id) : null,
      description: req.body.description,
      slug: req.body.slug,
      userId: req.admin.user.id,
    });
    flash(req, 'success', `Catégorie « ${created.name} » créée.`);
    return res.redirect(`/admin/categories?id=${created.id}`);
  } catch (err) {
    flash(req, 'error', err.message);
    return res.redirect('/admin/categories');
  }
});

router.post('/categories/reordonner', auth.requirePermission('catalog.write'), (req, res) => {
  const order = req.body.order ? (Array.isArray(req.body.order) ? req.body.order : JSON.parse(req.body.order)) : [];
  categories.reorder(order.map((o) => ({ id: Number(o.id), position: Number(o.position) })), req.admin.user.id);
  if (require('../../lib/http').isAjax(req)) return res.json({ ok: true });
  flash(req, 'success', 'Ordre enregistré.');
  return res.redirect('/admin/categories');
});

router.post('/categories/:id', auth.requirePermission('catalog.write'), (req, res) => {
  try {
    categories.update(Number(req.params.id), {
      name: req.body.name,
      slug: req.body.slug,
      description: req.body.description,
      parentId: req.body.parent_id === '' ? null : Number(req.body.parent_id) || undefined,
      archived: req.body.archived === '1',
      position: req.body.position !== undefined ? Number(req.body.position) : undefined,
    }, req.admin.user.id);
    flash(req, 'success', 'Catégorie mise à jour.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/categories?id=${req.params.id}`);
});

router.post('/categories/:id/supprimer', auth.requirePermission('catalog.delete'), (req, res) => {
  try {
    categories.remove(Number(req.params.id), req.admin.user.id);
    flash(req, 'info', 'Catégorie supprimée. Les sous-catégories ont été rattachées au niveau supérieur.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/categories');
});


router.post('/categories/:id/attributs', auth.requirePermission('catalog.write'), (req, res) => {
  try {
    categories.saveAttributeTemplate(
      Number(req.params.id),
      {
        key: req.body.key,
        label: req.body.label,
        type: req.body.type,
        options: String(req.body.options || '').split(/[;,\n]/).map((s) => s.trim()).filter(Boolean),
        unit: req.body.unit,
        required: req.body.required === '1',
        position: Number(req.body.position) || 0,
      },
      req.admin.user.id
    );
    flash(req, 'success', 'Caractéristique enregistrée pour cette catégorie.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect(`/admin/categories?id=${req.params.id}`);
});

router.post('/categories/attributs/:templateId/supprimer', auth.requirePermission('catalog.write'), (req, res) => {
  categories.deleteAttributeTemplate(Number(req.params.templateId), req.admin.user.id);
  flash(req, 'info', 'Caractéristique supprimée du modèle.');
  return res.redirect('/admin/categories');
});

/* ------------------------------------------------------------------ */
/* Marques                                                             */
/* ------------------------------------------------------------------ */
router.get('/marques', auth.requirePermission('catalog.read'), (req, res) => {
  res.render('admin/brands', {
    title: 'Marques',
    activeNav: 'brands',
    brands: products.listBrands({ includeArchived: true, withCounts: true }),
  });
});

router.post('/marques', auth.requirePermission('catalog.write'), (req, res) => {
  const name = normalizeText(req.body.name || '');
  if (!name) {
    flash(req, 'error', 'Le nom de la marque est obligatoire.');
    return res.redirect('/admin/marques');
  }
  products.findOrCreateBrand(name);
  flash(req, 'success', `Marque « ${name} » enregistrée.`);
  return res.redirect('/admin/marques');
});

router.post('/marques/:id/archiver', auth.requirePermission('catalog.write'), (req, res) => {
  db.run('UPDATE brands SET archived = 1 - archived WHERE id = ?', [Number(req.params.id)]);
  flash(req, 'success', 'Marque mise à jour.');
  return res.redirect('/admin/marques');
});

/* ------------------------------------------------------------------ */
/* Médiathèque                                                         */
/* ------------------------------------------------------------------ */
router.get('/medias', auth.requirePermission('catalog.read'), (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 48;
  const total = db.get('SELECT COUNT(*) AS n FROM media_files').n;
  const rows = db.all(
    `SELECT m.*, (SELECT COUNT(*) FROM product_images pi WHERE pi.media_id = m.id) AS usages,
            (SELECT p.name FROM product_images pi JOIN products p ON p.id = pi.product_id WHERE pi.media_id = m.id LIMIT 1) AS product_name,
            (SELECT p.id FROM product_images pi JOIN products p ON p.id = pi.product_id WHERE pi.media_id = m.id LIMIT 1) AS product_id
       FROM media_files m ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [perPage, (page - 1) * perPage]
  );
  res.render('admin/media', {
    title: 'Médiathèque',
    activeNav: 'media',
    items: rows,
    pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)), hasNext: page * perPage < total, hasPrev: page > 1, from: total ? (page - 1) * perPage + 1 : 0, to: Math.min(page * perPage, total) },
  });
});

router.post('/medias', auth.requirePermission('catalog.write'), upload.imageUpload, async (req, res, next) => {
  try {
    if (!req.files || !req.files.length) {
      flash(req, 'error', 'Aucune image reçue.');
      return res.redirect('/admin/medias');
    }
    let count = 0;
    for (const file of req.files) {
      const stored = await images.storeImage(file.buffer, { mime: file.mimetype });
      db.insert('media_files', {
        kind: 'image',
        file_key: stored.fileKey,
        filename: String(file.originalname || '').slice(0, 200),
        mime: stored.sourceMime,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        alt: normalizeText(req.body.alt || '').slice(0, 250),
        created_by: req.admin.user.id,
      });
      count += 1;
    }
    if (req.body.product_id) {
      const pid = Number(req.body.product_id);
      const media = db.all('SELECT id FROM media_files ORDER BY id DESC LIMIT ?', [count]);
      for (const m of media.reverse()) products.attachImage(pid, m.id, { userId: req.admin.user.id });
      flash(req, 'success', `${count} image(s) ajoutée(s) au produit.`);
      return res.redirect(`/admin/produits/${pid}#images`);
    }
    flash(req, 'success', `${count} image(s) ajoutée(s) à la médiathèque.`);
    return res.redirect('/admin/medias');
  } catch (err) { return next(err); }
});

router.post('/medias/:id/supprimer', auth.requirePermission('catalog.delete'), (req, res) => {
  const media = db.get('SELECT * FROM media_files WHERE id = ?', [Number(req.params.id)]);
  if (!media) {
    flash(req, 'error', 'Média introuvable.');
    return res.redirect('/admin/medias');
  }
  const used = db.get('SELECT COUNT(*) AS c FROM product_images WHERE media_id = ?', [media.id]).c;
  if (used) {
    flash(req, 'error', 'Ce média est utilisé par un produit : retirez-le d’abord de la fiche produit.');
    return res.redirect('/admin/medias');
  }
  db.run('DELETE FROM media_files WHERE id = ?', [media.id]);
  images.removeMedia(media.file_key);
  flash(req, 'info', 'Média supprimé du serveur.');
  return res.redirect('/admin/medias');
});

/** Modèle de caractéristiques d'une catégorie (pour le formulaire produit). */
router.get('/api/categories/:id/attributs', auth.requirePermission('catalog.read'), (req, res) => {
  res.json({ items: categories.attributeTemplates(Number(req.params.id)) });
});

module.exports = router;
