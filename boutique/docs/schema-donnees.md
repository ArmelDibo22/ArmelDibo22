# Schéma de données et règles métier

Base **SQLite** (module natif `node:sqlite`), journalisation **WAL**, un seul fichier
(`data/boutique.sqlite`). Migrations versionnées dans `src/db/migrations/`
(`0001_init.sql`, `0002_search.sql`), appliquées par `npm run migrate` et vérifiées
par `npm run check`.

Conventions :

- **Montants** : entiers en FCFA (jamais de flottants, jamais de centimes).
- **Dates** : chaînes ISO 8601 en UTC (`2026-10-15T20:07:11.753Z`), affichées en
  `Africa/Abidjan`.
- **SQL** : uniquement dans `src/db/index.js` et `src/domain/*`. Toute requête vérifie
  que le nombre de paramètres correspond au nombre de marqueurs (`SQL_PARAM_MISMATCH`).
- **47 tables**, dont 6 internes à l'index de recherche FTS5.

---

## 1. Vue d'ensemble

```
                         ┌────────────┐
                         │  settings  │  réglages plats « clé → valeur JSON »
                         └────────────┘
   ┌───────────┐   ┌───────────────┐   ┌──────────────────┐   ┌───────────────┐
   │categories │◀──│   products    │──▶│ product_variants │   │    brands     │
   │ (arbre)   │   │ 37 colonnes   │   └──────────────────┘   └───────────────┘
   └───────────┘   └───────┬───────┘            │
   attribute_templates     │                    │
                           ▼                    ▼
                    ┌─────────────┐      ┌──────────────┐     ┌─────────────────┐
                    │product_     │      │ stock_items  │◀────│ stock_movements │
                    │images/attrs │      │ UNIQUE(prod, │     │ 14 motifs,      │
                    └─────────────┘      │   variante)  │     │ qty_after       │
        kit_items ──────────────────────▶└──────┬───────┘     └─────────────────┘
                                                │
                                          ┌─────▼──────┐
                                          │reservations│  panier OU commande, expiration
                                          └─────┬──────┘
   carts ── cart_items                          │
      │                                         │
      └──────────────▶ orders ──────────────────┘
                        │  ├─ order_items
                        │  ├─ order_events      (journal, dont événements publics)
                        │  ├─ delivery_events   (étapes de livraison)
                        │  ├─ payments ────────── webhook_events (déduplication)
                        │  └─ refunds ── refund_items
   pos_sales ── pos_sale_items          (ventes au comptoir, séparées des commandes)
   customers ── customer_sessions       (compte facultatif)
   users ── sessions                    (administration : admin | vendor)
   shipping_zones ── shipping_rates ── carriers
   payment_methods                      (Wave, Orange Money, MTN, Moov, espèces ×2)
   pages, media_files, import_jobs ── import_rows, audit_log, rate_buckets, outbox, meta
```

---

## 2. Catalogue

### `products` (37 colonnes)

| Groupe | Colonnes |
|---|---|
| Identification | `sku` (UNIQUE), `name`, `slug` (UNIQUE), `category_id`, `brand_id` |
| Textes | `short_description`, `description` (HTML assaini), `warranty`, `box_contents` |
| Prix | `price`, `compare_at_price`, `promo_price`, `promo_starts_at`, `promo_ends_at` |
| Nature | `product_condition` (`neuf`, `reconditionne`, `occasion`, `lot`), `sale_unit`, `sale_unit_label`, `is_kit` |
| Logistique | `weight_g`, `length_cm`, `width_cm`, `height_cm` |
| Stock | `track_stock`, `low_stock_threshold`, `qty` (miroir du produit simple), `has_variants` |
| Publication | `status` (`draft`, `published`, `archived`), `data_confirmed`, `published_at`, `featured`, `position` |
| SEO / suivi | `meta_title`, `meta_description`, `view_count` (interne, jamais affiché comme preuve sociale) |
| Horodatage | `created_at`, `updated_at` |

Contraintes : `price INTEGER NOT NULL DEFAULT 0`, `name`/`slug` obligatoires,
`status` et `product_condition` soumis à `CHECK`.

**Règle d'achetabilité** (fonction unique `products.purchasability`, appliquée en
vitrine, au panier et à la création de commande — jamais seulement côté client) :

```
achetable ⇔ status = 'published'
          AND data_confirmed = 1
          AND prix de vente > 0
          AND référence présente
          AND disponible > 0   (sauf si track_stock = 0 → « Disponible sur commande »)
```

Un article publié sans prix est automatiquement **repassé en brouillon**.

### `product_variants`

`options` (JSON `{Couleur:"Bleu",Capacité:"128 Go"}`), `sku`, `price`, `promo_price`,
`compare_at_price`, `weight_g`, `barcode`, `active`, `position`. Le stock d'une
variante vit dans `stock_items` (une ligne par variante).

### `stock_items`, `stock_movements`, `reservations`

```
stock_items     UNIQUE (product_id, variant_id)      CHECK (qty_on_hand >= 0, qty_reserved >= 0)
                disponible = qty_on_hand − qty_reserved
stock_movements delta, reason (14 motifs : initial, vente, commande, annulation,
                retour, casse, inventaire, ajustement, import, kit, réservation…),
                qty_after, created_by, note, reference      → historique non modifiable
reservations    stock_item_id, cart_id OU order_id, qty, status (active|consumed|
                released|expired), expires_at               → UNIQUE anti-double-réservation
```

**Anti-survente** : la décrmentation passe par un `UPDATE` gardé, exécuté dans une
transaction :

```sql
UPDATE stock_items
   SET qty_reserved = qty_reserved + ?
 WHERE id = ?
   AND (qty_on_hand - qty_reserved) >= ?;   -- 0 ligne modifiée ⇒ StockError 409
```

**Réservation et expiration** : un panier réserve 15 minutes
(`CART_RESERVATION_MINUTES`), une commande en attente 90 minutes
(`ORDER_RESERVATION_MINUTES`). À la conversion du panier en commande, les réservations
sont **transférées** (`cart_id → order_id`), jamais dupliquées. À l'expiration, le stock
est libéré puis la commande est annulée si elle n'est ni payée ni réglable en espèces.

**Correction appliquée pendant les tests** : la réservation du panier n'est plus
comptée contre le client lui-même (`stock.reservedForCart`) — sinon le **dernier
exemplaire** en stock ne pouvait jamais être commandé.

### Kits

`kit_items (kit_product_id, component_product_id, component_variant_id, quantity)`.
Le stock d'un kit est **dérivé** : `saveKitComponents` force `track_stock = 0` sur le
kit et la disponibilité vaut `min(⌊disponible composant / quantité⌋)`.

**Correction appliquée** : une liste de composants vide (cas d'un article ordinaire
dont le formulaire envoie toujours le champ) ne désactive plus le suivi de stock.

### Recherche

`products_fts` (FTS5) sur nom, référence, marque, catégorie, descriptions et options
de variantes. L'index est maintenu **dans la même transaction** que l'écriture, avec
reconstruction complète disponible (`POST /admin/import/reindexer`).

---

## 3. Commandes, paiements, livraisons

### `orders` (48 colonnes) — trois statuts indépendants

| Champ | Valeurs |
|---|---|
| `status` | `pending`, `quote_required`, `confirmed`, `preparing`, `ready`, `shipped`, `delivered`, `partially_refunded`, `refunded`, `cancelled` |
| `payment_status` | `unpaid`, `awaiting_confirmation`, `paid`, `partially_refunded`, `refunded`, `failed`, `cancelled` |
| `delivery_status` | `none`, `to_prepare`, `in_preparation`, `pickup_ready`, `picked_up`, `handed_to_carrier`, `in_transit`, `delivered`, `returned`, `cancelled` |

Les transitions sont gardées par une matrice (`ORDER_TRANSITIONS`) : un passage
impossible lève `OrderError('BAD_TRANSITION', 409)`. **Payer ne veut pas dire livré,
et préparer ne veut pas dire payé.**

Autres colonnes notables :

- `reference` lisible (`PRV-2026-000004`), `tracking_token` opaque (32 octets) ;
- `idempotency_key` UNIQUE → **protection anti-double-commande** (renvoi du même
  formulaire ou réseau défaillant : la commande existante est rendue, pas recréée) ;
- totaux figés à la commande : `subtotal`, `discount`, `shipping_cost`, `total`,
  `amount_paid`, `amount_refunded`, `currency` (`XOF`) ;
- devis : `quote_required`, `quote_amount`, `quote_status`
  (`none|sent|accepted|refused`), `quote_sent_at`, `quote_accepted_at` ;
- deux notes séparées : `customer_note` (visible) et `internal_note` (jamais exposée,
  y compris sur le lien de suivi) ;
- `marketing_consent` **distinct** de `terms_accepted` (+ `terms_accepted_at`) ;
- `fulfillment_mode` (`pickup|delivery`), `zone_id`, `carrier_id`, `tracking_reference`,
  `city`, `quarter`, `address`, `landmark`, `recipient_*`.

### `order_events`, `delivery_events`

Journal horodaté de chaque changement (statut, note, auteur). Certains événements
portent un drapeau **public** : ce sont les seuls visibles depuis le lien de suivi.

### `payments`, `webhook_events`

```
payments        UNIQUE (provider, provider_reference)      ← un même paiement ne peut
                status: created|pending|succeeded|failed|     pas être enregistré deux fois
                        cancelled|refunded|partially_refunded
                amount, currency, confirmed_by, confirmed_at, failure_reason
webhook_events  UNIQUE (provider, event_id)                ← déduplication des
                payload, signature_ok, status (received|      notifications répétées
                processed|duplicate|rejected|error), ip
```

Chaîne de contrôle d'une notification, dans cet ordre :
limite de débit par IP → taille du corps (≤ 64 ko) → lecture JSON →
**vérification HMAC à temps constant** → **déduplication par `(passerelle, événement)`**
→ recherche de la commande → **contrôle de la devise et du montant attendus** →
application de l'effet dans une transaction.

Une page de retour, un message du client ou une capture d'écran **ne passent pas par ce
chemin** et ne peuvent donc jamais valider un paiement.

### `refunds`, `refund_items`

Remboursement total ou partiel, ligne par ligne, avec auteur et motif ; la commande
passe en `partially_refunded` ou `refunded`.

### `pos_sales`, `pos_sale_items`

Ventes au comptoir **séparées** des commandes en ligne : même sortie de stock, même
journal, mais comptabilisées distinctement dans les statistiques.

---

## 4. Livraison

```
shipping_zones  kind (pickup|daoukro|iffou|cote-divoire…), enabled, requires_quote,
                cod_allowed, free_over, delays
shipping_rates  zone_id, label, price, per_extra_kg, min/max_weight_g,
                min/max_subtotal, enabled
carriers        nom, suivi (URL modèle), contact
```

Résolution serveur (`shipping.resolveShipping({zoneId, subtotal, weightG})`) :

| Cas | Résultat |
|---|---|
| Retrait en boutique | `free` (seul cas de gratuité assumée) |
| Zone avec tarif applicable | `priced` : `price + arrondi((poids − poids_min)/1000 × supplément_kg)` |
| Franchise `free_over` atteinte **et configurée** | `free` |
| Zone `requires_quote` ou **aucun tarif applicable** | `quote` — « Livraison sur devis », **montant nul jamais affiché** |
| Zone inconnue ou désactivée | `quote` |

Le moyen de paiement est contraint par le mode et la zone
(`methodAllowedFor`) : paiement à la réception uniquement si `cod_allowed`,
« payer au retrait » refusé en livraison, Mobile Money uniquement s'il est configuré
— ou, en bac à sable non production, explicitement simulé.

---

## 5. Comptes et sécurité

| Table | Contenu |
|---|---|
| `users` | Administration : `role` (`admin` \| `vendor`), `can_confirm_cash`, `active`, `password_hash` (salé), `last_login_at` |
| `sessions` | Jeton **haché** (`token_hash`), expiration, IP, agent utilisateur, `revoked_at` |
| `customers` | Compte client **facultatif** : e-mail **ou** téléphone, `password_hash`, `marketing_consent` + `consent_at` distincts |
| `customer_sessions` | Sessions clients (30 jours) |
| `audit_log` | Qui a fait quoi : connexions (réussies et échouées), écritures de réglages, encaissements confirmés, imports, mouvements de stock, utilisateurs |
| `rate_buckets` | Compteurs de limitation de débit (fenêtre 60 s : 240 requêtes, 10 authentifications, 20 commandes, 300 notifications) |
| `outbox` | Notifications à envoyer (file interne, aucun envoi automatique n'est configuré) |
| `settings` | Réglages plats `key → value(JSON)`, schéma typé et validé, `updated_by`, `updated_at` |
| `pages` | Contenus légaux éditables, avec drapeau `needs_review` tant qu'ils ne sont pas validés |
| `meta` | Empreinte d'installation : `environment` (`production-data` \| `demo`), version de schéma |

Règles de protection :

- Le **dernier administrateur actif** ne peut être ni rétrogradé, ni désactivé, ni
  supprimé ; personne ne peut supprimer son propre compte.
- Un jeton de session n'est **jamais stocké en clair** ; une session expirée est
  révoquée à la lecture.
- Une recherche de suivi exige le **jeton** : la référence de commande seule ne suffit
  pas, et une erreur ne révèle pas si la référence existe.
- Aucune donnée de carte bancaire n'est stockée : l'application ne manipule que des
  références de transaction fournies par la passerelle.

---

## 6. Imports

```
import_jobs    filename, stored_path, format, mode, mapping(JSON), options(JSON),
               status (uploaded|mapped|running|done|cancelled|failed),
               total_rows, processed, batch_size, created_count, updated_count,
               error_count, skipped_count, report(JSON), created_by, started_at,
               finished_at
import_rows    job_id + row_number (UNIQUE), sku, data(JSON normalisé),
               status (pending|ok|duplicate|skipped|error), action, message(JSON :
               erreurs, avertissements, résultat), product_id
```

Chaque lot est **reprenable** : l'état vit en base, pas dans le navigateur.

---

## 7. Migrations

| Fichier | Contenu |
|---|---|
| `0001_init.sql` | Les 41 tables métier, index, contraintes `CHECK` et `UNIQUE` |
| `0002_search.sql` | Index de recherche FTS5 et déclencheurs de maintien |

Ajouter une migration : créer `src/db/migrations/000N_nom.sql`, puis `npm run migrate`.
Les migrations déjà appliquées sont inscrites dans `schema_migrations` et ne sont pas
rejouées. `npm run check` vérifie l'intégrité de la base (`PRAGMA integrity_check`) et
la présence de toutes les migrations.
