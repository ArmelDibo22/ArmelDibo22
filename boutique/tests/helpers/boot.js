'use strict';

/**
 * Amorçage des tests.
 *
 * Chaque fichier de test s'exécute dans son propre processus (`node --test`) :
 * ce module définit l'environnement AVANT tout chargement de `src/config`, puis
 * ouvre une base SQLite isolée par fichier de test. Les données de test ne
 * touchent donc jamais la base réelle (`data/boutique.sqlite`) ni la base de
 * démonstration (`data/demo.sqlite`).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DATA = path.join(ROOT, 'data', 'tests');

// --- 1. Environnement (doit précéder tout `require('../src/*')`) ------------
process.env.NODE_ENV = 'test';
process.env.DEMO = '';
process.env.APP_SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
process.env.PAYMENT_SIMULATION_ENABLED = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Test-Admin-2026!';
process.env.ADMIN_NAME = 'Administrateur de test';
process.env.MEDIA_DIR = path.join(TEST_DATA, 'media');
process.env.IMPORT_DIR = path.join(TEST_DATA, 'imports');
process.env.BACKUP_DIR = path.join(TEST_DATA, 'backups');
process.env.CATALOG_PAGE_SIZE = '12';
process.env.DB_BUSY_TIMEOUT_MS = '8000';
process.env.LOG_LEVEL = 'error';

/**
 * Ouvre une base de test dédiée au fichier appelant, applique les migrations et
 * les données de configuration de base (catégories, zones, moyens de paiement).
 *
 * @param {string} testFile `__filename` du fichier de test
 * @param {{seed?: boolean}} [options]
 */
function boot(testFile, { seed = true } = {}) {
  fs.mkdirSync(TEST_DATA, { recursive: true });
  const name = path.basename(testFile).replace(/\.test\.js$/, '').replace(/[^a-z0-9-]/gi, '_');
  const file = path.join(TEST_DATA, `${name}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.rmSync(file + suffix, { force: true });
  }
  process.env.DATABASE_PATH = file;

  const db = require('../../src/db');
  db.useDatabase(file);
  db.migrate();

  const refs = { db, dbFile: file };
  if (seed) {
    const { seedCore } = require('../../src/seed/core');
    seedCore({ verbose: false });
    Object.assign(refs, {
      settings: require('../../src/lib/settings'),
      products: require('../../src/domain/products'),
      stock: require('../../src/domain/stock'),
      cart: require('../../src/domain/cart'),
      shipping: require('../../src/domain/shipping'),
      orders: require('../../src/domain/orders'),
      payments: require('../../src/domain/payments'),
      webhook: require('../../src/domain/payments/webhook'),
      users: require('../../src/domain/users'),
      pos: require('../../src/domain/pos'),
      imports: require('../../src/domain/imports'),
      stats: require('../../src/domain/stats'),
      money: require('../../src/lib/money'),
      dates: require('../../src/lib/dates'),
      security: require('../../src/lib/security'),
    });
  }
  return refs;
}

/** Crée un article publié, confirmé et en stock — le cas nominal. */
function makeProduct(T, overrides = {}) {
  const category = T.db.get('SELECT id FROM categories WHERE slug = ?', ['cahiers-registres']);
  return T.products.create(Object.assign({
    sku: `T-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    name: 'Article de test',
    category_id: category ? category.id : null,
    price: 1000,
    qty: 10,
    low_stock_threshold: 2,
    status: 'published',
    data_confirmed: 1,
    track_stock: 1,
    sale_unit: 'piece',
  }, overrides));
}

/** Passe une commande via le parcours métier réel (retrait, paiement à la réception). */
function makeOrder(T, lines, overrides = {}) {
  const method = overrides.paymentMethod || 'pay_at_pickup';
  const result = T.orders.createOrder(Object.assign({
    mode: 'pickup',
    paymentMethod: method,
    termsAccepted: true,
    customer: { fullName: 'Client de test', phone: '0700000000' },
    lines,
    idempotencyKey: `test-${Math.random().toString(36).slice(2, 10)}`,
  }, overrides), { source: 'test' });
  return result.order;
}

module.exports = { boot, makeProduct, makeOrder, TEST_DATA };
