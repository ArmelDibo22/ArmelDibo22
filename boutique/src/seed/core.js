'use strict';

/**
 * Initialisation des données RÉELLES de configuration.
 *
 * Ce seed ne crée AUCUN produit : le catalogue est renseigné par l'exploitant
 * (formulaire ou import). Les produits de démonstration vivent dans une base
 * séparée (`npm run seed:demo`).
 *
 * Aucune information non confirmée n'est inventée : adresse précise, horaires et
 * numéros secondaires restent vides et sont signalés « à compléter ».
 */

const db = require('../db');
const settings = require('../lib/settings');
const security = require('../lib/security');
const dates = require('../lib/dates');
const categories = require('../domain/categories');
const config = require('../config');

const CATEGORY_TREE = [
  {
    name: 'Papeterie et fournitures scolaires',
    slug: 'papeterie-fournitures-scolaires',
    description: 'Cahiers, stylos, papier, classement et matériel scolaire.',
    children: [
      { name: 'Cahiers et registres', slug: 'cahiers-registres' },
      { name: 'Écriture et correction', slug: 'ecriture-correction' },
      { name: 'Papier et impression', slug: 'papier-impression' },
      { name: 'Classement et archives', slug: 'classement-archives' },
      { name: 'Fournitures scolaires', slug: 'fournitures-scolaires' },
      { name: 'Dessin et travaux manuels', slug: 'dessin-travaux-manuels' },
      { name: 'Kits scolaires', slug: 'kits-scolaires' },
    ],
    attributes: [
      { key: 'format', label: 'Format', type: 'select', options: ['A4', 'A5', 'A6', 'A3', '21 x 29,7 cm', '17 x 22 cm', 'Autre'] },
      { key: 'pages', label: 'Nombre de pages', type: 'number', unit: 'pages' },
      { key: 'grammage', label: 'Grammage', type: 'number', unit: 'g/m²' },
      { key: 'reglure', label: 'Réglure', type: 'select', options: ['Seyès (grands carreaux)', 'Petits carreaux', 'Lignes simples', 'Uni', 'Pointillés'] },
      { key: 'quantite_par_paquet', label: 'Quantité par paquet', type: 'number', unit: 'pièces' },
      { key: 'couleur', label: 'Couleur', type: 'text' },
      { key: 'matiere', label: 'Matière', type: 'text' },
    ],
  },
  {
    name: 'Informatique et accessoires',
    slug: 'informatique-accessoires',
    description: 'Ordinateurs, périphériques, stockage et consommables.',
    children: [
      { name: 'Ordinateurs portables', slug: 'ordinateurs-portables' },
      { name: 'Clés USB et stockage', slug: 'cles-usb-stockage' },
      { name: 'Claviers et souris', slug: 'claviers-souris' },
      { name: 'Réseaux et connectique', slug: 'reseaux-connectique' },
      { name: 'Imprimantes et consommables', slug: 'imprimantes-consommables' },
      { name: 'Accessoires PC', slug: 'accessoires-pc' },
    ],
    attributes: [
      { key: 'capacite', label: 'Capacité de stockage', type: 'text', unit: '' },
      { key: 'ram', label: 'Mémoire vive', type: 'text' },
      { key: 'processeur', label: 'Processeur', type: 'text' },
      { key: 'ecran', label: "Taille d'écran", type: 'number', unit: 'pouces' },
      { key: 'connectique', label: 'Connectique', type: 'text' },
      { key: 'compatibilite', label: 'Compatibilité', type: 'text' },
      { key: 'couleur', label: 'Couleur', type: 'text' },
      { key: 'garantie_constructeur', label: 'Garantie constructeur', type: 'text' },
    ],
  },
  {
    name: 'Téléphones et accessoires',
    slug: 'telephones-accessoires',
    description: 'Téléphones, chargeurs, écouteurs, protections et énergie nomade.',
    children: [
      { name: 'Téléphones et smartphones', slug: 'telephones-smartphones' },
      { name: 'Chargeurs et câbles', slug: 'chargeurs-cables' },
      { name: 'Écouteurs et audio', slug: 'ecouteurs-audio' },
      { name: 'Coques et protections', slug: 'coques-protections' },
      { name: 'Batteries externes', slug: 'batteries-externes' },
      { name: 'Accessoires téléphone', slug: 'accessoires-telephone' },
    ],
    attributes: [
      { key: 'capacite', label: 'Capacité', type: 'select', options: ['16 Go', '32 Go', '64 Go', '128 Go', '256 Go', '512 Go'] },
      { key: 'ram', label: 'Mémoire vive', type: 'text' },
      { key: 'ecran', label: "Taille d'écran", type: 'number', unit: 'pouces' },
      { key: 'batterie', label: 'Batterie', type: 'number', unit: 'mAh' },
      { key: 'sim', label: 'Nombre de SIM', type: 'select', options: ['1 SIM', '2 SIM (double SIM)'] },
      { key: 'reseau', label: 'Réseau', type: 'select', options: ['2G', '3G', '4G', '4G+', '5G'] },
      { key: 'couleur', label: 'Couleur', type: 'text' },
      { key: 'systeme', label: "Système d'exploitation", type: 'text' },
      { key: 'puissance', label: 'Puissance', type: 'text', unit: 'W' },
    ],
  },
];

const SHIPPING_ZONES = [
  {
    code: 'retrait-boutique',
    name: 'Retrait en boutique — Daoukro',
    kind: 'pickup',
    enabled: 1,
    position: 1,
    requires_quote: 0,
    free_over: null,
    eta_text: 'Retrait après confirmation de la commande, aux horaires d’ouverture.',
    conditions_text: 'Présenter la référence de commande et une pièce d’identité. Aucun frais de retrait.',
    cod_allowed: 1,
  },
  {
    code: 'daoukro',
    name: 'Livraison à Daoukro',
    kind: 'local',
    enabled: 1,
    position: 2,
    // Aucun tarif confirmé à ce jour : la zone reste « sur devis » jusqu'à saisie
    // d'un tarif réel. Elle n'est jamais présentée comme une livraison gratuite.
    requires_quote: 1,
    free_over: null,
    eta_text: 'Délai à confirmer lors du devis.',
    conditions_text: 'Livraison à Daoukro : ville, quartier, adresse et point de repère demandés.',
    cod_allowed: 1,
  },
  {
    code: 'iffou',
    name: 'Livraison région de l’Iffou',
    kind: 'region',
    enabled: 1,
    position: 3,
    requires_quote: 1,
    free_over: null,
    eta_text: 'Délai à confirmer lors du devis.',
    conditions_text: 'Hors Daoukro, dans la région de l’Iffou. Montant de la livraison convenu avant paiement.',
    cod_allowed: 0,
  },
  {
    code: 'cote-divoire',
    name: 'Expédition — reste de la Côte d’Ivoire',
    kind: 'national',
    enabled: 1,
    position: 4,
    requires_quote: 1,
    free_over: null,
    eta_text: 'Délai à confirmer selon le transporteur retenu.',
    conditions_text: 'Expédition par transporteur. Référence de suivi enregistrée dès la prise en charge.',
    cod_allowed: 0,
  },
];

const PAYMENT_METHODS = [
  {
    code: 'pay_at_pickup',
    name: 'Paiement au retrait',
    kind: 'cash',
    enabled: 1,
    position: 1,
    modes: ['pickup'],
    zone_codes: [],
    instructions:
      'Vous réglez en boutique au moment du retrait. L’encaissement est confirmé par un membre habilité de l’équipe.',
    merchant_ref: '',
    color: '#1F7A4D',
  },
  {
    code: 'pay_on_delivery',
    name: 'Paiement à la livraison',
    kind: 'cash',
    enabled: 0, // à activer une fois les zones et conditions du transporteur définies
    position: 2,
    modes: ['delivery'],
    zone_codes: [],
    instructions:
      'Disponible uniquement pour les zones et transporteurs qui l’autorisent. L’encaissement est confirmé à la remise du colis.',
    merchant_ref: '',
    color: '#1F7A4D',
  },
  {
    code: 'wave',
    name: 'Wave',
    kind: 'mobile_money',
    enabled: 0,
    position: 3,
    modes: ['pickup', 'delivery'],
    zone_codes: [],
    instructions:
      'Paiement Mobile Money Wave. À activer après ouverture du compte marchand et branchement de la passerelle.',
    merchant_ref: '',
    color: '#1BA5E4',
  },
  {
    code: 'orange_money',
    name: 'Orange Money',
    kind: 'mobile_money',
    enabled: 0,
    position: 4,
    modes: ['pickup', 'delivery'],
    zone_codes: [],
    instructions:
      'Paiement Mobile Money Orange Money. À activer après obtention des identifiants marchand API.',
    merchant_ref: '',
    color: '#FF7900',
  },
  {
    code: 'mtn_momo',
    name: 'MTN MoMo',
    kind: 'mobile_money',
    enabled: 0,
    position: 5,
    modes: ['pickup', 'delivery'],
    zone_codes: [],
    instructions:
      'Paiement Mobile Money MTN MoMo. À activer après obtention de la clé d’abonnement marchand.',
    merchant_ref: '',
    color: '#FFCC00',
  },
  {
    code: 'moov_money',
    name: 'Moov Money',
    kind: 'mobile_money',
    enabled: 0,
    position: 6,
    modes: ['pickup', 'delivery'],
    zone_codes: [],
    instructions:
      'Paiement Mobile Money Moov Money. À activer après obtention des accès marchand.',
    merchant_ref: '',
    color: '#005BAA',
  },
];

const PAGES = [
  {
    slug: 'livraison-retours',
    title: 'Livraison et retours',
    position: 1,
    body: `<h2>Retrait en boutique</h2>
<p>Vos articles peuvent être retirés directement chez <strong>ETS LE PRIVILÈGE</strong> à Daoukro. Le retrait est gratuit. Présentez la référence de votre commande ainsi qu'une pièce d'identité.</p>
<h2>Zones de livraison</h2>
<ul>
  <li>Daoukro (ville)</li>
  <li>Région de l'Iffou</li>
  <li>Reste de la Côte d'Ivoire (expédition par transporteur)</li>
</ul>
<h2>Frais et délais</h2>
<p>Les frais et délais dépendent de la destination, du poids et du volume du colis. Lorsqu'aucun tarif n'est encore défini pour votre destination, la commande est enregistrée comme <strong>demande de devis</strong> : nous vous contactons au téléphone indiqué pour convenir du montant définitif. <strong>Aucun paiement n'est demandé avant votre accord sur ce montant.</strong></p>
<p class="notice">Tarifs et délais exacts : <em>à compléter et à valider par l'exploitant</em> (Administration › Réglages › Livraison).</p>
<h2>Suivi</h2>
<p>Chaque commande dispose d'un lien de suivi privé. Le transporteur et la référence de suivi sont enregistrés dès la prise en charge du colis.</p>
<h2>Retours et réclamations</h2>
<p>Signalez toute anomalie (article manquant, endommagé ou non conforme) dès la réception. Les conditions de retour, le délai et la prise en charge des frais sont <em>à définir et à valider</em> avant publication définitive.</p>
<p class="notice">Délai de réclamation : <strong>{{À COMPLÉTER}}</strong> — Conditions de reprise : <strong>{{À COMPLÉTER}}</strong>.</p>`,
  },
  {
    slug: 'confidentialite',
    title: 'Politique de confidentialité',
    position: 2,
    body: `<h2>Données collectées</h2>
<p>Pour traiter une commande, nous collectons : nom, numéro de téléphone, et selon le mode de réception, la ville, le quartier, l'adresse et un point de repère. L'adresse e-mail n'est demandée que si elle est utile au suivi.</p>
<h2>Finalités</h2>
<ul>
  <li>Traitement, préparation, livraison ou mise à disposition de votre commande</li>
  <li>Information sur le suivi de votre commande</li>
  <li>Obligations comptables et légales</li>
</ul>
<h2>Consentement marketing</h2>
<p>L'envoi d'offres et d'informations commerciales fait l'objet d'un <strong>consentement distinct et facultatif</strong>. Il peut être retiré à tout moment.</p>
<h2>Paiements</h2>
<p><strong>Aucune donnée de carte bancaire n'est collectée ni conservée</strong> sur ce site. Les paiements Mobile Money sont traités par les prestataires concernés ; nous ne recevons que la confirmation du paiement, son montant et sa référence.</p>
<h2>Durée de conservation</h2>
<p>Les données de commande sont conservées pour la durée légale applicable. <em>Durée exacte à valider : {{À COMPLÉTER}}</em>.</p>
<h2>Vos droits</h2>
<p>Vous pouvez demander l'accès, la rectification ou la suppression de vos données en contactant la boutique (page Contact).</p>
<p class="notice">Ce document est une base de travail : il doit être relu, complété et validé avant mise en service commerciale.</p>`,
  },
  {
    slug: 'conditions',
    title: 'Conditions générales de vente',
    position: 3,
    body: `<h2>Objet</h2>
<p>Les présentes conditions régissent les ventes réalisées par <strong>ETS LE PRIVILÈGE DAOUKRO</strong> (Daoukro, région de l'Iffou, Côte d'Ivoire).</p>
<h2>Prix</h2>
<p>Les prix sont indiqués en francs CFA (XOF), toutes taxes comprises le cas échéant. Les prix applicables sont ceux affichés au moment de la validation de la commande, recalculés par nos serveurs.</p>
<h2>Disponibilité</h2>
<p>Un article n'est proposé à la vente que si son prix et sa disponibilité ont été confirmés. En cas d'indisponibilité après commande, vous êtes contacté pour un remplacement, un avoir ou un remboursement.</p>
<h2>Commande</h2>
<p>La commande peut être passée sans création de compte. Elle est ferme après confirmation du paiement ou, pour les paiements à la réception, après acceptation explicite de la commande par la boutique.</p>
<h2>Livraison sur devis</h2>
<p>Lorsque les frais de livraison ne sont pas connus, la commande est transmise comme demande de devis. Le paiement n'intervient qu'après votre accord écrit sur le montant définitif.</p>
<h2>Garanties et service après-vente</h2>
<p>Les garanties éventuelles sont précisées sur chaque fiche produit. <em>Conditions de garantie à compléter : {{À COMPLÉTER}}</em>.</p>
<h2>Informations légales de l'établissement</h2>
<p>Numéro RCCM / compte contribuable : <strong>{{À COMPLÉTER}}</strong>.</p>
<p class="notice">Document à faire relire et valider par l'exploitant, et le cas échéant par un conseil juridique, avant publication définitive.</p>`,
  },
  {
    slug: 'mentions-legales',
    title: 'Mentions légales',
    position: 4,
    body: `<h2>Éditeur</h2>
<p><strong>ETS LE PRIVILÈGE DAOUKRO</strong><br>Daoukro, région de l'Iffou, Côte d'Ivoire.</p>
<p>Immatriculation : <strong>{{À COMPLÉTER}}</strong><br>Responsable de la publication : <strong>{{À COMPLÉTER}}</strong></p>
<h2>Hébergement</h2>
<p>Hébergeur : <strong>{{À COMPLÉTER}}</strong>.</p>
<h2>Données personnelles</h2>
<p>Voir la politique de confidentialité.</p>`,
  },
];

function seedCore({ admin = null, verbose = true } = {}) {
  const log = (...args) => verbose && console.log(...args);
  db.migrate();
  settings.ensureDefaults();

  // --- Catégories ---------------------------------------------------------
  let createdCategories = 0;
  for (const family of CATEGORY_TREE) {
    let parent = db.get('SELECT * FROM categories WHERE slug = ?', [family.slug]);
    if (!parent) {
      parent = categories.create({
        name: family.name,
        slug: family.slug,
        description: family.description,
      });
      createdCategories += 1;
    }
    for (const [index, attr] of (family.attributes || []).entries()) {
      const existing = db.get('SELECT id FROM attribute_templates WHERE category_id = ? AND key = ?', [parent.id, attr.key]);
      if (!existing) {
        categories.saveAttributeTemplate(parent.id, { ...attr, position: index });
      }
    }
    (family.children || []).forEach((child, index) => {
      const existing = db.get('SELECT * FROM categories WHERE slug = ?', [child.slug]);
      if (!existing) {
        categories.create({ name: child.name, slug: child.slug, parentId: parent.id, position: index + 1 });
        createdCategories += 1;
      }
    });
  }
  log(`  catégories : ${createdCategories} créée(s)`);

  // --- Zones de livraison --------------------------------------------------
  let createdZones = 0;
  for (const zone of SHIPPING_ZONES) {
    const existing = db.get('SELECT id FROM shipping_zones WHERE code = ?', [zone.code]);
    if (!existing) {
      db.insert('shipping_zones', zone);
      createdZones += 1;
    }
  }
  log(`  zones de livraison : ${createdZones} créée(s)`);

  // --- Moyens de paiement --------------------------------------------------
  let createdMethods = 0;
  for (const method of PAYMENT_METHODS) {
    const existing = db.get('SELECT id FROM payment_methods WHERE code = ?', [method.code]);
    const row = {
      ...method,
      modes: JSON.stringify(method.modes),
      zone_codes: JSON.stringify(method.zone_codes),
      configured: 0,
      simulated: 1,
    };
    if (!existing) {
      db.insert('payment_methods', row);
      createdMethods += 1;
    }
  }
  log(`  moyens de paiement : ${createdMethods} créé(s)`);

  // --- Pages légales -------------------------------------------------------
  let createdPages = 0;
  for (const page of PAGES) {
    const existing = db.get('SELECT id FROM pages WHERE slug = ?', [page.slug]);
    if (!existing) {
      db.insert('pages', {
        slug: page.slug,
        title: page.title,
        body: page.body,
        published: 1,
        needs_review: 1,
        position: page.position,
      });
      createdPages += 1;
    }
  }
  log(`  pages : ${createdPages} créée(s)`);

  // --- Compte administrateur ----------------------------------------------
  const adminEmail = (admin?.email || config.bootstrapAdmin.email || '').toLowerCase();
  let adminUser = db.get('SELECT * FROM users WHERE email = ?', [adminEmail]);
  if (!adminUser) {
    const password = admin?.password || config.bootstrapAdmin.password;
    if (!password) {
      log('  administrateur : non créé (ADMIN_PASSWORD absent du .env)');
    } else {
      const problems = security.passwordIssues(password);
      if (problems.length) {
        log(`  administrateur : non créé — mot de passe insuffisant (${problems.join(', ')})`);
      } else {
        const id = db.insert('users', {
          email: adminEmail,
          full_name: admin?.name || config.bootstrapAdmin.name || 'Administrateur',
          password_hash: security.hashPassword(password),
          role: 'admin',
          active: 1,
          can_confirm_cash: 1,
        });
        adminUser = db.get('SELECT * FROM users WHERE id = ?', [id]);
        log(`  administrateur : créé (${adminEmail})`);
      }
    }
  } else {
    log(`  administrateur : déjà présent (${adminEmail})`);
  }

  // --- Marqueur d'environnement -------------------------------------------
  db.setMeta('environment', config.isDemo ? 'demo' : 'production-data');
  db.setMeta('seeded_at', dates.nowIso());
  db.setMeta('schema', '1.0.0');

  return { adminUser };
}

module.exports = { seedCore, CATEGORY_TREE, SHIPPING_ZONES, PAYMENT_METHODS, PAGES };
