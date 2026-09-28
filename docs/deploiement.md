# Mettre le hub en ligne

Ce que l'exploitant doit décider, dans l'ordre où ça se pose. Le dépôt ne porte
**ni Dockerfile ni CI** : l'hébergement est un choix ouvert, et ce document dit
ce qu'il doit satisfaire plutôt que par quoi le satisfaire.

## L'ordre de mise en route

```sh
pnpm install --frozen-lockfile
pnpm turbo build                      # apps/api -> dist/, apps/web -> .output/
pnpm --filter api db:migrate          # AVANT de démarrer l'API
node apps/api/dist/main                # :3003
node apps/web/.output/server/index.mjs # :3002
```

`db:migrate` passe avant le démarrage, pas après : une instance qui démarre sur
un schéma en retard répond en 500 sur les routes dont la colonne manque, et le
fait silencieusement pour les autres.

`GET /` sur l'API est la sonde de disponibilité — publique exprès, une sonde qui
doit s'authentifier ne sonde plus rien.

## La version de Node n'est pas un détail

**Node 24 au minimum**, et `engines.node` du `package.json` racine le déclare.

Ce n'est pas une préférence : `packageManager` épingle pnpm 11.22, qui exige
Node ≥ 22.13 et charge `node:sqlite` — un module natif apparu en Node 22. Sous
cette version, l'installation ne dégrade pas, elle **échoue** sur
`ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`, avant même
d'avoir lu une dépendance.

Le piège est qu'une plage large se résout vers le bas. `">=20"` a longtemps été
écrit là, et un constructeur qui lit cette plage a le droit d'installer Node 20 —
c'est exactement ce qu'a fait Railpack, et le déploiement a cassé à l'install.
La plage déclarée doit donc être celle sur laquelle le projet tourne vraiment,
pas la plus permissive qu'on puisse imaginer.

Si le constructeur choisit quand même mal, la plupart offrent une variable pour
forcer la main — `RAILPACK_NODE_VERSION=24` chez Railpack, qui prime sur
`engines`.

## Les variables, et ce que leur absence coûte

### Les trois sans lesquelles rien ne tourne

| Variable             | Ce qui se passe sans elle                   |
| -------------------- | ------------------------------------------- |
| `DATABASE_URL`       | rien ne démarre, app comme CLI Drizzle      |
| `VISITOR_KEY_SECRET` | **l'API refuse de démarrer** (`getOrThrow`) |
| `BETTER_AUTH_SECRET` | **l'API refuse de démarrer** (`getOrThrow`) |

Les deux secrets se génèrent par `openssl rand -hex 32`. Ils ne se changent pas
à la légère :

- changer `VISITOR_KEY_SECRET` **invalide toutes les clés visiteur** — les
  événements passés deviennent définitivement non regroupables entre eux ;
- changer `BETTER_AUTH_SECRET` déconnecte tout le monde.

Ils sont bloquants pour la même raison : ils sont lus à chaque événement ou à
chaque requête, et une valeur par défaut silencieuse produirait des données
fausses plutôt qu'une panne. Tout le reste est optionnel, et dégrade sans
casser — c'est l'arbitrage assumé du projet.

### Celles qui changent le comportement en silence

| Variable            | Défaut                  | Ce que ça coûte de la laisser au défaut                                                                                                                                                                |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`              | `3003`                  | —                                                                                                                                                                                                      |
| `WEB_URL`           | `http://localhost:3002` | **la seule origine à laquelle l'API accepte d'envoyer des cookies.** Fausse en production, le dashboard reçoit des 401 sur ses propres données. L'ingestion, elle, reste ouverte à toutes les origines |
| `API_URL`           | `http://localhost:3003` | Better Auth s'en sert pour construire les liens qu'il met dans les emails : faux, les liens d'invitation pointent sur localhost                                                                        |
| `DATABASE_POOL_MAX` | `10`                    | ce qui doit tenir sous le `max_connections` du serveur est le **produit** par le nombre d'instances — deux API derrière un répartiteur, c'est vingt                                                    |
| `TRUST_PROXY_HOPS`  | `0`                     | voir ci-dessous — c'est le réglage le plus dangereux du fichier                                                                                                                                        |
| `GEOIP_DB_PATH`     | —                       | la géolocalisation est simplement désactivée : l'API démarre et ingère, les sessions n'ont pas de pays                                                                                                 |
| `RETENTION_ENABLED` | `true`                  | voir ci-dessous                                                                                                                                                                                        |

### `TRUST_PROXY_HOPS`, et pourquoi jamais `true`

Derrière un reverse proxy, la connexion vient du proxy : `request.ip` vaut son
adresse, la même pour tout le trafic — donc **une seule clé visiteur et un seul
pays pour le monde entier**. La vraie adresse est dans `X-Forwarded-For`.

Mais un en-tête, ça s'écrit, et `POST /v1/events` est ouvert à toutes les
origines et sans session. Avec `trust proxy: true`, n'importe qui enverrait
`X-Forwarded-For: 8.8.8.8` et **choisirait** son IP — donc sa clé visiteur
(visiteurs uniques gonflés ou fusionnés à volonté) et son pays.

D'où un **nombre de sauts** et non un booléen : Express ne lit alors que la
n-ième adresse en partant de la fin, celle qu'un proxy de confiance a écrite, et
ignore ce que le client a mis devant. La valeur est un fait de la topologie du
déploiement, pas une préférence — un proxy devant l'API, c'est `1` ; un CDN puis
un load balancer, c'est `2`. Trop haut, la faille est ouverte ; trop bas, tout
le monde partage un pays.

En local, `0` est le bon réglage, et c'est pour ça qu'il n'y a pas de pays sur le
poste de développement. Ce n'est pas un bug.

### `RETENTION_ENABLED`, et la seule chose qu'elle gouverne

La purge des données de plus de 25 mois tourne tous les jours à 03:15 UTC. La
variable ne gouverne **que le déclenchement planifié** : la durée est une
constante du code (`RETENTION_MONTHS`), parce qu'une politique destructrice et
irréversible n'a pas à pouvoir être changée par une variable d'environnement, où
un `1` posé par erreur effacerait deux ans d'historique sans qu'aucun diff ne
l'ait montré.

Plusieurs instances sur la même base peuvent toutes l'avoir à `true` : le verrou
consultatif (`pg_try_advisory_lock`) rend l'exécution concurrente inoffensive.
La mettre à `false` sert aux instances qui ne doivent pas purger — une réplique
de lecture, un bac à sable branché sur une copie de production.

⚠️ Conséquence de conformité : `RETENTION_ENABLED=false` sur l'instance de
production satisfait l'article 5(1)(e) par rien du tout. La
[LIA](./legitimate-interest-assessment.md) en fait une vérification à la charge
du responsable de traitement, pas une garantie du logiciel.

### Le fichier GeoIP

DB-IP City Lite, format mmdb, ~124 Mo — **hors du dépôt**, donc à provisionner
au déploiement. À télécharger sur <https://db-ip.com/db/download/ip-to-city-lite>
et à poser où `GEOIP_DB_PATH` le désigne.

Le choix définitif de la base reste à trancher avant la mise en production : la
Lite est une base de développement.

### Côté web

Une seule variable, `VITE_API_URL`, défaut `http://localhost:3003`. Elle est
**inlinée au build** par Vite : la changer demande de rebuilder, pas de
redémarrer. Il n'y a pas de `.env.example` côté web ; c'est la seule.

## Le trou à connaître avant d'ouvrir à des tiers

**Aucun fournisseur d'email n'est branché.** `sendResetPassword` et
`sendVerificationEmail` **journalisent le lien** au lieu de l'envoyer, et
`requireEmailVerification: false` en découle mécaniquement — exiger une
vérification qu'aucun email ne transporte rendrait l'inscription impossible.

Tant que c'est le cas : une réinitialisation de mot de passe et une invitation
d'organisation ne sont récupérables que dans les journaux du serveur. Utilisable
en interne, à brancher avant d'ouvrir à quelqu'un d'autre.

## Stripe : déployer sans, brancher après

Les quatre variables Stripe sont optionnelles. Sans elles, l'API démarre et
ingère normalement ; un avertissement part au démarrage, et seule la connexion
d'un compte est refusée — en 503, avec un message explicite. Aucune route de
lecture ne demande l'intégration : un projet qui n'a jamais branché Stripe lit
son tableau de bord comme les autres, avec un revenu à zéro, et
`test/revenue-sans-stripe.e2e-spec.ts` fige exactement ça.

Les migrations des tables Stripe passent de toute façon. Il n'y a donc rien à
préparer pour brancher plus tard.

### Ce qu'il faudra le jour venu

Côté variables :

| Variable                   | Ce que c'est                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`        | notre clé plateforme (`sk_…`) : échange OAuth, appels au nom d'un compte connecté, signature du `state`. Un vrai secret, elle ne quitte jamais le serveur |
| `STRIPE_CONNECT_CLIENT_ID` | l'identifiant de la plateforme dans Connect (`ca_…`). Pas secret, il voyage dans l'URL d'autorisation                                                     |
| `STRIPE_WEBHOOK_SECRET`    | signature des webhooks (`whsec_…`). **Sans lui, les webhooks sont refusés en 503** : aucun revenu ne rentre                                               |
| `STRIPE_CONNECT_SCOPE`     | `read_only` ou `read_write`                                                                                                                               |

Côté dashboard Stripe, deux réglages que rien dans le code ne peut faire :

1. **Déclarer l'URL de retour** sur
   <https://dashboard.stripe.com/settings/connect/onboarding-options/oauth> :
   c'est `WEB_URL + /integrations/stripe/callback`, avec le domaine de
   production. Non déclarée, Stripe refuse la redirection.
2. **Créer l'endpoint webhook Connect** vers `https://<api>/v1/webhooks/stripe`.
   Un endpoint de compte, et non Connect, ne porte pas `event.account` — le hub
   ignore alors tout ce qu'il reçoit, silencieusement et à raison.

### Le piège du scope, qui décide du moment

`read_only` est la cible : le hub lit des paiements, il n'en crée aucun, et ça
nous met hors d'état de casser quoi que ce soit chez un client. Mais **Stripe ne
l'accorde pas d'office** — sans démarche auprès de leur support, l'autorisation
échoue sur « Please use the `read_write` scope, or contact support in order to
use read-only connections ».

Ce que `read_write` coûte au-delà du principe : la restriction de juin 2021 s'y
applique, donc un compte Standard déjà contrôlé par une autre plateforme devient
impossible à connecter.

⚠️ **Le scope est figé dans la ligne d'intégration au moment du branchement.**
Brancher des comptes en `read_write` maintenant, c'est devoir les faire tous
rebrancher le jour où le support accorde `read_only`. Déployer sans Stripe tant
que la question n'est pas tranchée évite précisément cette dette.

## Ce qui n'est pas encore là

- **Pas de plafond d'ingestion par projet.** C'est la seule protection réelle
  contre un projet qui déverse, et elle n'est pas faite. Un hub ouvert sans elle
  n'a rien pour se défendre.
- **Supprimer un compte laisse son organisation orpheline.** `organizations`
  n'a aucune clé étrangère vers `users` : supprimer un compte emporte son
  appartenance, jamais l'organisation que l'inscription lui a créée.
