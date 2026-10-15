'use strict';

/**
 * Traitement des images produit avec `sharp`.
 *
 * Chaque média téléversé produit plusieurs dérivés servis par taille :
 *   original.(ext)  — fichier reçu, conservé pour l'export
 *   large.webp      — 1200 px, fiche produit (zoom)
 *   medium.webp     — 720 px, fiche produit par défaut
 *   thumb.webp      — 320 px, listes et panier
 *   tiny.webp       — 24 px, espace réservé flou (chargement progressif)
 *
 * Les images sont stockées sur le disque du serveur (dossier `data/media`,
 * hors dépôt Git), jamais dans le navigateur ni dans la base de données.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const config = require('../config');
const ids = require('./ids');

const SIZES = {
  large: { width: 1200, quality: 82 },
  medium: { width: 720, quality: 78 },
  thumb: { width: 320, quality: 74 },
  tiny: { width: 24, quality: 40 },
};

function mediaRoot() {
  return config.storage.mediaDir;
}

function ensureRoot() {
  fs.mkdirSync(mediaRoot(), { recursive: true });
}

function dirFor(key) {
  // key = "ab/cd/abcdef....ext"
  const clean = String(key).replace(/[^a-z0-9._/-]/gi, '');
  if (clean.includes('..')) throw new Error('Clé de média invalide');
  return path.join(mediaRoot(), path.dirname(clean));
}

function extensionForMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  };
  return map[mime] || 'bin';
}

/** Détecte le type réel d'un fichier par ses octets (ne se fie pas à l'extension). */
function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('latin1');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
  }
  if (buffer.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buffer.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

/**
 * Enregistre un fichier image et génère ses dérivés.
 * @param {Buffer} buffer
 * @param {{mime?:string, filename?:string}} options
 * @returns {Promise<{key:string, mime:string, bytes:number, width:number, height:number, files:Object<string,number>}>}
 */
async function storeImage(buffer, options = {}) {
  ensureRoot();
  const detected = sniffMimeType(buffer) || options.mime;
  if (!detected || !config.storage.allowedImageTypes.includes(detected)) {
    const err = new Error(
      `Format d'image non accepté (${detected || 'inconnu'}). Formats autorisés : ${config.storage.allowedImageTypes.join(', ')}.`
    );
    err.code = 'BAD_IMAGE_TYPE';
    err.status = 400;
    throw err;
  }
  if (buffer.length > config.storage.maxUploadBytes) {
    const err = new Error(
      `Fichier trop volumineux (${Math.round(buffer.length / 1024 / 1024)} Mo). Limite : ${Math.round(
        config.storage.maxUploadBytes / 1024 / 1024
      )} Mo.`
    );
    err.code = 'FILE_TOO_LARGE';
    err.status = 400;
    throw err;
  }

  const ext = extensionForMime(detected);
  const key = ids.mediaKey(ext);
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });

  const base = path.join(dir, path.basename(key, `.${ext}`));
  fs.writeFileSync(`${base}.${ext}`, buffer);

  const files = { original: buffer.length };
  let width = 0;
  let height = 0;

  try {
    const source = sharp(buffer, { failOn: 'none' }).rotate(); // EXIF pris en compte
    const meta = await source.metadata();
    width = meta.width || 0;
    height = meta.height || 0;

    for (const [name, spec] of Object.entries(SIZES)) {
      const outPath = `${base}.${name}.webp`;
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: spec.width, withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toFile(outPath);
      files[name] = out.size;
    }
    // JPEG de secours pour les navigateurs très anciens.
    const fallback = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: SIZES.medium.width, withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true })
      .toFile(`${base}.medium.jpg`);
    files['medium.jpg'] = fallback.size;
  } catch (err) {
    // Image non décodable : on nettoie et on refuse.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    const e = new Error("Impossible de traiter cette image : fichier illisible ou corrompu.");
    e.code = 'BAD_IMAGE';
    e.status = 400;
    e.cause = err;
    throw e;
  }

  return {
    fileKey: key,
    mime: 'image/webp',
    sourceMime: detected,
    bytes: buffer.length,
    width,
    height,
    files,
  };
}

/** Enregistre un document (PDF de catalogue, bon de livraison…) sans traitement d'image. */
function storeDocument(buffer, { mime = 'application/pdf', filename = 'document.pdf' } = {}) {
  ensureRoot();
  const ext = extensionForMime(mime) || 'bin';
  const key = ids.mediaKey(ext);
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, path.basename(key)), buffer);
  return { fileKey: key, mime, bytes: buffer.length, filename };
}

/** Chemin absolu d'un dérivé. */
function resolvePath(fileKey, variant = 'medium') {
  const clean = String(fileKey).replace(/[^a-z0-9._/-]/gi, '');
  if (clean.includes('..')) return null;
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  const dir = path.join(mediaRoot(), path.dirname(clean));
  const name = path.basename(base);
  if (variant === 'original') return path.join(dir, `${name}${ext}`);
  const webp = path.join(dir, `${name}.${variant}.webp`);
  if (fs.existsSync(webp)) return webp;
  const jpg = path.join(dir, `${name}.${variant}.jpg`);
  if (fs.existsSync(jpg)) return jpg;
  const original = path.join(dir, `${name}${ext}`);
  return fs.existsSync(original) ? original : null;
}

function removeMedia(fileKey) {
  try {
    const clean = String(fileKey).replace(/[^a-z0-9._/-]/gi, '');
    if (clean.includes('..')) return false;
    const dir = path.join(mediaRoot(), path.dirname(clean));
    const name = path.basename(clean, path.extname(clean));
    if (!fs.existsSync(dir)) return false;
    let removed = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f === name || f.startsWith(`${name}.`)) {
        fs.rmSync(path.join(dir, f), { force: true });
        removed += 1;
      }
    }
    return removed > 0;
  } catch {
    return false;
  }
}

/** Espace réservé SVG sobre pour un produit sans photo (jamais de photo inventée). */
function placeholderSvg(label = '', { width = 640, height = 640 } = {}) {
  const text = String(label || 'Photo à venir')
    .replace(/[<>&]/g, '')
    .slice(0, 26)
    .toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Aucune photo disponible pour ce produit">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F7F9FC"/>
      <stop offset="100%" stop-color="#E9EEF6"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <g fill="none" stroke="#C3CEDF" stroke-width="2">
    <rect x="${width / 2 - 70}" y="${height / 2 - 60}" width="140" height="104" rx="10"/>
    <circle cx="${width / 2 - 30}" cy="${height / 2 - 26}" r="12"/>
    <path d="M${width / 2 - 62} ${height / 2 + 30} L${width / 2 - 14} ${height / 2 - 6} L${width / 2 + 18} ${height / 2 + 22} L${width / 2 + 40} ${height / 2 + 4} L${width / 2 + 62} ${height / 2 + 30}"/>
  </g>
  <text x="50%" y="${height / 2 + 86}" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="20" fill="#7A8AA5" letter-spacing="1.5">${text}</text>
</svg>`;
}

module.exports = {
  SIZES,
  storeImage,
  storeDocument,
  resolvePath,
  removeMedia,
  sniffMimeType,
  placeholderSvg,
  mediaRoot,
  extensionForMime,
};
