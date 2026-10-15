'use strict';

/** Initialise la configuration RÉELLE de la boutique (aucun produit de test). */

const db = require('../src/db');
const { seedCore } = require('../src/seed/core');

console.log('— Initialisation des données de configuration —');
db.migrate();
seedCore();
console.log('Terminé. Base :', require('../src/config').db.path);
console.log(
  "\nProchaines étapes : lancer `npm start`, ouvrir /admin, changer le mot de passe\npuis compléter Réglages › Établissement (adresse, horaires) et › Livraison (tarifs)."
);
