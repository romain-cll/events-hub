import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import {
  DRIZZLE,
  PG_POOL,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from './database.tokens';
import * as schema from './schema';

/**
 * Expose une seule instance Drizzle (et son pool `pg`) à toute l'application.
 *
 * `casing: 'snake_case'` fait le pont entre les propriétés camelCase du schéma
 * et les colonnes snake_case en base ; la même option est répétée dans
 * `drizzle.config.ts` pour que drizzle-kit génère le même SQL.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          // ## Pourquoi cette taille est réglable, alors que 10 convient
          //
          // Parce que le plafond qui compte n'est pas ici : c'est
          // `max_connections` de Postgres, et il est partagé par **tous** les
          // processus qui s'y connectent. Un pool est dimensionné pour un
          // processus seul ; le nombre de processus, lui, n'est pas connu d'ici.
          //
          // Le cas qui l'a imposé est la suite e2e : Jest lance un worker par
          // cœur, chacun démarre son application, donc son pool. Sur douze
          // cœurs, onze pools de dix réclament cent dix connexions pour un
          // plafond de cent — et au-delà Postgres refuse. Le refus ne remonte
          // pas en erreur de base : Better Auth n'arrive plus à lire la session,
          // conclut qu'il n'y en a pas, et la route répond 401. La suite qui
          // échoue change d'un run à l'autre, et rien ne désigne la vraie cause.
          //
          // Le même calcul vaut en production dès qu'on met deux instances
          // derrière un répartiteur : c'est le produit qui doit tenir sous le
          // plafond, pas le facteur.
          max: Number(config.get<string>('DATABASE_POOL_MAX') ?? '10'),
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) =>
        drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export { DRIZZLE, PG_POOL, type DrizzleDatabase, type DrizzleTransaction };
