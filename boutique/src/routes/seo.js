'use strict';

/** Référencement local : robots.txt, sitemap.xml et manifeste.
 *  Fondé uniquement sur les informations confirmées et les pages réellement publiées. */

const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const dates = require('../lib/dates');

const router = express.Router();

router.get('/robots.txt', (req, res) => {
  const base = config.publicUrl;
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /panier',
    'Disallow: /commande',
    'Disallow: /webhooks',
    'Disallow: /paiements/simuler',
    '',
    `Sitemap: ${base}/sitemap.xml`,
  ];
  res.type('text/plain; charset=utf-8').send(lines.join('\n'));
});

router.get('/sitemap.xml', (req, res) => {
  const base = config.publicUrl;
  const urls = [{ loc: `${base}/`, priority: '1.0', changefreq: 'daily' }];

  for (const c of db.all('SELECT slug, updated_at FROM categories WHERE archived = 0 ORDER BY position')) {
    urls.push({ loc: `${base}/categorie/${c.slug}`, lastmod: c.updated_at, priority: '0.8', changefreq: 'weekly' });
  }
  for (const p of db.all("SELECT slug, updated_at FROM products WHERE status = 'published' ORDER BY updated_at DESC LIMIT 20000")) {
    urls.push({ loc: `${base}/produit/${p.slug}`, lastmod: p.updated_at, priority: '0.7', changefreq: 'weekly' });
  }
  for (const pg of db.all('SELECT slug, updated_at FROM pages WHERE published = 1')) {
    urls.push({ loc: `${base}/informations/${pg.slug}`, lastmod: pg.updated_at, priority: '0.4', changefreq: 'yearly' });
  }
  urls.push({ loc: `${base}/contact`, priority: '0.6', changefreq: 'yearly' });
  urls.push({ loc: `${base}/catalogue`, priority: '0.9', changefreq: 'daily' });

  const body = urls
    .map(
      (u) =>
        `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    )
    .join('\n');
  res.type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});

router.get('/manifest.webmanifest', (req, res) => {
  const all = settings.load();
  res.type('application/manifest+json').send(
    JSON.stringify(
      {
        name: all['store.name'],
        short_name: all['store.short_name'],
        description: `Boutique en ligne — ${all['store.city']}, ${all['store.region']}, ${all['store.country']}`,
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: all['theme.background'],
        theme_color: all['theme.primary'],
        dir: 'ltr',
      },
      null,
      2
    )
  );
});

/** Données structurées LocalBusiness fondées sur les seules informations confirmées. */
router.get('/donnees-locales.json', (req, res) => {
  const all = settings.load();
  const contacts = (all['store.contacts'] || []).filter((c) => c.visible !== false);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: all['store.name'],
    description: all['store.tagline'] || `Boutique à ${all['store.city']}, région de l'${all['store.region']}, ${all['store.country']}.`,
    address: {
      '@type': 'PostalAddress',
      addressLocality: all['store.city'],
      addressRegion: all['store.region'],
      addressCountry: all['store.country_code'] || 'CI',
      ...(all['store.address'] && all['store.address_confirmed'] ? { streetAddress: all['store.address'] } : {}),
    },
    ...(all['store.maps_lat'] && all['store.maps_lng']
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: Number(all['store.maps_lat']),
            longitude: Number(all['store.maps_lng']),
          },
          hasMap: all['store.maps_url'],
        }
      : {}),
    telephone: contacts.filter((c) => c.type === 'phone').map((c) => c.value),
    email: contacts.filter((c) => c.type === 'email').map((c) => c.value),
    currenciesAccepted: all['commerce.currency'],
    priceRange: undefined,
    ...(all['store.hours_status'] === 'confirmed' && (all['store.hours'] || []).length
      ? {
          openingHoursSpecification: all['store.hours']
            .filter((h) => !h.closed && h.open && h.close)
            .map((h) => ({
              '@type': 'OpeningHoursSpecification',
              dayOfWeek: h.day,
              opens: h.open,
              closes: h.close,
            })),
        }
      : {}),
  };
  delete data.priceRange;
  res.type('application/ld+json').send(JSON.stringify(data, null, 2));
});

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

router.get('/heure-serveur', (req, res) => {
  res.json({ utc: dates.nowIso(), local: dates.formatDateTime(dates.nowIso()), timezone: dates.TZ });
});

module.exports = router;
