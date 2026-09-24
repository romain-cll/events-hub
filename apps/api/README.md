# `@events-hub/api`

NestJS + Drizzle + Postgres. Ingère les événements, les stocke, les compte, et
sert le dashboard. Écoute sur **`:3003`**.

⚠️ **Ne pas lancer `pnpm dev` ici** si les serveurs tournent déjà sous turbo à la
racine : un second démarrage échoue sur un port occupé ou, pire, en prend un
autre en silence.

## Démarrer

```sh
cp .env.example .env     # puis renseigner DATABASE_URL et les deux secrets
pnpm db:migrate
pnpm dev
```

`VISITOR_KEY_SECRET` et `BETTER_AUTH_SECRET` sont lues par `getOrThrow` :
**l'API refuse de démarrer sans elles**. `openssl rand -hex 32` pour chacune.
Les onze autres variables sont optionnelles, chacune commentée dans
`.env.example`, et [`docs/deploiement.md`](../../docs/deploiement.md) dit ce que
leur absence coûte en production.

## Commandes

```sh
pnpm dev             # nest start --watch
pnpm build           # -> dist/
pnpm start:prod      # node dist/main

pnpm test            # unitaires (jest)
pnpm test:e2e        # e2e contre un vrai Postgres — voir plus bas
pnpm lint
pnpm check-types

pnpm db:generate     # schéma modifié -> migration SQL dans drizzle/
pnpm db:migrate
pnpm db:check
pnpm db:studio
pnpm db:seed         # jeu de démonstration (scripts/seed-demo.mjs)
```

## Les tests e2e ont des règles, et elles sont testées

`pnpm test:e2e` demande un **vrai Postgres** et tourne en **deux passes** :
`test/jest-e2e.suites.js`, puis `test/jest-e2e.retention.js` seule. La rétention
est isolée parce que ses assertions sont globales — elle affirme que la purge ne
trouve plus rien nulle part, et le verrou consultatif est pris au niveau du
cluster.

`test/harness.e2e-spec.ts` fait échouer la suite si l'une de ces deux règles est
enfreinte, et le fichier explique pourquoi :

- une suite démarre son application par **`createTestApp()`** (`test/harness.ts`),
  jamais elle-même ;
- une suite qui crée des fixtures appelle **`cleanupFixtures(db)`**
  (`test/fixtures.ts`).

Compte de test local : `test@test.com` / `password`.

## Ce qui casse le build, et ce n'est pas une préférence

`src/architecture.spec.ts` lit les sources et échoue sur la forme du code :
hors de `features/`, aucun fichier ne nomme un type d'événement — pas même dans
un commentaire —, ne compare un `type` à un littéral, ni n'indexe un
comportement par lui. `@events-hub/api-contract` n'entre dans `src/` qu'en
`import type`.

`src/contract.spec.ts` vérifie que chaque forme de réponse coïncide **dans les
deux sens** avec son schéma de `packages/api-contract`.

La frontière socle / métier, le modèle d'événement et les pièges de migration
sont dans [`CLAUDE.md`](../../CLAUDE.md), à lire avant de toucher au socle.

## Où lire la suite

| Sujet                                       | Document                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Mettre en ligne, configurer Stripe          | [`docs/deploiement.md`](../../docs/deploiement.md)                     |
| Envoyer des événements                      | [`docs/ingestion.md`](../../docs/ingestion.md)                         |
| Les webhooks Stripe                         | [`src/features/stripe/README.md`](src/features/stripe/README.md)       |
| L'interprétation analytics                  | [`src/features/analytics/README.md`](src/features/analytics/README.md) |
| Ce qui est collecté, et sous quel fondement | [`docs/privacy.md`](../../docs/privacy.md)                             |
