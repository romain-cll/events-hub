import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { events } from './events';
import { projects } from './projects';

/**
 * Les webhooks Stripe déjà traités : la déduplication, **et** l'index qui
 * ramène d'un client Stripe aux événements qu'il a produits.
 *
 * ## D'abord, ne pas traiter deux fois
 *
 * Stripe rejoue ses webhooks — sur timeout, sur 5xx, par prudence. Sans
 * déduplication, un rejeu double le revenu du jour et **rien ne le signale** :
 * la donnée est plausible, elle est juste fausse.
 *
 * La clé primaire *est* le mécanisme : deux livraisons concurrentes du même
 * événement ne peuvent pas gagner toutes les deux, et c'est Postgres qui
 * l'arbitre, sans verrou applicatif ni fenêtre de course.
 *
 * ## Ensuite, retrouver les événements d'un client
 *
 * Presque tout objet Stripe porte un `customer`, mais le lien vers le visiteur,
 * lui, s'apprend souvent **plus tard** — le site pose l'identifiant sur le
 * client après le checkout, ou des mois après pour un client qui existait avant
 * l'installation. Quand ce lien arrive, il faut pouvoir remonter aux événements
 * déjà écrits.
 *
 * Cette table le permet sans rien ajouter au socle. L'alternative aurait été un
 * index d'expression sur `events.properties`, ce qui aurait fait entrer le
 * vocabulaire d'une verticale dans le schéma du socle — précisément ce qu'on
 * évite. Elle enregistrait déjà chaque webhook traité : lui faire porter le
 * client et l'événement écrit ne coûte que deux colonnes.
 *
 * ## Trois colonnes nullables, et c'est voulu
 *
 * Tout événement Stripe n'a pas de client — `customer.created` n'en a pas encore,
 * `invoice_payment.paid` ne référence que la facture. Et l'id de l'événement
 * écrit n'existe qu'*après* l'ingestion, alors que la réservation, elle, doit
 * précéder : c'est elle qui empêche deux livraisons simultanées de passer.
 *
 * ## Pourquoi elle vit ici
 *
 * `schema/index.ts` doit tout réexporter — c'est ce que lit `drizzle.config.ts`.
 * Elle n'est lue et écrite que par `features/stripe/`, et rien d'autre n'a de
 * raison d'y toucher.
 */
export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    /**
     * L'`evt_…` de Stripe, tel quel.
     *
     * Clé primaire plutôt qu'une colonne unique : cette table n'a pas d'identité
     * propre à défendre, elle *est* l'ensemble des identifiants déjà vus.
     */
    eventId: text().primaryKey(),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    /** Le client Stripe concerné, quand l'événement en désigne un. */
    customerId: text(),
    /**
     * L'événement que nous avons écrit pour ce webhook.
     *
     * `cascade` : cette ligne ne décrit rien sans lui. Le reste du schéma est en
     * `restrict` pour protéger la donnée d'ingestion d'une suppression en
     * chaîne — ici c'est l'inverse, la trace n'a aucune valeur seule.
     */
    writtenEventId: uuid().references(() => events.id, {
      onDelete: 'cascade',
    }),
    receivedAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // « Tout ce que ce client a produit », la lecture qui rend l'attribution
    // rétroactive possible. Cloisonnée par projet comme toutes les autres.
    index('stripe_webhook_events_project_customer_idx').on(
      table.projectId,
      table.customerId,
    ),
  ],
);
