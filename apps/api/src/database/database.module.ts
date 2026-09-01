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
