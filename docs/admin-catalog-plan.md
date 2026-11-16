# Plan du catalogue commun PGD Market

> Document historique : cette proposition a été remplacée. Chariow est la source unique des données commerciales; PGD ne conserve que les notes dans le store Netlify Blobs `ratings-v1`. Ne pas utiliser les propositions de migration ci-dessous comme instructions opérationnelles.

## Portée

Ce document décrit les données actuellement présentes et une structure cible. Il ne crée pas de store Netlify Blobs, n'initialise aucun produit et ne prescrit aucune modification immédiate du site public, du panier, du checkout, de Chariow ou de la livraison.

## Sources examinées

- `public/assets/js/products.js` : catalogue chargé par la boutique.
- `netlify/functions/_products.js` : catalogue chargé par le serveur.
- `netlify/functions/create-payment.js` : règle serveur d'éligibilité au paiement.
- `public/assets/js/app.js` : import du catalogue, résolution des textes et règle publique d'affichage disponible.
- `public/locales/fr.json` et `public/locales/en.json` : traductions de l'interface et des produits.

La comparaison ci-dessous reprend les valeurs de ces fichiers. Les chaînes de description peuvent contenir des balises `<br>` dans les sources.

## Correspondance des produits

| # | ID | Nom FR source | Nom EN | Prix actuel | Fichiers dans `products.js` (public) | Fichiers dans `_products.js` (serveur) | ID Chariow connu | État observé |
|---|---|---|---|---:|---|---|---|---|
| 1 | `550e8400-e29b-41d4-a716-446655440000` | `monétisation TikTok & 10k d'abonnés en 7 jours` | `TikTok monetization and 10,000 followers in 7 days` | 4 200 XOF dans les deux sources | `BONUS Le secret pour transformer tes vidéos en cash.pdf`; `PLAN 0 A 10K ABONNES EN 30 JOURS.pdf`; `video_cree_tiktok_monetise.mp4` | `BONUS Le secret pour transformer tes vidéos en cash.pdf`; `PLAN 0 A 10K ABONNES EN 30 JOURS.pdf` | `prd_5lj7fz8k` | Visible et commandable selon les deux règles actuelles; le MP4 n'est référencé que côté public. |
| 2 | `7f9c2b1d-8e4a-4d3f-a9c2-1b5e6f7a8c90` | `Guide Pratique du Marketing avec l’IA` | `Practical Guide to AI Marketing` | 3 000 XOF dans les deux sources | `Guide Pratique du Marketing avec l’IA.pdf` | `Guide Pratique du Marketing avec l’IA.pdf` | `prd_ln1r0vbr` | Visible et commandable selon les deux règles actuelles. |
| 3 | `3b12f1df-5232-4e7a-9f2d-8c1a6b5e4d30` | `Apprendre à rédiger un mémoire universitaire — Licence, Master, Doctorat` | `How to write a university thesis — Bachelor's, Master's, and Doctoral degrees` | 12 000 XOF, public seulement | Aucun fichier renseigné | Produit absent | Aucun renseigné | Visible dans le catalogue public, non commandable (`fichier` vide). L'état de vente Chariow n'est pas établi. |
| 4 | `a8d7c6b5-4e3f-42a1-b9c8-7d6e5f4a3b21` | `GUIDE CANVA PRO GRATUIT A VIE` | `CANVA PRO GUIDE — FREE FOR LIFE` | 25 000 XOF, public seulement | Aucun fichier renseigné | Produit absent | Aucun renseigné | Visible dans le catalogue public, non commandable (`fichier` vide). L'état de vente Chariow n'est pas établi. |
| 5 | `91e2d3c4-5f6a-4789-ab01-23456789cdef` | `Apprendre les bases de la crypto-monnaie et du Trading` | `Cryptocurrency and Trading Basics` | 30 000 XOF, public seulement | Aucun fichier renseigné | Produit absent | Aucun renseigné | Visible dans le catalogue public, non commandable (`fichier` vide). L'état de vente Chariow n'est pas établi. |

### Traductions et descriptions actuelles

`fr.json` ne contient pas de section `products`. Les textes français affichés proviennent donc des propriétés `nom` et `description` de `products.js`. `en.json` contient les noms et descriptions anglaises des cinq produits. Le catalogue serveur ne contient ni traduction ni description.

- **Produit 1, FR** : description complète du guide TikTok Cash, de l'atteinte de 10 000 abonnés, des bonus « Secret Vidéo en Cash », « Agenda du Succès », templates viraux, radar à tendances et tableau de bord. Texte source dans `public/assets/js/products.js`.
- **Produit 1, EN** : traduction complète commençant par « A PDF guide to creating and activating your monetized TikTok account, step by step. »; elle décrit le guide TikTok Cash et les cinq bonus correspondants. Texte dans `public/locales/en.json` sous l'ID du produit.
- **Produit 2, FR** : description du guide de marketing avec l'IA : automatisation, analyse client, création de contenu, ciblage, conversions et marque. Texte source dans `public/assets/js/products.js`.
- **Produit 2, EN** : traduction complète commençant par « Master modern marketing with the power of AI. »; elle décrit les mêmes axes d'apprentissage. Texte dans `public/locales/en.json` sous l'ID du produit.
- **Produit 3, FR/EN** : description FR `Stock Disponible bientot...`; description EN `Coming soon.`.
- **Produit 4, FR/EN** : description FR `Stock Disponible bientot...`; description EN `Coming soon.`.
- **Produit 5, FR/EN** : description FR `Stock Disponible bientot...`; description EN `Coming soon.`.

Les traductions anglaises sont des contenus éditoriaux à conserver lors de la migration, pas des valeurs à reconstituer à partir des noms français. Pour le français, les descriptions originales sont les chaînes complètes du catalogue JS, y compris les retours HTML actuels.

## Différences entre les deux catalogues

1. Les catalogues partagent exactement les IDs 1 et 2; les noms et prix de ces deux entrées concordent.
2. Le catalogue public compte cinq produits, le serveur seulement deux. Les produits 3 à 5 ne peuvent donc pas être rapprochés d'un produit Chariow à partir du dépôt.
3. Pour le produit 1, le frontend annonce trois fichiers, dont un MP4, tandis que le serveur ne connaît que deux PDF. Il n'est pas établi si la vidéo est effectivement livrée par Chariow.
4. Pour le produit 2, le fichier associé concorde.
5. Le catalogue public porte les images, catégories et descriptions; les champs `image` et `categorie` sont vides de sens côté serveur puisqu'ils n'y existent pas. Les cinq catégories publiques sont des chaînes vides.
6. Le serveur porte `chariowProductId` et `fichiers`, absents du catalogue public.
7. Aucun catalogue ne comporte de champ de publication. Les informations de traduction sont séparées des données produits uniquement pour l'anglais.

## Règles actuelles de visibilité et de disponibilité

- **Boutique** : `app.js` utilise `Boolean(product.fichier)`. Les cinq produits du tableau sont rendus dans le catalogue public; les deux premiers sont considérés disponibles, les trois derniers apparaissent indisponibles / bientôt disponibles.
- **Paiement** : `create-payment.js` trouve le produit dans `_products.js`, puis exige un prix entier strictement positif, une liste `fichiers` non vide et un `chariowProductId`. L'absence de produit serveur retourne 404; un produit incomplet retourne 400.
- **Distinction à préserver** : « publié/visible dans la boutique » et « commandable » sont deux états différents dans le comportement actuel. Les produits 3 à 5 sont visibles sans être achetables.

Règle cible proposée, à confirmer : `publie` contrôle l'apparition dans la boutique; l'éligibilité au paiement est calculée côté serveur à partir de `publie`, du prix valide, de références de livraison existantes et d'un ID Chariow connu. Ne pas considérer le seul champ `publie` comme preuve qu'un produit est livrable.

Pour reproduire la visibilité présente à la date de migration, la proposition serait de publier les cinq entrées, tout en laissant les produits 3 à 5 non commandables. Cette initialisation doit être approuvée explicitement; elle ne doit pas être exécutée implicitement.

## Schéma de produit proposé

```json
{
  "id": "UUID existant ou nouvel UUID approuvé",
  "nom": {
    "fr": "Nom français",
    "en": "English name"
  },
  "description": {
    "fr": "Description française",
    "en": "English description"
  },
  "prix": {
    "montant": 4200,
    "devise": "XOF"
  },
  "image": "assets/images/1.jpg",
  "categorie": "",
  "publie": true,
  "chariowProductId": "ID existant uniquement si confirmé",
  "fichiers": ["références de livraison existantes uniquement"],
  "createdAt": "date ISO ajoutée lors de la migration",
  "updatedAt": "date ISO ajoutée lors d'une modification"
}
```

Les champs d'audit temporels sont proposés pour le suivi des modifications; leurs valeurs historiques ne sont pas disponibles et ne doivent pas être inventées. Le prix courant est exprimé en XOF dans les deux catalogues. Aucun autre prix ou devise produit n'est établi ici.

## Données publiques et données serveur

**Projection publique recommandée** : `id`, noms et descriptions localisés, prix et devise, chemin d'image, catégorie et uniquement les produits publiés. Si nécessaire pour conserver l'affichage « bientôt disponible », retourner un indicateur public dérivé de l'éligibilité, sans retourner les détails privés qui le déterminent.

**À conserver côté serveur** : `chariowProductId`, `fichiers`, indicateurs internes de configuration et tout secret de fonction. `chariowProductId` et les noms de fichiers ne sont pas des clés secrètes en soi, mais ils servent à la liaison de paiement/livraison et n'ont pas besoin d'être exposés par l'API du catalogue public. Les fichiers numériques eux-mêmes ne sont pas des champs à déplacer dans le catalogue ni à publier; le présent inventaire ne les ouvre, ne les déplace et ne les copie pas.

Le champ de publication doit être vérifié par l'API publique et par la fonction de commande. Masquer un lien dans la boutique ne protège pas un checkout direct.

## Stratégie de migration vers Netlify Blobs

1. Confirmer les décisions listées ci-dessous avant d'écrire des données.
2. Utiliser un store **site-wide** via `getStore`, afin que le catalogue survive aux nouveaux déploiements; ne pas utiliser `getDeployStore` pour les données éditables du catalogue.
3. Pour ce petit volume, stocker une structure JSON versionnée dans une clé fixe du store, par exemple `catalog-v1`. Le nom de store et la clé sont des choix de conception à valider avant implémentation.
4. Construire un jeu de migration à partir des données source examinées, rapprocher les cinq IDs et vérifier les références de livraison sans modifier les fichiers d'ebooks.
5. Écrire les données seulement après validation; prévoir sauvegarde/export avant migration et éviter une réécriture silencieuse lors des prochains déploiements.
6. Les futurs endpoints d'administration lisent/écrivent le store après vérification serveur du rôle. L'endpoint public ne renvoie qu'une projection filtrée. La fonction de paiement lit les champs serveur de la même source; aucune modification de l'appel API Chariow ou du parcours de livraison n'est impliquée par ce document.
7. Protéger les réécritures du blob contre les écrasements concurrents (par exemple avec les ETags/écritures conditionnelles de Blobs) et utiliser une lecture à cohérence forte pour une vérification d'éligibilité au paiement qui doit voir immédiatement un masquage.

## Informations à confirmer avant migration

- Pour le produit 1, le MP4 `video_cree_tiktok_monetise.mp4` est-il effectivement livré à l'acheteur? Si oui, par quel canal et doit-il être ajouté à la liste serveur? Ne pas le supposer ni modifier la liste de livraison sans validation.
- Pour les produits 3, 4 et 5, existent-ils déjà dans Chariow? Si oui, fournir les IDs Chariow exacts; sinon, confirmer qu'ils restent non commandables. Aucun ID Chariow n'est déduit ou inventé dans ce plan.
- Les prix actuels des produits 3 à 5 (12 000, 25 000 et 30 000 XOF) sont-ils toujours voulus, bien qu'aucun ne soit commandable dans le catalogue serveur?
- Les cinq produits doivent-ils tous rester visibles pendant la migration, y compris les trois actuellement marqués « bientôt disponibles »?
- Les textes français et anglais des cinq produits sont-ils approuvés tels quels? Les catégories vides doivent-elles le rester ou être renseignées?
- Confirmer que le catalogue ne stockera que des références aux fichiers de livraison, et non les ebooks ni leur contenu.

## Fichiers fonctionnels concernés lors d'une étape ultérieure

Ce document ne les modifie pas. Une implémentation approuvée pourrait ensuite créer une interface `public/admin.html` et ses assets, une fonction de lecture publique, des fonctions d'administration authentifiées et un module d'accès Blobs partagé. Elle devrait adapter `public/assets/js/app.js` et `public/assets/js/products.js` pour la lecture du catalogue commun, ainsi que `netlify/functions/_products.js` et `create-payment.js` pour la lecture serveur cohérente. L'appel Chariow, la livraison et le panier restent hors de ce travail de conception; toute modification ultérieure nécessaire à la cohérence du catalogue devra être isolée et approuvée séparément.
