'use strict';

/**
 * Couche d'accès aux données.
 *
 * SQLite via le module natif `node:sqlite` (Node >= 22.5) : base persistante,
 * journal WAL, transactions ACID. Toutes les opérations sont SYNCHRONES :
 * une transaction ne doit donc jamais contenir d'`await` (règle vérifiée par
 * `assertSync`). Cette contrainte garantit la sérialisation des écritures et
 * empêche la survente même en cas de requêtes concurrentes.
 *
 * Le SQL est isolé dans ce module et les modules `src/domain/*` : une migration
 * vers PostgreSQL se limite à remplacer ce fichier.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;
let txDepth = 0;

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function connect(dbPath = config.db.path) {
  ensureDir(dbPath);
  const instance = new DatabaseSync(dbPath);
  instance.exec('PRAGMA journal_mode = WAL;');
  instance.exec('PRAGMA synchronous = NORMAL;');
  instance.exec(`PRAGMA busy_timeout = ${config.db.busyTimeoutMs};`);
  instance.exec('PRAGMA foreign_keys = ON;');
  instance.exec('PRAGMA temp_store = MEMORY;');
  return instance;
}

function getDb() {
  if (!db) db = connect();
  return db;
}

/** Permet les tests avec une base isolée (fichier temporaire ou :memory:). */
function useDatabase(dbPath) {
  if (db) {
    try { db.close(); } catch { /* déjà fermée */ }
  }
  db = dbPath === ':memory:' ? new DatabaseSync(':memory:') : connect(dbPath);
  return db;
}

function close() {
  if (db) {
    try { db.close(); } catch { /* noop */ }
    db = null;
  }
}

/* ------------------------------------------------------------------ */
/* Migrations                                                          */
/* ------------------------------------------------------------------ */
function ensureMigrationsTable(instance) {
  instance.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function migrate(instance = getDb()) {
  ensureMigrationsTable(instance);
  const applied = new Set(
    instance.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const results = [];
  for (const file of listMigrationFiles()) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    instance.exec('BEGIN IMMEDIATE;');
    try {
      instance.exec(sql);
      instance
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(version, file);
      instance.exec('COMMIT;');
      results.push({ version, file, status: 'applied' });
    } catch (err) {
      try { instance.exec('ROLLBACK;'); } catch { /* noop */ }
      throw new Error(`Migration ${file} en échec : ${err.message}`);
    }
  }
  return results;
}

/**
 * Compte les marqueurs `?` d'une requête, en ignorant ceux qui apparaissent
 * dans une chaîne SQL (ex. `WHERE note = 'pourquoi ?'`).
 */
function countPlaceholders(sql) {
  let count = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'") {
      // '' est une apostrophe échappée dans SQL : on ne sort pas de la chaîne.
      if (inString && sql[i + 1] === "'") { i += 1; continue; }
      inString = !inString;
    } else if (c === '?' && !inString) {
      count += 1;
    }
  }
  return count;
}

/**
 * Vérifie que le nombre de valeurs liées correspond au nombre de marqueurs.
 * Sans ce contrôle, SQLite renvoie « column index out of range » sans indiquer
 * quelle requête est en cause — ce qui rend le bogue très coûteux à trouver.
 */
function assertParams(sql, params) {
  const expected = countPlaceholders(sql);
  if (expected !== params.length) {
    const err = new Error(
      `Requête SQL incohérente : ${expected} marqueur(s) \`?\` pour ${params.length} valeur(s) liée(s).\n` +
      `SQL : ${String(sql).replace(/\s+/g, ' ').slice(0, 300)}`
    );
    err.code = 'SQL_PARAM_MISMATCH';
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */
function all(sql, params = []) {
  assertParams(sql, params);
  return getDb().prepare(sql).all(...params);
}

function get(sql, params = []) {
  assertParams(sql, params);
  return getDb().prepare(sql).get(...params) || null;
}

function run(sql, params = []) {
  assertParams(sql, params);
  return getDb().prepare(sql).run(...params);
}

/** Insère une ligne et retourne son identifiant. */
function insert(table, data) {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error('insert() : aucune colonne');
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const res = getDb().prepare(sql).run(...keys.map((k) => normalize(data[k])));
  return Number(res.lastInsertRowid);
}

/** Met à jour une ligne ; les valeurs `undefined` sont ignorées. */
function update(table, id, data) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) return { changes: 0 };
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
  const res = getDb()
    .prepare(sql)
    .run(...entries.map(([, v]) => normalize(v)), id);
  return { changes: Number(res.changes) };
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

/* ------------------------------------------------------------------ */
/* Transactions synchrones                                             */
/* ------------------------------------------------------------------ */
class TransactionError extends Error {}

/**
 * Exécute `fn` dans une transaction.
 * `fn` DOIT être synchrone : tout `await` à l'intérieur invalide la garantie
 * de sérialisation. La méthode est donc volontairement non-async.
 */
function transaction(fn, { immediate = true } = {}) {
  const instance = getDb();
  if (txDepth > 0) {
    // Transaction imbriquée : on utilise un point de sauvegarde.
    const savepoint = `sp_${txDepth}_${Date.now()}`;
    instance.exec(`SAVEPOINT ${savepoint};`);
    txDepth += 1;
    try {
      const out = fn();
      instance.exec(`RELEASE ${savepoint};`);
      txDepth -= 1;
      return out;
    } catch (err) {
      try { instance.exec(`ROLLBACK TO ${savepoint};`); } catch { /* noop */ }
      try { instance.exec(`RELEASE ${savepoint};`); } catch { /* noop */ }
      txDepth -= 1;
      throw err;
    }
  }
  instance.exec(immediate ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
  txDepth = 1;
  try {
    const out = fn();
    instance.exec('COMMIT;');
    txDepth = 0;
    return out;
  } catch (err) {
    try { instance.exec('ROLLBACK;'); } catch { /* noop */ }
    txDepth = 0;
    throw err;
  }
}

function inTransaction() {
  return txDepth > 0;
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */
function getMeta(key, fallback = null) {
  try {
    const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

function setMeta(key, value) {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, String(value));
}

function tableExists(name) {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

/** Résultat brut pour l'export / la sauvegarde. */
/**
 * `PRAGMA integrity_check` renvoie une ligne brute `{ integrity_check: 'ok' }`.
 * On normalise pour que tous les appelants (scripts, administration) aient la
 * même forme : `{ ok, integrity, detail }`.
 */
function integrityCheck() {
  try {
    const row = getDb().prepare('PRAGMA integrity_check').get();
    const value = String((row && (row.integrity_check ?? row.integrity)) ?? 'inconnue');
    return { ok: value === 'ok', integrity: value, detail: value };
  } catch (err) {
    return { ok: false, integrity: 'erreur', detail: err.message };
  }
}

module.exports = {
  getDb,
  useDatabase,
  close,
  migrate,
  listMigrationFiles,
  all,
  get,
  run,
  insert,
  update,
  transaction,
  inTransaction,
  getMeta,
  setMeta,
  tableExists,
  integrityCheck,
  TransactionError,
  countPlaceholders,
  normalize,
};
