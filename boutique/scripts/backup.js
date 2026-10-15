'use strict';

/**
 * Sauvegarde manuelle de la boutique.
 *
 * Usage :
 *   node scripts/backup.js                 # base seule (VACUUM INTO + contrôle d'intégrité)
 *   node scripts/backup.js --full          # archive complète : base + médias (.tar.gz)
 *   node scripts/backup.js --list          # liste les sauvegardes disponibles
 *   node scripts/backup.js --prune 14      # ne conserve que les 14 plus récentes
 *   node scripts/backup.js --json          # sortie machine
 *   node scripts/backup.js --db data/demo.sqlite   # cible une autre base
 *
 * Chaque sauvegarde est contrôlée par `PRAGMA integrity_check` avant d'être
 * annoncée comme réussie : un fichier corrompu fait échouer le script.
 */

const path = require('node:path');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

if (argv.includes('--db')) {
  const target = argv[argv.indexOf('--db') + 1];
  if (!target) {
    console.error('Usage : node scripts/backup.js --db <chemin>');
    process.exit(2);
  }
  process.env.DATABASE_PATH = path.resolve(target);
}

const config = require('../src/config');
const db = require('../src/db');
const backups = require('../src/lib/backups');
const settings = require('../src/lib/settings');

const log = (...args) => { if (!asJson) console.log(...args); };

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} Ko`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} Mo`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} Go`;
}

try {
  if (argv.includes('--list')) {
    const list = backups.listBackups();
    if (asJson) {
      console.log(JSON.stringify({ ok: true, backupDir: config.storage.backupDir, backups: list }, null, 2));
    } else {
      log(`Dossier : ${config.storage.backupDir}`);
      if (!list.length) log('Aucune sauvegarde.');
      for (const b of list) log(`  ${b.name.padEnd(46)} ${humanBytes(b.bytes).padStart(10)}   ${b.modifiedAt}`);
    }
    process.exit(0);
  }

  const full = argv.includes('--full');
  log(`— Sauvegarde ${full ? 'complète (base + médias)' : 'de la base'} —`);
  log(`Base    : ${config.db.path}`);
  log(`Dossier : ${config.storage.backupDir}`);

  const result = full ? backups.backupFull() : backups.backupDatabase();

  // Purge selon le réglage `backup.retention` (ou --prune N).
  const pruneIdx = argv.indexOf('--prune');
  const keep = pruneIdx !== -1
    ? Number(argv[pruneIdx + 1]) || 14
    : Number(settings.get('backup.retention')) || 14;
  const removed = backups.prune(keep);

  const integrity = result.integrity || (result.database ? backups.verifyDatabaseFile(result.database) : null);
  const file = result.archive || result.database || result.file;
  const bytes = result.bytes || (file ? require('node:fs').statSync(file).size : 0);

  if (integrity && !integrity.ok) {
    console.error(`Sauvegarde créée mais INTEGRITE INVALIDE : ${integrity.integrity}`);
    console.error(`Fichier : ${file}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, file, bytes, integrity, removed, kept: keep }, null, 2));
  } else {
    log('');
    log(`Fichier      : ${path.basename(file)}`);
    log(`Taille       : ${humanBytes(bytes)}`);
    log(`Intégrité    : ${integrity ? integrity.integrity : 'non vérifiable (archive)'}`);
    if (integrity && integrity.products !== undefined) log(`Articles     : ${integrity.products}`);
    if (result.note) log(`Note         : ${result.note}`);
    log(`Purge        : ${removed} ancien(s) fichier(s) supprimé(s), ${keep} conservé(s)`);
    log('');
    log('Conservez une copie HORS du serveur : une sauvegarde laissée sur la même');
    log('machine ne protège ni du vol ni d’une panne de disque.');
  }
  db.close();
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }));
  else console.error('Échec de la sauvegarde :', err.message);
  process.exit(1);
}
