import {
  VersioningType,
  VERSION_NEUTRAL,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express, { type Express } from 'express';

import type { Auth } from './auth/auth';
import { AUTH } from './auth/auth.tokens';

/** Chemin servi par Better Auth, aligné sur `basePath` dans `auth.ts`. */
const AUTH_PATH = '/v1/auth';

/** La route d'ingestion, seule à être ouverte à toutes les origines. */
const INGESTION_PATH = '/v1/events';

/** Le webhook Stripe, seule route dont le corps ne doit pas être parsé. */
const STRIPE_WEBHOOK_PATH = '/v1/webhooks/stripe';

/**
 * Configuration commune à l'application réelle et aux tests e2e.
 *
 * Elle vit ici plutôt que dans `bootstrap()` pour une raison précise : un test
 * qui configurerait l'app de son côté finirait par tester une application qui
 * n'est pas celle qu'on déploie. Le versioning en est l'exemple direct — sans
 * lui, `POST /v1/events` n'est même pas routé — et depuis l'auth, l'ordre des
 * middlewares l'est tout autant.
 *
 * ⚠️ L'application **doit** être créée avec `{ bodyParser: false }`. Voir
 * `main.ts`, et les `createNestApplication({ bodyParser: false })` des tests.
 */
export function configureApp(app: INestApplication): void {
  const auth = app.get<Auth>(AUTH);
  const config = app.get(ConfigService);
  const server = app.getHttpAdapter().getInstance() as Express;
  const webUrl = config.get<string>('WEB_URL') ?? 'http://localhost:3002';

  // ## `trust proxy` : un nombre de sauts, jamais `true`
  //
  // Derrière un reverse proxy, la connexion vient du proxy : `request.ip` vaut
  // son adresse, la même pour tout le trafic — donc une seule clé visiteur et
  // un seul pays pour le monde entier. La vraie adresse est dans
  // `X-Forwarded-For`, et `trust proxy` dit à Express d'y croire.
  //
  // ⚠️ Un en-tête, ça s'écrit. `POST /v1/events` est **ouvert à toutes les
  // origines et sans session** : avec `trust proxy: true`, n'importe qui
  // enverrait `X-Forwarded-For: 8.8.8.8` et **choisirait** son IP, donc sa clé
  // visiteur (visiteurs uniques gonflés ou fusionnés à volonté) et son pays.
  //
  // D'où un **nombre de sauts** et non un booléen : Express ne lit alors que la
  // n-ième adresse en partant de la fin de la chaîne, celle qu'un proxy de
  // confiance a écrite, et ignore ce que le client a mis devant. Absent ou `0`,
  // rien n'est cru — c'est le défaut, et c'est le bon en local.
  const hops = Number(config.get<string>('TRUST_PROXY_HOPS') ?? '0');

  if (Number.isInteger(hops) && hops > 0) server.set('trust proxy', hops);

  // ## Deux politiques CORS, et elles s'excluent
  //
  // Les deux sont credentialées, mais pas de la même façon : l'ingestion
  // **reflète** l'origine qui l'appelle, le dashboard en **nomme** une seule.
  //
  // - l'ingestion est appelée depuis les sites clients, dont on ne connaît pas
  //   la liste à ce stade de la requête — le corps n'est pas encore parsé, donc
  //   la clé de projet n'est pas encore lue. La refléter est la seule forme
  //   compatible avec un cookie : `Access-Control-Allow-Origin: *` interdit de
  //   les envoyer, et sans cookie le mode consenti n'existe pas ;
  // - tout le reste — auth et dashboard — reste sur une origine nommée.
  //
  // Refléter n'ouvre rien ici, et c'est ce qui distingue cette route des
  // autres : sa réponse ne contient que l'écho de ce que l'appelant a envoyé.
  // Il n'y a rien à y lire qu'il ne détienne déjà. Le danger — un site tiers
  // qui lirait les analytics d'un utilisateur connecté en se servant de sa
  // session — vise les routes qui *renvoient* de la donnée, et celles-là sont
  // sur `dashboardCors`.
  //
  // La vraie garde de l'ingestion n'est pas ici de toute façon : c'est
  // l'allowlist d'origines portée par la clé, vérifiée par
  // `ProjectKeysService.resolve`, qui tourne après et répond 204. Le CORS
  // décide de ce que le navigateur s'autorise à lire ; l'allowlist décide de ce
  // qui est écrit.
  //
  // `cors` pose `Vary: Origin` de lui-même en mode reflet — sans quoi un cache
  // pourrait resservir à un site l'en-tête calculé pour un autre.
  //
  // L'aiguillage est explicite plutôt que deux `use()` empilés : montés l'un
  // après l'autre, le second réécrirait les en-têtes du premier sur
  // `/v1/events` et le navigateur verrait deux réponses contradictoires.
  const publicCors = cors({ origin: true, credentials: true });
  const dashboardCors = cors({ origin: [webUrl], credentials: true });

  server.use((request, response, next) =>
    request.path.startsWith(INGESTION_PATH)
      ? publicCors(request, response, next)
      : dashboardCors(request, response, next),
  );

  // ## L'ordre qui suit n'est pas négociable
  //
  // Better Auth a besoin du flux de requête intact : un parser qui tourne avant
  // lui l'a déjà consommé, et le handler reçoit un corps vide. D'où
  // `{ bodyParser: false }` à la création de l'app, ce handler monté en
  // premier, et le parsing JSON réintroduit *après* pour toutes les autres
  // routes — dont `POST /v1/events`, qui en dépend.
  //
  // `server.all(chemin, …)` et non `server.use(chemin, …)` : `use` ampute le
  // préfixe de `req.url`, alors que le handler reconstruit l'URL à partir du
  // `basePath` complet et ne retrouverait plus ses routes.
  server.all(`${AUTH_PATH}/*splat`, toNodeHandler(auth));

  // Même contrainte que Better Auth, pour une autre raison. Stripe signe les
  // **octets** du corps : parser puis re-sérialiser ne redonne pas la même
  // chaîne, donc la signature ne vérifierait plus jamais. `express.raw` doit
  // donc précéder le parsing JSON — monté après, il ne verrait qu'un corps déjà
  // consommé, et tous les webhooks seraient refusés.
  //
  // Cantonné à ce chemin : le reste de l'API veut du JSON parsé.
  server.use(STRIPE_WEBHOOK_PATH, express.raw({ type: 'application/json' }));
  server.use(express.json());

  // Versioning par l'URI : un contrôleur annoté `version: '1'` est servi sous
  // `/v1/...`. `VERSION_NEUTRAL` par défaut pour que les routes sans version
  // (racine, health) restent à la racine plutôt que d'hériter d'un `/v1`.
  //
  // Better Auth ne passe pas par le routeur Nest — il est monté ci-dessus en
  // middleware Express — donc son `/v1` vient de `basePath`, pas d'ici.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });
}
