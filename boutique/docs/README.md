# Documentation — ETS LE PRIVILÈGE DAOUKRO

Cette documentation s'adresse à trois lecteurs : la **personne qui gère la boutique**
(sans compétence technique), **l'administrateur système** qui installe et sauvegarde,
et **le développeur** qui reprendrait le code.

| Document | Pour qui | Contenu |
|---|---|---|
| [guide-articles.md](guide-articles.md) | Gestionnaire | Ajouter, modifier, publier un article ; photos, variantes, kits, promotions, stock |
| [guide-import.md](guide-import.md) | Gestionnaire | Importer un catalogue depuis Excel/CSV, modèle, aperçu, rapport, modifications en masse |
| [etat-des-lieux.md](etat-des-lieux.md) | Décideur | Ce qui fonctionne, ce qui est simulé, ce qui attend une configuration externe |
| [installation-exploitation.md](installation-exploitation.md) | Technicien | Installation, lancement, sauvegarde, restauration, déploiement, supervision |
| [schema-donnees.md](schema-donnees.md) | Technicien | Modèle de données, règles métier, migrations |
| [services-et-couts.md](services-et-couts.md) | Décideur | Services à connecter et coûts récurrents à vérifier (rien n'est souscrit) |
| [rapport-de-tests.md](rapport-de-tests.md) | Tous | Tests réalisés, résultats chiffrés, bogues trouvés et corrigés, limites |

## Les trois commandes à connaître

```bash
npm run check      # 74 vérifications : toutes les pages répondent, aucun accès non autorisé
npm run journey    # 121 vérifications : le métier complet est joué en HTTP réel (écrit des données)
npm test           # 82 tests automatisés sur base isolée (n'écrit jamais dans la base réelle)
```

`npm run journey` **écrit** des articles et des commandes : il refuse de s'exécuter
hors mode démonstration (`DEMO=true`) sauf ordre explicite `--allow-real`.

## Principe directeur de l'application

Rien n'est inventé. Une information non confirmée par l'établissement (adresse,
horaires, tarif de livraison, prix d'un article, logo) n'est jamais affichée comme
si elle était vraie : elle reste vide, signalée « à compléter » dans
**Administration › Tableau de bord › Mise en route**, et modifiable sans développeur.

De la même façon, un frais de livraison inconnu n'est jamais présenté comme offert :
la commande passe en **« Livraison sur devis »** et attend l'accord du client sur le
montant avant tout paiement.
