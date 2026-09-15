import type Stripe from 'stripe';

import {
  attributionOf,
  customerIdOf,
  customerLinkOf,
  customerOf,
  occurredAtOf,
  propertiesOf,
  replayOf,
  typeOf,
} from './event-mapping';

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

describe('customerOf', () => {
  it('trouve le client désigné par l’objet', () => {
    expect(customerOf({ object: 'invoice', customer: 'cus_1' })).toBe('cus_1');
  });

  it('trouve le client quand l’objet **est** le client', () => {
    // `customer.created` et `customer.updated` n'ont pas de champ `customer`.
    // Les traiter comme les autres perdrait les deux seuls événements par
    // lesquels un site annonce l'identité de son client — donc la seule chose
    // qui rende un renouvellement attribuable.
    expect(customerOf({ object: 'customer', id: 'cus_2' })).toBe('cus_2');
  });
});

describe('customerLinkOf', () => {
  const avec = (object: Record<string, unknown>) =>
    customerLinkOf(evenement('x', object));

  it('lit la paire sur un objet qui désigne son client', () => {
    expect(
      avec({
        object: 'checkout.session',
        customer: 'cus_1',
        metadata: { eh_visitor_id: 'v-1' },
      }),
    ).toEqual({ customerId: 'cus_1', visitorId: 'v-1' });
  });

  it('lit la paire sur le client lui-même', () => {
    expect(
      avec({
        object: 'customer',
        id: 'cus_2',
        metadata: { eh_visitor_id: 'v-2' },
      }),
    ).toEqual({ customerId: 'cus_2', visitorId: 'v-2' });
  });

  it('n’affirme rien sans metadata', () => {
    // Un événement sans metadata ne dit pas « pas de visiteur » : il ne dit
    // rien. Le déduire écraserait une paire apprise ailleurs.
    expect(avec({ object: 'invoice', customer: 'cus_1' })).toBeUndefined();
  });

  it('n’affirme rien sans client à qui rattacher', () => {
    expect(
      avec({ object: 'invoice', metadata: { eh_visitor_id: 'v-1' } }),
    ).toBeUndefined();
  });

  it('ignore une metadata vide plutôt que d’apprendre du vide', () => {
    expect(
      avec({ object: 'customer', id: 'cus_3', metadata: { eh_visitor_id: '' } }),
    ).toBeUndefined();
  });
});


describe('attributionOf', () => {
  const VISITEUR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const VISITE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  it('rend l’identité durable quand le site en pose une', () => {
    const { data } = evenement('checkout.session.completed', {
      metadata: { eh_visitor_id: VISITEUR },
    });

    expect(attributionOf(data.object)).toEqual({
      kind: 'visitor',
      visitorId: VISITEUR,
    });
  });

  it('rend la visite quand c’est tout ce que le site a pu poser', () => {
    // Le visiteur n'a pas consenti : pas d'identité durable à joindre, mais la
    // visite pendant laquelle il a payé existe quand même.
    const { data } = evenement('checkout.session.completed', {
      metadata: { eh_session_id: VISITE },
    });

    expect(attributionOf(data.object)).toEqual({
      kind: 'session',
      sessionId: VISITE,
    });
  });

  it('préfère l’identité durable quand les deux sont posées', () => {
    // Le cas d'un site qui câble les deux sans condition, et c'est le bon
    // réflexe de sa part : c'est ici qu'on arbitre, pas chez lui. La visite
    // n'ajouterait rien que la durable ne dise déjà mieux — elle limiterait
    // l'attribution à l'achat immédiat.
    const { data } = evenement('checkout.session.completed', {
      metadata: { eh_visitor_id: VISITEUR, eh_session_id: VISITE },
    });

    expect(attributionOf(data.object)).toEqual({
      kind: 'visitor',
      visitorId: VISITEUR,
    });
  });

  it('ne rend rien quand la metadata est absente ou vide', () => {
    expect(attributionOf(evenement('invoice.paid').data.object)).toBeUndefined();
    expect(
      attributionOf(
        evenement('invoice.paid', { metadata: { eh_session_id: '' } }).data
          .object,
      ),
    ).toBeUndefined();
  });
});

describe('typeOf — le checkout, qui recouvre deux faits', () => {
  const checkout = (mode: string) =>
    evenement('checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      mode,
      amount_total: 4900,
      currency: 'eur',
    });

  it('isole le paiement ponctuel', () => {
    // Sans cet affinage, il faudrait choisir entre compter deux fois
    // l'abonnement et perdre le ponctuel : les deux arrivent sous le même type.
    expect(typeOf(checkout('payment'))).toBe('stripe.payment.one_time');
  });

  it('laisse le checkout d’abonnement à son type', () => {
    // Son montant est déjà compté par la facture, qui produira son propre
    // événement. Le renommer le ferait entrer une seconde fois dans le total.
    expect(typeOf(checkout('subscription'))).toBe(
      'stripe.checkout.session.completed',
    );
    expect(typeOf(checkout('setup'))).toBe(
      'stripe.checkout.session.completed',
    );
  });

  it('recopie le mode, pour que la décision se vérifie', () => {
    expect(propertiesOf(checkout('payment'))).toMatchObject({
      'stripe.checkout.mode': 'payment',
    });
  });
});

describe('replayOf — une facture lue dans l’historique', () => {
  const facture = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'in_1',
      object: 'invoice',
      status: 'paid',
      amount_paid: 4900,
      currency: 'eur',
      billing_reason: 'subscription_cycle',
      customer: 'cus_1',
      livemode: true,
      created: 1_788_000_000,
      status_transitions: { paid_at: 1_788_000_600 },
      metadata: {},
      ...overrides,
    }) as unknown as Stripe.Invoice;

  it('affine le type comme le ferait un webhook', () => {
    // Le rejeu doit produire le **même** type qu'un webhook vivant : deux
    // vocabulaires selon le chemin d'écriture rendraient toute lecture de
    // revenu dépendante de la date d'installation.
    expect(replayOf(facture())?.type).toBe('stripe.subscription.renewed');
    expect(replayOf(facture({ billing_reason: 'manual' }))?.type).toBe(
      'stripe.invoice.paid',
    );
  });

  it('date le revenu du paiement, pas de l’émission', () => {
    // Une facture émise le 1er et payée le 8 est du revenu du 8. Prendre
    // `created` avancerait tout l'historique.
    expect(replayOf(facture())?.occurredAt).toEqual(
      new Date(1_788_000_600 * 1000),
    );
  });

  it('retombe sur la création quand Stripe ne détaille plus la transition', () => {
    const ancienne = facture({ status_transitions: { paid_at: null } });

    expect(replayOf(ancienne)?.occurredAt).toEqual(
      new Date(1_788_000_000 * 1000),
    );
  });

  it('recopie le montant et dit qu’il vient d’un rejeu', () => {
    // `stripe.replayed` n'est pas décoratif : le rejeu ne produit qu'un
    // événement là où un checkout vivant en produit quatre, et une lecture qui
    // vise le checkout ne verra rien du passé. Mieux vaut que la différence se
    // constate que de la supposer.
    expect(replayOf(facture())?.properties).toEqual({
      'stripe.object.id': 'in_1',
      'stripe.customer.id': 'cus_1',
      'stripe.billing_reason': 'subscription_cycle',
      'stripe.livemode': true,
      'stripe.replayed': true,
      'payment.amount': 4900,
      'payment.currency': 'eur',
    });
  });

  it('ignore une facture qui n’a pas été payée', () => {
    // Une facture émise n'est pas du revenu, et une impayée encore moins.
    expect(replayOf(facture({ status: 'open' }))).toBeNull();
    expect(replayOf(facture({ status: 'void' }))).toBeNull();
  });
});
