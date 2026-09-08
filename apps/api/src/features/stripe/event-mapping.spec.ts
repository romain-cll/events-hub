import type Stripe from 'stripe';

import { customerIdOf, occurredAtOf, propertiesOf, typeOf } from './event-mapping';

/**
 * La traduction du vocabulaire Stripe, et rien d'autre.
 *
 * Fonctions pures : ni base, ni réseau, ni Stripe. Ce qui se joue ici est une
 * question de **sens** — un renouvellement n'est pas un nouveau client — et une
 * erreur y produirait une donnée plausible et fausse, que rien d'autre
 * n'attraperait.
 */

const evenement = (
  type: string,
  object: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Stripe.Event =>
  ({
    id: 'evt_1',
    type,
    created: 1_788_000_000,
    livemode: false,
    data: { object },
    ...extra,
  }) as unknown as Stripe.Event;

describe('typeOf', () => {
  it('laisse passer un type Stripe inconnu, préfixé', () => {
    // La promesse du socle vaut aussi ici : accueillir un nouvel événement
    // Stripe ne doit demander aucun code.
    expect(typeOf(evenement('charge.dispute.funds_withdrawn'))).toBe(
      'stripe.charge.dispute.funds_withdrawn',
    );
  });

  it.each([
    ['subscription_create', 'stripe.subscription.started'],
    ['subscription_cycle', 'stripe.subscription.renewed'],
    ['subscription_update', 'stripe.subscription.changed'],
  ])('distingue %s', (reason, attendu) => {
    // Le cœur du fichier. `invoice.paid` recouvre trois faits qui n'ont pas le
    // même sens : les confondre ferait passer une expansion pour de la
    // récurrence, et fausserait « d'où viennent les nouveaux clients ».
    expect(
      typeOf(evenement('invoice.paid', { billing_reason: reason })),
    ).toBe(attendu);
  });

  it('retombe sur le pass-through pour une raison qu’on n’interprète pas', () => {
    // `manual` et `subscription_threshold` existent. Leur inventer un type
    // figerait une interprétation que personne n'a encore.
    expect(typeOf(evenement('invoice.paid', { billing_reason: 'manual' }))).toBe(
      'stripe.invoice.paid',
    );
  });

  it('ne s’émeut pas d’une facture sans raison de facturation', () => {
    expect(typeOf(evenement('invoice.paid', {}))).toBe('stripe.invoice.paid');
  });
});

describe('propertiesOf', () => {
  it('garde de quoi identifier, compter et distinguer test de production', () => {
    const properties = propertiesOf(
      evenement(
        'invoice.paid',
        {
          id: 'in_1',
          amount_paid: 4900,
          currency: 'eur',
          customer: 'cus_1',
          billing_reason: 'subscription_cycle',
        },
        { livemode: true },
      ),
    );

    expect(properties).toMatchObject({
      'stripe.event.id': 'evt_1',
      'stripe.object.id': 'in_1',
      'stripe.customer.id': 'cus_1',
      'stripe.billing_reason': 'subscription_cycle',
      'stripe.livemode': true,
      // En centimes, comme Stripe les donne : convertir ici ferait entrer des
      // flottants dans une donnée comptable.
      'payment.amount': 4900,
      'payment.currency': 'eur',
    });
  });

  it.each([
    ['amount_paid', { amount_paid: 100, currency: 'eur' }],
    ['amount_total', { amount_total: 100, currency: 'eur' }],
    ['amount', { amount: 100, currency: 'eur' }],
  ])('trouve le montant dans %s', (_champ, object) => {
    // Stripe n'a pas d'objet « paiement » unique : trois champs pour la même
    // question, selon la nature de l'objet.
    expect(propertiesOf(evenement('x', object))['payment.amount']).toBe(100);
  });

  it('n’invente pas de montant quand il n’y en a pas', () => {
    const properties = propertiesOf(evenement('customer.subscription.updated'));

    // Un abonnement mis à jour n'est pas un encaissement. Poser un montant à
    // zéro le ferait entrer dans les lectures de revenu.
    expect(properties).not.toHaveProperty('payment.amount');
    expect(properties).not.toHaveProperty('payment.currency');
  });
});

describe('customerIdOf', () => {
  it('accepte l’identifiant comme l’objet développé', () => {
    expect(customerIdOf({ customer: 'cus_1' })).toBe(
      'cus_1',
    );
    expect(
      customerIdOf({ customer: { id: 'cus_2' } }),
    ).toBe('cus_2');
  });

  it('rend undefined plutôt que de deviner', () => {
    expect(customerIdOf({})).toBeUndefined();
    expect(
      customerIdOf({ customer: null }),
    ).toBeUndefined();
  });
});

describe('occurredAtOf', () => {
  it('convertit les secondes de Stripe en instant', () => {
    // Stripe date en secondes, `Date` en millisecondes. L'oublier place tous
    // les paiements en 1970 — et les sort de toutes les fenêtres de lecture.
    expect(occurredAtOf(evenement('x')).toISOString()).toBe(
      new Date(1_788_000_000_000).toISOString(),
    );
  });
});
