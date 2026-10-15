'use strict';

/** Slugs et normalisation de texte (français : les accents sont retirés). */

const MAP = {
  à: 'a', á: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', æ: 'ae',
  ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e', ì: 'i', í: 'i', î: 'i', ï: 'i',
  ð: 'd', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o', œ: 'oe',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ý: 'y', þ: 'th', ÿ: 'y', ı: 'i',
  ẞ: 'ss', ß: 'ss',
};

function transliterate(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[^\u0000-\u007f]/g, (ch) => MAP[ch] || MAP[ch.toLowerCase()] || '');
}

function slugify(input, fallback = 'element') {
  const base = transliterate(input)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/g, '');
  return base || fallback;
}

/** Garantit un slug unique en ajoutant un suffixe numérique. */
function uniqueSlug(base, exists) {
  let candidate = base;
  let i = 2;
  while (exists(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
    if (i > 10000) return `${base}-${Date.now().toString(36)}`;
  }
  return candidate;
}

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

/** Retire toute balise HTML (utilisé pour les descriptions courtes / extraits). */
function stripHtml(html) {
  return normalizeText(
    String(html || '')
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

function excerpt(text, max = 160) {
  const t = stripHtml(text);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

module.exports = { slugify, uniqueSlug, normalizeText, stripHtml, excerpt, transliterate };
