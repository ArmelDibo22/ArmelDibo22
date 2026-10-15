'use strict';

/**
 * Restauration d'une sauvegarde.
 *
 * Usage :
 *   node scripts/restore.js <fichier.sqlite> [--dry-run] [--yes] [--target <chemin>]
 *
 * Règles de sécurité :
 *   1. l'application doit être arrêtée (sinon la base restaurée serait aussitôt
 *      écrasée par les écritures en cours) ;
 *   2. la sauvegarde est vérifiée (`PRAGMA integrity_check`) AVANT tout remplacement ;
 *   3. la base courante est copiée dans `<base>.avant-restauration-<horodatage>`
 *      pour permettre un retour arrière ;
 *   4. si la vérification après copie échoue, la base précédente est rétablie ;
 *   5. aucune confirmation `--yes` => aucune écriture (le script s'arrête).
 *
 * Pour une archive complète (.tar.gz), extraire d'abord les médias :
 *   tar -xzf data/backups/<fichier>.tar.gz -C data/
 */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const confirmed = argv.includes('--yes');
const targetIdx = argv.indexOf('--target');

const source = argv.find((a) => !a.startsWith('--') && (targetIdx === -1 || argv.indexOf(a) !== targetIdx + 1));

if (!source) {
  console.error('Usage : node scripts/restore.js <fichier.sqlite> [--dry-run] [--yes] [--target <chemin>]');
  console.error('Exemple : node scripts/restore.js data/backups/base-20260101-1200.sqlite --dry-run');
  process.exit(2);
}

if (targetIdx !== -1) process.env.DATABASE_PATH = path.resolve(argv[targetIdx + 1]);

const config = require('../src/config');
const db = require('../src/db');
const backups = require('../src/lib/backups');

const sourcePath = path.resolve(source);
const target = config.db.path;

if (!fs.existsSync(sourcePath)) {
  console.error(`Fichier introuvable : ${sourcePath}`);
  process.exit(1);
}
if (/\.tar\.gz$/i.test(sourcePath) || /\.zip$/i.test(sourcePath)) {
  console.error('Ce fichier est une archive. Restaurez d’abord la base qu’elle contient :');
  console.error(`  tar -xzf ${path.basename(sourcePath)} -C data/`);
  console.error('puis relancez ce script sur le fichier .sqlite extrait.');
  process.exit(2);
}

console.log('— Restauration —');
console.log(`Sauvegarde : ${sourcePath}`);
console.log(`Base cible : ${target}`);
console.log('');

// 1. Vérification avant toute écriture.
let precheck;
try {
  precheck = backups.verifyDatabaseFile(sourcePath);
} catch (err) {
  console.error('Lecture de la sauvegarde impossible :', err.message);
  process.exit(1);
}
if (!precheck.ok) {
  console.error(`Sauvegarde invalide (${precheck.integrity}) : restauration abandonnée.`);
  process.exit(1);
}
console.log(`Intégrité de la sauvegarde : ${precheck.integrity} · ${precheck.products} article(s)`);

if (dryRun) {
  console.log('');
  console.log('Mode --dry-run : aucune écriture effectuée. La sauvegarde est utilisable.');
  process.exit(0);
}

// 2. Détection d'une application probablement encore démarrée.
const wal = `${target}-wal`;
if (fs.existsSync(wal)) {
  const ageMs = Date.now() - fs.statSync(wal).mtimeMs;
  if (ageMs < 60_000) {
    console.error('');
    console.error('Le fichier WAL de la base a été modifié il y a moins d’une minute :');
    console.error('l’application semble encore démarrer. Arrêtez-la (Ctrl+C ou arrêt du');
    console.error('service) puis relancez ce script. Restauration abandonnée.');
    process.exit(1);
  }
}

if (!confirmed) {
  console.error('');
  console.error('Cette opération REMPLACE la base courante.');
  console.error('Relancez avec --yes pour confirmer :');
  console.error(`  node scripts/restore.js ${path.relative(process.cwd(), sourcePath)} --yes`);
  process.exit(1);
}

try {
  const result = backups.restore(sourcePath, { targetFile: target });
  console.log('');
  console.log('Restauration terminée.');
  console.log(`Contrôle final : ${result.verify.integrity} · ${result.verify.products} article(s)`);
  if (result.previous) {
    console.log(`Base précédente conservée : ${result.previous}`);
    console.log('Vous pouvez la supprimer une fois la restauration vérifiée.');
  }
  db.close();
  console.log('');
  console.log('Relancez l’application, puis contrôlez /admin/etat.');
} catch (err) {
  console.error('Échec de la restauration :', err.message);
  process.exit(1);
}
