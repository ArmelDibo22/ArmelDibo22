'use strict';

/**
 * Jeu d'icônes SVG inline (aucune dépendance, aucune requête réseau).
 * Toutes les icônes héritent de `currentColor` et s'alignent sur le texte.
 */

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2.2l2.3 12.1a1.6 1.6 0 0 0 1.6 1.3h9.2a1.6 1.6 0 0 0 1.6-1.3L21 7H5.4"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.4a3.2 3.2 0 0 1 0 5.9M18 14.4a6.5 6.5 0 0 1 3.5 5.1"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  'chevron-up': '<path d="m5 15 7-7 7 7"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.8 2.8L16.2 9.6"/>',
  alert: '<path d="M12 3.6 21.2 19.4a1 1 0 0 1-.9 1.5H3.7a1 1 0 0 1-.9-1.5z"/><path d="M12 9.6v4.2M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8h.01"/>',
  phone: '<path d="M6.2 3.5h3l1.5 3.8-2 1.4a12 12 0 0 0 5.6 5.6l1.4-2 3.8 1.5v3a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 4.2 5.7a2 2 0 0 1 2-2.2Z"/>',
  'map-pin': '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.2 2"/>',
  mail: '<rect x="2.8" y="5" width="18.4" height="14" rx="2"/><path d="m3.4 6.4 8.6 6 8.6-6"/>',
  whatsapp: '<path d="M3.6 20.4 5 16.6A8 8 0 1 1 8 19.4z"/><path d="M9 9.2c.3 2 2.2 4 4.4 4.6l1-1.2 1.8.8v1.3c0 .6-.6 1.1-1.3 1a8.4 8.4 0 0 1-6.9-6.9c-.1-.7.4-1.3 1-1.3H10l.8 1.8z"/>',
  truck: '<path d="M2.8 6.5h10.4v9.8H2.8z"/><path d="M13.2 9.8h3.6l3.4 3.2v3.3h-7z"/><circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/>',
  store: '<path d="M3.6 9.4h16.8v10.2a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1z"/><path d="M2.6 9.4 4.8 4h14.4l2.2 5.4M9 20.6v-6h6v6"/>',
  'credit-card': '<rect x="2.6" y="5.2" width="18.8" height="13.6" rx="2"/><path d="M2.6 9.8h18.8M6.4 15h3.2"/>',
  wallet: '<path d="M3.4 7.4A2 2 0 0 1 5.4 5.4h12.2a2 2 0 0 1 2 2v1.6"/><rect x="3.4" y="7.4" width="17.2" height="11.2" rx="2"/><path d="M16.4 13h2.4"/>',
  cash: '<rect x="2.4" y="6" width="19.2" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v4M18 10v4"/>',
  package: '<path d="M12 2.8 21 7.4v9.2L12 21.2 3 16.6V7.4z"/><path d="m3 7.4 9 4.6 9-4.6M12 12v9.2"/>',
  box: '<path d="M4.4 7.6 12 3.6l7.6 4v8.8L12 20.4l-7.6-4z"/><path d="M4.4 7.6 12 11.6l7.6-4M12 11.6v8.8"/>',
  tag: '<path d="M3.6 11.4V4.4a.8.8 0 0 1 .8-.8h7l9.2 9.2a.8.8 0 0 1 0 1.2l-6.6 6.6a.8.8 0 0 1-1.2 0z"/><circle cx="7.8" cy="7.8" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4.4 6.6h15.2M9 6.6V4.8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.8M6.4 6.6 7.4 20a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l1-13.4"/>',
  edit: '<path d="M4.4 19.6h4L19 9a2.1 2.1 0 0 0-3-3L5.4 16.6z"/><path d="m14.6 5.4 3 3"/>',
  download: '<path d="M12 3.6v11.2M7.6 10.4 12 14.8l4.4-4.4M4 17.6v1.6a1.2 1.2 0 0 0 1.2 1.2h13.6a1.2 1.2 0 0 0 1.2-1.2v-1.6"/>',
  upload: '<path d="M12 20.4V9.2M7.6 13.6 12 9.2l4.4 4.4M4 6.4V4.8A1.2 1.2 0 0 1 5.2 3.6h13.6A1.2 1.2 0 0 1 20 4.8v1.6"/>',
  print: '<path d="M7 8.4V3.6h10v4.8"/><rect x="3.6" y="8.4" width="16.8" height="7.6" rx="1.4"/><path d="M7 13.6h10v6.8H7z"/>',
  star: '<path d="m12 3.6 2.6 5.4 5.8.8-4.2 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.6 9.8l5.8-.8z"/>',
  filter: '<path d="M3.6 5.4h16.8l-6.6 7.6v6l-3.6 1.8v-7.8z"/>',
  grid: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.2"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.2"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.2"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.2"/>',
  list: '<path d="M8.4 6.4h12M8.4 12h12M8.4 17.6h12M3.8 6.4h.01M3.8 12h.01M3.8 17.6h.01"/>',
  dashboard: '<rect x="3.6" y="3.6" width="7.4" height="9" rx="1.2"/><rect x="13" y="3.6" width="7.4" height="5.4" rx="1.2"/><rect x="13" y="11" width="7.4" height="9.4" rx="1.2"/><rect x="3.6" y="14.6" width="7.4" height="5.8" rx="1.2"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.6 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.4 1Z"/>',
  logout: '<path d="M9.4 20.4H5.2a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6h4.2M15.4 16.4 19.8 12l-4.4-4.4M19.8 12H9.4"/>',
  login: '<path d="M14.6 3.6h4.2a1.6 1.6 0 0 1 1.6 1.6v13.6a1.6 1.6 0 0 1-1.6 1.6h-4.2M10 16.4 5.6 12 10 7.6M5.6 12H16"/>',
  'arrow-right': '<path d="M4.4 12h15.2M14 6.4l5.6 5.6-5.6 5.6"/>',
  'arrow-left': '<path d="M19.6 12H4.4M10 6.4 4.4 12l5.6 5.6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.4 4.4v4.4H16"/>',
  camera: '<path d="M3.6 8.4h3.2l1.6-2.4h7.2l1.6 2.4h3.2a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V9.4a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.6" r="3.4"/>',
  image: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2"/><circle cx="8.6" cy="9.8" r="1.6"/><path d="m4 17 5-5 4.4 4.4L16.6 13l3.4 3.4"/>',
  calendar: '<rect x="3.6" y="5.2" width="16.8" height="15.2" rx="2"/><path d="M3.6 10h16.8M8.4 3.2v4M15.6 3.2v4"/>',
  shield: '<path d="M12 3.2 20 6v6c0 4.6-3.4 7.6-8 9-4.6-1.4-8-4.4-8-9V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
  lock: '<rect x="4.8" y="10.4" width="14.4" height="10" rx="2"/><path d="M8.4 10.4V7.6a3.6 3.6 0 1 1 7.2 0v2.8"/>',
  eye: '<path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3"/>',
  chart: '<path d="M4 20V4M4 20h16"/><rect x="7.4" y="12" width="3" height="5"/><rect x="12.6" y="8.4" width="3" height="8.6"/><rect x="17.6" y="14.6" width="3" height="2.4"/>',
  bell: '<path d="M18 15.4V10a6 6 0 1 0-12 0v5.4L4.4 18h15.2z"/><path d="M9.6 18a2.4 2.4 0 0 0 4.8 0"/>',
  file: '<path d="M13.6 3.2H6.8a1.6 1.6 0 0 0-1.6 1.6v14.4a1.6 1.6 0 0 0 1.6 1.6h10.4a1.6 1.6 0 0 0 1.6-1.6V8z"/><path d="M13.6 3.2V8h4.8"/>',
  copy: '<rect x="8.4" y="8.4" width="12" height="12" rx="2"/><path d="M4.4 15.6A2 2 0 0 1 3.6 14V5.6a2 2 0 0 1 2-2H14a2 2 0 0 1 1.6.8"/>',
  scale: '<path d="M12 4v16M6 8h12M6 8l-3 6h6zM18 8l-3 6h6z"/>',
  layers: '<path d="m12 3.4 8.4 4.2L12 11.8 3.6 7.6z"/><path d="m3.6 12 8.4 4.2 8.4-4.2M3.6 16.4 12 20.6l8.4-4.2"/>',
  'external-link': '<path d="M14 4h6v6M20 4l-8.6 8.6"/><path d="M18 14.4v4.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V7.6a1.6 1.6 0 0 1 1.6-1.6h4.4"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 13.6 3.6-3.2"/><circle cx="12" cy="17" r="1.6"/>',
  tree: '<rect x="9" y="3.4" width="6" height="4.4" rx="1"/><rect x="3.4" y="16.2" width="6" height="4.4" rx="1"/><rect x="14.6" y="16.2" width="6" height="4.4" rx="1"/><path d="M12 7.8v4M6.4 16.2v-2.4h11.2v2.4"/>',
  quote: '<path d="M6 3.6h9L19 8v12.4H6z"/><path d="M14.6 3.6V8H19M8.8 12.4h7M8.8 16h4.6"/>',
  sliders: '<path d="M4 7.4h9M17 7.4h3M4 16.6h3M11 16.6h9"/><circle cx="15" cy="7.4" r="2"/><circle cx="9" cy="16.6" r="2"/>',
  database: '<ellipse cx="12" cy="6" rx="7.6" ry="3"/><path d="M4.4 6v12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3V6"/><path d="M4.4 12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3"/>',
  gift: '<rect x="3.4" y="8.6" width="17.2" height="4"/><path d="M4.8 12.6v6.4a1.4 1.4 0 0 0 1.4 1.4h11.6a1.4 1.4 0 0 0 1.4-1.4v-6.4M12 8.6v11.8"/><path d="M12 8.6S10.8 4 8.6 4a2.3 2.3 0 0 0 0 4.6zM12 8.6S13.2 4 15.4 4a2.3 2.3 0 0 1 0 4.6z"/>',
};

const SIZES = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 };

/**
 * @param {string} name clé de l'icône
 * @param {'xs'|'sm'|'md'|'lg'|'xl'|number} [size]
 * @param {object} [attrs] attributs HTML supplémentaires
 * @returns {string} balise <svg>
 */
function icon(name, size = 'md', attrs = {}) {
  const body = PATHS[name] || PATHS.info;
  const px = typeof size === 'number' ? size : SIZES[size] || 20;
  const extra = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;
}

function has(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

module.exports = { icon, has, names: Object.keys(PATHS) };
