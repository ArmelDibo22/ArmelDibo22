# Guide — Importer et exporter le catalogue

Pour passer d'un fichier Excel (ou d'une liste papier saisie dans Excel) à un
catalogue en ligne, **sans ressaisir article par article**.

Chemin : **Catalogue › Import / export**.

---

## 1. Le principe en quatre écrans

```
   ① Téléverser            ② Associer les colonnes        ③ Aperçu                ④ Exécution
 ┌────────────────┐      ┌──────────────────────────┐   ┌────────────────────┐   ┌──────────────────┐
 │  mon-catalogue │      │ Référence     → sku      │   │ 210 lignes lues    │   │ Lot 1/5   ████░  │
 │      .xlsx     │ ───▶ │ Nom produit   → name     │──▶│  198 créations     │──▶│ Lot 2/5   ██████ │
 │  ou .csv       │      │ Prix (FCFA)   → price    │   │    8 mises à jour  │   │ …                │
 │                │      │ Stock       → qty        │   │    4 rejets        │   │                  │
 └────────────────┘      │ (rien)        → ignoré   │   │ AUCUNE ÉCRITURE    │   │ Rapport final    │
                         └──────────────────────────┘   └────────────────────┘   └──────────────────┘
```

**L'aperçu n'écrit rien.** Vous pouvez changer d'avis, changer de mode, corriger le
fichier et recommencer : le catalogue n'est touché qu'à l'étape ④.

---

## 2. Le modèle à télécharger

Deux formats, mêmes colonnes :

- **Catalogue › Import / export › Télécharger le modèle (.xlsx)**
- **… › Télécharger le modèle (.csv)** — encodage UTF-8 avec BOM, séparateur `;`
  (compatible Excel en français).

Le modèle contient les **30 colonnes** reconnues et des lignes d'exemple : un article
simple, un article à variantes, un article en promotion datée, un lot (kit).

| # | Colonne du modèle | Champ | Obligatoire | Exemple |
|---|---|---|---|---|
| 1 | Référence | `sku` | **oui** | `PAP-CAH-200-A4` |
| 2 | Nom du produit | `name` | **oui** | `Cahier 200 pages format A4` |
| 3 | Catégorie | `category` | non | `Papeterie et fournitures scolaires` |
| 4 | Sous-catégorie | `subcategory` | non | `Cahiers et registres` |
| 5 | Marque | `brand` | non | `Clairefontaine` |
| 6 | Description courte | `short_description` | non | `Cahier piqué 200 pages` |
| 7 | Description détaillée | `description` | non | texte enrichi autorisé |
| 8 | Prix (FCFA) | `price` | **oui** (sauf mise à jour) | `1500` |
| 9 | Prix de référence barré | `compare_at_price` | non | `1800` |
| 10 | Prix promotionnel | `promo_price` | non | `1200` |
| 11 | Promotion début | `promo_starts_at` | non | `2026-11-01` ou `01/11/2026` |
| 12 | Promotion fin | `promo_ends_at` | non | `2026-11-30` |
| 13 | Stock | `qty` | non | `40` |
| 14 | Seuil d'alerte | `low_stock_threshold` | non | `5` |
| 15 | Suivi du stock | `track_stock` | non | `oui` / `non` |
| 16 | Unité de vente | `sale_unit` | non | `pièce`, `lot`, `paquet`, `rame`, `carton` |
| 17 | État | `product_condition` | non | `neuf` / `reconditionné` |
| 18 | Garantie | `warranty` | non | `6 mois` |
| 19 | Contenu fourni | `box_contents` | non | `1 cahier` |
| 20 | Poids (g) | `weight_g` | non | `320` |
| 21–23 | Longueur / Largeur / Hauteur (cm) | `length_cm`… | non | `30` |
| 24 | Statut | `status` | non | `brouillon` / `publié` / `archivé` |
| 25 | Prix et disponibilité confirmés | `data_confirmed` | non | `oui` / `non` |
| 26 | Variantes | `variants` | non | voir §5 |
| 27 | Caractéristiques | `attributes` | non | `Format:A4;Pages:200` |
| 28 | Composants du kit | `kit_components` | non | `PAP-CAH-96:2;PAP-TRO-01:1` |
| 29 | Titre SEO | `meta_title` | non | |
| 30 | Description SEO | `meta_description` | non | |

**Les intitulés de colonnes n'ont pas besoin d'être exactement ceux du modèle.**
L'assistant reconnaît les variantes courantes (« Référence », « Ref », « Code article »,
« SKU », « Désignation », « Prix unitaire », « PU », « Quantité en stock »…) et propose
une association, que vous pouvez toujours corriger à la main. Une colonne non associée
est simplement ignorée.

---

## 3. Étape ① — Téléverser

- Formats acceptés : **.xlsx** et **.csv**. Tout autre format est refusé.
- Taille maximale : **10 Mo**. Lignes maximales : **50 000** par fichier.
- La première ligne du fichier doit contenir les **intitulés**, pas des données.
- Un fichier sans ligne de données est refusé avec un message explicite.

> Il n'y a **aucune limite de nombre d'articles dans le catalogue** : la limite porte
> sur un seul fichier importé à la fois. Un catalogue de 5 000 ou 20 000 références
> fonctionne ; c'est l'hébergement (disque, mémoire) qui fixe la vraie limite — voir
> [installation-exploitation.md](installation-exploitation.md#7-limites-dhébergement).

---

## 4. Étape ② — Associer les colonnes et choisir le mode

### Les trois modes

| Mode | Comportement | Usage typique |
|---|---|---|
| **Création uniquement** | Une référence déjà présente au catalogue est **ignorée** (signalée « doublon ») | Premier chargement du catalogue |
| **Mise à jour par référence** | Seules les références **existantes** sont modifiées ; une référence inconnue est **rejetée** | Mettre à jour les stocks et les prix |
| **Création ou mise à jour** (upsert) | Ce qui existe est mis à jour, le reste est créé | Rapprochement régulier avec votre inventaire |

### Les options

| Option | Effet |
|---|---|
| **Cellules vides** : *conserver* (défaut) | Une cellule vide **ne modifie rien** |
| **Cellules vides** : *effacer* | Une cellule vide **vide la donnée** (choix explicite, annoncé à l'aperçu) |
| **Colonnes à vider** | Liste de champs à effacer même en mode « conserver » |
| **Statut des nouveaux articles** | *brouillon* (défaut) ou *publié* |
| **Créer les catégories absentes** | Une catégorie inconnue du fichier est créée (sinon la ligne est rejetée) |
| **Créer les marques absentes** | Idem pour les marques |
| **Générer une référence manquante** | Fabrique `IMP-00042` pour une ligne sans référence |
| **Confirmer prix et disponibilité** | Coche la case qui rend l'article **achetable** |
| **Autoriser un prix manquant** | Accepte les lignes sans prix (elles resteront en brouillon) |
| **Taille de lot** | Nombre de lignes traitées par lot (1 à 500, défaut 50) |

> **Le point le plus important** : par défaut, une cellule vide ne détruit jamais une
> donnée existante. Un fichier qui ne contient que `Référence ; Stock` met à jour les
> stocks **sans toucher aux prix ni aux descriptions**. L'effacement est un choix
> explicite, et l'aperçu annonce ligne par ligne ce qui sera effacé.

---

## 5. Écrire variantes, caractéristiques et kits dans une cellule

**Variantes** — `;` sépare les variantes, `|` sépare les options d'une même variante :

```
Capacité:32 Go|Couleur:Noir;Capacité:64 Go|Couleur:Noir
```
→ deux variantes : {32 Go, Noir} et {64 Go, Noir}.

Une écriture plus simple est aussi comprise : `Couleur:Bleu;Couleur:Rouge;Couleur:Vert`
donne trois variantes d'une option.

**Caractéristiques** — `Intitulé:Valeur` séparées par `;` :

```
Format:A4;Pages:200;Réglure:Seyès;Grammage:90 g
```

**Composants d'un kit** — `RÉFÉRENCE:quantité` séparés par `;` :

```
PAP-CAH-96:2;PAP-TRO-01:1;PAP-STY-BIC:4
```

Les références des composants doivent exister (dans le catalogue ou dans le même
fichier) ; sinon la ligne est rejetée et le motif cité.

---

## 6. Étape ③ — L'aperçu

L'aperçu qualifie **chaque ligne** avant toute écriture :

| Statut | Signification |
|---|---|
| **Création** | Nouvel article |
| **Mise à jour** | Référence existante, modifiée |
| **Ignorée** | Hors du mode choisi (référence déjà présente en mode création, absente en mode mise à jour) |
| **Doublon** | Même référence deux fois dans le fichier : seule la première est prise |
| **Rejetée** | Erreur bloquante, avec le motif et le champ concerné |

Motifs de rejet les plus fréquents :

- `Référence absente. Renseignez-la ou activez la génération automatique.`
- `Prix manquant. Sans prix, l'article ne peut pas être publié (il sera importé en brouillon).`
- `Montant illisible : « abc ».`
- `Le nom du produit est obligatoire.`
- `Catégorie « … » introuvable et création désactivée.`
- `Composant de kit « … » introuvable.`
- `Une référence est obligatoire pour mettre à jour un article.`

Avertissements (non bloquants) :

- `Catégorie « … » absente : elle sera créée.`
- `Prix non renseigné : le prix existant sera conservé.` (mise à jour, cellules vides conservées)
- `Le prix promotionnel est supérieur ou égal au prix normal : promotion ignorée.`
- `Publication impossible sans prix. L'article restera en brouillon.`

Un article annoncé **publié** mais sans prix confirmé est **automatiquement repassé en
brouillon** : rien d'invendable n'apparaît en vitrine.

Vous pouvez **revenir en arrière** à cette étape : changer de mode ou d'association de
colonnes et relancer un aperçu sur le même fichier donne un résultat fidèle.

---

## 7. Étape ④ — Exécution par lots et rapport

Le traitement est **découpé en lots** (50 lignes par défaut) avec une barre de
progression : un fichier de 5 000 lignes ne fige pas le navigateur, et une
interruption peut être **reprise** là où elle s'est arrêtée.

Le **rapport** (`Catalogue › Import / export › Rapport`) donne :

```
Articles créés          198
Articles mis à jour       8
Lignes ignorées           0
Lignes rejetées           4
────────────────────────────
Répartition vérifiée   complète · 210 lignes sur 210
```

puis, **ligne par ligne** : numéro de ligne dans le fichier, référence, nom, action,
statut, motif détaillé, lien vers la fiche créée. Un filtre par statut
(toutes / traitées / rejetées / doublons / ignorées / en attente) permet d'aller droit
aux problèmes.

Le bouton **Relancer les lignes rejetées** remet ces lignes en file d'attente après
correction du fichier : les lignes déjà importées ne sont pas dupliquées si vous
utilisez le mode *création ou mise à jour*.

Un lot peut aussi être **annulé** : plus aucune ligne ne sera traitée.

---

## 8. Exporter

- **Exporter le catalogue (.csv / .xlsx)** : toutes les références, dans les mêmes
  colonnes que le modèle → vous pouvez modifier le fichier puis le réimporter en
  mode *mise à jour*.
- **Exports de gestion** : `commandes.csv`, `ventes.csv` (caisse), `clients.csv`,
  ainsi que l'export des statistiques.
- Les cellules commençant par `=`, `+`, `-` ou `@` sont neutralisées à l'export :
  ouvrir un export dans Excel ne peut pas exécuter de formule.

---

## 9. Et les fichiers PDF ou les photos de listes de prix ?

L'extraction automatique depuis un PDF ou une photo est un **travail préparatoire,
à valider humainement** : la mise en page d'un catalogue fournisseur, les tableaux
fusionnés et les photos de prix manuscrits produisent des résultats partiels.

La méthode fiable, et la seule promise ici :

1. convertir le PDF/la photo en tableau (outil de votre choix, ou saisie) ;
2. coller les colonnes dans le **modèle** téléchargé ;
3. importer en mode **création**, **statut brouillon**, **confirmation désactivée** ;
4. relire le rapport, corriger les lignes rejetées ;
5. vérifier prix et disponibilité, puis **publier**.

Aucune conversion automatique « parfaite » n'est annoncée : un article dont le prix ou
la disponibilité ne sont pas confirmés n'est pas mis en vente.

---

## 10. Limites techniques à connaître

| Élément | Valeur | Commentaire |
|---|---|---|
| Taille d'un fichier | 10 Mo | Au-delà, découpez le fichier |
| Lignes par fichier | 50 000 | Au-delà, découpez le fichier |
| Taille d'un lot | 1 à 500 lignes | 50 par défaut ; augmentez sur un serveur rapide |
| Colonnes reconnues | 30 | Les colonnes non reconnues sont ignorées |
| Photos | non incluses | Les images s'ajoutent dans la fiche produit ou la médiathèque |
| Articles au catalogue | **sans limite codée** | Limité par le disque et la mémoire de l'hébergement |
