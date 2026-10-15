# Dibo Kouassi Armel

**Technicien informatique & GSM · Support, systèmes et réseaux · IA appliquée · Communication numérique**

📍 Daoukro, Côte d’Ivoire

## À propos

J’associe le support informatique, le dépannage GSM et la communication numérique pour répondre à des besoins concrets : accompagner les utilisateurs, entretenir les équipements, organiser les documents et produire des supports clairs.

Je m’intéresse particulièrement à l’utilisation de l’intelligence artificielle et de l’automatisation pour simplifier les tâches répétitives. Ce profil accueillera progressivement mes ressources pratiques, mes démonstrations et mes projets documentés.

## Mes domaines de pratique

| Domaine | Activités et connaissances |
| --- | --- |
| Support informatique | Diagnostic, maintenance de postes Windows, assistance aux utilisateurs et dépannage matériel et logiciel. |
| Systèmes et réseaux | Bases de Linux, TCP/IP, DHCP et DNS ; organisation des sauvegardes et sensibilisation à la sécurité informatique. |
| Services GSM | Diagnostic de smartphones, assistance logicielle et accompagnement des utilisateurs. |
| Bureautique et documents | Mise en forme Word, traitement de listes Excel, préparation de documents et gestion de fichiers. |
| IA et communication | Utilisation d’outils d’IA générative, création de supports visuels et montage vidéo. |

## Ma façon de travailler

- Comprendre le besoin avant de choisir l’outil.
- Avancer par étapes et vérifier le résultat.
- Documenter les procédures pour faciliter leur réutilisation.
- Rendre les explications accessibles aux utilisateurs.

## Projet livré — Boutique en ligne ETS LE PRIVILÈGE DAOUKRO

Application e-commerce complète et fonctionnelle, développée pour un établissement de
Daoukro (région de l'Iffou, Côte d'Ivoire) : catalogue, commandes avec ou sans compte,
retrait en boutique ou livraison, paiement Mobile Money ou en espèces, et une
administration permettant de gérer le catalogue, le stock, les commandes et les
encaissements **sans compétence technique**.

Code et documentation : [`boutique/`](boutique) · Documentation : [`boutique/docs/`](boutique/docs)

| | |
| --- | --- |
| Stack | Node.js 22, Express 5, EJS, SQLite natif (WAL), CSS/JS vanilla, `sharp`, `exceljs` — sans étape de construction |
| Vérification | **82 tests automatisés**, **74 contrôles d'installation**, **121 vérifications du parcours métier réel** en HTTP, **0 erreur serveur** |
| Catalogue | 3 familles, catégories et sous-catégories modifiables, variantes, kits, promotions datées, **aucune limite codée au nombre d'articles** |
| Import | Assistant Excel/CSV : modèle téléchargeable, association des colonnes, aperçu sans écriture, exécution par lots, **rapport ligne par ligne**, modifications en masse |
| Livraison | Retrait, Daoukro, région de l'Iffou, reste du pays ; frais inconnus ⇒ **« Livraison sur devis »** avec accord du client, jamais « offert » |
| Paiements | Wave, Orange Money, MTN MoMo, Moov Money, espèces au retrait et à la livraison ; **aucune API inventée** : seul un paiement validé par une notification serveur signée, contrôlée en montant et en devise et dédupliquée fait foi |
| Sécurité | Rôles administrateur/vendeur, journal d'audit, jetons hachés, protection anti-survente et anti-double-commande, aucune donnée de carte stockée, consentement marketing distinct |
| Honnêteté des données | **Rien d'inventé** : adresse, horaires, logo, tarifs et textes légaux restent à confirmer et sont signalés « à compléter » ; le jeu de démonstration vit dans une base séparée |

Démarrer la démonstration :

```bash
cd boutique
npm ci --no-audit --no-fund && cp .env.example .env
npm run migrate && npm run reset:demo
DEMO=true PORT=3000 npm start      # boutique sur http://localhost:3000, administration sur /admin
npm run check                      # 74 vérifications
DEMO=true npm run journey -- --url http://127.0.0.1:3000   # 121 vérifications du métier réel
```

Documentation : [ajouter des articles](boutique/docs/guide-articles.md) ·
[importer un catalogue](boutique/docs/guide-import.md) ·
[installation, sauvegarde, déploiement](boutique/docs/installation-exploitation.md) ·
[schéma de données](boutique/docs/schema-donnees.md) ·
[services à connecter et coûts](boutique/docs/services-et-couts.md) ·
[rapport de tests](boutique/docs/rapport-de-tests.md) ·
[ce qui fonctionne / est simulé / attend une configuration](boutique/docs/etat-des-lieux.md)

## Axes de développement du portfolio

Les premiers contenus que je souhaite documenter porteront sur :

1. Des procédures de maintenance et de dépannage informatique.
2. Des exemples d’automatisation de documents avec des données de démonstration.
3. Des guides pratiques de sauvegarde et d’organisation des fichiers.
4. Des démonstrations d’IA appliquée à la communication numérique.

## Formation continue

Je consolide mes connaissances en administration système, réseaux, cybersécurité, support technique et outils d’intelligence artificielle.

---

**Mon objectif : transformer mes compétences pratiques en ressources utiles, claires et reproductibles.**
