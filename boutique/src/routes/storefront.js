'use strict';

/** Boutiques : accueil, catalogue, catégories, recherche, fiche produit, contact, pages. */

const express = require('express');
const db = require('../db');
const products = require('../domain/products');
const categories = require('../domain/categories');
const settings = require('../lib/settings');
const config = require('../config');
const { notFound } = require('../lib/http');
const { sanitizeHtml } = require('../lib/validate');
const { normalizeText } = require('../lib/slug');
const ratelimit = require('../lib/ratelimit');
const whatsapp = require('../lib/whatsapp');
const money = require('../lib/money');

const router = express.Router();

/**
 * Vue « variantes » destinée à la fiche produit : prix, disponibilité et
 * achetabilité sont calculés côté serveur, le navigateur ne fait que les
 * afficher quand l'exploitant change d'option.
 */
function buildVariantView(product, variants) {
  return variants.map((v) => {
    const price = products.priceOf(product, v);
    const avail = products.availabilityOf(product, v);
    const purch = products.purchasability(product, v);
    return {
      id: v.id,
      sku: v.sku || product.sku || '',
      label: v.options_label || v.sku || 'Standard',
      options: v.options || {},
      sale: price.sale,
      priceLabel: money.format(price.sale),
      compareAtLabel: price.compareAt ? money.format(price.compareAt) : '',
      available: avail.available === Infinity ? null : avail.available,
      availabilityStatus: avail.status,
      availabilityLabel: avail.label,
      purchasable: purch.ok,
      reason: purch.ok ? '' : purch.reasons[0],
    };
  });
}

const PUBLIC_FILTERS = { statuses: ['published'], purchasableOnly: false };

/* ------------------------------------------------------------------ */
/* Accueil                                                             */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const tree = categories.tree();
  const featured = products.list({ ...PUBLIC_FILTERS, featured: 1, purchasableOnly: true, sort: 'nouveaute' }, { page: 1, perPage: 8 });
  const fresh = products.list({ ...PUBLIC_FILTERS, purchasableOnly: true, sort: 'nouveaute' }, { page: 1, perPage: 8 });
  // Promotions RÉELLES : uniquement celles dont les dates de validité sont actives.
  const promos = products.list({ ...PUBLIC_FILTERS, onPromo: 1, purchasableOnly: true, sort: 'promotions' }, { page: 1, perPage: 4 });

  res.renderPage('home', {
    title: null,
    metaDescription:
      settings.get('store.tagline') ||
      `Papeterie, informatique et téléphonie à ${settings.get('store.city')} (${settings.get('store.region')}). Retrait en boutique ou livraison.`,
    canonical: '/',
    tree,
    featured: featured.items,
    fresh: fresh.items,
    promos: promos.items,
    totals: { published: db.get("SELECT COUNT(*) AS n FROM products WHERE status = 'published' AND data_confirmed = 1").n },
    whatsappUrl: whatsapp.url(`Bonjour ${settings.get('store.short_name')}, j'ai une question.`),
  });
});

/* ------------------------------------------------------------------ */
/* Catalogue et recherche                                              */
/* ------------------------------------------------------------------ */
function parseFilters(req) {
  const q = normalizeText(String(req.query.q || '')).slice(0, 120);
  const filters = { ...PUBLIC_FILTERS };
  if (q) filters.q = q;
  if (req.query.marque) {
    filters.brandIds = String(req.query.marque)
      .split(',')
      .map((v) => Number(v))
      .filter(Boolean);
  }
  if (req.query.etat) filters.condition = String(req.query.etat).slice(0, 20);
  if (req.query.prix_min !== undefined && req.query.prix_min !== '') filters.priceMin = Number(req.query.prix_min) || 0;
  if (req.query.prix_max !== undefined && req.query.prix_max !== '') filters.priceMax = Number(req.query.prix_max) || 0;
  if (req.query.disponible) filters.inStock = true;
  if (req.query.promo) filters.onPromo = true;
  filters.sort = String(req.query.tri || 'pertinence');
  return { q, filters, page: Number(req.query.page) || 1, perPage: Number(req.query.par_page) || config.commerce.catalogPageSize };
}

function catalogView(req, res, { categorySlug = null } = {}) {
  const { q, filters, page, perPage } = parseFilters(req);
  let activeCategory = null;
  let breadcrumbTrail = [];

  if (categorySlug) {
    activeCategory = categories.getBySlug(categorySlug);
    if (!activeCategory) throw notFound('Catégorie introuvable.');
    breadcrumbTrail = categories.breadcrumb(activeCategory.id);
    filters.categoryIds = categories.descendantIds(activeCategory.id);
    filters.statuses = ['published'];
  }

  const result = products.list(filters, { page, perPage });
  const activeBrands = filters.brandIds || [];

  res.renderPage('catalog', {
    title: activeCategory ? activeCategory.name : q ? `Recherche : ${q}` : 'Catalogue',
    metaDescription: activeCategory?.description || `Catalogue ${settings.get('store.name')} — ${settings.get('store.city')}, ${settings.get('store.region')}.`,
    canonical: activeCategory ? `/categorie/${activeCategory.slug}` : q ? `/recherche?q=${encodeURIComponent(q)}` : '/catalogue',
    items: result.items,
    pagination: result.pagination,
    facets: result.facets,
    filters,
    q,
    activeCategory,
    breadcrumbTrail,
    tree: categories.tree(),
    brands: products.listBrands({ withCounts: true }),
    activeBrands,
    conditions: products.CONDITIONS,
    sorts: [
      { value: 'pertinence', label: q ? 'Pertinence' : 'Nouveautés' },
      { value: 'nouveaute', label: 'Nouveautés' },
      { value: 'prix_asc', label: 'Prix croissant' },
      { value: 'prix_desc', label: 'Prix décroissant' },
      { value: 'nom_asc', label: 'Nom A → Z' },
      { value: 'promotions', label: 'Promotions' },
    ],
    isSearch: Boolean(q),
    whatsappUrl: q ? whatsapp.url(`Bonjour ${settings.get('store.short_name')}, je cherche « ${q} ».`) : '',
  });
}

router.get('/catalogue', (req, res, next) => {
  try {
    catalogView(req, res);
  } catch (err) { next(err); }
});

router.get('/recherche', (req, res, next) => {
  try {
    catalogView(req, res);
  } catch (err) { next(err); }
});

router.get('/categorie/:slug', (req, res, next) => {
  try {
    catalogView(req, res, { categorySlug: req.params.slug });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Fiche produit                                                       */
/* ------------------------------------------------------------------ */
router.get('/produit/:slug', (req, res, next) => {
  const product = products.getBySlug(req.params.slug, { anyStatus: false });
  if (!product) return next(notFound('Produit introuvable ou retiré de la vente.'));

  const variants = products.variantsOf(product.id).filter((v) => v.active);
  const images = products.imagesOf(product.id);
  const attributes = products.attributesOf(product.id);
  const category = product.category_id ? categories.get(product.category_id) : null;
  const trail = category ? categories.breadcrumb(category.id) : [];
  const purchasability = products.purchasability(product, variants.length === 1 ? variants[0] : null);
  const kitComponents = product.is_kit
    ? db.all(
        `SELECT ki.quantity, p.name, p.sku, p.slug FROM kit_items ki JOIN products p ON p.id = ki.component_product_id WHERE ki.kit_product_id = ?`,
        [product.id]
      )
    : [];

  // Compteur de vues interne : jamais affiché, sert uniquement au pilotage.
  db.run('UPDATE products SET view_count = view_count + 1 WHERE id = ?', [product.id]);

  res.renderPage('product', {
    title: product.meta_title || product.name,
    metaDescription: product.meta_description || product.excerpt,
    canonical: `/produit/${product.slug}`,
    product,
    variants,
    images,
    attributes,
    category,
    breadcrumbTrail: trail,
    purchasability,
    kitComponents,
    variantView: buildVariantView(product, variants),
    conditions: products.CONDITIONS,
    ogImage: images.length ? `/media/${images[0].file_key}?s=large` : null,
    related: products.related(product, 8),
    priceRange: products.priceRange(product),
    whatsappUrl: whatsapp.questionUrl(product),
    enabledMethods: require('../domain/payments')
      .listMethods({ enabledOnly: true })
      .filter((m) => m.configured || m.isCash || config.payments.simulationEnabled)
      .map((m) => m.name),
    pickupNote: settings.get('shipping.pickup_note'),
    structuredData: productStructuredData(product, images),
  });
});

function productStructuredData(product, images) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    sku: product.sku || undefined,
    description: product.excerpt || product.name,
    ...(images.length
      ? { image: images.slice(0, 5).map((i) => `${config.publicUrl}/media/${i.file_key}?s=large`) }
      : {}),
    brand: product.brand_name ? { '@type': 'Brand', name: product.brand_name } : undefined,
    category: product.category_name || undefined,
    itemCondition:
      product.product_condition === 'reconditionne'
        ? 'https://schema.org/RefurbishedCondition'
        : product.product_condition === 'occasion'
          ? 'https://schema.org/UsedCondition'
          : 'https://schema.org/NewCondition',
    offers: product.purchasable
      ? {
          '@type': 'Offer',
          priceCurrency: settings.get('commerce.currency'),
          price: product.price_info.sale,
          availability:
            product.availability.status === 'in_stock'
              ? 'https://schema.org/InStock'
              : product.availability.status === 'low'
                ? 'https://schema.org/LimitedAvailability'
                : 'https://schema.org/OutOfStock',
          url: `${config.publicUrl}/produit/${product.slug}`,
          areaServed: { '@type': 'City', name: settings.get('store.city') },
        }
      : undefined,
  };
  return JSON.stringify(data);
}

/* ------------------------------------------------------------------ */
/* Contact                                                             */
/* ------------------------------------------------------------------ */
router.get('/contact', (req, res) => {
  const zones = db.all("SELECT * FROM shipping_zones WHERE enabled = 1 ORDER BY position");
  res.renderPage('contact', {
    title: 'Contact et localisation',
    metaDescription: `Contacter ${settings.get('store.name')} à ${settings.get('store.city')} : téléphone, itinéraire et horaires.`,
    canonical: '/contact',
    zones,
    whatsappUrl: whatsapp.url(`Bonjour ${settings.get('store.short_name')}, j'aimerais un renseignement.`),
    sent: req.query.envoye === '1',
  });
});

router.post(
  '/contact',
  ratelimit.middleware({ keyPrefix: 'rl-contact', windowMs: 10 * 60_000, max: 5, keyFn: () => 'message' }),
  (req, res) => {
    const name = normalizeText(req.body.name || '').slice(0, 120);
    const contact = normalizeText(req.body.contact || '').slice(0, 120);
    const message = normalizeText(req.body.message || '').slice(0, 2000);
    const errors = {};
    if (name.length < 2) errors.name = 'Indiquez votre nom.';
    if (contact.length < 6) errors.contact = 'Indiquez un téléphone ou un e-mail pour vous répondre.';
    if (message.length < 10) errors.message = 'Votre message est trop court.';
    // Pot de miel anti-robots : un champ masqué que seul un bot remplit.
    if (normalizeText(req.body.website || '')) errors.website = 'Message rejeté.';

    if (Object.keys(errors).length) {
      const zones = db.all('SELECT * FROM shipping_zones WHERE enabled = 1 ORDER BY position');
      return res.status(400).renderPage('contact', {
        title: 'Contact et localisation',
        zones,
        whatsappUrl: whatsapp.url(''),
        errors,
        values: { name, contact, message },
      });
    }

    db.insert('outbox', {
      channel: settings.get('notifications.email_enabled') ? 'email' : 'log',
      recipient: contact,
      subject: `Message de ${name}`,
      body: message,
      meta: JSON.stringify({ kind: 'contact', name, contact, ip: req.ip }),
    });
    db.insert('audit_log', {
      user_id: null,
      actor: 'public',
      action: 'contact.message',
      entity_type: 'contact',
      entity_id: contact.slice(0, 60),
      detail: JSON.stringify({ name, length: message.length }),
      ip: req.ip || '',
    });
    return res.redirect('/contact?envoye=1');
  }
);

/* ------------------------------------------------------------------ */
/* Pages éditables (livraison, confidentialité, conditions…)            */
/* ------------------------------------------------------------------ */
router.get('/informations/:slug', (req, res, next) => {
  const page = db.get('SELECT * FROM pages WHERE slug = ? AND published = 1', [req.params.slug]);
  if (!page) return next(notFound('Page introuvable.'));
  res.renderPage('page', {
    title: page.title,
    metaDescription: page.meta_description || `${page.title} — ${settings.get('store.name')}`,
    canonical: `/informations/${page.slug}`,
    page: { ...page, body: sanitizeHtml(page.body) },
    pages: db.all('SELECT slug, title FROM pages WHERE published = 1 ORDER BY position ASC'),
  });
});

/** Suggestion de recherche (JSON, utilisé par l'autocomplétion progressive). */
router.get('/api/suggestions', (req, res) => {
  const q = normalizeText(String(req.query.q || '')).slice(0, 60);
  if (q.length < 2) return res.json({ items: [] });
  const match = products.buildMatchQuery(q);
  const items = match
    ? db.all(
        `SELECT p.name, p.slug, p.sku,
                CASE WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
                      AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                      AND (p.promo_ends_at IS NULL OR p.promo_ends_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     THEN p.promo_price ELSE p.price END AS price,
                (SELECT m.file_key FROM product_images pi JOIN media_files m ON m.id = pi.media_id
                  WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.position LIMIT 1) AS image_key
           FROM products p JOIN products_fts ON products_fts.product_id = CAST(p.id AS TEXT)
          WHERE p.status = 'published' AND p.data_confirmed = 1 AND products_fts MATCH ?
          ORDER BY rank ASC LIMIT 8`,
        [match]
      )
    : [];
  return res.json({ items });
});

module.exports = router;
