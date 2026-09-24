# `@events-hub/web`

Le dashboard : TanStack Start + React + Tailwind + shadcn/ui. Sert sur
**`:3002`**, parle à l'API sur `:3003`.

⚠️ **Ne pas lancer `pnpm dev` ici** si les serveurs tournent déjà sous turbo à la
racine.

**L'interface est en anglais.** Les commentaires et les discussions sont en
français. Les écrans d'authentification encore en français sont une dette connue.

## Commandes

```sh
pnpm dev               # vite dev --port 3002
pnpm build             # -> .output/ (Nitro)
pnpm preview
pnpm generate-routes   # tsr generate — routeTree.gen.ts
pnpm lint
pnpm check-types       # tsr generate, puis tsc --noEmit
```

`node .output/server/index.mjs` sert le build. `scripts/build-world-map.mjs`
regénère les données du planisphère.

## Configuration

Une seule variable, et elle est optionnelle :

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| `VITE_API_URL` | base de l'API — ingestion, lecture, authentification. Défaut `http://localhost:3003` |

Elle est déclarée dans `src/env.d.ts` et lue **une seule fois**, dans
`src/lib/api.ts` (`API_URL`) ; `auth-client.ts` en dérive son `baseURL`. En
ajouter une seconde définition laisserait un jour l'une pointer ailleurs que
l'autre.

## Les routes

Le routage est par fichiers (`src/routes/`), `routeTree.gen.ts` est **généré** —
ne pas l'éditer.

```
index.tsx                                   /
auth/{login,signup}.tsx                     connexion, inscription
_authed/projects/index.tsx                  la liste
_authed/projects/$projectId/analytics.tsx   le tableau de bord
_authed/projects/$projectId/events.tsx      l'explorateur d'événements
_authed/projects/$projectId/setup.tsx       poser le snippet
_authed/projects/$projectId/settings/…      projet, clés, membres, organisation, intégrations
_authed/integrations/stripe/callback.tsx    le retour OAuth de Stripe
_authed/invitations/$invitationId.tsx       accepter une invitation
```

Le préfixe `_authed` porte la garde de session : la session vit dans le contexte
du routeur, jamais dans un `useSession()`.

## Design

**Compact design** comme style de base, et le levier qui la porte est
`--spacing: 0.22rem` dans `src/styles.css`. `--chart-1` vaut `--primary`
volontairement. shadcn/ui, `components.json` à la racine de `apps/web`.

Pas de paragraphe explicatif sous une métrique : la nuance va dans la doc, pas
sous le graphique.

## Où lire la suite

| Sujet                                           | Document                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Ce que la page audience × revenu doit porter    | [`docs/page-audience-revenu.md`](../../docs/page-audience-revenu.md) |
| L'inventaire des croisements analytics × revenu | [`docs/croisements-revenu.md`](../../docs/croisements-revenu.md)     |
| Mettre en ligne                                 | [`docs/deploiement.md`](../../docs/deploiement.md)                   |
| Les invariants du dépôt                         | [`CLAUDE.md`](../../CLAUDE.md)                                       |
