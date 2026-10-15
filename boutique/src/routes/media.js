'use strict';

/**
 * Service des médias produits.
 *
 * Les fichiers vivent sur le disque du serveur (`data/media`), hors dépôt Git.
 * Les dérivés WebP sont servis avec un cache long ; un JPEG de secours est
 * produit pour les navigateurs qui ne prennent pas en charge WebP.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const images = require('../lib/images');
const db = require('../db');

const router = express.Router();

const VARIANTS = new Set(['tiny', 'thumb', 'medium', 'large', 'original']);

router.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  const rawKey = decodeURIComponent(req.path.replace(/^\//, ''));
  if (!rawKey || rawKey.includes('..')) return res.status(400).type('text/plain').send('Clé invalide');

  const requested = String((req.query && req.query.s) || 'medium');
  const variant = VARIANTS.has(requested) ? requested : 'medium';

  // Les médias doivent être référencés en base : pas d'accès à un fichier arbitraire.
  const baseKey = rawKey.replace(/\.(tiny|thumb|medium|large)\.(webp|jpg)$/, '');
  const media = db.get('SELECT * FROM media_files WHERE file_key = ?', [baseKey]);

  const supportsWebp = String(req.headers.accept || '').includes('image/webp') || /image\/webp/.test(String(req.query.t || ''));
  let file = images.resolvePath(baseKey, variant === 'original' ? 'original' : variant);
  if (file && !supportsWebp && file.endsWith('.webp')) {
    const fallback = images.resolvePath(baseKey, `${variant}.jpg`);
    if (fallback) file = fallback;
  }
  if (!file || !fs.existsSync(file)) {
    // Un fichier absent (image supprimée, clé inconnue) ne doit jamais casser une
    // page : on sert un SVG de remplacement en 200 pour que <img> l'affiche.
    // Le statut 404 empêcherait le rendu du corps de réponse par le navigateur.
    const svg = images.placeholderSvg(media ? '' : 'Média introuvable');
    res.status(200).type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=300').send(svg);
    return;
  }

  res.setHeader('Cache-Control', `public, max-age=${60 * 60 * 24 * 90}, immutable`);
  res.setHeader('Content-Type', file.endsWith('.webp') ? 'image/webp' : file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.resolve(file));
});

module.exports = router;
