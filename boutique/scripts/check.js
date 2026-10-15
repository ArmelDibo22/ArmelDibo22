'use strict';

/**
 * `npm run check` — vérification de bout en bout d'une installation.
 *
 * 1. intégrité de la base et migrations appliquées ;
 * 2. démarrage réel du serveur sur un port éphémère ;
 * 3. parcours de toutes les pages publiques (aucune ne doit renvoyer 5xx) ;
 * 4. connexion administrateur puis parcours de toutes les pages d'administration ;
 * 5. cohérence des réglages (checklist de mise en route).
 *
 * Aucune donnée n'est modifiée en dehors de la session de connexion.
 * Utilisation : node scripts/check.js [--url http://hote:port] [--json]
 */

const path = require('node:path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;

const config = require('../src/config');
const db = require('../src/db');
const settings = require('../src/lib/settings');

const PUBLIC_URLS = [
  ['/', 200],
  ['/catalogue', 200],
  ['/catalogue?page=2', 200],
  ['/catalogue?tri=prix_asc', 200],
  ['/recherche?q=cahier', 200],
  ['/panier', 200],
  ['/commande', 302],
  ['/suivi', 200],
  ['/contact', 200],
  ['/informations/livraison-retours', 200],
  ['/informations/confidentialite', 200],
  ['/informations/conditions', 200],
  ['/compte', 302],
  ['/compte/connexion', 200],
  ['/compte/inscription', 200],
  ['/admin/connexion', 200],
  ['/robots.txt', 200],
  ['/sitemap.xml', 200],
  ['/sante', 200],
  ['/api/panier', 200],
  ['/api/suggestions?q=ca', 200],
  ['/assets/css/app.css', 200],
  ['/assets/css/admin.css', 200],
  ['/assets/js/app.js', 200],
  ['/assets/js/admin.js', 200],
  ['/favicon.ico', 200],
  ['/page-inexistante-xyz', 404],
  ['/media/inconnu.jpg', 200],
];

const ADMIN_URLS = [
  ['/admin', 200],
  ['/admin/produits', 200],
  ['/admin/produits/nouveau', 200],
  ['/admin/categories', 200],
  ['/admin/marques', 200],
  ['/admin/medias', 200],
  ['/admin/commandes', 200],
  ['/admin/commandes?groupe=quote', 200],
  ['/admin/commandes?groupe=cash', 200],
  ['/admin/stock', 200],
  ['/admin/stock?vue=tous', 200],
  ['/admin/stock/mouvements', 200],
  ['/admin/caisse', 200],
  ['/admin/clients', 200],
  ['/admin/import', 200],
  ['/admin/import/modele.csv', 200],
  ['/admin/import/modele.xlsx', 200],
  ['/admin/export/catalogue.csv', 200],
  ['/admin/export/catalogue.xlsx', 200],
  ['/admin/reglages', 200],
  ['/admin/reglages?onglet=contacts', 200],
  ['/admin/reglages?onglet=commerce', 200],
  ['/admin/reglages?onglet=apparence', 200],
  ['/admin/reglages?onglet=livraison', 200],
  ['/admin/reglages?onglet=paiements', 200],
  ['/admin/reglages?onglet=pages', 200],
  ['/admin/reglages?onglet=notifications', 200],
  ['/admin/reglages/paiements/notifications', 200],
  ['/admin/statistiques', 200],
  ['/admin/statistiques/export.csv', 200],
  ['/admin/utilisateurs', 200],
  ['/admin/journal', 200],
  ['/admin/sauvegardes', 200],
  ['/admin/etat', 200],
  ['/admin/exports/commandes.csv', 200],
  ['/admin/exports/ventes.csv', 200],
  ['/admin/exports/clients.csv', 200],
  ['/admin/inexistant', 404],
];

/** Garde-fou : un administrateur non connecté ne doit rien voir. */
const GUARD_URLS = [
  ['/admin', 302],
  ['/admin/produits', 302],
  ['/admin/commandes', 302],
  ['/admin/reglages', 302],
  ['/compte/commandes', 302],
];

class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of raw) {
      const [pair] = String(c).split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(String(c))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function main() {
  const results = [];
  let base = urlArg;
  let server = null;

  if (!base) {
    db.migrate();
    settings.ensureDefaults();
    const { createApp } = require('../src/app');
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  const jar = new Jar();
  const hit = async (url, { method = 'GET', body = null, expect = 200, label = url } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: jar.header(),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    jar.absorb(res);
    const text = await res.text();
    const ok = res.status === expect;
    results.push({ label, url, method, status: res.status, expected: expect, ok, bytes: text.length });
    return { res, text, ok };
  };

  // --- 1. Base de données -------------------------------------------------
  const integrity = db.integrityCheck();
  const migrations = db.all('SELECT version FROM schema_migrations ORDER BY version');
  results.push({
    label: 'Intégrité de la base',
    url: path.basename(config.db.path),
    method: 'db',
    status: integrity.ok ? 200 : 500,
    expected: 200,
    ok: Boolean(integrity.ok),
    bytes: migrations.length,
    detail: `integrity=${integrity.integrity} · migrations=${migrations.map((m) => m.version).join(',')}`,
  });

  // --- 2. Garde-fous d'accès ----------------------------------------------
  for (const [url, expect] of GUARD_URLS) {
    await hit(url, { expect, label: `Accès refusé sans session : ${url}` });
  }

  // --- 3. Pages publiques --------------------------------------------------
  for (const [url, expect] of PUBLIC_URLS) {
    await hit(url, { expect });
  }

  // --- 4. Connexion administrateur -----------------------------------------
  const login = await hit('/admin/connexion', { expect: 200, label: 'Page de connexion admin' });
  const csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(login.text);
  const adminEmail = config.bootstrapAdmin.email;
  const adminPassword = config.bootstrapAdmin.password;
  if (csrf && adminEmail && adminPassword) {
    const posted = await hit('/admin/connexion', {
      method: 'POST',
      body: { _csrf: csrf[1], email: adminEmail, password: adminPassword, suite: '/admin' },
      expect: 302,
      label: 'Connexion administrateur',
    });
    if (posted.ok) {
      for (const [url, expect] of ADMIN_URLS) {
        await hit(url, { expect, label: url });
      }
    } else {
      results.push({ label: 'Pages admin', url: '(ignorées)', method: 'GET', status: 0, expected: 200, ok: false, detail: 'Connexion échouée' });
    }
  } else {
    results.push({
      label: 'Connexion administrateur',
      url: '/admin/connexion',
      method: 'POST',
      status: 0,
      expected: 302,
      ok: false,
      detail: 'BOOTSTRAP_ADMIN_EMAIL/PASSWORD absents : vérification admin ignorée',
    });
  }

  // --- 5. Récapitulatif ----------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  if (asJson) {
    console.log(JSON.stringify({ base, integrity, ok: failed.length === 0, results }, null, 2));
  } else {
    console.log('');
    console.log(`Vérification de ${base}`);
    console.log('─'.repeat(78));
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗';
      const detail = r.detail ? `  ${r.detail}` : '';
      console.log(`${mark} ${String(r.status).padEnd(4)} ${r.label.padEnd(46)} (attendu ${r.expected})${detail}`);
    }
    console.log('─'.repeat(78));
    console.log(`${results.length - failed.length}/${results.length} vérifications réussies`);
    if (failed.length) {
      console.log('ÉCHECS :');
      for (const f of failed) console.log(`  · ${f.label} → ${f.status} (attendu ${f.expected})`);
    }
    const checklist = settings.completenessChecklist();
    const pending = checklist.filter((c) => !c.done);
    console.log('');
    console.log(`Mise en route : ${checklist.length - pending.length}/${checklist.length} information(s) confirmée(s).`);
    for (const p of pending) console.log(`  · à compléter : ${p.label}`);
    console.log('');
  }

  if (server) await new Promise((r) => server.close(r));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Vérification impossible :', err);
  process.exit(2);
});
