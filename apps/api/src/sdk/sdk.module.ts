import { Module } from '@nestjs/common';

import { SdkController } from './sdk.controller';
import { SdkService } from './sdk.service';

/** Le script d'installation, servi par le hub qui reçoit ses événements. */
@Module({
  controllers: [SdkController],
  providers: [SdkService],
})
export class SdkModule {}
