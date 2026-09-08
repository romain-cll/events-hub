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

Ce module lit la première, et va chercher la seconde quand la première est vide.
Il transmet la valeur **brute** au socle, qui en dérive la clé : la corrélation
est calculée à un seul endroit, et ce module ne tient jamais de clé visiteur.

Pas de consentement, pas de `eh_visitor_id`, donc pas d'attribution. Le paiement
est écrit quand même — il compte dans le revenu, il n'est simplement rattaché à
aucun parcours.

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
