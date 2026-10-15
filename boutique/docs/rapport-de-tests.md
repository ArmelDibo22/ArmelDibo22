# Rapport de tests

Date des essais : **15 octobre 2026** · Environnement : Node.js v22.22.3, Linux x86-64
· Base de démonstration `data/demo.sqlite` (séparée de la base réelle `data/boutique.sqlite`).

---

## 1. Résultat synthétique

| Campagne | Portée | Résultat |
|---|---|---|
| `npm test` — tests automatisés | 7 fichiers, **86 tests** sur base isolée par fichier | **86 / 86 réussis** |
| `npm run check` — contrôle d'installation | **74 vérifications** HTTP + intégrité de la base | **74 / 74 réussies** |
| `npm run journey` — parcours métier réel | **16 étapes**, **252 vérifications** HTTP + effets en base | **252 / 252 réussies** |
| Erreurs serveur pendant le parcours final | `data/logs/app.log` | **0** (aucun 5xx non plus) |
| Compilation et contrat des 64 vues EJS | 3 tests automatisés | **0 échec** |

Les tests automatisés n'écrivent **jamais** dans la base réelle ni dans la base de
démonstration : chaque fichier ouvre sa propre base dans `data/tests/`.

---

## 2. Tests automatisés (`npm test`)

| Fichier | Tests | Ce qui est couvert |
|---|---|---|
| `tests/unit.test.js` | 8 | Montants FCFA (formatage, arrondi, conversion), normalisation des numéros ivoiriens, slugs, dates, validation, hachage de mot de passe, signature HMAC, cohérence du schéma |
| `tests/catalog.test.js` | 12 | Référence unique, slug dédoublonné, achetabilité (prix, confirmation, publication), variantes et fourchette de prix, kit = minimum des composants, duplication, brouillon automatique sans prix, recherche sur **2 000 articles** (FTS, accents, référence, pagination plafonnée, filtres, facettes), le maintien du suivi de stock d'un article simple, **modification en masse sans critère = aucun article touché**, **et variantes modifiables sans perdre le suivi de stock** |
| `tests/stock-orders.test.js` | 17 | Réservation panier puis commande, refus de survente, **8 acheteurs simultanés sur 3 unités**, forme d'une commande invitée, idempotence (anti-double-commande), validation nom/téléphone/ville/adresse/conditions, encaissement espèces autorisé et non autorisé + audit, annulation et restitution, **expiration des réservations** (commande en ligne annulée, commande en espèces conservée, devis non touché), devis envoyé/accepté/refusé, garde-fous de transition, masquage du suivi, le dernier exemplaire en stock, **remboursement partiel puis intégral avec remise en stock et journal d'audit**, **et annulation d'une commande payée (trace d'audit + remboursement à traiter)** |
| `tests/shipping-payments.test.js` | 18 | Gratuité uniquement au retrait, tarif de base + supplément au poids, zone sans tarif → devis (jamais 0 FCFA), zone inconnue, franchise de livraison, cohérence moyen de paiement ↔ mode ↔ zone, refus d'activer un Mobile Money sans identifiants, **chaîne complète du webhook** : succès, signature invalide, signature absente, doublon d'identifiant d'événement, deux événements pour une commande déjà réglée, montant erroné, devise erronée, commande inconnue, statut d'échec, passerelle inconnue (404), passerelle sans webhook (405), corps vide (400), corps illisible (400), corps trop volumineux (413), redirection d'initiation, **séparation des trois statuts**, impossibilité pour un client d'auto-valider un paiement en espèces |
| `tests/imports.test.js` | 14 | Modèle téléchargeable CSV et XLSX, refus d'un format non pris en charge et d'un fichier vide, suggestion d'association des colonnes françaises, **aperçu sans écriture**, doublons dans le fichier, prix absent, prix illisible, référence absente, catégorie inconnue, traitement **par lots reprenables**, rapport complet et répartition vérifiée, article importé non confirmé = brouillon non vendable, **cellule vide qui n'efface rien** par défaut et qui efface sur choix explicite, mise à jour d'une référence inconnue, upsert, variantes/caractéristiques/composants de kit, export du catalogue, annulation d'un lot |
| `tests/access.test.js` | 14 | Matrice de permissions administrateur/vendeur (14 autorisées, 9 refusées), habilitation à encaisser modifiable, **protection du dernier administrateur** (rétrogradation, désactivation, suppression, auto-suppression), mot de passe faible et e-mail déjà pris, connexion et compte désactivé, journalisation des échecs, **jeton de session haché** + cookie HttpOnly/SameSite + expiration + révocation, **isolation des commandes entre clients**, suivi accessible uniquement par jeton, compte client sans e-mail, consentement marketing distinct, hachage des mots de passe, journal d'audit, validation des réglages, limitation de débit |
| `tests/views.test.js` | 3 | Les **64 vues** EJS se compilent (évite une erreur 500 découverte seulement en production), respect du contrat de rendu (documents d'administration complets, fragments publics), et absence de toute preuve sociale artificielle dans le balisage rendu |

---

## 3. Contrôle d'installation (`npm run check`)

74 vérifications : intégrité de la base et migrations appliquées ; **accès refusés sans
session** (`/admin`, `/admin/produits`, `/admin/commandes`, `/admin/reglages`,
`/compte/commandes` renvoient 302) ; **29 pages publiques** (accueil, catalogue,
pagination, tri, recherche, panier, commande, suivi, contact, trois pages légales,
compte, connexion, inscription, connexion admin, `robots.txt`, `sitemap.xml`, sonde de
santé, API panier et suggestions, feuilles de style, scripts, favicon, page inexistante
en 404, image inconnue servie en 200 avec image de substitution) ; connexion
administrateur puis **38 pages d'administration** ; cohérence des réglages et liste
« Mise en route ».

---

## 4. Parcours métier réel (`npm run journey`)

252 vérifications jouées **en HTTP réel** contre le serveur, avec des navigateurs
simulés distincts (visiteur mobile, client invité, client inscrit, vendeur,
administrateur), en contrôlant à chaque fois la réponse **et** l'effet en base.

| Étape | Vérifications | Points marquants |
|---|---|---|
| Vitrine sur mobile | 12 | Recherche, catégories et panier accessibles dès le premier écran ; pas de grande bannière décorative ; pas de faux témoignage ni compteur de ventes ; numéro supplémentaire affiché ; pagination ; 404 sur un article inexistant |
| Administration : créer un article | 14 | Création depuis le formulaire, prix en FCFA entier, stock initial, visibilité en vitrine, modification du prix, duplication avec référence distincte, **article non confirmé publié mais non achetable** (bouton désactivé), **publication refusée sans prix confirmé**, **rétrogradation automatique d'un article publié devenu non conforme** |
| Import CSV assisté | 13 | Téléversement multipart, 5 lignes détectées, association des colonnes, **aperçu sans écriture**, 2 créations / 3 rejets, doublon du fichier non dupliqué, motifs de rejet cités par ligne, **rapport affiché**, export du catalogue |
| Achat invité en retrait + espèces | 14 | Panier et total calculés serveur, réservation du stock, commande créée, **statuts séparés**, confirmation sans paiement annoncé, **vendeur non habilité refusé**, administrateur encaisse, **sortie de stock**, audit de l'encaissement, bon de commande imprimable |
| Livraison à Daoukro | 7 | Frais annoncés avant la commande, jamais « offerts » par erreur, frais calculés serveur, total cohérent, adresse enregistrée, paiement à la réception accepté pour la zone |
| Livraison sur devis | 11 | « Livraison sur devis » affichée, **aucun montant inventé**, commande en `quote_required`, devis envoyé par l'administration, **client qui accepte depuis son lien de suivi**, total mis à jour, aucun paiement validé avant encaissement |
| Paiement Mobile Money (bac à sable) | 20 | Activation depuis l'administration, moyen toujours marqué « non configuré », refus d'activation hors bac à sable, redirection vers la passerelle, **la redirection ne vaut pas paiement**, notification signée → payé, **trois notifications répétées → un seul encaissement et un seul événement**, sortie de stock, **montant erroné rejeté (422)**, **paiement échoué non réglé**, **signature forgée refusée (401)** |
| Concurrence sur stock limité | 5 | Trois clients sur **un seul exemplaire** : un seul obtient la commande, une seule commande enregistrée, stock jamais négatif, disponible épuisé sans survente, article ensuite affiché en rupture |
| Annulation et restitution | 5 | Réservation à la commande, annulation, **stock restitué**, réservations libérées, article de nouveau achetable |
| Séparation des rôles et des données | 14 | Vendeur : commandes et catalogue oui, **utilisateurs et journal d'audit refusés (403)**, réglages en lecture seule (**écriture refusée 403**) ; visiteur non connecté renvoyé à la connexion ; suivi impossible avec un mauvais téléphone, avec un jeton invalide (404) ou avec la seule référence (404) ; suivi valide **sans note interne** |
| Catégories : création, renommage, ordre, archivage, suppression | 28 | Sous-catégorie créée sous la famille choisie, slug unique, renommage sans casser les articles rattachés, **réordonnancement persisté**, catégorie archivée **retirée de la vitrine mais conservée en administration**, **suppression refusée tant que des articles sont rattachés**, ré-affectation des enfants, articles détachés sans être supprimés, filtres du catalogue cohérents |
| Modifications en masse du catalogue | 21 | Changement de statut, de catégorie, de prix, de stock et de seuil sur une sélection, **journal d'audit par opération**, **sélection vide = rien de modifié**, **action inconnue refusée**, articles non conformes **rétrogradés en brouillon**, suivi de stock conservé, **vendeur autorisé à modifier le catalogue mais pas à supprimer une catégorie** |
| Photos : téléversement, image principale, ordre, fichiers refusés | 24 | Trois images téléversées en une requête, **dérivés WebP réellement produits** (320 px pour la vignette), première image devenue principale, **changement d'image principale persisté**, réordonnancement, suppression d'une image et de ses fichiers, **fichier texte refusé (415)**, **image illisible refusée avec message explicite**, **le message affiché compte les images réellement ajoutées**, image servie avec cache long |
| Retour et remboursement d'une commande payée | 25 | **Remboursement refusé à un vendeur (403)**, remboursement partiel créé puis **appliqué** : montant remboursé, **remise en stock vérifiée**, événement visible par le client, remboursement intégral du solde, **refus d'un montant supérieur au reste dû**, **refus d'un remboursement sur une commande non payée**, refus d'une quantité nulle, **journal d'audit des deux opérations**, bon de commande et suivi à jour |
| Compte client facultatif | 30 | Mot de passe faible refusé, inscription sans e-mail acceptée, **un numéro déjà rattaché à un compte ne peut pas en ouvrir un second (409)**, consentement marketing horodaté, **panier d'invité fusionné dans le compte**, commande rattachée au compte, **un autre client ne voit pas cette commande (404)**, administrateur renvoyé à la connexion depuis `/compte`, modification des coordonnées, **désabonnement marketing tracé**, changement de mot de passe (ancien refusé, nouveau accepté), **suppression du compte : anonymisation, sessions révoquées, commande et lien de suivi conservés** |
| Caisse, statistiques, sauvegarde | 9 | Vente au comptoir enregistrée, statistiques séparant commandes, encaissements et ventes au comptoir, export CSV, **sauvegarde exécutée avec fichier produit et intégrité vérifiée**, **restauration vérifiée à blanc** |

Le parcours est **rejouable** : il remet à zéro les compteurs de limitation de débit de
la base de démonstration au démarrage, et choisit des numéros de téléphone libres pour
les comptes qu'il crée (un numéro déjà rattaché à un compte est refusé à l'inscription,
à juste titre).

État de la base à l'issue du parcours final (preuve que les opérations ont bien eu lieu) :
**13 commandes** dont 2 payées, 1 remboursée et 1 annulée, **2 remboursements appliqués**,
**37 articles** (29 du jeu de démonstration + 8 créés par le parcours et l'import) dont
32 publiés et **0 publié sans prix confirmé**, **22 catégories**, **13 clients** dont 1
anonymisé, **31 images** avec leurs dérivés WebP, **64 mouvements de stock** et **0 stock
négatif**, 1 lot d'import, 1 vente au comptoir, 5 événements de notification de paiement
(2 traités, 3 rejetés ou dédoublonnés), **175 entrées de journal d'audit** (dont
`refund.create`, `refund.apply`, `order.cancel`, `product.image_add`, `category.delete`,
`customer.deleted`, `consent.withdrawn`), 1 sauvegarde de 675 840 octets dans
`data/demo-backups/` (séparée des sauvegardes réelles), **0 erreur serveur et aucun 5xx**
dans `data/logs/app.log` (les 37 réponses 4xx sont celles que le parcours provoque
volontairement : refus de rôle, fichier non image, doublon de compte, commande d'un autre
client, identifiant invalide).

---

## 5. Anomalies trouvées et corrigées

Ces anomalies ont été découvertes **par les tests**, pas par la relecture du code.
Plusieurs étaient **bloquantes** : elles rendaient un usage normal impossible sans
aucun message d'erreur évident (n° 7, 8 et 9 — permissions et imports —, n° 22 et 23 —
remboursements affichés comme appliqués sans effet réel ni trace —, n° 25 — photos
annoncées ajoutées alors qu'elles ne l'étaient pas).

Le numéro 27 est un réglage ajusté après mesure, pas un défaut de code.

### Découvertes par le parcours métier réel

| # | Anomalie | Impact réel | Correction |
|---|---|---|---|
| 1 | `saveKitComponents([])` désactivait le suivi de stock | **Tous** les articles créés ou modifiés via le formulaire perdaient le suivi de stock : ni réservation, ni protection anti-survente, ni sortie de stock à l'encaissement | Le suivi n'est désactivé que si l'article a réellement des composants ; un kit vidé redevient un article simple suivi (`src/domain/stock.js`) |
| 2 | La réservation du panier était comptée contre le client | Le **dernier exemplaire** en stock ne pouvait jamais être commandé : le panier le réservait, puis la commande le trouvait « indisponible » | `stock.reservedForCart()` ajouté ; `computeTotals`, `createOrder`, le tunnel de commande et l'affichage du panier rendent au client ses propres unités (`orders.js`, `products.js`, `cart.js`, `routes/checkout.js`) |
| 3 | Balise EJS mal fermée dans le bon de commande imprimable | `GET /admin/commandes/:id/impression` → **erreur 500** : impossible d'imprimer un récapitulatif | Balise corrigée ; un test compile désormais les 64 vues |
| 4 | Vue du **rapport d'import** absente | `GET /admin/import/:id/rapport` → **erreur 500** : le rapport promis n'existait pas | `src/views/admin/imports/report.ejs` créée (compteurs, motifs de rejet, lignes filtrables, relance des rejets) |

### Découvertes par les tests automatisés

| # | Anomalie | Impact réel | Correction |
|---|---|---|---|
| 5 | `releaseExpired()` exigeait un statut de paiement jamais écrit | **Code mort** : les commandes en ligne abandonnées restaient « en attente » indéfiniment avec leur stock immobilisé | Annulation quand la commande est en attente, non payée et non réglable en espèces ; une commande en espèces reste encaissable au comptoir, un devis n'est pas touché (`stock.js`) |
| 6 | `methodAllowedFor()` exigeait des identifiants marchands pour tout Mobile Money | Le bac à sable et toute la chaîne de notification étaient **inatteignables**, alors que l'administration permettait d'activer un moyen simulé | Moyen simulé accepté quand la simulation est activée **et** hors production (`shipping.js`) |
| 7 | `cash.confirm` absent des permissions du vendeur | Un vendeur **habilité à encaisser** ne voyait jamais le bouton « Encaisser » (la règle spéciale de contrôle était morte) | Permission ajoutée, toujours soumise à l'habilitation individuelle (`users.js`) |
| 8 | Un lot d'import **annulé** restait exécutable | Annuler un import ne l'arrêtait pas : les lignes continuaient d'être traitées | Exécution refusée avec un message explicite (`imports.js`) |
| 9 | Découpage des variantes à l'import | `Capacité:32 Go\|Couleur:Noir;Capacité:64 Go\|Couleur:Noir` créait **4 variantes d'une option** au lieu de 2 variantes de 2 options | `;` sépare les variantes, `\|` leurs options ; une option répétée dans un groupe est comprise comme plusieurs variantes |
| 10 | Prix vide en mise à jour | **Un fichier de stocks seul était entièrement rejeté** ; pire, un article publié dont la cellule de prix était vide était rétrogradé en brouillon | En mise à jour, un prix absent signifie « ne pas modifier » (avertissement, pas erreur) ; l'effacement reste un choix explicite annoncé à l'aperçu |
| 11 | Second aperçu sur le même lot | Changer de mode après un aperçu produisait des lignes **vides** (les intitulés d'origine avaient disparu) | Association tolérante et analyseurs de variantes/caractéristiques/kit idempotents |
| 12 | Effacement explicite d'un prix | `NOT NULL constraint failed: products.price` : la ligne était rejetée au lieu d'effacer le prix | Les colonnes numériques non nullables reçoivent 0 (« effacé »), les autres restent réellement nulles (`products.js`) |
| 13 | `seed-demo.js` écrasait `DATABASE_PATH` | Le garde-fou d'isolement de la démonstration **bloquait** `npm run reset:demo` | Le script laisse la configuration résoudre elle-même les cibles de démonstration |
| 14 | Script `npm test` | `node --test tests/` échouait (`MODULE_NOT_FOUND`) sur Node 22 | Motif explicite `tests/*.test.js` |
| 15 | Classe `pill--neutral` utilisée mais absente du CSS | Pastilles d'état non stylées dans deux écrans d'administration | Règle ajoutée (`assets/css/app.css`) |

### Découvertes par le parcours étendu (photos, masse, remboursements, catégories, compte)

Ces cinq étapes ont été ajoutées pour couvrir des usages quotidiens qui n'étaient testés
que par des tests unitaires. Elles ont révélé six anomalies réelles.

| # | Anomalie | Impact réel | Correction |
|---|---|---|---|
| 22 | `createRefund(…, appliquer: '1')` enregistrait directement le remboursement comme `done` | Le garde de `applyRefund()` (`if (!refund \|\| refund.status === 'done') return`) court-circuitait tout : **l'administration affichait « remboursement appliqué » alors que le montant remboursé restait à 0, que le stock n'était pas remis et qu'aucun événement n'était tracé**. L'argent était rendu en caisse sans aucune écriture | Le remboursement est toujours créé à l'état `pending`, puis appliqué par `applyRefund()` (`src/domain/orders.js`) |
| 23 | `orders.js` n'écrivait **aucune** ligne dans le journal d'audit | Annulations, créations et applications de remboursement étaient invisibles dans le journal : impossible de savoir **qui** avait remboursé **quoi** et **quand** | Fonction `audit()` locale ; `refund.create`, `refund.apply` et `order.cancel` sont désormais journalisés (`src/domain/orders.js`) |
| 24 | `bulkUpdate` et `create` laissaient un article `published` sans prix ou sans confirmation | Un article **non achetable** apparaissait dans `/sitemap.xml` et dans les résultats de recherche interne : un client arrivait sur une page où le bouton d'achat est désactivé, sans comprendre pourquoi | Rétrogradation automatique en brouillon avec `report.demoted`, `setStatus('published')` refuse (`NOT_PUBLISHABLE`), et le sitemap n'émet plus que des articles publiés, confirmés et à prix strictement positif |
| 25 | `attachUploadedImages` avalait les échecs fichier par fichier, et les deux formulaires article l'appelaient **sans attendre** sa fin | Le message « 3 image(s) ajoutée(s) » pouvait s'afficher alors qu'aucune image n'était passée ; pire, la photo n'apparaissait qu'après un rafraîchissement manuel, ce qui pousse à re-téléverser et à créer des doublons | La fonction renvoie `{ attached, rejected }`, un message distinct signale les fichiers refusés avec leur motif, et les deux gestionnaires sont `async` et attendent le résultat (`src/routes/admin/catalog.js`) |
| 26 | `bulkUpdate(ids, {})` renvoyait `{ count: 1 }` et réindexait la recherche | Une modification en masse envoyée **sans aucun critère** (formulaire partiellement rempli) annonçait « 1 produit modifié » alors que rien ne l'était, et déclenchait une réindexation inutile | Retour anticipé avec un rapport complet vide (`skipped`, `demoted`, `details` inclus) dès qu'aucune clé de modification n'est définie |
| 27 | Plafond du tunnel de commande à **20 soumissions par 10 minutes et par adresse IP** | Sous CGNAT (partage d'adresse IP publique entre abonnés d'un même opérateur mobile), des clients légitimes pouvaient recevoir « Trop de demandes » en pleine période de rentrée scolaire, alors que l'anti-doublon repose déjà sur la clé d'idempotence | Plafond porté à 60, documenté et réglable par `RATE_LIMIT_CHECKOUT_MAX` (`src/config.js`, `.env.example`, `docs/installation-exploitation.md`) |

### Corrigées lors des sessions précédentes (rappel)

| # | Anomalie | Impact |
|---|---|---|
| 16 | `releaseReservations()` poussait une valeur sans marqueur correspondant | **Tout ajout au panier échouait** (`column index out of range`) |
| 17 | `normalizeInput()` envoyait `null` dans la branche numérique | **Duplication d'un article impossible** pour les colonnes nullables |
| 18 | Paiement en espèces enregistré avec une référence prestataire vide | Collision d'unicité dès la **seconde** commande en espèces |
| 19 | `DEMO=true` n'isolait rien quand `.env` définissait `DATABASE_PATH` | La démonstration écrivait dans la **base réelle** |
| 20 | `requireAdmin` répondait 403 au lieu de rediriger | Un visiteur non connecté voyait une erreur au lieu de la page de connexion |
| 21 | `/media/inconnu.jpg` répondait 404 | Vignettes cassées au lieu de l'image de substitution |

---

## 6. Ce que les tests ne couvrent pas (limites connues)

| Limite | Pourquoi | Risque | Contre-mesure |
|---|---|---|---|
| **Rendu visuel sur appareil réel** | Aucun navigateur graphique dans l'environnement de test | Mise en page, contrastes et taille des cibles tactiles non vérifiés pixel par pixel | Le parcours contrôle la structure (recherche, catégories et panier dès le premier écran, absence de bannière pleine hauteur) ; **une relecture sur téléphone réel reste à faire** |
| **Passerelles de paiement réelles** | Aucun contrat marchand, aucune documentation officielle vérifiable, aucun bac à sable distant accessible | Les adaptateurs Wave / Orange Money / MTN / Moov restent « non configurés » | Le pipeline de notification (signature, montant, devise, commande, déduplication, effet unique) est **terminé et testé** via une passerelle de démonstration ; l'adaptateur de chaque prestataire sera complété à la réception de sa documentation |
| **Envoi de SMS et d'e-mails** | Aucun prestataire choisi, aucun coût engagé | Les confirmations ne partent pas automatiquement | Une file interne (`outbox`) est prête ; les écrans de suivi et le lien WhatsApp fonctionnent sans prestataire |
| **Volume de production** | Tests menés sur 2 000 articles (recherche) et 29 articles (démonstration) | Comportement non mesuré à 50 000 articles | Requêtes paginées côté serveur, index FTS, aucune limite codée ; une mesure sur le volume réel reste à faire |
| **Charge simultanée** | Concurrence testée à 8 acheteurs simultanés sur 3 unités, et 3 clients sur 1 exemplaire | Comportement non mesuré sous des centaines de clients simultanés | SQLite n'autorise qu'une écriture à la fois : au-delà de plusieurs milliers de commandes par jour, prévoir PostgreSQL |
| **Restauration réelle** | Testée à blanc (`--dry-run`) pour ne pas écraser la base en cours d'essai | Une restauration complète n'a pas été jouée en conditions réelles | Procédure documentée ; un exercice mensuel est recommandé |
| **Accessibilité normative** | Navigation clavier, contrastes et libellés vérifiés dans le code ; aucun audit par un lecteur d'écran | Non-conformités éventuelles non détectées | Attributs `aria-*`, `scope`, `caption`, focus visibles et `visually-hidden` en place ; un audit avec lecteur d'écran reste à mener |
| **Informations de l'établissement** | Fiche Google Maps inaccessible depuis l'environnement de construction | Adresse, horaires, logo et tarifs réels inconnus | Champs vides, signalés « à compléter », modifiables dans l'administration ; **rien n'est inventé** |
| **Contenus légaux** | Les textes juridiques ne peuvent pas être rédigés à la place de l'établissement | Trois pages restent à valider | Modèles avec mentions `{{À COMPLÉTER}}`, drapeau `needs_review`, case « validée » dans Réglages › Pages |

---

## 7. Reproduire les essais

```bash
cd boutique
npm ci --no-audit --no-fund
cp .env.example .env                 # puis renseigner APP_SECRET et le compte administrateur
npm run migrate && npm run seed

npm test                             # 86 tests sur bases isolées
npm run check                        # 74 vérifications, sans modifier les données

npm run reset:demo                   # jeu de démonstration propre (base séparée)
DEMO=true PORT=3000 npm start        # dans un premier terminal
DEMO=true npm run journey -- --url http://127.0.0.1:3000   # dans un second
```

Le parcours refuse de s'exécuter hors mode démonstration (il écrit des articles et des
commandes) sauf `--allow-real` explicite. Options utiles : `--json` (sortie machine),
`--only <motif>` (une seule étape).
