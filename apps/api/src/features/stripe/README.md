# `features/stripe`

Transforme les webhooks d'un compte Stripe connecté en événements du hub.

## Le piège, et il coûtera cher à qui l'oublie

**Un seul paiement déclenche plusieurs événements Stripe.** Un checkout par carte
en produit couramment quatre : `payment_intent.succeeded`, `charge.succeeded`,
`invoice.paid`, `checkout.session.completed`. Tous portent un montant. Tous sont
stockés, et c'est voulu — on ne sait pas d'avance lequel un client voudra lire.

Conséquence : **une lecture de revenu doit viser un type précis**, jamais « tout
ce qui porte `payment.amount` ». Sinon le même euro est compté quatre fois, le
résultat reste plausible, et rien ne le signale.

L'affinage fait à l'ingestion rend ces types **disjoints**, et c'est ce qui
permet de les sommer :

| Type | Ce qu'il porte |
|---|---|
| `stripe.subscription.started` | premier paiement d'un abonnement |
| `stripe.subscription.renewed` | renouvellement |
| `stripe.subscription.changed` | montée ou descente de gamme |
| `stripe.invoice.paid` | les autres `billing_reason` — `manual`, seuils |
| `stripe.payment.one_time` | achat ponctuel pur |

Les quatre premiers viennent tous d'`invoice.paid`, que Stripe distingue
lui-même par `billing_reason` : **une facture n'en porte qu'un**. Le cinquième
est le checkout `mode: 'payment'`, isolé par `typeOf` — sans cet affinage il se
confondrait avec le checkout qui ouvre un abonnement, dont le montant est déjà
compté par `subscription.started`.

Ce qui reste hors du total, délibérément : `payment_intent.succeeded`,
`charge.succeeded` et `checkout.session.completed` en `mode: 'subscription'`,
qui sont les doublons du même euro.

⚠️ **Rupture de série** : les `checkout.session.completed` écrits avant cet
affinage gardent leur type. Les paiements ponctuels antérieurs restent donc hors
du total, et le rattrapage ne les récupère pas — il ne rejoue que des factures.

## Ce que Stripe tranche, et ce qu'il ne tranche pas

`billing_reason` distingue lui-même un premier abonnement d'un renouvellement et
d'un changement de plan. On ne le déduit pas : deviner à partir de « ce visiteur
a-t-il déjà payé » se trompe dans les deux sens — deux achats ponctuels
distincts passeraient pour un renouvellement, et un renouvellement sans metadata
pour un nouveau client.

En revanche, Stripe ne dit rien pour un **paiement ponctuel** : « nouveau client »
y est une question de **lecture** — est-ce le premier paiement de ce
`stripe.customer.id` sur la fenêtre — et non un type. La figer à l'ingestion la
rendrait fausse au premier rattrapage d'historique.

## L'attribution

Le site client pose `eh_visitor_id` dans la `metadata` de ses objets Stripe. Deux
endroits, et le second est celui qui compte :

- la **Checkout Session**, posée pendant la visite : attribue le premier paiement ;
- le **Customer**, qu'il faut poser aussi : sans lui, un renouvellement facturé
  des mois plus tard n'a plus aucun navigateur derrière lui, et la LTV tombe à
  côté.

La valeur brute est transmise au socle, qui en dérive la clé. Ce module ne tient
jamais de clé visiteur, et ne saurait pas en fabriquer une.

Pas de consentement, pas de `eh_visitor_id`, donc pas d'attribution. Le paiement
est écrit quand même — il compte dans le revenu, il n'est simplement rattaché à
aucun parcours. Et cet état **reste réparable** : voir plus bas.

## La paire client ↔ visiteur, et pourquoi elle est retenue

La première version interrogeait Stripe à chaque événement pour lire la metadata
du client. Éprouvée sur un vrai abonnement, elle attribuait **deux événements sur
douze**.

La cause était une course : un site pose l'identifiant sur son client *après* le
checkout, or les webhooks du paiement arrivent avant. On lisait un client encore
vide, deux secondes trop tôt — et c'est le paiement, le seul qui compte, qui
repartait muet pendant que les événements sans intérêt étaient rattachés.

`stripe_customers` retient la paire dès qu'un événement l'affirme. Trois
conséquences :

- l'ordre d'arrivée des webhooks n'a plus d'importance ;
- les renouvellements et les actions du portail, qui n'ont jamais de metadata
  propre, sont attribués par le client ;
- **ce qui a déjà été écrit est rattrapé** — `stripe_webhook_events` sert d'index
  du client vers nos événements, et le socle les attribue rétroactivement. Y
  compris des clients antérieurs à l'installation, le jour où leur metadata
  arrive.

L'attribution rétroactive **n'écrase jamais** : une identité affirmée à
l'ingestion l'emporte sur une identité déduite après coup.

## Le trou connu

`invoice_payment.paid` ne référence que la facture, jamais le client. Il n'y a
donc rien à interroger, et il restera inattribuable — sans conséquence, il fait
doublon avec `invoice.paid`, qui porte le même montant et le même client.

## Idempotence

Stripe rejoue ses webhooks sur timeout, sur 5xx, et par prudence. `stripe_webhook_
events` réserve l'`evt_…` avant l'écriture, et la clé primaire fait l'arbitrage —
deux livraisons concurrentes ne peuvent pas gagner toutes les deux. Un échec
d'écriture relâche la réservation, sans quoi le rejeu de Stripe, seul filet
restant, serait pris pour un doublon.

## L'état d'abonnement, projeté

Le flux d'événements ne contient **rien d'antérieur à la connexion** : un client
abonné depuis deux ans n'a produit aucun `subscription.started` chez nous. Aucune
lecture de rétention, de cohorte ou de churn ne tient sans un état courant, d'où
deux tables — `stripe_subscriptions` et `stripe_subscription_items`.

La charge utile du webhook **est** l'objet `Subscription`, items compris : la
projection ne fait aucun appel sortant. Elle recopie, change les secondes en
instants, et rien d'autre.

Trois choses à ne pas défaire :

- **`observedAt` est le garde-fou d'ordre.** Stripe ne garantit pas l'ordre de
  livraison et `Subscription` n'a pas de champ de version. L'upsert ne s'applique
  que si `event.created` est plus récent que l'observation en base — sans quoi un
  `.updated` en retard ressuscite un abonnement résilié.
- **Les items sont remplacés, pas fusionnés.** Un downgrade fait disparaître une
  ligne ; une fusion la laisserait avec son ancien montant, sans rien casser.
- **`deleted` ne supprime rien.** Stripe envoie `status: 'canceled'` et son
  `ended_at` : c'est exactement la ligne dont le churn a besoin.

La projection vit dans le bloc « après l'écriture » de `handle()`, avec le
rattrapage : elle est réparable, un paiement écrit deux fois ne l'est pas.

⚠️ Prérequis opérationnel : cocher `customer.subscription.*` sur l'endpoint
Connect. Le pass-through les laisse déjà traverser le fil, mais rien n'arrive
tant qu'ils ne sont pas souscrits.

## La lecture : `GET /v1/projects/:id/revenue/attribution`

D'où vient l'argent, rangé de **quatre façons à la fois** : par campagne, par
provenance, par page d'entrée et par pays. Une seule route parce que la carte
Acquisition les affiche ensemble — quatre appels laisseraient leurs totaux
diverger dès qu'un paiement arrive entre deux.

Il n'y a **pas de `kind`** : les cinq types sommés sont disjoints (voir plus
haut), et l'analyse fine du revenu appartient à Stripe. `eventTypes` dit lesquels
ont été retenus, parce qu'un chiffre dont on ne peut pas nommer l'origine ne vaut
rien.

La valeur rendue est celle de la **première visite** du visiteur, pas de celle où
il a payé. Modèle d'attribution assumé — *first touch* — qui répond à « qu'est-ce
qui m'amène des clients », pas à « quelle page a conclu ». Elle est **lue** à
chaque appel, jamais gelée : `attribute()` rattache des paiements
rétroactivement, donc la première visite devient légitimement connaissable après
coup.

**Rien n'est recopié pour ça.** La campagne et le pays sont des colonnes de la
visite ; le referrer et le chemin d'entrée vivent dans le sac du premier
événement, et le Core les groupe à la clé qu'on lui nomme — comme il groupe déjà
un montant. Deux `lateral` enchaînés, servis par les index existants.

Le repli des provenances (`google.fr` + `google.com` → une ligne) se fait **après
coup**, avec `classifyReferrer` de `features/analytics` : la règle de classement
reste écrite une seule fois. Conséquence à connaître : `visitors` y est un
**majorant**, un même visiteur pouvant apparaître derrière deux referrers du même
moteur. Les montants, eux, sont exacts.

Chaque axe rend trois ensembles, et les deux derniers ne sont pas un reste :

| Ensemble | Ce qu'il porte |
|---|---|
| `rows` | le classement, coupé à `limit` |
| `direct` | des visiteurs **connus**, sans valeur sur cet axe |
| `unattributed` | des paiements qu'aucun parcours ne réclame |

Les afficher ensemble est la condition pour que le classement soit lisible :
annoncer « 12 k€ venus de Google » sans dire que 30 k€ ne sont rattachés à rien
fait lire une part comme un total.

Les montants sortent **en centimes, par devise**, tels que Stripe les écrit.
Deux devises font deux lignes : les additionner demanderait un taux de change,
donc une date de taux, donc une décision qui n'appartient pas à ce module.

⚠️ Les filtres `country`, `landing`, `source` et `campaign` sont **déclarés et
sans effet** : la forme est posée pour que la page puisse se filtrer sans rouvrir
le contrat. Un e2e vérifie qu'ils ne changent rien, pour qu'on ne croie pas
qu'ils agissent.

## L'historique du montant, écrit avant d'être lu

`stripe_subscription_revisions` note une ligne chaque fois que le montant
mensuel d'un abonnement **ou son statut** change. Elle existe alors qu'aucune
lecture ne s'en sert encore, et c'est délibéré.

Le MRR courant se calcule à tout moment depuis les deux tables d'abonnement. Sa
**décomposition** — ce qui l'a fait bouger — demande l'écart entre deux instants,
et cet écart n'est reconstructible nulle part : Stripe n'expose aucun état passé,
son API Events ne remonte que trente jours, et notre projection écrase l'ancien
montant à chaque mise à jour. **Chaque mois sans cette table est un mois absent
du waterfall pour toujours.**

Trois choses à savoir avant de la lire :

- **On range des faits, pas des causes.** Un avant, un après, un statut.
  « Expansion », « churn » et « nouveau » se déduisent des deux montants ; les
  figer en base les trancherait avant que la lecture ait dit ce dont elle a
  besoin.
- **`monthlyBefore` à `null` n'est pas zéro** : le premier dit que l'abonnement
  n'existait pas, le second qu'il ne valait rien.
- **Une résiliation ne met pas le montant à zéro.** Stripe renvoie l'abonnement
  avec ses prix et le statut `canceled` : c'est ce qu'on recopie. C'est à la
  lecture de décider qu'un `canceled` ne compte pas — et c'est pour ça que le
  statut est stocké, et qu'un changement de statut seul suffit à écrire une
  ligne.

Le montant mensualisé vient de `monthlyAmountOf` — la formule de Stripe, annuel
÷ 12, trimestriel ÷ 3 — **hors remises, taxes et proration**, qui dépendent de la
facture et pas de l'abonnement. L'écran qui affichera le MRR doit le dire à côté
du chiffre.

⚠️ **L'historique démarre à la mise en service.** Les abonnements déjà en base
n'auront de révision qu'à leur premier changement : la courbe partira plate, et
ce n'est pas une panne. Le passé ne se rattraperait qu'en repartant des factures.

## Les lectures de rétention

`GET /revenue/cohorts` — la matrice triangulaire. Une ligne par mois de
**première visite**, une colonne par mois écoulé depuis.

Trois choses qui se lisent de travers si on ne les dit pas :

- **la courbe peut monter.** La cohorte est celle de l'acquisition, pas de
  l'abonnement : quelqu'un vu en mars qui s'abonne en juin n'apparaît qu'en M+3.
  C'est le délai de conversion, et c'est ce qu'une cohorte d'abonnement masque en
  partant de 100 % par construction ;
- **`null` n'est pas zéro** — le mois n'est pas écoulé ;
- **`unmeasured`** compte les clients sans première visite connue. Une matrice
  qui couvre un tiers des clients ressemble, sans lui, à une matrice complète.

`GET /revenue/movements` — entrées, sorties, solde, par mois. **Aucun taux** : le
churn se divise d'au moins trois façons défendables, et en figer une priverait
les autres de leurs termes. `active` n'est pas le cumul des mouvements — un
abonnement pris et résilié dans le même mois compte dans les deux et dans aucun
solde.

La cohorte traverse le socle (`CoreService.firstVisits` : identifiants bruts en
entrée, dates en sortie — la clé ne sort pas). Les mouvements, non : ils ne
parlent que de dates d'abonnement, qui sont nos tables.

⚠️ L'état d'abonnement est une **approximation connue** : Stripe n'expose aucun
historique de statut, donc une pause ne produit ni sortie ni entrée, et un
abonnement suspendu puis repris compte comme actif tout du long.

## Le rattrapage : `POST /v1/projects/:id/revenue/sync`

Brancher un compte n'importe rien du passé. Cette route le rattrape, et sert
aussi de bouton « resynchroniser ». Elle vit ici et pas dans le callback OAuth
parce qu'`integrations.controller.ts` est du socle, et que le socle n'importe
rien de `features/`.

Trois passes, et leur ordre est le sujet :

1. **Les clients**, pour relire les paires `eh_visitor_id` déjà posées — y
   compris sur des clients antérieurs à l'installation. Chaque paire nouvelle
   déclenche l'attribution rétroactive de ce qui est déjà en base, et permet aux
   deux passes suivantes d'attribuer au moment où elles écrivent.
2. **Les abonnements** (`status: 'all'` — un résilié est ce que le churn
   cherche), items repaginés quand la liste dit `has_more` : une réponse de liste
   n'en rend que dix.
3. **Les factures payées**, bornées à `created < connectedAt`. Au-delà, les
   webhooks ont déjà écrit ; la réservation l'empêcherait, mais s'en remettre à
   elle logerait une règle métier dans un mécanisme de secours.

Réservation sous l'**identifiant d'objet** (`in_…`) faute d'`evt_…` : une facture
historique n'a jamais eu d'événement. Les deux espaces de noms ne se croisent
pas.

Entièrement **idempotent** : le rapport rend `skipped`, qui compte les factures
déjà rejouées. Relancer ne double rien.

⚠️ **Fidélité moindre que le direct.** Un checkout vivant produit quatre
événements Stripe, le rejeu n'en produit qu'un par facture — sans quoi le revenu
historique serait quadruplé. Une lecture qui vise `checkout.session.completed` ne
verra donc rien du passé, et `stripe.replayed` le dit sur chaque ligne.

Ce qu'il ne réparera pas : un client dont la metadata n'a **jamais** été posée
reste non attribué. Le rejeu écrit son revenu, il ne lui invente pas une origine.
