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

## Pas encore fait

Le **rattrapage d'historique à la connexion** : brancher un compte n'importe rien
du passé, seuls les événements postérieurs arrivent. Il devra passer par le même
chemin que les webhooks pour rester idempotent par construction.
