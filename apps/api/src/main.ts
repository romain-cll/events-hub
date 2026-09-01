import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // `bodyParser: false` est exigé par le montage de Better Auth : son handler a
  // besoin du flux brut. `configureApp` réintroduit `express.json()` juste
  // après lui, donc les autres routes ne perdent rien. Voir `app.setup.ts`.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  configureApp(app);

  // Sans ça, `onApplicationShutdown` ne tourne pas et le pool `pg` reste ouvert.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
