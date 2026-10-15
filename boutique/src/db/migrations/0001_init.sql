-- ============================================================================
-- 0001 — Schéma initial : ETS LE PRIVILÈGE DAOUKRO
-- Conventions : montants en FCFA entiers (XOF sans décimale), dates en UTC
-- ISO-8601 (affichage converti en Africa/Abidjan), identifiants entiers.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Méta / réglages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,            -- JSON
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  INTEGER
);

-- ---------------------------------------------------------------------------
-- Utilisateurs de l'administration (rôles : admin | vendeur)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name        TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'vendor' CHECK (role IN ('admin','vendor')),
  active           INTEGER NOT NULL DEFAULT 1,
  can_confirm_cash INTEGER NOT NULL DEFAULT 0,  -- habilité à confirmer un encaissement
  last_login_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  image_key    TEXT NOT NULL DEFAULT '',
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id, position);

-- Modèles d'attributs par catégorie (caractéristiques adaptées à la famille)
CREATE TABLE IF NOT EXISTS attribute_templates (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  label        TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','select','boolean')),
  options      TEXT NOT NULL DEFAULT '[]',   -- JSON array pour type=select
  unit         TEXT NOT NULL DEFAULT '',
  required     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_id, key)
);

CREATE TABLE IF NOT EXISTS brands (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug       TEXT NOT NULL UNIQUE,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY,
  sku                 TEXT UNIQUE COLLATE NOCASE,      -- référence unique
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand_id            INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  short_description   TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',        -- HTML assaini
  price               INTEGER NOT NULL DEFAULT 0,      -- FCFA entier
  compare_at_price    INTEGER,                          -- prix barré (réel, non artificiel)
  promo_price         INTEGER,
  promo_starts_at     TEXT,
  promo_ends_at       TEXT,
  product_condition   TEXT NOT NULL DEFAULT 'neuf' CHECK (product_condition IN ('neuf','reconditionne','occasion','lot')),
  warranty            TEXT NOT NULL DEFAULT '',
  box_contents        TEXT NOT NULL DEFAULT '',
  sale_unit           TEXT NOT NULL DEFAULT 'piece',   -- piece|lot|paquet|rame|carton|autre
  sale_unit_label     TEXT NOT NULL DEFAULT '',
  weight_g            INTEGER,
  length_cm           REAL,
  width_cm            REAL,
  height_cm           REAL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  is_kit              INTEGER NOT NULL DEFAULT 0,
  track_stock         INTEGER NOT NULL DEFAULT 1,
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  qty                 INTEGER NOT NULL DEFAULT 0,       -- stock du produit simple (sans variante)
  has_variants        INTEGER NOT NULL DEFAULT 0,
  position            INTEGER NOT NULL DEFAULT 0,
  featured            INTEGER NOT NULL DEFAULT 0,
  view_count          INTEGER NOT NULL DEFAULT 0,       -- interne, jamais affiché comme preuve sociale
  meta_title          TEXT NOT NULL DEFAULT '',
  meta_description    TEXT NOT NULL DEFAULT '',
  data_confirmed      INTEGER NOT NULL DEFAULT 0,       -- prix + disponibilité confirmés par l'exploitant
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, position);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, status);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);

CREATE TABLE IF NOT EXISTS product_variants (
  id            INTEGER PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT UNIQUE COLLATE NOCASE,
  options       TEXT NOT NULL DEFAULT '{}',   -- JSON {"Couleur":"Bleu","Capacité":"128 Go"}
  price         INTEGER,                       -- NULL = prix du produit
  promo_price   INTEGER,
  compare_at_price INTEGER,
  weight_g      INTEGER,
  barcode       TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, position);

CREATE TABLE IF NOT EXISTS product_attributes (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  value       TEXT NOT NULL DEFAULT '',
  unit        TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, key)
);

-- Composants explicites d'un kit / lot
CREATE TABLE IF NOT EXISTS kit_items (
  id                 INTEGER PRIMARY KEY,
  kit_product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (kit_product_id, component_product_id, component_variant_id)
);

CREATE TABLE IF NOT EXISTS media_files (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','document')),
  file_key    TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  height       INTEGER,
  alt         TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id    INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  alt         TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, position);

-- ---------------------------------------------------------------------------
-- Stock : une ligne par propriétaire de stock (produit simple ou variante)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_items (
  id            INTEGER PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id    INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL DEFAULT '',
  qty_on_hand   INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_reserved  INTEGER NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  track_stock   INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_items(product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            INTEGER PRIMARY KEY,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL,
  variant_id    INTEGER,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN
    ('initial','ajustement','achat_fournisseur','vente','vente_boutique','commande','retour','annulation','import','reservation','liberation','kit','perte','inventaire')),
  reference     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  qty_after     INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_stock ON stock_movements(stock_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_ref ON stock_movements(reference);

-- Réservations avec expiration (panier et commande en attente de paiement)
CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  cart_id       INTEGER,
  order_id      INTEGER,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released','expired')),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_cart ON reservations(cart_id);
CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id);

-- ---------------------------------------------------------------------------
-- Clients (compte facultatif) et paniers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                 INTEGER PRIMARY KEY,
  email              TEXT UNIQUE COLLATE NOCASE,
  phone              TEXT NOT NULL DEFAULT '',
  full_name          TEXT NOT NULL DEFAULT '',
  password_hash      TEXT NOT NULL DEFAULT '',   -- vide = client sans compte
  marketing_consent  INTEGER NOT NULL DEFAULT 0,
  consent_at         TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(full_name);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS carts (
  id            INTEGER PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
  currency      TEXT NOT NULL DEFAULT 'XOF',
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_carts_status ON carts(status, expires_at);

CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY,
  cart_id     INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (cart_id, product_id, variant_id)
);

-- ---------------------------------------------------------------------------
-- Livraison : transporteurs, zones, tarifs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carriers (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL UNIQUE,
  contact        TEXT NOT NULL DEFAULT '',
  tracking_url_template TEXT NOT NULL DEFAULT '',  -- ex. https://suivi.exemple/?ref={reference}
  enabled        INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shipping_zones (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('pickup','local','region','national','international')),
  enabled         INTEGER NOT NULL DEFAULT 1,
  position        INTEGER NOT NULL DEFAULT 0,
  requires_quote  INTEGER NOT NULL DEFAULT 0,   -- aucun tarif connu => devis
  free_over       INTEGER,                       -- montant du panier à partir duquel c'est offert
  eta_text        TEXT NOT NULL DEFAULT '',      -- délai estimatif, rédigé par l'exploitant
  conditions_text TEXT NOT NULL DEFAULT '',
  cod_allowed     INTEGER NOT NULL DEFAULT 0,    -- paiement à la livraison autorisé
  default_carrier_id INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS shipping_rates (
  id             INTEGER PRIMARY KEY,
  zone_id        INTEGER NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
  carrier_id     INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  label          TEXT NOT NULL DEFAULT '',
  min_weight_g   INTEGER NOT NULL DEFAULT 0,
  max_weight_g   INTEGER,
  min_subtotal   INTEGER NOT NULL DEFAULT 0,
  max_subtotal   INTEGER,
  price          INTEGER NOT NULL DEFAULT 0,     -- forfait
  per_extra_kg   INTEGER NOT NULL DEFAULT 0,     -- supplément par kg au-dessus du palier
  enabled        INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  UNIQUE (zone_id, carrier_id, min_weight_g, min_subtotal)
);
CREATE INDEX IF NOT EXISTS idx_rates_zone ON shipping_rates(zone_id, enabled, position);

-- ---------------------------------------------------------------------------
-- Moyens de paiement
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,   -- wave | orange_money | mtn_momo | moov_money | pay_at_pickup | pay_on_delivery
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('mobile_money','cash','card','other')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  configured    INTEGER NOT NULL DEFAULT 0,
  simulated     INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  modes         TEXT NOT NULL DEFAULT '["pickup","delivery"]',   -- JSON
  zone_codes    TEXT NOT NULL DEFAULT '[]',                      -- JSON : zones autorisées (vide = toutes)
  instructions  TEXT NOT NULL DEFAULT '',
  merchant_ref  TEXT NOT NULL DEFAULT '',                        -- n° marchand / numéro d'encaissement (non secret)
  color         TEXT NOT NULL DEFAULT '',
  logo_key      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method_code        TEXT NOT NULL,
  provider           TEXT NOT NULL DEFAULT 'manual',
  provider_reference TEXT NOT NULL DEFAULT '',
  amount             INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'XOF',
  status             TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','pending','succeeded','failed','cancelled','refunded','partially_refunded')),
  failure_reason     TEXT NOT NULL DEFAULT '',
  confirmed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, provider_reference)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT '',
  payload        TEXT NOT NULL DEFAULT '{}',
  signature_ok   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','duplicate','rejected','error')),
  error          TEXT NOT NULL DEFAULT '',
  received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at   TEXT,
  ip             TEXT NOT NULL DEFAULT '',
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Commandes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  tracking_token    TEXT NOT NULL UNIQUE,
  idempotency_key   TEXT UNIQUE,
  cart_id           INTEGER REFERENCES carts(id) ON DELETE SET NULL,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- commande créée en boutique

  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','quote_required','confirmed','preparing','ready','shipped','delivered','partially_refunded','refunded','cancelled')),
  payment_status    TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN
    ('unpaid','awaiting_confirmation','paid','partially_refunded','refunded','failed','cancelled')),
  delivery_status   TEXT NOT NULL DEFAULT 'none' CHECK (delivery_status IN
    ('none','to_prepare','in_preparation','handed_to_carrier','in_transit','delivered','returned','pickup_ready','picked_up','cancelled')),

  fulfillment_mode  TEXT NOT NULL CHECK (fulfillment_mode IN ('pickup','delivery')),
  zone_id           INTEGER REFERENCES shipping_zones(id) ON DELETE SET NULL,
  carrier_id        INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  tracking_reference TEXT NOT NULL DEFAULT '',

  recipient_name    TEXT NOT NULL DEFAULT '',
  recipient_phone   TEXT NOT NULL DEFAULT '',
  recipient_email   TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  quarter           TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',
  landmark          TEXT NOT NULL DEFAULT '',
  pickup_at         TEXT,
  desired_date      TEXT NOT NULL DEFAULT '',

  payment_method_code TEXT NOT NULL DEFAULT '',
  subtotal          INTEGER NOT NULL DEFAULT 0,
  discount          INTEGER NOT NULL DEFAULT 0,
  shipping_cost     INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  amount_paid       INTEGER NOT NULL DEFAULT 0,
  amount_refunded   INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'XOF',

  quote_required    INTEGER NOT NULL DEFAULT 0,
  quote_amount      INTEGER,
  quote_status      TEXT NOT NULL DEFAULT 'none' CHECK (quote_status IN ('none','requested','sent','accepted','refused')),
  quote_sent_at     TEXT,
  quote_accepted_at TEXT,

  customer_note     TEXT NOT NULL DEFAULT '',
  internal_note     TEXT NOT NULL DEFAULT '',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  terms_accepted    INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at TEXT,

  placed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at           TEXT,
  cancelled_at      TEXT,
  cancel_reason     TEXT NOT NULL DEFAULT '',
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(recipient_phone);

CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE SET NULL,
  variant_id     INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  stock_item_id  INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
  sku            TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  options_label  TEXT NOT NULL DEFAULT '',
  unit           TEXT NOT NULL DEFAULT 'piece',
  unit_price     INTEGER NOT NULL DEFAULT 0,
  original_price INTEGER NOT NULL DEFAULT 0,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  line_total     INTEGER NOT NULL DEFAULT 0,
  is_kit         INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id, position);

CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'order' CHECK (scope IN ('order','payment','delivery','quote','note')),
  from_value  TEXT NOT NULL DEFAULT '',
  to_value    TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  public      INTEGER NOT NULL DEFAULT 0,   -- visible sur le suivi client
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS delivery_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  happened_at TEXT NOT NULL,
  public      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_events ON delivery_events(order_id, happened_at);

CREATE TABLE IF NOT EXISTS refunds (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'refund' CHECK (kind IN ('return','refund','cancellation','exchange')),
  amount      INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  method      TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  restock     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','done','refused')),
  processed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  processed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

CREATE TABLE IF NOT EXISTS refund_items (
  id         INTEGER PRIMARY KEY,
  refund_id  INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  amount     INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Ventes physiques en boutique (caisse)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_sales (
  id            INTEGER PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  subtotal      INTEGER NOT NULL DEFAULT 0,
  discount      INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  amount_paid   INTEGER NOT NULL DEFAULT 0,
  change_due    INTEGER NOT NULL DEFAULT 0,
  method_code   TEXT NOT NULL DEFAULT 'pay_at_pickup',
  status        TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','cancelled','refunded')),
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_user ON pos_sales(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pos_sale_items (
  id           INTEGER PRIMARY KEY,
  sale_id      INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id   INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  sku          TEXT NOT NULL DEFAULT '',
  options_label TEXT NOT NULL DEFAULT '',
  unit_price   INTEGER NOT NULL DEFAULT 0,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  line_total   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Import / export du catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_jobs (
  id           INTEGER PRIMARY KEY,
  filename     TEXT NOT NULL DEFAULT '',
  stored_path  TEXT NOT NULL DEFAULT '',
  format       TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx')),
  mode         TEXT NOT NULL DEFAULT 'create' CHECK (mode IN ('create','update','upsert','preview')),
  mapping      TEXT NOT NULL DEFAULT '{}',
  options      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','mapped','running','done','failed','cancelled')),
  total_rows   INTEGER NOT NULL DEFAULT 0,
  processed    INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count  INTEGER NOT NULL DEFAULT 0,
  batch_size   INTEGER NOT NULL DEFAULT 50,
  report       TEXT NOT NULL DEFAULT '{}',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number  INTEGER NOT NULL,
  sku         TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','duplicate','skipped','error')),
  action      TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  UNIQUE (job_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_job ON import_rows(job_id, status);

-- ---------------------------------------------------------------------------
-- Contenus éditables, journal d'audit, limites de débit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  published    INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor       TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS rate_buckets (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  reset_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL DEFAULT 'log',   -- log | email | sms (connecteurs à brancher)
  recipient   TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
