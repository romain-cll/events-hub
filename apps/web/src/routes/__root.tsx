import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { TanStackDevtools } from '@tanstack/react-devtools';

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools';

import appCss from '../styles.css?url';

import { sessionQuery } from '#/lib/session';

import type { QueryClient } from '@tanstack/react-query';

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  /**
   * La session est résolue ici, une fois pour toutes, avant tout rendu.
   *
   * Ce que `beforeLoad` retourne fusionne dans le contexte des routes filles :
   * `_authed` y lit `session` sans avoir à la redemander, et sans que
   * `MyRouterContext` — qui décrit le contexte *initial* — ait à la déclarer.
   *
   * À la racine et non dans `_authed`, parce que les routes publiques en ont
   * besoin aussi : la page d'accueil doit savoir si elle propose « Se
   * connecter » ou « Ouvrir le dashboard ».
   *
   * `ensureQueryData` et non `fetchQuery` : au retour sur une page déjà
   * visitée, la valeur en cache est rendue telle quelle. Le coût réel est donc
   * d'un appel par chargement, pas par navigation.
   */
  beforeLoad: async ({ context }) => ({
    session: await context.queryClient.ensureQueryData(sessionQuery()),
  }),
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'events-hub',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
