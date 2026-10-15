# État des lieux — ce qui fonctionne, ce qui est simulé, ce qui attend une configuration

Document destiné à la décision : il sépare clairement le **réel**, le **simulé** et
l'**attente externe**. Date : 15 octobre 2026.

---

## 1. Ce qui fonctionne réellement

Ces fonctions sont complètes, testées et utilisables dès maintenant, sans aucun service
externe.

### Vitrine

- Accueil, catalogue paginé (24 articles/page), catégories et sous-catégories, filtres
  (catégorie, marque, prix, disponibilité, état), tris, **recherche plein texte** avec
  suggestions et correction d'accentuation.
- Fiches articles : galerie photo ordonnée avec image principale, variantes, prix et
  promotion datée, caractéristiques, garantie, contenu fourni, unité de vente, poids et
  dimensions, état (neuf / reconditionné), disponibilité réelle.
- Panier **côté serveur** (le navigateur n'est jamais la source de vérité), compte client
  **facultatif**, commande **sans compte**, suivi de commande par lien à jeton.
- Contact et itinéraire, pages livraison/retours, confidentialité, conditions de vente.
- Adaptation mobile : recherche, catégories et panier accessibles dès le premier écran,
  pas de grande bannière décorative, images servies en WebP dans quatre tailles.

### Administration

- Catalogue complet : création, modification, **duplication**, publication, archivage,
  images (téléversement, image principale, réordonnancement, suppression), variantes,
  caractéristiques par catégorie, **kits et lots** avec composants.
- Catégories : création, renommage, **réordonnancement**, archivage, sous-catégories,
  modèles d'attributs.
- **Modifications en masse** : statut, catégorie, prix (fixe, +/- FCFA, pourcentage,
  arrondi), stock, seuil d'alerte, confirmation des données, suivi de stock, mise en
  avant, marque.
- Stock : quantités par article et par variante, seuils, **historique complet des
  mouvements** avec motif et auteur, ajustements, alertes.
- Commandes : préparation, expédition, étapes de livraison, transporteur et référence de
  suivi, notes internes, annulation avec restitution du stock, remboursements totaux ou
  partiels, **bon de commande imprimable**.
- **Vente au comptoir** (caisse) avec encaissement et sortie de stock, comptabilisée
  séparément des ventes en ligne.
- Devis de livraison : envoi du montant, accord ou refus du client depuis son lien de
  suivi, mise à jour du total.
- **Encaissement en espèces** confirmé par un utilisateur habilité, avec montant, note,
  auteur et date — impossible à auto-valider par un client.
- Statistiques séparant **commandes reçues**, **ventes encaissées**, **ventes au
  comptoir**, **remboursements**, avec séries par jour, meilleurs articles, ventes par
  zone et par moyen de paiement, et export CSV.
- Import / export : modèle téléchargeable, assistant d'association des colonnes, aperçu
  sans écriture, exécution par lots avec progression, **rapport ligne par ligne**, relance
  des lignes rejetées, export du catalogue et exports de gestion.
- Réglages : établissement, contacts (dont contact principal et **WhatsApp par numéro,
  jamais supposé**), apparence (palette modifiable), commerce, paiements, livraison
  (zones, transporteurs, tarifs, franchises), pages légales, notifications.
- Comptes : administrateur et vendeur, habilitation individuelle à encaisser, journal
  d'audit, sauvegardes, état du système, notifications de paiement reçues.

### Garde-fous vérifiés

- Aucun article sans prix, sans référence, non publié ou **non confirmé** n'est achetable.
- Aucun frais de livraison inconnu n'est présenté comme offert : la commande passe en
  « Livraison sur devis » et attend l'accord du client.
- Aucune survente : réservation, garde d'écriture en base, expiration et restitution.
- Aucun paiement validé sans notification serveur signée, contrôlée en montant et en
  devise, dédupliquée.
- Aucune donnée de carte bancaire stockée.
- Consentement marketing **distinct** et facultatif ; e-mail **non obligatoire**.
- Accès refusés par rôle ; suivi accessible uniquement par jeton ; note interne jamais
  exposée ; jetons de session hachés.

---

## 2. Ce qui est simulé (et clairement signalé comme tel)

| Élément | Nature exacte | Où c'est visible |
|---|---|---|
| **Passerelle de paiement « bac à sable »** | Un adaptateur local imite le comportement d'une passerelle : il produit une notification **réellement signée en HMAC**, envoyée au vrai point d'entrée `/webhooks/sandbox`, avec montant, devise, référence de commande, identifiant d'événement, statut de succès ou d'échec, et rejeu possible 1 à 5 fois | Bandeau « démonstration » sur la page, pages sous `/paiements/simuler`, mention explicite « aucun argent réel n'est mouvementé », moyen de paiement marqué **simulé** et **non configuré** |
| **Jeu de données de démonstration** | 29 articles fictifs, photos générées localement portant la mention « image de démonstration », 3 commandes et 1 vente au comptoir fictives | Base **séparée** (`data/demo.sqlite`), dossier de médias séparé, bandeau permanent, `meta.environment = demo`, refus de démarrer en `NODE_ENV=production` |
| **Tarif de livraison de démonstration** | Un tarif fictif (1 000 FCFA + 250 FCFA/kg, franchise à 100 000 FCFA) existe **uniquement** dans la base de démonstration pour illustrer le calcul | La base réelle part sans tarif : toute livraison y est donc « sur devis » tant que les vrais tarifs ne sont pas saisis |
| **Encaissement manuel d'un Mobile Money** | Un client peut payer hors ligne et un utilisateur habilité le confirmer ; c'est un **mode de secours réel**, pas une simulation | Présenté comme « paiement manuel à confirmer », avec auteur et historique |

Le bac à sable est désactivé par `PAYMENT_SIMULATION_ENABLED=false`, et il est
**impossible** en `NODE_ENV=production`. Il ne peut donc pas se retrouver actif par
accident sur une boutique en ligne.

---

## 3. Ce qui attend une configuration externe

| # | Élément | Ce qui manque | Où le saisir | Bloquant pour vendre ? |
|---|---|---|---|---|
| 1 | **Adresse précise de l'établissement** | La fiche Google Maps n'était pas accessible depuis l'environnement de construction ; seule la position géographique fournie est utilisée pour le lien d'itinéraire | Réglages › Établissement, puis cocher « adresse confirmée » | Non (mais indispensable pour la livraison et la confiance) |
| 2 | **Horaires d'ouverture** | Non confirmés | Réglages › Établissement (jours et heures), puis statut « confirmés » | Non |
| 3 | **Logo officiel** | Non récupérable de façon certaine | Réglages › Apparence › téléverser le logo | Non — un logo typographique « ETS LE PRIVILÈGE » occupe l'emplacement, remplaçable en un clic |
| 4 | **Tarifs de livraison réels** | Non communiqués | Réglages › Livraison : zones, transporteurs, tarifs, franchise, délai, paiement à la réception autorisé | Non — en attendant, « Livraison sur devis » s'applique |
| 5 | **Conditions de vente** | Texte juridique à valider par l'établissement | Réglages › Pages | Oui pour une mise en ligne : l'acceptation est exigée à la commande |
| 6 | **Politique de confidentialité** | Texte juridique à valider | Réglages › Pages | Oui pour une mise en ligne |
| 7 | **Information livraison et retours** | Texte à valider | Réglages › Pages | Non, mais attendu par les clients |
| 8 | **Identifiants marchands Mobile Money** | Aucun contrat souscrit, aucune documentation officielle vérifiable | `.env` (`WAVE_*`, `ORANGE_MONEY_*`, `MTN_MOMO_*`, `MOOV_*`) puis Réglages › Paiements | Non — le paiement en espèces fonctionne ; chaque moyen reste « non configuré » tant qu'il n'est pas renseigné |
| 9 | **Numéro principal et WhatsApp** | Le numéro fourni (`+225 07 58 11 38 57`) est enregistré comme **contact supplémentaire** ; rien ne permet d'affirmer qu'il accepte WhatsApp | Réglages › Contacts : définir le contact principal, activer WhatsApp **numéro par numéro** | Non — le bouton WhatsApp n'apparaît que si vous l'activez |
| 10 | **Envoi de SMS / e-mails** | Aucun prestataire choisi, aucun coût engagé | Notifications (file interne prête) | Non — le suivi fonctionne par lien et par WhatsApp |
| 11 | **Hébergement et nom de domaine** | Rien n'est publié : aucune mise en ligne sans autorisation | Voir [installation-exploitation.md](installation-exploitation.md) | Oui pour vendre en ligne |
| 12 | **Catalogue réel** | Aucun fichier d'articles ni photo réelle n'a été fourni | Administration ou import Excel/CSV | Oui — le catalogue réel est vide par conception |

La liste « Mise en route » du **Tableau de bord** reprend ces points en permanence et
affiche la progression (actuellement **1 information confirmée sur 8** : le moyen de
paiement à l'enlèvement).

---

## 4. Décisions assumées

| Décision | Raison |
|---|---|
| **Aucune donnée inventée** | Une adresse, un horaire, un tarif ou un numéro inventés créeraient un litige réel avec un client réel |
| **Aucun produit extrait d'une photo mis en vente** | Un prix, une référence et une disponibilité non confirmés ne permettent pas de vendre |
| **Base réelle vide au départ** | Le catalogue réel appartient à l'établissement ; le jeu de démonstration vit dans un fichier séparé |
| **Frais inconnus = devis, jamais « offert »** | Annoncer une livraison gratuite non maîtrisée engage financièrement la boutique |
| **Aucune API de paiement inventée** | Une intégration imaginée échouerait en production et pourrait faire croire à un paiement reçu |
| **Notification serveur signée comme seule preuve de paiement** | Une capture d'écran, un message du client ou une page de retour se falsifient |
| **Pas de faux témoignages, compteurs ou comptes à rebours** | Interdit par le cahier des charges et contraire à la confiance |
| **SQLite plutôt qu'un serveur de base de données** | Un seul fichier : sauvegarde, restauration et migration simples, coût nul, suffisant pour le volume d'une boutique |
| **Rendu serveur sans étape de construction** | Pas d'outillage fragile à maintenir, hébergement possible partout où Node 22 tourne |
| **`view_count` jamais affiché** | Un compteur de vues deviendrait une preuve sociale artificielle |

---

## 5. Prochaines étapes recommandées

1. **Saisir les informations de l'établissement** : adresse, horaires, contacts, logo
   (30 minutes, aucun risque : tout est modifiable).
2. **Importer le catalogue réel** depuis un fichier Excel, en brouillon, confirmation
   désactivée ; relire le rapport ; publier progressivement.
3. **Définir les tarifs de livraison** par zone (Daoukro, région de l'Iffou, reste de la
   Côte d'Ivoire) ou laisser « sur devis » au démarrage.
4. **Faire valider les trois textes légaux** par l'établissement (ou un conseil).
5. **Choisir un hébergement et un nom de domaine**, puis suivre
   [installation-exploitation.md](installation-exploitation.md) — publication uniquement
   après autorisation.
6. **Ouvrir un compte marchand** auprès d'une passerelle Mobile Money, obtenir sa
   documentation officielle, compléter l'adaptateur correspondant et tester en bac à
   sable du prestataire avant activation.
7. **Mettre en place la sauvegarde quotidienne** et une copie hors serveur, puis faire un
   exercice de restauration.
8. **Relire l'interface sur un téléphone réel** et avec un lecteur d'écran avant
   l'ouverture au public.
