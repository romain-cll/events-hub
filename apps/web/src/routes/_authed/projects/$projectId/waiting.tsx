import { useQuery } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { CheckCircle2Icon } from 'lucide-react';
import { useEffect } from 'react';

import { Steps } from '#/components/onboarding';
import { Button } from '#/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#/components/ui/empty';
import { Spinner } from '#/components/ui/spinner';
import { ingestionQuery } from '#/lib/projects';

/** Le rythme d'interrogation pendant l'attente. */
const POLL_MS = 3000;

/** Le temps laissé à « c'est arrivé » avant de basculer sur les analytics. */
const CELEBRATE_MS = 1200;

/**
 * La vue par défaut des analytics, telle que la route l'exige.
 *
 * `offset: 0` est la période en cours. Il est écrit plutôt que sous-entendu :
 * la route le rend obligatoire pour que rien ne puisse lier vers un décalage
 * involontaire, et un projet qui vient de recevoir son premier événement n'a
 * aucune raison d'ouvrir sur autre chose qu'aujourd'hui.
 */
const DEFAULT_VIEW = { days: 7, offset: 0 } as const;

/**
 * Étape 3 sur 3 — on attend le premier événement, et on ne fait que ça.
 *
 * ## Le `loader` est ce qui saute l'écran
 *
 * C'est la seule route du dashboard à en avoir un, et pour une raison précise :
 * la décision « faut-il montrer cette page ? » doit être prise **avant** de la
 * monter. Prise dans le composant, elle produirait un écran d'attente affiché
 * une fraction de seconde à quelqu'un qui n'attend rien — la personne qui
 * revient sur un projet déjà installé verrait clignoter un état qui la
 * concerne encore moins qu'il n'est vrai.
 *
 * `redirect` est *levé*, comme dans `_authed` : le routeur l'intercepte comme un
 * signal, ce qui interrompt le chargement au lieu de le laisser finir.
 *
 * ## Le sondage s'arrête tout seul
 *
 * `refetchInterval` lit l'état de la requête et rend `false` une fois
 * l'événement vu. Sans ça, la page continuerait d'interroger l'API pendant la
 * seconde d'affichage du succès, et surtout pendant tout le temps où un onglet
 * oublié resterait ouvert sur cet écran.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/waiting')({
  loader: async ({ context, params }) => {
    const status = await context.queryClient.ensureQueryData(
      ingestionQuery(params.projectId),
    );

    if (status.hasEvents) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({
        to: '/projects/$projectId/analytics',
        params: { projectId: params.projectId },
        search: DEFAULT_VIEW,
        replace: true,
      });
    }
  },
  component: Waiting,
});

function Waiting() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();

  const { data, error } = useQuery({
    ...ingestionQuery(projectId),
    refetchInterval: (query) => (query.state.data?.hasEvents ? false : POLL_MS),
  });

  const received = data?.hasEvents ?? false;

  /**
   * La bascule, une fois l'événement vu.
   *
   * Le délai n'est pas décoratif : c'est la seule confirmation que
   * l'installation a marché. Basculer à l'instant même donnerait un écran
   * d'analytics surgi de nulle part, sans que rien n'ait dit « ça y est ».
   *
   * `replace` : l'attente ne doit pas rester dans l'historique. Un « retour »
   * depuis les analytics y ramènerait, le `loader` renverrait aussitôt en
   * avant, et le bouton retour serait piégé. Il ramène donc à l'installation,
   * qui est la page utile à relire.
   */
  useEffect(() => {
    if (!received) return;

    const timer = setTimeout(() => {
      void navigate({
        to: '/projects/$projectId/analytics',
        params: { projectId },
        search: DEFAULT_VIEW,
        replace: true,
      });
    }, CELEBRATE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [received, navigate, projectId]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Steps current={3} />

      {error ? (
        <Empty className="border">
          <EmptyTitle>Cannot tell yet</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">
            {error.message}
          </EmptyDescription>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/projects/$projectId/setup" params={{ projectId }}>
                Back to the snippet
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : received ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2Icon className="text-primary" />
            </EmptyMedia>
            <EmptyTitle>First event received</EmptyTitle>
            <EmptyDescription>
              Your site is talking to the hub. Taking you to the analytics.
            </EmptyDescription>
          </EmptyHeader>

          <EmptyContent>
            <Button asChild>
              <Link
                to="/projects/$projectId/analytics"
                params={{ projectId }}
                search={DEFAULT_VIEW}
                replace
              >
                View analytics
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Waiting for your first event</EmptyTitle>
            <EmptyDescription>
              Open your site in a browser — the SDK sends a page view as soon as
              a page loads. We check every few seconds and move on by ourselves.
            </EmptyDescription>
          </EmptyHeader>

          <EmptyContent>
            {/*
              Les deux issues d'une attente qui dure, et elles sont
              différentes : « rien n'arrive, montre-moi le snippet » et « je
              finirai plus tard ». N'offrir que la seconde laisserait quelqu'un
              relire son intégration de mémoire.
            */}
            <Button asChild variant="outline">
              <Link to="/projects/$projectId/setup" params={{ projectId }}>
                Show the snippet again
              </Link>
            </Button>

            <Button asChild variant="ghost">
              <Link to="/projects">I&rsquo;ll finish later</Link>
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
