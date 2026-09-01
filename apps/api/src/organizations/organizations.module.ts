import { Module } from '@nestjs/common';

import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/** La lecture des appartenances. L'écriture reste chez Better Auth. */
@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
