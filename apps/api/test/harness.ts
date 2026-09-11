import type { INestApplication } from '@nestjs/common';
import {
  Test,
  type TestingModule,
  type TestingModuleBuilder,
} from '@nestjs/testing';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * Le démarrage d'une application e2e, en un seul endroit.
 *
 * Chaque suite recopiait les cinq mêmes lignes. Les factoriser ne serait pas une
 * raison suffisante d'écrire ce fichier — elles étaient justes. Ce qui l'impose
 * est la ligne qu'elles n'avaient pas, et sans laquelle ajouter une suite rend
 * les précédentes instables.
 *
 * ## Le port éphémère par requête
 *
 * Supertest ne prend pas un serveur qui écoute : il en fait écouter un. À
 * chaque appel de `request(server)`, il regarde `server.address()` et, s'il est
 * nul, fait `server.listen(0)` — puis `server.close()` dès la réponse lue (voir
 * `supertest/lib/test.js`). Une suite de vingt requêtes, c'est donc vingt
 * liaisons et vingt fermetures sur des ports que le noyau recycle, pas une
 * application qui écoute.
 *
 * Ce cycle a un taux d'échec propre, indépendant du code testé : le client
 * reçoit des octets qui ne sont pas une réponse HTTP et remonte
 * `Parse Error: Expected HTTP/`. Mesuré hors de tout ce dépôt — onze processus
 * rejouant le motif sur des serveurs vides — une occurrence pour soixante-six
 * mille requêtes. Aucune assertion n'est fausse ; la requête n'aboutit pas.
 *
 * D'où la condition de déclenchement observée, qui n'a l'air d'avoir aucun
 * sens : **le nombre de suites, pas le nombre de tests**. Vingt-six suites
 * passaient dix fois sur dix, vingt-sept échouaient une fois sur dix. Le nombre
 * de cycles croît avec le nombre de suites, le taux suit, et le message désigne
 * la suite malchanceuse plutôt que la cause. En CI, c'est un rouge qu'on
 * relance sans lire — et qui finit par coûter la confiance dans la suite.
 *
 * ## Écouter une fois, et ne plus lâcher
 *
 * `app.listen(0)` ici, dans le `beforeAll`, rend `address()` non nul pour toute
 * la vie de la suite : supertest le constate et ne lie plus rien. Le nombre de
 * cycles passe de plusieurs centaines par exécution à un par suite, et surtout
 * il cesse de dépendre du nombre de suites — c'est cette dépendance-là qu'il
 * fallait couper, pas le taux.
 *
 * Ce que ça coûte : chaque suite garde une socket en écoute du début à la fin.
 * Le plafond n'est plus le nombre de suites mais `maxWorkers`, fixé dans
 * `jest-e2e.json` — on peut en ajouter autant qu'on veut sans rien déplacer.
 *
 * Écartés : sérialiser les suites (`--runInBand`), qui abaisse le taux sans le
 * supprimer et paie toute la durée du run ; et réessayer la requête en échec,
 * qui masquerait aussi la vraie troncature le jour où il y en aura une.
 *
 * `127.0.0.1` et non toutes les interfaces : c'est la seule adresse que
 * supertest appelle, et écouter au-delà exposerait l'application de test au
 * réseau local — sur macOS, ça se voit, le pare-feu demande l'autorisation.
 *
 * ## `customize`, pour les suites qui doivent doubler un fournisseur
 *
 * Une seule en a besoin aujourd'hui : celle du rattrapage Stripe, qui remplace
 * le client sortant. Le paramètre existe pour qu'elle passe **par ici** plutôt
 * qu'à côté — une suite qui recopierait ces lignes pour glisser un
 * `overrideProvider` perdrait le `listen`, et ramènerait l'instabilité que ce
 * fichier existe pour supprimer.
 */
export async function createTestApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (
    builder,
  ) => builder,
): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await customize(
    Test.createTestingModule({ imports: [AppModule] }),
  ).compile();

  // `bodyParser: false` puis `configureApp` : exactement ce que fait `main.ts`,
  // et pour la même raison — Better Auth a besoin du flux brut, et sans le
  // versioning que `configureApp` installe, `/v1` n'existe pas. Une suite qui
  // configurerait l'app autrement testerait une application qu'on ne déploie
  // pas.
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    bodyParser: false,
  });

  configureApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');

  return app;
}
