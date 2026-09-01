# events-hub

Monorepo Turborepo + pnpm.

## Structure

```
apps/
  api/   # NestJS        — http://localhost:3001
  web/   # TanStack Start — http://localhost:3000
packages/
  eslint-config/   # config ESLint partagée (base / node / react)
  sdk/             # SDK navigateur : ingestion + collecteurs d'événements
```

## Commandes

```sh
pnpm install
pnpm dev           # lance toutes les apps
pnpm build
pnpm lint
pnpm test
pnpm check-types
pnpm format        # pnpm format:check en CI
```

## Base de données

`apps/api` utilise **Drizzle ORM** (driver `node-postgres`) sur le Postgres local
— pas de Docker. Une seule variable pilote tout, l'app comme la CLI :

```sh
cp apps/api/.env.example apps/api/.env   # puis renseigner DATABASE_URL
```

Côté Postgres, la convention du poste est une base + un rôle dédié par projet :

```sql
CREATE ROLE user_events_hub LOGIN PASSWORD '...';
CREATE DATABASE events_hub;
-- drizzle-kit crée un schéma "drizzle" pour sa table __drizzle_migrations :
-- sans ce GRANT, `db:migrate` échoue sur « permission denied for database ».
GRANT CREATE ON DATABASE events_hub TO user_events_hub;
```

### Où vit le schéma

```
apps/api/
  drizzle.config.ts          # config drizzle-kit (dialect, out, casing)
  drizzle/                   # migrations SQL générées — à committer
  src/database/
    database.module.ts       # @Global : fournit DRIZZLE + PG_POOL
    database.tokens.ts       # tokens d'injection + type DrizzleDatabase
    schema/                  # une table par fichier, ré-exportée dans index.ts
```

`casing: 'snake_case'` est réglé **des deux côtés** (`drizzle()` et
`drizzle.config.ts`) : on écrit `startsAt` en TypeScript, la colonne s'appelle
`starts_at`. Modifier l'un sans l'autre fait diverger le SQL généré du SQL
exécuté.

### Commandes

```sh
pnpm db:generate   # schéma modifié -> nouveau fichier SQL dans drizzle/
pnpm db:migrate    # applique les migrations en attente
pnpm db:studio     # explorateur web
```

Depuis la racine elles passent par Turbo (`turbo run db:*`, non cachées) ; on
peut aussi les lancer dans `apps/api` avec `pnpm db:generate`, ou cibler l'app
avec `pnpm --filter @events-hub/api db:push` (`db:push` pousse le schéma sans
migration — pratique en exploration, à éviter dès qu'il y a des données).

### Utiliser la base dans un service

```ts
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import { events } from '../database/schema';

@Injectable()
export class EventsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  findAll() {
    return this.db.select().from(events);
  }
}
```

Le module est `@Global()` : pas besoin de l'importer dans chaque feature module.
Le pool est fermé via `onApplicationShutdown`, d'où le `app.enableShutdownHooks()`
dans `main.ts`.

La table `events` stocke l'événement brut : `id` (uuid généré en base),
`type`, `version`, `occurred_at`, plus `attributes` et `properties` en `jsonb`
(`NOT NULL DEFAULT '{}'`, donc jamais `null` côté lecture). Les deux colonnes
jsonb sont typées `Record<string, unknown>` en TypeScript — la forme réelle
dépend du `type`, elle n'est pas contrainte par le schéma.

### Horodatage

`occurred_at` est un `timestamptz(3)`. Trois points à ne pas confondre :

Malgré son nom, `timestamptz` ne stocke pas de timezone : il lit l'offset à
l'écriture, convertit en UTC et range un instant absolu. C'est bien ce qu'on
veut — un `+02:00` est placé au bon point de la ligne du temps, et `Z` est une
représentation ISO 8601 valide en sortie.

Deux points à ne pas casser :

- **Sortie** : `pg` renvoie un `Date`, dont la sérialisation JSON est déjà
  `2026-08-20T14:30:00.000Z`. Ne pas passer la colonne en `mode: 'string'` —
  on récupérerait la forme Postgres (`2026-08-20 14:30:00+00`, espace au lieu
  de `T`), qui n'est pas de l'ISO 8601.
- **Précision bornée à 3** : un `Date` JavaScript ne descend pas sous la
  milliseconde. Avec la précision Postgres par défaut (microseconde), une
  valeur écrite avec 6 décimales se relit tronquée — écrit ≠ relu, en silence.

À l'ingestion, valider la chaîne entrante avec un validateur standard
(`class-validator` / `zod`) : `new Date()` avale sans broncher des formes qui
ne sont pas de l'ISO 8601.

## API HTTP

Le versioning est activé par l'URI (`main.ts`) : un contrôleur annoté
`@Controller({ path: 'events', version: '1' })` est servi sous `/v1/events`.
Le défaut est `VERSION_NEUTRAL`, donc les routes sans version (racine, health)
restent à la racine au lieu d'hériter d'un `/v1` involontaire.

### Validation

La validation d'entrée passe par **Zod**, pas par `class-validator` : le schéma
est la source de vérité et le type TypeScript s'en déduit (`z.infer`), au lieu
d'avoir une classe décorée à tenir synchronisée avec un type.

`ZodValidationPipe` (`src/common/pipes/`) est branché **par paramètre**, pas en
pipe global — le schéma dépend de la route, et l'écrire à côté du handler rend
le contrat lisible :

```ts
@Post()
create(@Body(new ZodValidationPipe(createEventSchema)) payload: CreateEventDto) {
  return this.eventsService.create(payload);
}
```

Le handler reçoit la **sortie** du schéma : les `transform` et les `default`
sont déjà appliqués (`occurredAt` est un `Date`, `attributes` vaut `{}` s'il
était absent). D'où deux types exportés — `CreateEventPayload` (l'entrée, telle
qu'elle arrive sur le fil) et `CreateEventDto` (la sortie, telle que le service
la reçoit).

Un échec renvoie un 400 listant **toutes** les erreurs d'un coup :

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Request body validation failed",
  "issues": [{ "path": "occurredAt", "message": "Invalid ISO datetime" }]
}
```

### `POST /v1/events`

Ingère un événement et renvoie `201` avec la ligne telle que Postgres l'a
écrite (`id` généré en base, valeurs par défaut appliquées).

```sh
curl -X POST http://localhost:3001/v1/events \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "page.viewed",
    "version": 1,
    "occurredAt": "2026-08-20T16:30:00+02:00",
    "attributes": { "page.path": "/pricing" },
    "properties": { "durationMs": 1200 }
  }'
```

```json
{
  "id": "5ad5d50d-2f2e-49cc-a5ce-d826dd0dffa5",
  "type": "page.viewed",
  "version": 1,
  "occurredAt": "2026-08-20T14:30:00.000Z",
  "attributes": { "page.path": "/pricing" },
  "properties": { "durationMs": 1200 }
}
```

Le schéma est **strict** : une clé inconnue fait échouer la requête. Sur une
ingestion, un `occuredAt` mal orthographié qui passerait en 201 est le pire
scénario — la donnée est perdue et personne ne le sait. `attributes` et
`properties` sont optionnels (`{}` par défaut), le reste est obligatoire.

`occurredAt` doit être de l'ISO 8601 avec timezone ; l'offset est accepté au
même titre que `Z` et normalisé en UTC à l'écriture. La conversion en `Date`
dans le schéma borne au passage la précision à la milliseconde, avant l'écriture
— voir [Horodatage](#horodatage).

### Le contrat est générique, et c'est gardé

`type` est une chaîne libre. Le Core valide la **forme** d'un événement, dérive
une clé visiteur, écrit — et ne sait rien de ce qu'il écrit. Un type jamais vu
passe :

```sh
curl -X POST http://localhost:3001/v1/events \
  -H 'Content-Type: application/json' \
  -d '{ "projectId": "…", "type": "ai_agent_visit", "version": 1, "occurredAt": "…" }'
```

C'est la promesse qui rend les modules possibles : `error`, `api_call`,
`webhook`, `deployment` s'ajouteront sans qu'une ligne du Core bouge. Le
pipeline est le même pour tous :

```
HTTP → validation structurelle (Zod) → clé visiteur (HMAC) → EventStore → Postgres
```

Deux tests la tiennent, et ils ne font pas doublon :

| test                             | ce qu'il attrape                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/core-boundary.spec.ts` | la **forme du code** : le Core ne nomme aucun type, ne compare rien à un `type`, n'indexe rien par `type`, n'importe rien de `modules/`     |
| `test/event-stream.e2e-spec.ts`  | le **comportement** : des types inconnus traversent réellement HTTP → Postgres → `EventStore`, avec le même traitement que les types connus |

Le premier voit un aiguillage écrit mais jamais atteint ; le second voit une
connaissance métier logée ailleurs que dans une comparaison — une valeur par
défaut appliquée à un seul type, un `Set` de types « connus », une colonne
dédiée. Vérifié : une violation écrite sans littéral ni `===` passe le premier
et échoue au second.

La sémantique vit donc entièrement en dehors du Core — dans le SDK d'un côté,
dans `src/modules/` de l'autre. `AnalyticsService` est le seul endroit du
backend qui sache ce qu'est une page vue, et le seul qui sache où le chemin de
la page est rangé.

### La surface de lecture du Core

`EventStore` est ce que le Core offre aux modules. Il sait dénombrer, découper
en journées, et grouper — jamais interpréter.

```ts
countEvents(scope); // combien d'événements
countVisitors(scope); // combien de visiteurs distincts
countEventsByDay(scope); // la même chose par journée UTC, trous remplis
countVisitorsByDay(scope);
topValues(scope, selector); // les valeurs les plus fréquentes d'une clé JSON
```

`topValues` est la primitive de requêtage générique : l'appelant nomme une
colonne (`attributes` ou `properties`) et une clé, le Core groupe.

```ts
store.topValues(
  { projectId, from, to, type: 'page_view' },
  { source: 'attributes', key: 'page.path', limit: 10 },
);
// → [{ value: '/pricing', events: 3, visitors: 2 }, …]
```

Le Core ne sait pas que `page.path` désigne une page. Un module de suivi
d'erreurs demanderait `{ source: 'properties', key: 'error.name' }` sur le type
`error` — même méthode, aucune ligne à changer ici. C'est ce qui fait du Core un
moteur de requêtage d'event stream, et des modules ses interprètes.

Quatre points à connaître avant de s'en servir :

- **`key` est une donnée, pas du SQL.** Elle part en paramètre lié ; `source`
  choisit entre deux colonnes connues à l'avance. Une clé biscornue rend une
  liste vide.
- **Les clés absentes ou à `null` sont écartées.** Pour connaître la couverture,
  comparer la somme des `events` à `countEvents()` sur le même périmètre.
- **La valeur est toujours du texte** — `->>` rend la forme textuelle quel que
  soit le type JSON, et le Core n'invente pas le type attendu.
- **L'ordre est total** : `events` décroissant puis la valeur croissante. Sans
  ce second critère, la coupe du `limit` ne serait pas déterministe à égalité.

`limit` vaut 10 par défaut, parce que la cardinalité d'une clé JSON n'est bornée
par rien.

Ce que le Core **ne** fait pas : décider qu'un événement est le premier ou le
dernier d'un visiteur. « Entrée », « sortie », « session » sont des
interprétations, et elles appartiendront au module qui en aura besoin — avec ses
propres règles, le jour où il en aura vraiment besoin.

### Le module Analytics

`src/modules/analytics/` est le premier interprète de l'event stream. Il tient
en trois décisions, et elles sont toutes des constantes en haut d'un fichier :

```ts
const EVENT_TYPE = 'page_view'; // ce qui compte comme une page vue
const PATH_ATTRIBUTE = 'page.path'; // où le chemin est rangé
const TOP_PAGES_LIMIT = 10; // combien de pages le classement retient
```

`GET /v1/projects/:projectId/analytics?from=&to=&interval=day` rend :

```json
{
  "from": "2026-08-16T00:00:00.000Z",
  "to": "2026-08-23T00:00:00.000Z",
  "pageViews": 42,
  "uniqueVisitors": 17,
  "topPages": [{ "value": "/", "events": 12, "visitors": 9 }],
  "interval": "day",
  "timeseries": [{ "start": "…", "pageViews": 6, "uniqueVisitors": 4 }]
}
```

La chaîne complète tient en une ligne, et chaque maillon ignore le suivant :

```
page_view (SDK) → EventStore.topValues (générique) → Analytics (interprète) → API → dashboard
```

Trois points qui se lisent mal dans le code seul :

- **`limit` n'est pas dans l'API.** Dix pages est la réponse à « quelles sont
  les pages les plus vues », pas un réglage de l'appelant. Le schéma de query
  est un `strictObject` : `?limit=50` rend un 400 plutôt que d'être ignoré.
- **`topPages` est un classement, pas une décomposition.** La somme de ses
  `events` est inférieure à `pageViews` dès qu'il y a plus de dix pages ou
  qu'une vue n'a pas de chemin. En tirer des pourcentages du total serait faux
  — le dashboard affiche les comptes bruts et une barre relative à la première
  ligne.
- **`value`, pas `path`.** Le chemin est rendu tel que le site l'a émis. Le
  renommer laisserait croire à une normalisation que personne ne fait.

Le dashboard ne calcule rien : il ne trie pas (la liste arrive ordonnée, et la
réordonner casserait le départage déterministe du serveur), ne somme rien, ne
comble aucun trou.

`test/analytics.e2e-spec.ts` éprouve tout ça par la route : plusieurs pages,
plusieurs visiteurs sur une même page, les autres types écartés, les vues sans
chemin ignorées, la fenêtre respectée, le cloisonnement par projet, et l'ordre
stable à égalité.

### D'où viennent les visiteurs — la règle, spécifiée avant d'être branchée

`src/modules/analytics/entry-source.ts` fixe la définition de la **provenance
d'un visiteur** ; `entry-source.spec.ts` l'éprouve sur des parcours réels. Rien
n'est câblé : pas de route, pas d'appel au Core, **pas une clé de plus collectée
par le SDK**.

> La source d'un visiteur est le **`page.referrer` de son premier `page_view`
> dans la fenêtre**.

`page.referrer` est `document.referrer` : l'URL exacte de la page d'où vient le
visiteur, telle que le navigateur la donne. C'est _la_ provenance, et rien
d'autre dans le flux ne la porte.

#### Pourquoi « le premier `page_view` », et pas chaque vue

Le referrer est figé au chargement du document et ne bouge pas des navigations
internes sans rechargement. C'est ce qui le rend utilisable — n'importe quel
événement de la visite porte encore l'origine du document — et c'est aussi ce
qui interdit de le compter événement par événement : un visiteur venu de Google
et passé sur trois pages porte le referrer Google sur les trois. Compté par
vue, ça ferait trois arrivées Google pour une visite, avec une erreur
exactement proportionnelle à la profondeur des visites — invisible, et d'autant
plus grosse que le site est bon.

Un visiteur, une source. Les lignes de la répartition **partitionnent** donc les
visiteurs : la somme de leurs `visitors` vaut le total. C'est l'inverse des
`visitors` de `topValues`, qui comptent une personne dans chaque valeur touchée.

#### Le rôle, plus étroit, de `navigation.from`

Il ne décide pas de la source. Il dit une seule chose : cette vue a-t-elle été
précédée par une page du même site — donc **tient-on la page d'atterrissage**.

| première vue du visiteur | source                        | `path`                       |
| ------------------------ | ----------------------------- | ---------------------------- |
| sans `navigation.from`   | le referrer                   | la landing                   |
| avec `navigation.from`   | le referrer, toujours valable | une page de milieu de visite |

Le second cas arrive quand la fenêtre coupe une visite en cours. Il est rendu
comme le drapeau `isLanding` (et le total `visitorsSeenMidVisit`), pas comme un
filtre : une visite attrapée en cours de route a quand même une provenance, et
la jeter serait perdre un visiteur pour une question de cadrage.

À noter, parce que ça change la lecture : `navigation.from` n'est pas que le
routeur JS. Le SDK le remplit aussi en MPA depuis un `document.referrer` de même
origine. C'est ce qui fait qu'il est absent sur une vraie arrivée, quel que soit
le type de site — et présent dès qu'on regarde une page de milieu de visite.

#### Quatre natures, dont une qui n'est pas de l'acquisition

| `kind`     | quand                                 | `name`            |
| ---------- | ------------------------------------- | ----------------- |
| `direct`   | aucun referrer                        | `null`            |
| `search`   | l'hôte porte un label de moteur connu | `google`          |
| `referral` | tout autre hôte externe               | `blog.autre.test` |
| `internal` | referrer de **notre propre origine**  | `shop.test`       |

`internal` est le résidu — rechargement, navigation vers une ancre, ou visite
attrapée après un changement de document sur un site classique. Il est **rendu**
plutôt qu'écarté : sa part dit à quel point la lecture est polluée.
L'acquisition, c'est les trois autres.

Le moteur est reconnu par **label d'hôte** (`google` couvre `google.fr` comme
`www.google.co.uk`) — une heuristique assumée, remplaçable par une table sans
qu'une ligne du Core bouge. La comparaison d'origine est stricte, comme dans le
SDK : `docs.shop.test` est donc `referral`. Décider qu'un sous-domaine est « le
même site » demande de savoir quels hôtes appartiennent au projet — une
configuration, pas une donnée d'événement.

#### Ce que la règle ne peut pas savoir

- **`visitor_key` tourne chaque jour UTC.** Le même humain revenu demain est un
  autre visiteur, avec une autre source. L'attribution est quotidienne au mieux ;
  faire mieux demanderait une identité qui survit à la journée — précisément ce
  que ce projet a choisi de ne pas stocker.
- **Il n'y a pas de session.** Un visiteur revenu le soir garde la source du
  matin. `countArrivals()` mesure ce que ça coûte — le nombre d'arrivées de
  document — sans changer l'attribution, et rendu à part pour ne jamais se
  mélanger aux visiteurs dans un même compteur.
- **`direct` veut dire « aucune provenance connue »**, pas « URL tapée au
  clavier » : une `Referrer-Policy` restrictive ou un HTTPS → HTTP produit le
  même vide.
- **Sur un site classique, une visite coupée par la fenêtre perd sa
  provenance** : le document a changé, le referrer pointe sur la page
  précédente du site. La réponse est `internal`, et c'est la réponse honnête —
  aucune règle ne peut retrouver Google ici.

#### Ce qui manque au Core, maintenant qu'on sait

La règle a besoin, **par visiteur, du plus ancien `page_view` de la fenêtre**,
avec trois clés lues ensemble sur cette même ligne (`page.referrer`, `page.url`,
`page.path`) plus la présence de `navigation.from`.

`topValues` ne sait rien faire de ça : il agrège une clé, il ne rend pas de
lignes. Ce qui manque n'est donc pas une agrégation de plus mais une
**projection** — « pour chaque visiteur, la première ligne, et ces colonnes-là ».
Le « premier événement d'un visiteur » est d'ailleurs pile ce que le Core avait
refusé de savoir jusqu'ici ; il peut le faire sans rien connaître du métier — un
`DISTINCT ON (visitor_key) … ORDER BY occurred_at` ne mentionne ni source, ni
landing page, ni moteur de recherche. La classification, elle, reste ici.

## SDK navigateur

`packages/sdk` est le client que chargent les sites instrumentés. Il fait deux
choses : poster un événement (`track()`), et transformer les signaux natifs du
navigateur en un flux d'événements normalisé (`start()`).

```ts
const analytics = new Analytics({ projectId, endpoint });
analytics.start(); // page_view, click, submit, outbound_click, page_leave
```

**Le Core n'en sait rien.** Aucun de ces types n'est connu de `POST /v1/events`,
qui continue de n'accepter qu'un `type`, une `version` et deux objets libres.
La sémantique de `page_view` ou de `leave.reason` vit entièrement dans le SDK
d'un côté et dans les modules de lecture de l'autre — jamais dans l'ingestion.

Détail des événements, des clés produites et de la frontière
`attributes` / `properties` : [`packages/sdk/README.md`](packages/sdk/README.md).

## Versions de TypeScript

Les deux apps sont volontairement sur des versions différentes, **épinglées à
l'exact** (pas de `^`) :

| app        | TypeScript | pourquoi                               |
| ---------- | ---------- | -------------------------------------- |
| `apps/api` | `5.9.2`    | plafonnée, voir ci-dessous             |
| `apps/web` | `6.0.3`    | version livrée par le starter TanStack |

**Ne pas monter `apps/api` en TypeScript 6.** `nest build` échoue alors en
silence : rien n'est produit dans `dist/`, sans le moindre message d'erreur.
La cause est que `nest build` charge deux copies de TypeScript à la fois —
celle de l'app (résolue depuis le cwd par `lib/compiler/typescript-loader.js`)
et celle qu'embarque `@nestjs/cli` (`require("typescript")` statique dans
`lib/compiler/compiler.js`, épinglée en 5.9.3). Le CLI pilote donc le
compilateur de l'app via une API interne qui diverge à partir de la 6.

Deux autres plafonds sur l'API, à revérifier avant toute montée :

- `typescript-eslint` → peer `typescript >=4.8.4 <6.1.0` (aucune v9 publiée)
- `ts-jest` → peer `typescript >=4.3 <7`

TypeScript 7 est donc hors de portée pour l'API, même s'il est en `latest` sur
npm.

L'écart entre les deux apps est sans conséquence tant qu'elles ne partagent pas
de types : chacune compile de son côté et TypeScript ne va jamais en production.
Il faudra en tenir compte le jour où un `packages/*` exposera des types consommés
par les deux — ce code partagé devra être écrit pour le compilateur le plus
ancien, donc en 5.9.
