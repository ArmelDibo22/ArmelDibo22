'use strict';

/**
 * Sauvegarde et restauration.
 *
 * La base tient dans un seul fichier SQLite : la sauvegarde consiste à
 * checkpoint le journal WAL puis copier le fichier, accompagné des médias.
 * Un contrôle d'intégrité est effectué avant et après copie.
 *
 * Aucune sauvegarde ne quitte le serveur : le fichier produit doit être
 * téléchargé par un administrateur puis conservé hors du serveur (voir
 * docs/exploitation.md pour la procédure).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../db');
const config = require('../config');
const dates = require('../lib/dates');
const logger = require('../lib/logger');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stampName(prefix = 'sauvegarde') {
  return `${prefix}-${dates.todayInTz()}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Copie cohérente de la base (méthode « VACUUM INTO » : produit un fichier
 * autonome et compact, sûr même pendant l'écriture).
 */
function backupDatabase(targetDir = config.storage.backupDir) {
  ensureDir(targetDir);
  const name = `${stampName('base')}.sqlite`;
  const target = path.join(targetDir, name);
  try {
    db.getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new Error(`Sauvegarde de la base impossible : ${err.message}`);
  }
  const integrity = verifyDatabaseFile(target);
  return { file: target, name, bytes: fs.statSync(target).size, integrity };
}

function verifyDatabaseFile(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const probe = new DatabaseSync(file, { readOnly: true });
    const row = probe.prepare('PRAGMA integrity_check').get();
    const count = probe.prepare('SELECT COUNT(*) AS n FROM products').get();
    probe.close();
    return { ok: String(row?.integrity_check) === 'ok', integrity: row?.integrity_check, products: count?.n ?? 0 };
  } catch (err) {
    return { ok: false, integrity: err.message, products: 0 };
  }
}

/** Archive la base + les médias + les réglages exportables en un seul .tar.gz. */
function backupFull(targetDir = config.storage.backupDir) {
  ensureDir(targetDir);
  const { file, name } = backupDatabase(targetDir);
  const archive = path.join(targetDir, `${stampName('complete')}.tar.gz`);
  const mediaDir = config.storage.mediaDir;
  const args = ['-czf', archive, '-C', path.dirname(file), name];
  if (fs.existsSync(mediaDir)) {
    args.push('-C', path.dirname(mediaDir), path.basename(mediaDir));
  }
  try {
    execFileSync('tar', args, { stdio: 'pipe' });
  } catch (err) {
    logger.warn('tar indisponible : sauvegarde de la base seule', { error: String(err.message).slice(0, 200) });
    return { archive: null, database: file, note: 'Archive tar indisponible sur ce serveur : la base seule a été sauvegardée.' };
  }
  return { archive, database: file, bytes: fs.statSync(archive).size };
}

function listBackups(dir = config.storage.backupDir) {
  ensureDir(dir);
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(sqlite|tar\.gz|zip)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Conserve uniquement les N sauvegardes les plus récentes. */
function prune(keep = 14, dir = config.storage.backupDir) {
  const backups = listBackups(dir);
  let removed = 0;
  for (const b of backups.slice(Math.max(1, Number(keep) || 14))) {
    try { fs.rmSync(b.path, { force: true }); removed += 1; } catch { /* noop */ }
  }
  return removed;
}

/**
 * Restauration : remplace la base courante par une sauvegarde vérifiée.
 * À exécuter de préférence application arrêtée (script/restore.js).
 */
function restore(sourceFile, { targetFile = config.db.path, dryRun = false } = {}) {
  if (!fs.existsSync(sourceFile)) throw new Error('Fichier de sauvegarde introuvable.');
  const check = verifyDatabaseFile(sourceFile);
  if (!check.ok) throw new Error(`Sauvegarde invalide : ${check.integrity}`);
  if (dryRun) return { ok: true, dryRun: true, check };

  ensureDir(path.dirname(targetFile));
  const backupOfCurrent = `${targetFile}.avant-restauration-${Date.now()}`;
  if (fs.existsSync(targetFile)) fs.copyFileSync(targetFile, backupOfCurrent);
  fs.copyFileSync(sourceFile, targetFile);
  for (const suffix of ['-wal', '-shm']) {
    const side = targetFile + suffix;
    if (fs.existsSync(side)) fs.rmSync(side, { force: true });
  }
  const verify = verifyDatabaseFile(targetFile);
  if (!verify.ok) {
    if (fs.existsSync(backupOfCurrent)) fs.copyFileSync(backupOfCurrent, targetFile);
    throw new Error('Restauration échouée : la base précédente a été rétablie.');
  }
  return { ok: true, check, verify, previous: fs.existsSync(backupOfCurrent) ? backupOfCurrent : null };
}

/** Export JSON de toutes les tables (lecture humaine, secours). */
function exportJson(targetFile = null) {
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
  const dump = { exportedAt: dates.nowIso(), schema: db.getMeta('schema'), tables: {} };
  for (const t of tables) {
    try {
      dump.tables[t] = db.all(`SELECT * FROM "${t}"`);
    } catch (err) {
      dump.tables[t] = { error: err.message };
    }
  }
  const json = JSON.stringify(dump);
  if (targetFile) {
    ensureDir(path.dirname(targetFile));
    fs.writeFileSync(targetFile, json);
    return { file: targetFile, bytes: Buffer.byteLength(json) };
  }
  return { json, bytes: Buffer.byteLength(json) };
}

module.exports = {
  backupDatabase,
  backupFull,
  listBackups,
  prune,
  restore,
  verifyDatabaseFile,
  exportJson,
  stampName,
};
