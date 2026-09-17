# Ce que la page « audience × revenu » doit porter

L'écran qui reprend **toute** l'analytics web et l'enrichit du revenu. Il ne
remplace pas l'inventaire de `croisements-revenu.md` : celui-ci dit ce qu'on doit
pouvoir savoir, celui-là dit ce qu'**une page** en montre, et dans quel ordre.

Établi le 11/09/2026, avant la maquette.

## L'état des données

- ✅ lisible avec les routes d'aujourd'hui
- 🟡 lecture à écrire, la donnée est en base
- 🔴 donnée manquante

Un seul 🔴 dans toute la page. Tout le reste existe et attend une lecture — ce
qui veut dire que la maquette peut être dessinée **comme si tout était vert**, et
que c'est elle qui décidera des lectures à écrire.

## 1. Bandeau — l'état en dix secondes

Visiteurs uniques ✅ · sessions ✅ · pages vues ✅ · temps actif ✅ · rebond ✅
Revenu de la période, par devise 🟡 · clients payants 🟡 · nouveaux abonnés ✅ ·
résiliations ✅ · **part du revenu attribuée** 🟡

## 2. Le temps

Trafic et revenu sur **un seul graphique**, à deux échelles ✅ · marqueurs de
déploiement ✅ · saisonnalité des renouvellements ✅

⚠️ **Cette section disait le contraire, et la règle a été levée sciemment.** Elle
posait « le revenu à côté, jamais superposé — jamais deux axes Y », et la raison
tient toujours : deux échelles arbitraires laissent croire qu'un croisement des
tracés veut dire quelque chose, alors que déplacer l'une des deux le déplace
aussi.

Les deux ont été réunis parce qu'un seul dessin répond mieux à la question qu'on
vient poser — *ce pic de trafic a-t-il rapporté ?* — et quatre choix rendent la
lecture honnête à défaut d'être neutre : des **barres** pour le revenu contre un
**trait** pour le trafic, deux formes que l'œil ne compare pas point par point ;
chaque axe de la couleur de sa série ; le revenu derrière ; et aucune aire
dégradée, qui noierait les barres.

La courbe de la période précédente est tombée avec : trois tracés sur un dessin
qui porte deux échelles, c'était le tracé de trop. L'écart reste annoncé en
chiffres par le bandeau. Voir `apps/web/src/components/traffic-revenue-chart.tsx`,
où la décision vit.

## 3. Acquisition — la section qui porte la page

Un seul tableau, une ligne par source / referrer / campagne UTM, et six
colonnes : visiteurs ✅ · sessions ✅ · clients 🟡 · taux de conversion 🟡 ·
revenu ✅ pour les campagnes, 🟡 pour les sources · **revenu par visiteur** 🟡 —
c'est lui qui révèle la source à faible volume et forte valeur, que le revenu
absolu enterre.

Plus : premier contact contre dernière visite, et **l'écart entre les deux**,
qui est lui-même une lecture 🟡 · landing pages enrichies pareil 🟡 · pays et
langue pareil 🟡

## 4. Conversion

Délai premier contact → achat, en distribution 🟡 · sessions avant achat, en
distribution 🟡 · pages vues avant achat 🟡 · **lift des pages chez les
convertisseurs** 🟡 · entonnoir visite → tarifs → checkout → payé 🟡 · clics
sortants vers le paiement sans paiement derrière ✅

Jamais une moyenne seule : ces distributions sont toutes à queue lourde, et la
moyenne y décrit un client qui n'existe pas.

## 5. Qui ils sont

Pays / région / ville ✅ · navigateur / OS / appareil ✅ · langue 🟡 · taille
d'écran 🟡 · nouveaux contre revenants 🟡

**Chacun filtrable payant / non payant** 🟡 — c'est ce filtre qui transforme une
analytics web en analytics de revenu, et il vaut à lui seul plusieurs des
lectures ci-dessus.

## 6. Rétention & valeur

Cohortes en heatmap triangulaire ✅ · mouvements d'abonnement en barres ✅ ·
**LTV par visiteur en histogramme** 🟡 · LTV par source 🟡 · churn par source 🟡
· statut d'abonnement courant 🟡 · décomposition du MRR en waterfall 🟡 ·
comportement après l'achat, revenir ou disparaître 🟡

## 7. Où ils vont

Pages d'entrée ✅ · pages de sortie ✅ · séquences de pages fréquentes chez les
convertisseurs 🟡 · événements métier croisés au revenu 🟡

## 8. Qualité de la mesure — en pied de page, jamais cachée

Part non attribuée ouverte en **trois causes** qui n'appellent pas la même
action : client antérieur à l'installation, refus de consentement, metadata
manquante 🟡 · écart entre le revenu Stripe total et le revenu attribué 🟡 ·
liste actionnable des clients sans metadata, seule cause réparable 🟡 · sessions
de robots écartées ✅ · taux de consentement 🔴

Annoncer un revenu attribué sans dire quelle part échappe à la mesure est un
mensonge par omission.
