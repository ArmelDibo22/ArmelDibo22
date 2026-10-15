'use strict';

/**
 * Vues : chaque modèle EJS doit pouvoir être compilé.
 *
 * Une balise mal fermée ou une variable non déclarée ne se voit qu'au rendu : la
 * page renvoie alors une erreur 500 découverte par un client. Deux écrans avaient
 * exactement ce défaut (bon de commande imprimable, rapport d'import). Compiler
 * toutes les vues coûte moins d'une seconde et l'interdit définitivement.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ejs = require('ejs');

const VIEWS = path.resolve(__dirname, '..', 'src', 'views');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

const files = walk(VIEWS);

test('toutes les vues EJS se compilent', () => {
  assert.ok(files.length >= 60, `le jeu de vues est complet (${files.length} fichiers)`);

  const failures = [];
  for (const file of files) {
    try {
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      failures.push(`${path.relative(VIEWS, file)} : ${err.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], 'vue(s) en échec de compilation');
});

test('les vues d’administration sont des documents complets, les vues publiques des fragments', () => {
  // Contrat de rendu : `res.renderPage(view, data, layout)` enveloppe les vues
  // publiques ; les vues d'administration incluent elles-mêmes l'en-tête et le
  // pied de page. Une inversion produirait des pages sans styles ni navigation.
  for (const file of files) {
    const relative = path.relative(VIEWS, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const includesHeader = source.includes("/admin/partials/header");
    const includesFooter = source.includes("/admin/partials/footer");

    if (relative.startsWith('admin/')) {
      // Documents imprimables (volontairement sans ossature) et squelettes.
      const exempt = ['admin/partials/header.ejs', 'admin/partials/footer.ejs',
        'admin/layout.ejs', 'admin/layout-bare.ejs', 'admin/login.ejs',
        'admin/error.ejs', 'admin/404.ejs',
        'admin/orders/print.ejs', 'admin/pos-print.ejs'].includes(relative);
      if (exempt) continue;
      assert.ok(includesHeader, `${relative} doit inclure l’en-tête d’administration`);
      assert.ok(includesFooter, `${relative} doit inclure le pied de page d’administration`);
    } else {
      assert.ok(!includesHeader && !includesFooter,
        `${relative} est une vue publique : elle ne doit pas inclure l’ossature d’administration`);
    }
  }
});

test('aucune vue publique n’affiche de preuve sociale artificielle', () => {
  // Exigence métier : pas de faux témoignages, de compteur de ventes ni de compte à
  // rebours. `view_count` existe en base mais ne doit jamais être rendu.
  for (const file of files) {
    if (path.relative(VIEWS, file).startsWith('admin')) continue;
    const raw = fs.readFileSync(file, 'utf8');
    // Les commentaires de code et de page ne sont pas rendus : on ne juge que le balisage.
    const source = raw
      .replace(/<%#[\s\S]*?%>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<%\s*\/\*[\s\S]*?\*\s*%>/g, ' ')
      .replace(/<%[\s\S]*?%>/g, ' ');
    assert.ok(!/view_count/.test(source), `${path.relative(VIEWS, file)} expose le compteur de vues`);
    assert.ok(!/déjà \d+ (ventes|commandes)|compte à rebours|témoignage/i.test(source),
      `${path.relative(VIEWS, file)} contient une preuve sociale artificielle`);
  }
});
