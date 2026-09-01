import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/auth.decorators';

/**
 * Racine et health : publics par nature. Sans ça, le guard global les
 * protégerait — et une sonde de disponibilité qui doit s'authentifier ne sonde
 * plus la disponibilité.
 */
@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
