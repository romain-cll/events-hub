import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { DRIZZLE } from '../database/database.module';
import { createAuth } from './auth';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AUTH } from './auth.tokens';

/**
 * L'authentification, offerte à toute l'application.
 *
 * `@Global()` pour la même raison que `DatabaseModule` : `AuthGuard` est
 * enregistré ici en `APP_GUARD`, donc instancié par le conteneur racine, et il
 * a besoin d'`AUTH`. Sans le caractère global il faudrait importer ce module
 * dans chaque module qui expose une route protégée — c'est-à-dire partout.
 *
 * Enregistrer le guard **ici** plutôt que dans `AppModule` garde la décision
 * « tout est protégé sauf mention contraire » dans le fichier qui parle
 * d'authentification, au lieu de la diluer dans la racine de composition.
 */
@Global()
@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH,
      inject: [DRIZZLE, ConfigService],
      useFactory: createAuth,
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}

export { AUTH } from './auth.tokens';
export type { Auth, AuthContext } from './auth';
