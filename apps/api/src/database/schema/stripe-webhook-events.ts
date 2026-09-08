import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Les webhooks Stripe déjà traités, pour ne pas les traiter deux fois.
 *
 * ## Pourquoi une table, et pas une clé dans `properties`
 *
 * L'identifiant de l'événement Stripe est bien rangé dans `properties` — c'est
 * une charge utile fournie par une source, de forme dépendante du type. Mais
 * l'unicité ne peut pas s'y appuyer : un index unique sur
 * `properties->>'stripe.event.id'` vivrait dans le schéma du socle et y ferait
 * entrer le vocabulaire d'une verticale. Le socle ne sait pas ce qu'est Stripe,
 * et cette table est la façon de le garder vrai.
 *
 * ## Pourquoi il en faut une tout court
 *
 * Stripe rejoue ses webhooks — sur timeout, sur 5xx, sur simple prudence. Sans
 * déduplication, un rejeu double le revenu du jour, et **rien ne le signale** :
 * la donnée est plausible, elle est juste fausse. C'est le genre d'erreur qu'on
 * ne découvre qu'en la cherchant.
 *
 * La clé primaire *est* le mécanisme : deux livraisons concurrentes du même
 * événement ne peuvent pas gagner toutes les deux, et c'est Postgres qui
 * l'arbitre, sans verrou applicatif ni fenêtre de course.
 *
 * ## Elle vit ici, mais elle n'appartient pas au socle
 *
 * `schema/index.ts` doit tout réexporter — c'est ce que lit `drizzle.config.ts`.
 * D'où sa place dans ce dossier. Elle n'est lue et écrite que par
 * `features/stripe/`, et rien d'autre n'a de raison d'y toucher.
 */
export const stripeWebhookEvents = pgTable('stripe_webhook_events', {
  /**
   * L'`evt_…` de Stripe, tel quel.
   *
   * Clé primaire plutôt qu'une colonne unique : cette table n'a pas d'identité
   * propre à défendre, elle *est* l'ensemble des identifiants déjà vus.
   */
  eventId: text().primaryKey(),
  receivedAt: timestamp({ withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});
