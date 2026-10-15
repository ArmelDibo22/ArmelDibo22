# Plan de réalisation — Boutique ETS LE PRIVILÈGE DAOUKRO

## Contraintes d'environnement constatées
| Élément | Constat | Conséquence |
| --- | --- | --- |
| Dépôt | README de profil personnel uniquement, 1 commit | Application créée dans `boutique/`, README racine complété d'un lien |
| Runtime | Node.js v22.22.3, npm 10.9.8, Debian 12, 2 vCPU / 3,8 Go | Pas de chaîne de build front, rendu serveur |
| Réseau sortant | github.com, registry.npmjs.org, pypi.org uniquement | **Google Maps inaccessible** → aucune donnée inventée ; tout est configurable |
| Base de données | Aucun serveur PostgreSQL/MySQL/Redis présent | SQLite persistant via le module natif `node:sqlite` (WAL) |

## Choix d'architecture (justifié dans `docs/architecture.md`)
Node.js 22 + Express 5 + EJS (rendu serveur), SQLite `node:sqlite`, `sharp` (images),
`exceljs` (imports .xlsx), `multer` (téléversements), `node:test` (tests).
Zéro build front : CSS/JS vanilla servis en statique.

## Étapes
1. Socle : configuration, base de données, migrations, réglages typés, authentification, RBAC, CSRF, limites de débit, journal d'audit.
2. Catalogue : catégories arborescentes, marques, produits, variantes, attributs par catégorie, images multi-tailles, kits.
3. Stock : `stock_items` + `stock_movements`, réservations avec expiration, transactions anti-survente.
4. Panier & commande : panier serveur, tunnel invité/compte, retrait & livraison, devis de livraison.
5. Paiements : registre de moyens activables, passerelle générique, webhooks HMAC idempotents, encaissements manuels confirmés par un utilisateur autorisé.
6. Administration : catalogue, médias, commandes, stock, ventes physiques, retours/remboursements, clients, imports/exports, réglages, statistiques.
7. Imports : .xlsx/.csv, modèle téléchargeable, mapping de colonnes, aperçu, validation, doublons, création/mise à jour par référence, lots avec progression, rapport.
8. Interface publique : design blanc / bleu marine / doré, mobile d'abord, états de chargement/vide/erreur.
9. Tests : parcours essentiels automatisés (`npm test`).
10. Livrables : `.env.example`, modèle d'import, guide, sauvegarde/restauration, déploiement, bilan.

## Règles de probité appliquées
- Aucune information non confirmée n'est inventée (horaires, adresse précise, numéros secondaires).
- Aucun faux témoignage, compteur, compte à rebours ni promotion artificielle.
- Les tarifs de livraison inconnus ne sont jamais présentés comme gratuits → « Livraison sur devis ».
- Les API de paiement non vérifiables depuis cet environnement ne sont pas simulées comme réelles :
  elles sont laissées à l'état `NOT_CONFIGURED` avec le point d'intégration documenté.
- Les données de démonstration vivent dans une base distincte de la base réelle.
