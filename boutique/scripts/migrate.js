'use strict';

/** Applique les migrations à la base configurée. */

const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

if (process.argv.includes('--db')) {
  const idx = process.argv.indexOf('--db');
  const target = process.argv[idx + 1];
  if (!target) {
    console.error('Usage : node scripts/migrate.js --db <chemin>');
    process.exit(2);
  }
  db.useDatabase(path.resolve(target));
  console.log(`Base cible : ${path.resolve(target)}`);
}

try {
  const applied = db.migrate();
  if (!applied.length) console.log('Aucune migration à appliquer : le schéma est à jour.');
  for (const m of applied) console.log(`Migration appliquée : ${m.file}`);
  const check = db.integrityCheck();
  console.log('Intégrité de la base :', check.integrity);
  console.log('Fichier :', config.db.path);
} catch (err) {
  console.error('Échec de la migration :', err.message);
  process.exit(1);
}
