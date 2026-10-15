# Services à connecter et coûts récurrents à vérifier

**Aucun service payant n'a été souscrit** pour construire cette application, et
**aucun abonnement n'est engagé**. Ce document liste ce qu'il faudra connecter le jour
où la boutique sera mise en ligne, ce que chaque élément coûte typiquement, et les
questions à poser avant de signer.

Les montants indiqués sont des **ordres de grandeur à confirmer auprès des prestataires**
— ils ne constituent ni un devis ni un engagement. Tous sont en FCFA (XOF) sauf mention.

---

## 1. Ce qui fonctionne déjà sans aucun service externe

| Fonction | Besoin externe |
|---|---|
| Catalogue, recherche, fiches articles, photos | **aucun** (base et disque locaux) |
| Panier, commande invité ou avec compte | **aucun** |
| Retrait en boutique | **aucun** |
| Livraison : zones, tarifs, devis, étapes | **aucun** (tarifs saisis dans l'administration) |
| Paiement **en espèces** à l'enlèvement ou à la livraison, confirmé par un utilisateur habilité | **aucun** |
| Administration complète, statistiques, exports, sauvegardes | **aucun** |

Autrement dit : **la boutique peut ouvrir sans rien payer à personne**, en encaissant
en espèces. Tout le reste est du confort ou de l'automatisation.

---

## 2. À connecter avant une mise en ligne

### 2.1 Hébergement et nom de domaine — indispensable

| Poste | Ordre de grandeur indicatif | Périodicité | Questions à poser |
|---|---|---|---|
| Serveur virtuel (1 Go RAM, 2 cœurs, 20 Go) | 5 000 – 25 000 / mois | mensuel | Datacenter et latence depuis la Côte d'Ivoire ? Sauvegarde automatique incluse ? IPv4 fixe ? |
| Nom de domaine `.ci` | à demander au registraire accrédité | annuel | Prix de renouvellement (souvent supérieur à la première année) ? |
| Nom de domaine `.com` / `.shop` | 6 000 – 15 000 / an | annuel | Renouvellement automatique ? Transfert possible ? |
| Certificat HTTPS | **0** (Let's Encrypt) | — | Renouvellement automatique configuré par l'hébergeur ? |
| Hébergement mutualisé « Node.js » | 3 000 – 15 000 / mois | mensuel | Node 22 disponible ? Processus résident autorisé ? Accès SSH ? |

**Alternative gratuite pour démarrer** : faire tourner l'application sur un poste de la
boutique, accessible en réseau local, le temps de choisir un hébergeur. Aucun coût, mais
pas d'accès depuis Internet.

### 2.2 Paiement Mobile Money — le poste qui engage le plus

Quatre passerelles sont préparées dans le code (**Wave, Orange Money, MTN MoMo,
Moov Money**). Aucune n'est inventée : tant que les identifiants marchands sont vides,
le moyen reste **« non configuré »** et ne peut pas être activé (sauf en bac à sable de
démonstration).

| Prestataire | Ce qu'il faut obtenir | Coût typique | Délai typique |
|---|---|---|---|
| Wave | Compte marchand + accès API/lien de paiement | Commission par transaction, pas d'abonnement | Quelques jours |
| Orange Money Côte d'Ivoire | Compte marchand Orange Money API | Commission par transaction ; frais d'intégration possibles | Semaines |
| MTN MoMo | Compte marchand MoMo API (+ `Target Environment`, clé de souscription) | Commission par transaction | Semaines |
| Moov Money | Compte marchand | Commission par transaction | Semaines |
| Agrégateur local (type prestataire de paiement ivoirien) | Un seul contrat pour plusieurs moyens | Commission majorée en échange d'une intégration unique | Semaines |

**Questions à poser avant de signer** (à ne jamais accepter sans réponse écrite) :

1. Commission **par transaction** et plancher éventuel (ex. « 1 %, minimum 100 FCFA ») ?
2. Frais d'**intégration** ou de **certification** uniques ?
3. Abonnement **mensuel** fixe, même sans transaction ?
4. **Délai de reversement** des fonds sur le compte marchand (J+1, J+3, hebdomadaire) ?
5. Frais de **retrait** des fonds reversés ?
6. Que se passe-t-il en cas de **remboursement** : la commission est-elle rendue ?
7. Format de la **notification serveur** (webhook) : signature HMAC ? Quel en-tête ?
   Quelle est l'URL de rappel à déclarer ?
8. Environnement de **test** (bac à sable) disponible et gratuit ?
9. **Plafonds** par transaction et par jour ?
10. Support technique joignable, et en quelle langue ?

Dès réception, les valeurs se saisissent dans `.env`
(`WAVE_MERCHANT_ID`, `WAVE_API_KEY`, `ORANGE_MONEY_CLIENT_ID`, …) puis le moyen est
activé dans **Administration › Réglages › Paiements**. Le secret de signature
(`PAYMENT_WEBHOOK_SECRET`) doit correspondre à celui de la passerelle.

> **Point de vigilance technique** : l'implémentation fournie valide les notifications
> reçues (signature, montant, devise, commande, déduplication) mais **n'invente aucune
> API**. L'adaptateur de chaque prestataire doit être complété avec la documentation
> officielle reçue après contractualisation. Le pipeline de notification, lui, est
> terminé et testé — il est exercé aujourd'hui par une passerelle de démonstration
> clairement signalée.

### 2.3 Notifications aux clients — recommandé

Aucun envoi automatique n'est configuré : une file interne (`outbox`) est prête à
recevoir les messages à envoyer.

| Canal | Ordre de grandeur indicatif | Périodicité | Remarque |
|---|---|---|---|
| WhatsApp Business API | facturé **par conversation** | à l'usage | Le bouton « WhatsApp » actuel utilise un simple lien `wa.me` : **gratuit**, il ouvre la conversation du client |
| Passerelle SMS locale | 10 – 40 FCFA par SMS | à l'usage | Utile pour « votre commande est prête » |
| E-mail transactionnel | 0 – 15 000 / mois selon le volume | mensuel | Un compte d'envoi (SMTP) suffit au démarrage |

**Rappel de conformité** : le consentement marketing est **distinct** de l'acceptation
des conditions de vente et **facultatif**. Un client qui commande sans cocher cette case
ne doit recevoir aucun message commercial.

### 2.4 Cartographie et itinéraire — gratuit

Le lien « Itinéraire » utilise les coordonnées géographiques fournies par
l'établissement. Aucune clé API de cartographie n'est nécessaire.

| Option | Coût | Faut-il la prendre ? |
|---|---|---|
| Lien Google Maps (actuel) | **0** | Suffisant : ouvre l'application de plans du client |
| Carte intégrée (Leaflet + tuiles OpenStreetMap) | **0** | Confort, à faire si vous voulez une carte sur la page Contact |
| API de géocodage / itinéraire | payante au-delà d'un quota | **Non nécessaire** |

### 2.5 Sauvegarde hors serveur — fortement recommandé

| Solution | Ordre de grandeur | Périodicité |
|---|---|---|
| Disque externe + copie manuelle hebdomadaire | achat unique du disque | 0 |
| Stockage en ligne (compte de 100 Go) | 1 000 – 5 000 / mois | mensuel |
| Second serveur / copie distante automatisée | inclus dans un second hébergement | mensuel |

L'application produit les sauvegardes ; **leur copie hors du serveur reste à organiser**
(voir [installation-exploitation.md](installation-exploitation.md#4-sauvegarde)).

### 2.6 Maintenance — à décider

| Poste | Ordre de grandeur | Périodicité |
|---|---|---|
| Mises à jour de sécurité Node.js et dépendances | 0 si fait en interne | mensuel |
| Intervention d'un prestataire | à négocier | ponctuel |
| Nom de domaine + certificat | voir §2.1 | annuel |

---

## 3. Récapitulatif des coûts récurrents à arbitrer

| Scénario | Coût récurrent | Ce que le client peut faire |
|---|---|---|
| **Minimum** : boutique sur un poste local, paiement en espèces | **0** | Consulter le catalogue, réserver, venir payer et retirer |
| **En ligne, sans paiement électronique** : hébergement + domaine | ≈ 5 000 – 25 000 / mois + domaine annuel | Commander en ligne, payer en espèces au retrait ou à la livraison |
| **En ligne + Mobile Money** : + commissions par transaction | idem + commission (aucun fixe si le prestataire n'en impose pas) | Payer immédiatement depuis son téléphone |
| **Confort complet** : + SMS/e-mail de suivi + sauvegarde externe | + 5 000 – 20 000 / mois selon le volume | Être prévenu à chaque étape |

Le seul poste **obligatoire** pour vendre en ligne est l'hébergement (et le nom de
domaine). Le paiement électronique est un confort : le paiement en espèces à
l'enlèvement ou à la livraison est pleinement fonctionnel, avec confirmation par un
utilisateur habilité et historique.

---

## 4. Ce qui est explicitement exclu de ce projet

- **Aucune souscription** à un service payant n'a été faite, ni compte marchand ouvert.
- **Aucune publication** de la boutique sur Internet sans autorisation explicite.
- **Aucune donnée de carte bancaire** n'est collectée ni stockée : l'application ne
  traite que des références de transaction issues des passerelles.
- **Aucun tarif de livraison inventé** : tant que les tarifs réels ne sont pas saisis,
  la commande passe en « Livraison sur devis » et attend l'accord du client.
- **Aucune information d'établissement inventée** : adresse, horaires, contacts et
  logo restent à confirmer par l'établissement (voir
  [etat-des-lieux.md](etat-des-lieux.md)).
