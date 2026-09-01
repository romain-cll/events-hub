import { Module } from '@nestjs/common';

import { FaviconsController } from './favicons.controller';

/**
 * Le relais de favicons du dashboard.
 *
 * Aucun service, aucune dépendance : le contrôleur est tout le module. C'est
 * volontaire — il n'y a rien à partager, et un `FaviconsService` à une méthode
 * ne ferait qu'ajouter un fichier entre la route et son unique `fetch`.
 */
@Module({ controllers: [FaviconsController] })
export class FaviconsModule {}
