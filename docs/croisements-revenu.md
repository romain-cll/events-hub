# Ce qu'on doit rendre lisible : analytics web × paiements

Inventaire des croisements qui répondent à la question du produit — **qu'est-ce
qui a un impact sur le revenu ?** Ce fichier ne décrit aucun écran : il liste ce
qu'un client doit pouvoir savoir de ses visiteurs, de ceux qui rapportent, d'où
ils viennent et où ils vont. Les écrans viennent après, et n'en prendront qu'une
partie à la fois.

Établi le 11/09/2026.

## Les cinq qui portent le reste

Si on n'en construit que cinq, ce sont ceux-là — chacun répond à une décision que
le client prend vraiment.

1. **LTV par source d'acquisition** — pas le premier paiement, la valeur vie.
2. **Taux de conversion visiteur → client par source** — le volume ne dit rien.
3. **Délai premier contact → achat**, en distribution.
4. **Lift des pages chez les convertisseurs** — pas les plus vues, les
   sur-représentées.
5. **Rétention par cohorte d'acquisition.**

## Une règle qui prime sur l'inventaire

**Les données Stripe sont stockées sans transformation.** Aucun montant
recalculé, aucun agrégat dérivé qui pourrait diverger de ce que Stripe affiche.

La raison n'est pas technique : un client qui voit un écart de MRR entre son
tableau de bord Stripe et le nôtre conclut que c'est le nôtre qui ment — et il a
raison de le conclure, puisqu'il n'a aucun moyen de trancher. Un chiffre faux
coûte moins cher qu'un chiffre qu'on ne peut pas expliquer.

Ce que ça implique là où Stripe n'expose pas la métrique par API (le MRR en est
le cas type) : ou bien on ne l'affiche pas, ou bien on l'affiche en nommant la
formule et en la réconciliant. Jamais un chiffre dont l'origine se devine.

## D'où ils viennent

- Revenu et **LTV** par domaine référent de **premier** contact
- Idem par **dernière** visite, et l'écart entre les deux modèles d'attribution —
  cet écart est lui-même une lecture : il dit à quel point le choix du modèle
  change les conclusions
- Revenu par **campagne UTM** (`source` / `medium` / `campaign`)
- Revenu par **landing page** — la première page de la première session
- Revenu par **pays, région, ville** — déjà porté par `sessions`
- Revenu par **langue** du navigateur
- **Taux de conversion visiteur → client par source**
- **Revenu par visiteur** par source — c'est lui qui révèle la source à faible
  volume et forte valeur, que le revenu absolu enterre
- Coût par acquisition — demande une source de dépense, hors périmètre

## Qui ils sont

- Segmentation **payant / non payant** : tout le reste du produit gagne à être
  filtré là-dessus
- **Distribution** du nombre de sessions avant achat — jamais la moyenne
- Distribution du nombre de pages vues avant achat
- Distribution du **délai premier contact → premier paiement**
- Nouveaux contre revenants, et le revenu de chacun
- **Navigateur, système, type d'appareil** — dérivés du User-Agent, qui n'est
  jamais stocké
- Taille d'écran
- Statut courant : actif, résilié, jamais payé
- **LTV par visiteur**, et sa distribution : quelques clients font tout le
  revenu, une moyenne le cache

## Lesquels rapportent

- **LTV par source**, par landing page, par pays
- **Revenu cumulé par cohorte** d'acquisition (mois de première visite)
- **Rétention par cohorte** : encore abonnés à M+1, M+3, M+6
- **Churn par source** — une source peut convertir fort et churner plus fort
  encore, et c'est invisible sur le seul revenu d'acquisition
- **Décomposition du MRR** : nouveau, expansion, contraction, churn
- Expansion par cohorte : qui monte de plan, et venait d'où
- Temps avant churn croisé au comportement web — a-t-il cessé de visiter avant de
  partir ?

## Où ils vont

- **Lift des pages chez les convertisseurs** : la page la plus vue est presque
  toujours l'accueil, ce qui n'apprend rien. Ce qui apprend, c'est la page
  sur-représentée chez ceux qui paient
- **Entonnoir** visite → tarifs → checkout démarré → payé, avec le taux de chaque
  marche
- Pages de sortie avant abandon de checkout
- **Clics sortants vers le paiement sans paiement derrière** — déjà mesurable,
  `link.origin` le porte
- Séquences de pages les plus fréquentes chez les convertisseurs
- **Événements métier croisés au revenu** : quelle fonctionnalité utilisée
  corrèle avec payer, et avec rester
- Comportement après l'achat : revenir ou disparaître, le meilleur prédicteur de
  churn dont on dispose

## Quand

- Revenu par jour et par heure, **à côté** du trafic — jamais superposé, le
  système de design interdit deux axes Y
- Saisonnalité des renouvellements
- **Impact d'un déploiement sur la conversion** — les deploys sont déjà ingérés,
  et ce croisement est ce qu'aucun outil d'analytics web ne fait
- **Coût d'une erreur ou d'une panne en revenu**, dès que les erreurs seront
  ingérées

## Qualité de la mesure

Elle se montre, elle ne se cache pas. Annoncer un revenu attribué sans dire quelle
part échappe à la mesure est un mensonge par omission.

- Part non attribuée, ouverte en trois causes qui n'appellent pas la même action :
  client antérieur à l'installation, refus de consentement, metadata manquante
- Écart entre le revenu Stripe total et le revenu attribué
- **Liste actionnable des clients sans metadata** — la seule cause réparable
- Taux de consentement, et son effet sur ce qui est visible

## Formes de graphique

- **Barres horizontales triées** pour toute répartition (source, pays, page)
- **Entonnoir** pour les étapes
- **Heatmap triangulaire** pour la rétention par cohorte, courbes cumulées pour
  le revenu par cohorte
- **Waterfall** pour la décomposition du MRR
- **Histogramme** pour les distributions — LTV, délai de conversion, sessions
  avant achat. Jamais une moyenne seule : ces distributions sont toutes à queue
  lourde, et la moyenne y décrit un client qui n'existe pas
- **Nuage de points** pour sessions avant achat × LTV

**Pas de Sankey.** Joli en démonstration, illisible au-delà de trois niveaux. Une
liste de séquences triées dit la même chose et se lit.

## Ce qui manque en données

Par rentabilité décroissante :

1. **Parser les UTM** — débloque toute l'acquisition payante, coût faible
2. **Dériver navigateur et système** du User-Agent, côté serveur, sans jamais le
   stocker
3. **Projeter le statut d'abonnement** courant : les lectures de cohorte, de
   rétention et de churn en dépendent toutes, et le flux d'événements seul ne
   peut pas y répondre — il ne contient rien d'antérieur à la connexion
4. Le coût des campagnes — chantier à part
5. `identify` pour le cross-device — reporté, voir la mémoire du projet
