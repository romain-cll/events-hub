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

Le type à viser dépend de la question :

| Question | Type |
|---|---|
| Nouveaux clients | `stripe.subscription.started` |
| Revenu récurrent | `stripe.subscription.renewed` |
| Expansion / contraction | `stripe.subscription.changed` |
| Paiement ponctuel | `stripe.checkout.session.completed` |

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

## La lecture : `GET /v1/projects/:id/revenue/campaigns`

Le revenu croisé à l'acquisition, et **une seule question à la fois**. `kind`
choisit le type additionné — `new`, `recurring`, `change`, `one_time` — et la
réponse rend le type retenu dans `eventType` : un chiffre dont on ne peut pas
nommer l'origine ne vaut pas mieux qu'un chiffre faux.

La campagne rendue est celle de la **première visite** du visiteur, pas de celle
où il a payé. C'est un modèle d'attribution assumé — *first touch* — et il
répond à « quelle campagne m'amène des clients », pas à « quelle page a conclu ».
Elle est **lue** à chaque appel, jamais gelée sur l'événement : `attribute()`
rattache des paiements rétroactivement, donc la première visite d'un visiteur
devient légitimement connaissable après coup.

Trois listes, et les deux dernières ne sont pas un reste :

| Liste | Ce qu'elle porte |
|---|---|
| `campaigns` | le classement, coupé à `limit` |
| `direct` | des visiteurs **connus**, venus sans campagne |
| `unattributed` | des paiements qu'aucun parcours ne réclame |

Les afficher ensemble est la condition pour que le classement soit lisible :
annoncer « 12 k€ venus de Google » sans dire que 30 k€ ne sont rattachés à rien
fait lire une part comme un total.

Les montants sortent **en centimes, par devise**, tels que Stripe les écrit.
Deux devises font deux lignes : les additionner demanderait un taux de change,
donc une date de taux, donc une décision qui n'appartient pas à ce module.

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
