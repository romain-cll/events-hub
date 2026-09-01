import type { EventRow } from '@events-hub/api-contract';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '#/components/ui/empty';
import { PeriodSelector } from '#/components/period-selector';
import { Skeleton } from '#/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs';
import { PERIODS, periodBounds, type Period } from '#/lib/analytics';
import { eventsQuery } from '#/lib/events';
import { projectsQuery } from '#/lib/projects';

/**
 * L'explorateur d'événements : le journal brut, page par page.
 *
 * ## Ce que cet écran est, et que le tableau de bord n'est pas
 *
 * Analytics répond à des questions — combien de visiteurs, quelles pages, d'où
 * ils viennent — et ne sait donc parler que de vues de page. Ici il n'y a pas
 * de question : des événements, dans l'ordre où ils sont arrivés, avec leurs
 * deux sacs intacts. C'est le seul écran du produit où un type que personne n'a
 * prévu s'affiche comme les autres.
 *
 * ## Le plus récent en tête
 *
 * Un journal se consulte par ce qui vient d'arriver. Le pas de pagination va
 * donc vers le **passé** : le chevron droit descend dans le journal, le gauche
 * remonte vers le présent en réutilisant un curseur déjà vu.
 *
 * ## L'unité de lecture est la session
 *
 * Le journal reste **chronologique** — à l'envers, mais sans trou —, donc les
 * visites s'y entrelacent : deux visiteurs simultanés produisent des lignes
 * alternées. Les regrouper par
 * session aurait détruit ce que le journal a d'utile — l'ordre réel — alors
 * survoler une ligne éteint tout ce qui n'appartient pas à sa session. Le fil
 * se lit dans le désordre ambiant sans qu'on ait à le sortir.
 *
 * ## Trois choses dans l'URL, une dans le composant
 *
 * La fenêtre et le filtre s'y trouvent, pour la raison déjà posée sur
 * `analytics` : un tableau de bord se partage et se met en favori. Le curseur
 * non — c'est une position opaque et transitoire, qui dans un signet ne
 * désignerait plus rien après quelques jours d'ingestion.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/events')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { days: Period; offset: number; types?: string[] } => ({
    days: PERIODS.includes(search.days as Period) ? (search.days as Period) : 7,
    offset: Math.max(0, Math.trunc(Number(search.offset)) || 0),
    // Trois états, et les trois disent autre chose. Absent : aucun filtre, donc
    // tous les types — c'est ce que l'API comprend quand le paramètre manque.
    // Une liste : ceux-là. Une liste **vide** : aucun, ce qui n'est pas « tous »
    // et ne part jamais sur le réseau.
    types: Array.isArray(search.types)
      ? search.types.filter((type): type is string => typeof type === 'string')
      : undefined,
  }),
  component: Events,
});

const time = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
});

const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});

/**
 * La clé où le SDK range le chemin de la page.
 *
 * Nommée une fois, et son absence est prévue : un événement métier émis par un
 * client n'a aucune raison de la porter, et la colonne doit alors afficher un
 * tiret plutôt que de disparaître. C'est la seule clé que cet écran connaisse,
 * et il n'en dépend pas.
 */
const PATH_ATTRIBUTE = 'page.path';

function periodLabel(days: Period, offset: number): string {
  const { first, last } = periodBounds(days, offset);

  return `${dayLabel.format(first)} – ${dayLabel.format(last)}`;
}

/**
 * `a3f1d6c4-…` → `a3f1`. Le fil se reconnaît, il ne se recopie pas.
 *
 * `null` — un événement serveur, qui n'a pas de visiteur — donne un tiret. Ce
 * n'est pas une donnée qui manquerait : il n'y a pas de fil à suivre, et une
 * puce vide le dirait moins clairement qu'un tiret assumé.
 */
function shortSession(sessionId: string | null): string {
  return sessionId === null ? '—' : sessionId.slice(0, 4);
}

/** Une valeur de sac JSON, écrite pour tenir sur une ligne. */
function scalar(value: unknown): string {
  // Les valeurs viennent d'un `JSON.parse` : `undefined` ne peut pas s'y
  // trouver, donc `JSON.stringify` rend toujours une chaîne.
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function Events() {
  const { projectId } = Route.useParams();
  const { days, offset, types } = Route.useSearch();
  const navigate = Route.useNavigate();

  // La pile des curseurs déjà franchis. Elle appartient à la lecture en cours :
  // changer de fenêtre ou de filtre en fait une autre, et la pile d'avant n'y
  // désigne plus rien. La comparer à l'identité de la requête la remet à zéro
  // au bon moment, sans effet de bord ni synchronisation à tenir.
  const identity = JSON.stringify({ days, offset, types });
  const [trail, setTrail] = useState<{ key: string; stack: string[] }>({
    key: identity,
    stack: [],
  });

  const stack = trail.key === identity ? trail.stack : [];
  const after = stack.at(-1);

  const [hovered, setHovered] = useState<string | null>(null);
  const [opened, setOpened] = useState<number | null>(null);

  // `types` part tel quel : absent vaut « tous », vide vaut « aucun », et c'est
  // `eventsQuery` qui décide lequel des deux atteint le réseau.
  const page = useQuery(eventsQuery(projectId, days, offset, { types, after }));

  const projects = useQuery(projectsQuery());
  const project = projects.data?.find(({ id }) => id === projectId);

  const facets = page.data?.types ?? [];
  const checked = types ?? facets;
  const nothingChecked = types !== undefined && types.length === 0;

  // « Tout coché » a deux écritures — le filtre absent, ou la liste complète —
  // et elles doivent se présenter pareil. Les distinguer à l'écran donnerait une
  // case décochée au-dessus d'un libellé qui dit « All types ».
  const allChecked =
    types === undefined ||
    (facets.length > 0 && checked.length === facets.length);

  const go = (next: string[] | undefined) => {
    setOpened(null);
    void navigate({ search: { days, offset, types: next } });
  };

  const toggle = (type: string) => {
    const without = checked.filter((kept) => kept !== type);

    go(checked.includes(type) ? without : [...checked, type]);
  };

  const label = nothingChecked
    ? 'No types'
    : allChecked
      ? 'All types'
      : checked.length === 1
        ? checked[0]
        : `${checked.length} types`;

  const events = page.data?.events ?? [];

  // La page est rendue du plus récent au plus ancien ; la tranche de temps, elle,
  // s'écrit dans le sens de lecture habituel. La dernière ligne est donc la borne
  // gauche — l'inverse se lirait comme un intervalle à l'envers.
  const span =
    events.length > 0
      ? `${time.format(new Date(events[events.length - 1].occurredAt))} – ${time.format(
          new Date(events[0].occurredAt),
        )}`
      : '—';

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="text-muted-foreground text-sm">
            {project?.name ?? 'Loading…'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PeriodSelector
            size="sm"
            previousLabel={`Previous ${days} days`}
            nextLabel={`Next ${days} days`}
            canGoNext={offset > 0}
            onPrevious={() => {
              void navigate({ search: { days, offset: offset + 1, types } });
            }}
            onNext={() => {
              void navigate({ search: { days, offset: offset - 1, types } });
            }}
          >
            {periodLabel(days, offset)}
          </PeriodSelector>

          <Tabs
            value={String(days)}
            onValueChange={(value) => {
              void navigate({
                search: { days: Number(value) as Period, offset: 0, types },
              });
            }}
          >
            <TabsList>
              {PERIODS.map((period) => (
                <TabsTrigger key={period} value={String(period)}>
                  {period} days
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {page.error ? (
        <Empty className="border">
          <EmptyTitle>Events unavailable</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">
            {page.error.message}
          </EmptyDescription>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Event log</CardTitle>
            <CardDescription>
              Newest first. Hover a row to follow its session through the log.
            </CardDescription>

            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={facets.length === 0}
                  >
                    {label}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>

                {/* `onSelect` est empêché de fermer le menu : un filtre à
                    cocher se règle en plusieurs gestes, et se refermer à chaque
                    case obligerait à le rouvrir autant de fois. */}
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuCheckboxItem
                    // Trois états, parce que la case en porte trois : pleine
                    // quand tout est coché, vide quand rien ne l'est, et barrée
                    // entre les deux — une case vide sur une sélection
                    // partielle dirait le contraire de ce que le tableau montre.
                    checked={
                      allChecked
                        ? true
                        : nothingChecked
                          ? false
                          : 'indeterminate'
                    }
                    onSelect={(event) => {
                      event.preventDefault();
                      // Tout ou rien : elle coche quand il en manque, et ne
                      // décoche que lorsque tout l'est déjà.
                      go(allChecked ? [] : undefined);
                    }}
                  >
                    All types
                  </DropdownMenuCheckboxItem>

                  <DropdownMenuSeparator />

                  {facets.map((type) => (
                    <DropdownMenuCheckboxItem
                      key={type}
                      checked={checked.includes(type)}
                      onSelect={(event) => {
                        event.preventDefault();
                        toggle(type);
                      }}
                    >
                      <span className="font-mono text-xs">{type}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {nothingChecked ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No event type selected</EmptyTitle>
                  <EmptyDescription>
                    Pick at least one type to read the log.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : page.data === undefined ? (
              <Skeleton className="h-[420px] w-full" />
            ) : events.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    Nothing over {periodLabel(days, offset)}
                  </EmptyTitle>
                  <EmptyDescription>
                    No event reached this project over the period.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Log
                events={events}
                hovered={hovered}
                opened={opened}
                onHover={setHovered}
                onOpen={(index) =>
                  setOpened((current) => (current === index ? null : index))
                }
              />
            )}

            {page.data && events.length > 0 ? (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground text-xs">
                  {events.length} events · 20 per page
                </span>

                {/* Le pas affiche une **tranche de temps**, pas un numéro de
                    page : un curseur ne sait pas compter ce qu'il n'a pas lu,
                    et un total coûterait à chaque page ce que la pagination
                    évite. */}
                <PeriodSelector
                  size="sm"
                  previousLabel="Newer events"
                  nextLabel="Older events"
                  canGoPrevious={stack.length > 0}
                  canGoNext={page.data.nextCursor !== null}
                  onPrevious={() => {
                    setOpened(null);
                    setTrail({ key: identity, stack: stack.slice(0, -1) });
                  }}
                  onNext={() => {
                    const next = page.data?.nextCursor;

                    if (next === null || next === undefined) return;

                    setOpened(null);
                    setTrail({ key: identity, stack: [...stack, next] });
                  }}
                >
                  {span}
                </PeriodSelector>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Les colonnes, écrites une fois : l'en-tête et les lignes s'y alignent. */
const COLUMNS = 'grid-cols-[84px_128px_76px_minmax(0,1fr)_minmax(0,1.4fr)]';

/**
 * Le journal, et le fil de session.
 *
 * Le survol n'ajoute rien à l'écran : il **retire**. Les lignes des autres
 * sessions s'effacent, celles de la session survolée gardent leur opacité et
 * prennent un rail à gauche. C'est la seule mise en évidence de l'écran, et
 * elle n'utilise qu'une couleur — un code couleur par session aurait demandé
 * une palette catégorielle que le design system ne certifie qu'à trois
 * emplacements, alors qu'une fenêtre porte des dizaines de sessions.
 */
function Log({
  events,
  hovered,
  opened,
  onHover,
  onOpen,
}: {
  events: EventRow[];
  hovered: string | null;
  opened: number | null;
  onHover: (sessionId: string | null) => void;
  onOpen: (index: number) => void;
}) {
  return (
    <div className="text-sm">
      <div
        className={`text-muted-foreground grid ${COLUMNS} border-b font-medium`}
      >
        <div className="px-2 py-2">Time</div>
        <div className="px-2 py-2">Type</div>
        <div className="px-2 py-2">Session</div>
        <div className="px-2 py-2">Path</div>
        <div className="px-2 py-2">Properties</div>
      </div>

      {events.map((event, index) => {
        // Les deux comparaisons excluent `null` explicitement, et ce n'est pas
        // de la prudence : `hovered` vaut `null` quand rien n'est survolé, et
        // `sessionId` vaut `null` quand l'événement n'a pas de visiteur. Sans
        // ce garde, `null === null` ferait passer toutes les lignes serveur
        // pour le fil survolé, en permanence.
        const followable = hovered !== null && event.sessionId !== null;
        const dimmed = hovered !== null && hovered !== event.sessionId;
        const threaded = followable && hovered === event.sessionId;
        const path = event.attributes[PATH_ATTRIBUTE];

        return (
          <div
            key={`${event.sessionId}-${event.occurredAt}-${String(index)}`}
            className={`border-b transition-opacity last:border-b-0 ${
              dimmed ? 'opacity-30' : ''
            } ${threaded ? 'shadow-[inset_2px_0_0_var(--primary)]' : ''}`}
            onMouseEnter={() => {
              onHover(event.sessionId);
            }}
            onMouseLeave={() => {
              onHover(null);
            }}
          >
            <button
              type="button"
              className={`hover:bg-muted/50 grid w-full ${COLUMNS} cursor-pointer items-center text-left`}
              onClick={() => {
                onOpen(index);
              }}
            >
              <span className="text-muted-foreground px-2 py-2 font-mono text-xs tabular-nums">
                {time.format(new Date(event.occurredAt))}
              </span>
              <span className="px-2 py-2">
                <Badge variant="secondary" className="font-mono">
                  {event.type}
                </Badge>
              </span>
              <span className="text-muted-foreground px-2 py-2 font-mono text-xs">
                {shortSession(event.sessionId)}
              </span>
              <span className="truncate px-2 py-2">
                {typeof path === 'string' ? path : '—'}
              </span>
              <span className="text-muted-foreground truncate px-2 py-2 font-mono text-xs">
                {Object.entries(event.properties)
                  .map(([key, value]) => `${key} ${scalar(value)}`)
                  .join('  ·  ') || '—'}
              </span>
            </button>

            {opened === index ? <Detail event={event} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ce que la ligne ne montrait pas : les deux sacs en entier, et la session.
 *
 * Les deux colonnes ne sont pas décoratives — `attributes` décrit le contexte
 * du navigateur, `properties` ce que l'événement dit de lui-même. Les fondre
 * ferait perdre la seule chose qui distingue une clé du SDK d'une clé du type.
 */
function Detail({ event }: { event: EventRow }) {
  return (
    <div className="bg-muted/40 grid gap-6 px-2 pt-2 pb-4 sm:grid-cols-2">
      <Bag title="Attributes" bag={event.attributes} />

      <div className="flex flex-col gap-4">
        <Bag title="Properties" bag={event.properties} />
        <Bag
          title="Origin"
          bag={{
            source: event.source,
            sessionId: event.sessionId,
            sessionStartedAt: event.sessionStartedAt,
          }}
        />
      </div>
    </div>
  );
}

function Bag({ title, bag }: { title: string; bag: Record<string, unknown> }) {
  const entries = Object.entries(bag);

  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
        {title}
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground font-mono text-xs">empty</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground truncate">{key}</dt>
              <dd className="truncate">{scalar(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
