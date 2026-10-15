# Guide — Ajouter et gérer les articles

Objectif : enrichir le catalogue **sans développeur**, sans limite de nombre d'articles
fixée dans le code, et sans jamais mettre en vente un article dont le prix ou la
disponibilité n'est pas confirmé.

Toutes les captures d'écran mentales ci-dessous correspondent aux libellés réels de
l'administration : `http://votre-boutique/admin`.

---

## 1. Le menu

| Groupe | Entrée | Usage |
|---|---|---|
| Pilotage | **Tableau de bord** | Chiffres du jour + liste « Mise en route » (informations à confirmer) |
| Pilotage | **Statistiques** | Commandes reçues / ventes encaissées / ventes au comptoir / remboursements |
| Ventes | **Commandes** | Préparer, expédier, encaisser, annuler, rembourser, imprimer |
| Ventes | **Vente en boutique** | Encaisser une vente au comptoir (caisse) |
| Ventes | **Devis à établir** | Commandes en « Livraison sur devis » |
| Ventes | **Encaissements** | Paiements en espèces à confirmer |
| Catalogue | **Produits** | Créer, modifier, dupliquer, publier, archiver |
| Catalogue | **Catégories** | Familles et sous-catégories, renommage, réordonnancement, archivage |
| Catalogue | **Marques** | Marques utilisées par les fiches |
| Catalogue | **Stock** | Quantités, seuils d'alerte, historique des mouvements |
| Catalogue | **Import / export** | Importer depuis Excel/CSV, exporter le catalogue |
| Relation client | **Clients** | Comptes clients et consentements |
| Relation client | **Médiathèque** | Photos téléversées, réutilisables d'une fiche à l'autre |
| Configuration | **Réglages** | Établissement, contacts, apparence, commerce, paiements, livraison, pages, notifications |
| Configuration | **Utilisateurs** | Comptes administrateur / vendeur et habilitation à encaisser |

Deux rôles existent : **administrateur** (tout) et **vendeur** (catalogue, commandes,
stock, caisse, clients, imports, statistiques ; pas les comptes, pas les réglages,
pas les remboursements, pas le journal d'audit). L'encaissement en espèces par un
vendeur nécessite l'habilitation individuelle **« peut confirmer un encaissement »**.

---

## 2. Créer un article (5 minutes)

**Catalogue › Produits › Nouveau produit**

Le formulaire est long, mais **deux champs suffisent** pour enregistrer un brouillon :
le **nom** et, pour le mettre en vente, un **prix** et la case
**« Prix et disponibilité confirmés »**. Tout le reste se complète plus tard.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Identification                                            │
│    Nom du produit *            [Cahier 200 pages format A4  ]│
│    Référence (SKU)             [PAP-CAH-200-A4            ]  │  ← unique, majuscules
│    Catégorie                   [Papeterie et fournitures ▾]  │
│    Sous-catégorie              [Cahiers et registres      ▾]  │
│    Marque                      [Clairefontaine            ]  │
│    URL (slug)                  (générée automatiquement)     │
├──────────────────────────────────────────────────────────────┤
│ 2. Description                                               │
│    Description courte          […500 caractères max       ]  │  ← liste et cartes
│    Description détaillée       [éditeur : gras, listes, …]   │  ← fiche produit
│    Contenu fourni              [1 cahier + 1 règle        ]  │
│    Garantie                    [6 mois                    ]  │
│    État                        (neuf · reconditionné · occasion · lot)
├──────────────────────────────────────────────────────────────┤
│ 3. Prix                                                      │
│    Prix de vente (FCFA) *      [1 500]                       │  ← entier, sans virgule
│    Prix de référence barré     [1 800]                       │  ← facultatif
│    Prix promotionnel           [1 200]                       │  ← doit être < prix
│    Promotion du                [01/11/2026] au [30/11/2026]  │  ← datée, donc expirable
├──────────────────────────────────────────────────────────────┤
│ 4. Stock                                                     │
│    Suivre le stock             [✓]                           │  ← décoché = sur commande
│    Quantité en stock           [40]                          │
│    Seuil d'alerte              [5]                           │  ← alerte Tableau de bord
│    Unité de vente              (pièce · lot · paquet · rame · carton · autre)
│    Libellé d'unité             [la rame]                     │
│    Poids (g) / L × l × H (cm)  [320] [30] [21] [2]           │  ← sert aux frais de livraison
├──────────────────────────────────────────────────────────────┤
│ 5. Publication                                               │
│    Statut                      (brouillon · publié · archivé)│
│    Prix et disponibilité confirmés [✓]  ← OBLIGATOIRE pour vendre
│    Mettre en avant             [ ]                           │
│    Titre SEO / Description SEO […]                           │
└──────────────────────────────────────────────────────────────┘
```

### Ce que l'application vérifie pour vous

| Règle | Effet |
|---|---|
| Référence déjà utilisée | Refus immédiat : « La référence … existe déjà » |
| Prix vide ou nul | L'article est **enregistré en brouillon**, jamais publié |
| « Prix et disponibilité confirmés » non coché | L'article existe mais **n'est pas achetable** : la fiche affiche *Indisponible à la vente* |
| Prix promotionnel ≥ prix de vente | Refus : « Le prix promotionnel doit être inférieur au prix de vente » |
| Fin de promotion avant son début | Refus |
| Statut **publié** | En ligne dès maintenant, indexé dans la recherche |
| Statut **archivé** | Retiré de la vitrine, conservé pour l'historique des commandes |

> **Règle métier importante** : un article pris en photo en boutique mais dont le prix,
> la référence ou la disponibilité ne sont pas confirmés **ne doit pas être mis en
> vente**. Enregistrez-le en brouillon, sans cocher la confirmation : il est prêt à
> être complété, invisible pour les clients.

---

## 3. Les photos

**Fiche produit › Images** (ou directement dans le formulaire de création).

1. Cliquez sur **Ajouter des images** — JPEG, PNG, WebP ou AVIF, 8 Mo par fichier.
2. Chaque image est **redimensionnée et convertie en WebP** par le serveur : quatre
   tailles sont produites (`tiny`, `thumb`, `medium`, `large`) et servies selon
   l'écran, avec repli JPEG. Aucune image d'origine n'est envoyée telle quelle au
   visiteur mobile.
3. **Définir comme image principale** choisit la photo affichée dans les listes.
4. Les flèches **Réordonner** fixent l'ordre de la galerie.
5. **Supprimer** retire le fichier du disque et de la base.

Les images sont stockées sur le disque du serveur (`MEDIA_DIR`), jamais dans la base,
et servies avec un cache navigateur de 90 jours. Une référence d'image inconnue
renvoie une image de substitution (statut 200) : aucune vignette cassée en vitrine.

---

## 4. Variantes (couleur, capacité, modèle, taille…)

**Fiche produit › Variantes › Ajouter une variante**

Une variante porte : ses **options** (ex. `Couleur : Bleu`, `Capacité : 128 Go`),
une **référence** propre, un **prix** propre (facultatif : sinon le prix de la fiche
s'applique), un **poids** propre et une **quantité** suivie séparément.

```
Variante 1  Couleur [Bleu ]  Capacité [32 Go]  Réf [USB-32-BLEU]  Prix [5 000]  Stock [12]
Variante 2  Couleur [Bleu ]  Capacité [64 Go]  Réf [USB-64-BLEU]  Prix [7 500]  Stock [ 4]
Variante 3  Couleur [Noir ]  Capacité [32 Go]  Réf [USB-32-NOIR]  Prix [5 000]  Stock [ 0]  ← rupture
```

En vitrine, le client choisit la variante avant d'ajouter au panier ; une variante
épuisée est grisée. La fourchette de prix (« à partir de 5 000 FCFA ») est calculée
sur les variantes actives.

---

## 5. Kits et lots scolaires

Un **kit** est un article composé d'autres articles déjà existants.

1. Cochez **Cet article est un kit**.
2. Dans **Composants du kit**, ajoutez chaque composant : article + quantité.
3. Enregistrez.

Le stock d'un kit est **dérivé** : le suivi propre du kit est désactivé et la
disponibilité affichée vaut le nombre de lots complets possibles.

```
Kit « Rentrée primaire »  (composants : 2 cahiers 96 p., 1 trousse, 1 lot de stylos)
  cahiers 96 p.   → 120 disponibles / 2 par kit = 60
  trousse         →  18 disponibles / 1 par kit = 18
  lot de stylos   →  25 disponibles / 1 par kit = 25
                                          disponibilité du kit = 18 lots
```

Conséquence volontaire : vendre un kit décrémente **chacun** de ses composants, et un
composant manquant bloque la vente du kit plutôt que de vendre du vent.

---

## 6. Caractéristiques propres à la catégorie

**Réglages › …** non : **Catalogue › Catégories › Attributs** définit, par catégorie,
les caractéristiques proposées (ex. pour *Cahiers et registres* : `Format`, `Nombre de
pages`, `Réglure`, `Grammage`). Ces modèles apparaissent ensuite dans la fiche produit,
où chaque attribut se remplit par une ligne `Intitulé : Valeur`.

En import, la même information s'écrit dans une cellule : `Format:A4;Pages:200`.

---

## 7. Modifier, dupliquer, publier en masse

### Dupliquer

**Fiche produit › Dupliquer** crée une copie (brouillon, référence suffixée) : pratique
pour une déclinaison d'un même article (autre format, autre couleur) sans tout ressaisir.

### Modifications en masse

**Catalogue › Produits**, cochez plusieurs lignes puis **Actions sur la sélection** :

| Action | Champs |
|---|---|
| Changer le statut | brouillon / publié / archivé |
| Changer la catégorie | catégorie cible |
| Ajuster les prix | prix fixe · augmentation/diminution en FCFA · pourcentage · arrondi (ex. à 50 FCFA) |
| Ajuster le stock | variation (+20, −5) appliquée avec historique |
| Changer le seuil d'alerte | valeur |
| Confirmer / déconfirmer les données | case « Prix et disponibilité confirmés » |
| Activer / désactiver le suivi de stock | case |
| Mettre en avant / retirer | accueil et tête de catégorie |
| Changer la marque | marque |

Chaque opération en masse est **journalisée** (qui, quand, quoi).

### Publier un article préparé à l'avance

Un article importé en brouillon se publie en deux clics : ouvrez la fiche, vérifiez le
prix et la disponibilité, cochez **« Prix et disponibilité confirmés »**, choisissez le
statut **Publié**, enregistrez. Sans cette confirmation, la publication est refusée.

---

## 8. Le stock au quotidien

**Catalogue › Stock** liste les quantités par article et par variante, avec le seuil
d'alerte et les articles en rupture.

- **Ajuster** : saisissez la nouvelle quantité physique et un **motif**
  (réapprovisionnement, casse, inventaire, correction, import…). Chaque ajustement
  écrit une ligne d'historique avec quantité avant/après, auteur, date et motif.
- **Mouvements** (`Catalogue › Stock › Mouvements`) : le journal complet, filtrable.

Règles appliquées partout dans l'application :

```
disponible = quantité physique − quantité réservée
```

- Un **panier** réserve ses articles 15 minutes (réglable `CART_RESERVATION_MINUTES`).
- Une **commande en attente de paiement** les réserve 90 minutes
  (`ORDER_RESERVATION_MINUTES`), puis la réservation expire et le stock redevient
  disponible.
- Le **stock sort** réellement à l'encaissement confirmé (espèces validées par un
  utilisateur habilité, ou notification de paiement signée par la passerelle).
- Une **annulation** restitue le stock (case « remettre les articles en stock »).
- Deux clients qui se disputent le **dernier exemplaire** : un seul obtient la
  commande, l'autre reçoit un refus explicite. Aucune survente n'est possible
  (vérifié par test de concurrence).
- Un article dont le **suivi de stock est désactivé** s'affiche
  « Disponible sur commande » et ne bloque jamais une vente.

---

## 9. Avant de publier : la liste de contrôle

Le **Tableau de bord › Mise en route** affiche en permanence ce qui manque
(8 points). Un article est prêt à vendre quand :

- [ ] le **nom** est parlant pour un client, pas seulement pour vous ;
- [ ] la **référence** est unique et correspond à votre inventaire ;
- [ ] le **prix** est saisi en FCFA entiers (pas de virgule, pas de centimes) ;
- [ ] la **catégorie** est la bonne (la navigation et la recherche en dépendent) ;
- [ ] la **quantité** correspond à ce qui est réellement en rayon ;
- [ ] au moins **une photo** est en place (sinon une vignette neutre s'affiche) ;
- [ ] la case **« Prix et disponibilité confirmés »** est cochée ;
- [ ] le **statut** est *Publié*.
