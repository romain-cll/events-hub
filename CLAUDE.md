# events-hub

Un **hub d'événements** : on y ingère des événements de toutes provenances —
analytics navigateur, produit, deployments, uptime, erreurs, paiements — pour
pouvoir les **croiser** et savoir ce qui cause quoi. La question que le produit
vise est « **qu'est-ce qui a un impact sur le revenu ?** » : quelle source
rapporte, quelle fonctionnalité convertit, ce qu'a coûté cette erreur ou ce
déploiement. L'analytics web est la première verticale livrée, pas le produit.

Le revenu est une **famille d'événements comme les autres**, pas un module à
part : le socle n'en sait rien, il route, stocke et compte. La seule contrainte
que ce cadrage ajoute est négative — ne jamais supposer, dans le socle, qu'un
événement vient du navigateur ou relève de l'analytics.

Monorepo pnpm + turbo : `apps/api` (NestJS + Drizzle + Postgres), `apps/web`
(TanStack Start + React), `packages/api-contract`, `packages/sdk`.

## À savoir avant de toucher quoi que ce soit

**Ne démarre jamais les serveurs de dev.** Ils tournent déjà sous turbo — web sur
`:3002`, API sur `:3003`. Un `pnpm dev` de plus échoue sur un port occupé ou, pire,
en prend un autre en silence.

**Compte de test : `test@test.com` / `password`.** Se connecter avec, plutôt que
créer un compte jetable qui laissera une organisation orpheline derrière lui.

**Interface en anglais**, commentaires et discussions **en français**.

## Les invariants qui cassent le build

`apps/api/src/architecture.spec.ts` lit les sources et échoue sur la *forme* du
code. Ce ne sont pas des préférences, ce sont des tests :

- **Hors de `features/`, aucun fichier ne nomme un type d'événement** — pas même
  dans un commentaire. Écrire « pollue déjà avec `page_view` » dans une docstring
  du socle fait échouer la suite. Dire « un type enregistré » à la place.
- Hors de `features/`, on ne compare pas un `type` à un littéral, on n'aiguille pas
  dessus, on n'indexe pas un comportement par lui.
- `@events-hub/api-contract` n'entre dans `apps/api/src/` qu'en **`import type`**.
  Un import de valeur ferait entrer le paquet dans le build émis.

`apps/api/src/contract.spec.ts` vérifie que chaque forme de réponse **coïncide dans
les deux sens** avec son schéma de `packages/api-contract`. Ajouter un champ à une
réponse sans toucher le contrat ne compile pas, exprès : le contrat a dérivé quatre
fois avant d'exister, et c'est ce qui l'empêche.

## La frontière socle / métier

Le **socle** — `core/`, `events/`, `event-types/`, `sessions/`, `privacy/`,
`geoip/` — ne sait pas ce qu'un type d'événement *signifie*. Il route, stocke,
compte. Les **modules métier** (`features/`) sont les seuls à avoir le droit
d'interpréter, et c'est leur travail.

`EventStore` est le **seul** accès à la table `events`. Sa méthode privée `where()`
est traversée par les neuf lectures : c'est là que vit toute règle qui doit valoir
pour toutes (le filtre `serverOnly` y est). Une règle posée dans un module de
`features/` sera oubliée par le suivant.

Un module du socle n'est pas monté dans `AppModule` : il est tiré par ceux qui
l'importent. Les modules de `features/` portent le suffixe `Feature` pour ne pas
être confondus avec leur voisin du socle (`EventsModule` vs `EventsFeatureModule`).

## Le modèle d'événement

Un événement porte `type` (chaîne libre, inventée par le client), `occurredAt`,
`source`, `sessionId` **nullable**, et deux sacs `jsonb` opaques.

Il n'y a **pas de version d'événement**, et c'est délibéré : la colonne a existé,
ne consignait rien, et personne ne pouvait la remplir correctement. La
compatibilité du fil est portée par le préfixe **`/v1`** de l'API — dans `/v1` on
n'ajoute que de l'optionnel, une rupture devient `/v2`. La version du SDK, elle,
voyage dans `attributes` sous `sdk.version`.

- **`source`** vaut `browser` ou `server`, et il est **dérivé de la classe de clé**
  présentée à l'ingestion, jamais lu dans le payload. C'est ce qui le rend digne de
  confiance.
- **`sessionId` à `null`** n'est pas une valeur manquante : c'est un événement
  **sans visite** — un deploy, un paiement, une sonde. Les compteurs adossés à la
  session s'en filtrent structurellement (`COUNT DISTINCT` ignore les `NULL`, une
  jointure interne écarte ces lignes) : il n'y a **rien à filtrer à la main**.
- **`visitorKey` à `null`** est l'autre question, et ce n'est pas la même : « pas de
  visite » ne veut pas dire « pas de visiteur ». Un paiement rapporté par un serveur
  désigne quelqu'un dont on connaît le parcours, des mois après sa dernière visite.
  La colonne ne porte **que** l'identité durable, celle qui a été consentie —
  jamais la clé dérivée du réseau, qui tourne chaque jour. Sans consentement, un
  paiement n'est corrélable à rien, et c'est le cadre qui le veut.
  `features/` n'a pas le droit de **nommer** cette clé : la corrélation passe par
  `EventStore`.

**La règle de rangement :** colonne = axe de corrélation **dérivé par le serveur** ;
`jsonb` = charge utile **fournie par le client**, de forme dépendante du `type`. Les
mélanger laisserait un client écrire une valeur que le serveur est censé garantir.

Deux natures de clé : `eh_pk_` publique, stockée en clair, `Origin` vérifiée ;
`eh_sk_` secrète, **hachée**, montrée une seule fois, sans contrôle d'`Origin`.

## Migrations

Drizzle : `pnpm --filter api db:generate`, puis `db:migrate`, puis `db:check`.

`drizzle-kit generate` réclame un TTY quand une table perd une colonne *et* en gagne
une autre dans la même génération — il demande s'il s'agit d'un renommage. **Scinder
en deux générations** plutôt que forcer.

Une colonne `NOT NULL` sans défaut sur une table déjà peuplée échoue : poser un
défaut le temps du remplissage, puis le retirer dans la même migration.

## Style

Les commentaires expliquent le **pourquoi**, ce qui a été **écarté** et ce que ça
**coûte** — jamais ce que le code fait, qui se lit. Ils sont denses et assumés :
c'est là que vivent les décisions. Un commentaire qui paraphrase la ligne suivante
est à supprimer.

Côté interface : pas de paragraphe explicatif sous une métrique — la nuance va dans
la doc, pas sous le graphique.

## Design

Compact design comme style de base ; `--spacing: 0.22rem` dans
`apps/web/src/styles.css` est le levier qui la porte. `--chart-1` vaut `--primary`
volontairement. shadcn/ui, `components.json` à la racine de `apps/web`.

## Commandes

```
pnpm turbo lint check-types test    # tout le monorepo
pnpm --filter api test:e2e          # e2e contre un vrai Postgres
pnpm --filter api db:generate       # après une modification de schéma
```
