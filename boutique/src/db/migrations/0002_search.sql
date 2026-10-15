-- ============================================================================
-- 0002 — Index de recherche plein texte (FTS5)
-- Recherche et filtres exécutés côté serveur, sans charger tout le catalogue.
-- L'index est maintenu par le code applicatif (domain/catalog.js) dans la même
-- transaction que l'écriture du produit, ce qui garantit la cohérence.
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  product_id UNINDEXED,
  name,
  sku UNINDEXED,
  brand,
  category,
  short_description,
  description,
  variants,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Vue de synthèse du stock disponible par produit (utilisée pour les filtres).
CREATE VIEW IF NOT EXISTS product_stock_summary AS
SELECT
  p.id                                     AS product_id,
  p.track_stock                            AS track_stock,
  p.is_kit                                 AS is_kit,
  COALESCE((SELECT SUM(si.qty_on_hand)     FROM stock_items si WHERE si.product_id = p.id), 0) AS qty_on_hand,
  COALESCE((SELECT SUM(si.qty_reserved)    FROM stock_items si WHERE si.product_id = p.id), 0) AS qty_reserved,
  COALESCE((SELECT SUM(si.qty_on_hand - si.qty_reserved) FROM stock_items si WHERE si.product_id = p.id), 0) AS available
FROM products p;

-- Vue du prix de vente effectif (promotion datée prise en compte).
CREATE VIEW IF NOT EXISTS product_price_summary AS
SELECT
  p.id AS product_id,
  CASE
    WHEN p.promo_price IS NOT NULL AND p.promo_price > 0
     AND (p.promo_starts_at IS NULL OR p.promo_starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     AND (p.promo_ends_at   IS NULL OR p.promo_ends_at   >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    THEN p.promo_price ELSE p.price
  END AS sale_price,
  p.price AS base_price,
  p.promo_price,
  p.compare_at_price,
  (SELECT MIN(COALESCE(v.promo_price, v.price, p.price))
     FROM product_variants v
    WHERE v.product_id = p.id AND v.active = 1) AS min_variant_price,
  (SELECT MAX(COALESCE(v.price, p.price))
     FROM product_variants v
    WHERE v.product_id = p.id AND v.active = 1) AS max_variant_price
FROM products p;
