'use strict';

/**
 * Remet le jeu de démonstration à zéro, puis le recrée.
 *
 * Ne touche JAMAIS aux données réelles : seules les cibles de démonstration
 * (`data/demo.sqlite`, `data/demo-media`, `data/demo-imports`, `data/demo-backups`)
 * sont supprimées. Refusé si NODE_ENV=production.
 *
 * Usage :
 *   npm run reset:demo
 *   node scripts/reset-demo.js --no-orders   # sans les commandes de démonstration
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  console.error('reset-demo est interdit lorsque NODE_ENV=production.');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const targets = [
  process.env.DEMO_DATABASE_PATH || 'data/demo.sqlite',
  `${process.env.DEMO_DATABASE_PATH || 'data/demo.sqlite'}-wal`,
  `${process.env.DEMO_DATABASE_PATH || 'data/demo.sqlite'}-shm`,
  process.env.DEMO_MEDIA_DIR || 'data/demo-media',
  'data/demo-imports',
  'data/demo-backups',
].map((p) => path.resolve(ROOT, p));

const realDb = path.resolve(ROOT, process.env.DATABASE_PATH || 'data/boutique.sqlite');
for (const t of targets) {
  if (t === realDb) {
    console.error('Refus : une cible de démonstration pointe sur la base réelle.');
    process.exit(1);
  }
}

console.log('— Réinitialisation du jeu de démonstration —');
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  const isDir = fs.statSync(t).isDirectory();
  fs.rmSync(t, { recursive: isDir, force: true });
  console.log(`  supprimé : ${path.relative(ROOT, t)}`);
}

const args = [path.join('scripts', 'seed-demo.js'), '--fresh'];
if (process.argv.includes('--no-orders')) {
  // rien : les commandes sont facultatives
} else {
  args.push('--orders');
}

console.log('');
const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env: Object.assign({}, process.env, { DEMO: 'true', NODE_ENV: process.env.NODE_ENV || 'development' }),
});
process.exit(child.status === null ? 1 : child.status);
