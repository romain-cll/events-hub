/**
 * Point d'entrée unique du schéma : ce que `drizzle.config.ts` lit et ce que
 * `DatabaseModule` passe à `drizzle()` pour typer la query API relationnelle.
 * Tout nouveau fichier de schéma doit être ré-exporté ici.
 */
export * from './projects';
export * from './users';
export * from './accounts';
export * from './auth-sessions';
export * from './verifications';
export * from './organizations';
export * from './memberships';
export * from './invitations';
export * from './project-keys';
export * from './events';
export * from './sessions';
export * from './event-types';
export * from './integrations';
export * from './stripe-webhook-events';
export * from './stripe-customers';
export * from './stripe-subscriptions';
export * from './stripe-subscription-revisions';
