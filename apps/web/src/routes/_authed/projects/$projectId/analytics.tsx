import type {
  AnalyticsSummary,
  LocationGrain,
  LocationsPage,
  SessionsPage,
} from '@events-hub/api-contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from '#/components/ui/chart';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '#/components/ui/empty';
import { Button } from '#/components/ui/button';
import { PeriodSelector } from '#/components/period-selector';
import { Badge } from '#/components/ui/badge';
import { Skeleton } from '#/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs';
import {
  PERIODS,
  locationsQuery,
  periodBounds,
  previousSessionsQuery,
  previousSummaryQuery,
  sessionsQuery,
  summaryQuery,
  type Period,
} from '#/lib/analytics';
import {
  bounceRate,
  compareVisitors,
  dailyVisitors,
  entryPages,
  exits,
  percentChange,
  referrers,
  trafficSources,
  type ComparedDay,
  type ExitRow,
  type SourceRow,
} from '#/lib/analytics-rollup';
import { API_URL } from '#/lib/api';
import { deploymentsQuery, type DayDeployments } from '#/lib/deployments';
import { projectsQuery } from '#/lib/projects';

/**
 * La période vit dans l'URL plutôt que dans un `useState` : un dashboard se
 * partage et se met en favori, et « les 30 derniers jours » fait partie de ce
 * qu'on partage.
 */
export const Route = createFileRoute('/_authed/projects/$projectId/analytics')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { days: Period; offset: number } => ({
    days: PERIODS.includes(search.days as Period) ? (search.days as Period) : 7,
    // Un décalage négatif désignerait le futur, un décalage fractionnaire une
    // période qui n'existe pas. Les deux sont ramenés à « la période en
    // cours » plutôt que refusés : une URL bricolée doit rendre une page, pas
    // une erreur.
    offset: Math.max(0, Math.trunc(Number(search.offset)) || 0),
  }),
  component: Analytics,
});

/**
 * Formateurs figés sur une locale et sur UTC.
 *
 * Le défaut du navigateur donnerait un rendu différent côté serveur et côté
 * client — donc une erreur d'hydratation. UTC pour la même raison qu'au
 * repliage : une journée qui commence à 00 h 00 UTC doit s'afficher sur sa
 * journée, pas sur la veille pour un visiteur à l'ouest de Greenwich.
 */
const number = new Intl.NumberFormat('en-US');
const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});

/**
 * Le libellé du jour, sans l'année.
 *
 * Le graphique en porte deux — celui de la période courante et celui de la
 * période précédente — et sur trente jours ils tombent parfois de part et
 * d'autre d'un 31 décembre. L'année n'est donc pas décorative dans le tooltip,
 * où les deux dates se lisent côte à côte ; elle l'est sur l'axe, où toutes les
 * graduations sont de la même période.
 */
const dayWithYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Un taux tel qu'on l'écrit sur une carte : `42.3%`.
 *
 * **Jamais de signe**, et il sert aussi bien à une valeur qu'à un écart. Sur un
 * écart, le sens est déjà porté par la flèche d'à côté : l'écrire une seconde
 * fois donne « ▼ −2,3 pts », où le lecteur voit deux marques de baisse et se
 * demande si elles disent la même chose. Voir `Change`.
 *
 * Une décimale, parce que le point de pourcentage est déjà une unité fine —
 * deux feraient croire à une précision que l'échantillon n'a pas.
 */
const ratio = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** La réserve au-dessus du point le plus haut, en proportion. */
const HEADROOM = 1.2;

/** Le nombre de graduations visé — indicatif, pas imposé. */
const TICKS = 4;

/**
 * Les hauteurs de graduation qui se lisent bien, par ordre croissant.
 *
 * Multipliées par une puissance de dix, elles donnent les seuls pas qu'un œil
 * suit sans compter : 20, 25, 30, 300, 1 500. Un pas de 23 est juste aussi, et
 * illisible.
 */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * Le sommet de l'axe : 20 % au-dessus du point le plus haut, toujours.
 *
 * ## Pourquoi une réserve, et pourquoi relative
 *
 * Deux raisons qui vont dans le même sens. Une courbe qui touche le haut de son
 * cadre paraît tassée et donne l'impression d'être coupée ; et `natural` dépasse
 * réellement au-dessus du point le plus haut, donc sans réserve la crête sort du
 * tracé et se fait rogner par le bord du SVG.
 *
 * Relative parce qu'elle doit suivre l'échelle au lieu de la subir : un pic à
 * 100 monte l'axe à 120, un pic à 1 000 le monte à 1 200, et le graphique se lit
 * pareil dans les deux cas. Une réserve en pixels ferait l'inverse — elle
 * compterait beaucoup sur une petite échelle et disparaîtrait sur une grande.
 */
function chartCeiling(max: number): number {
  // Une échelle vide garde un axe : sans plafond, la ligne de base
  // disparaîtrait avec lui.
  if (max <= 0) return TICKS;

  return Math.ceil(max * HEADROOM);
}

/**
 * Les graduations, posées **sous** le plafond plutôt que dessus.
 *
 * ## C'est le point de tout ce couple de fonctions
 *
 * Les deux décisions sont séparées, et il a fallu s'y reprendre pour le voir.
 * Tant que le plafond était contraint de tomber sur une graduation ronde, la
 * réserve dérivait avec lui : un maximum de 355 poussait l'axe à 600, soit 69 %
 * de vide au-dessus de la courbe — l'inverse exact de ce qu'on cherchait.
 *
 * Ici le plafond vaut les 20 % promis, au visiteur près, et les graduations se
 * posent où le pas rond tombe. La dernière n'atteint donc pas forcément le haut
 * de l'axe, et c'est normal : une graduation dit « voici la hauteur », pas
 * « voici la limite ».
 *
 * ## Le pas est arrondi vers le bas
 *
 * Vers le haut, il sauterait la dernière graduation dès qu'il dépasserait le
 * quart du plafond, et une échelle à deux traits ne se lit plus. Vers le bas, au
 * pire, on en gagne une.
 */
function chartTicks(ceiling: number): number[] {
  const magnitude = 10 ** Math.floor(Math.log10(ceiling / TICKS));
  const step = Math.max(
    // Le plancher à 1 tient les petits volumes : des visiteurs sont des
    // entiers, un axe gradué en demis n'a pas de sens.
    1,
    Math.floor(
      [...NICE_STEPS]
        .reverse()
        .map((nice) => nice * magnitude)
        .find((size) => size <= ceiling / TICKS) ?? magnitude,
    ),
  );

  const ticks: number[] = [];

  for (let value = 0; value <= ceiling; value += step) ticks.push(value);

  return ticks;
}

const chartConfig = {
  current: { label: 'Current period', color: 'var(--chart-1)' },
  previous: { label: 'Previous period', color: 'var(--chart-2)' },
  // Une troisième couleur, parce que les deux premières sont prises et qu'un
  // marqueur qui reprendrait l'une d'elles se lirait comme un point de mesure.
  // Elle est dans la légende pour la même raison : un rond isolé sur l'axe
  // n'explique pas ce qu'il marque.
  deployments: { label: 'Deployment', color: 'var(--chart-3)' },
} satisfies ChartConfig;

/**
 * La période affichée, écrite en toutes lettres : `Aug 21 – Aug 27`.
 *
 * L'année n'apparaît que quand la période ne tombe pas dans l'année en cours.
 * Sur un tableau de bord, `2026` est vrai partout et n'apprend rien tant qu'on
 * n'a pas reculé assez loin pour que ça change — l'écrire tout le temps est du
 * bruit qui pousse le reste vers la droite.
 */
function periodLabel(days: Period, offset: number): string {
  const { first, last } = periodBounds(days, offset);
  const thisYear = last.getUTCFullYear() === new Date().getUTCFullYear();
  const format = thisYear ? dayLabel : dayWithYear;

  return `${format.format(first)} – ${format.format(last)}`;
}

/**
 * Les natures qu'on annonce à côté du nom.
 *
 * `referral` n'y est pas, et c'est le seul absent volontaire. Un lien depuis
 * `news.ycombinator.com` est simplement une source : le site est nommé, il n'y
 * a rien à ajouter. Écrire « referral » à côté figerait le mot sur ce cas-là,
 * alors qu'il est réservé à ce qui viendra — un `?ref=` posé délibérément sur
 * un lien, une notion qui n'existe encore ni dans le SDK ni dans l'API.
 *
 * `search` et `internal` restent, parce que le nom seul ne les dit pas :
 * `google` pourrait être n'importe quel site, et `shop.test` ressemble à un
 * tiers alors que c'est nous.
 */
const LABELLED_KINDS = new Set<SourceRow['kind']>(['search', 'internal']);

/**
 * ## Deux requêtes, et tout le reste en découle
 *
 * `/analytics` rend les agrégats de période — il ne fait remonter aucune ligne,
 * donc son coût ne dépend pas du volume, et il porte le seul chiffre
 * irrécupérable autrement (`uniqueVisitors`). `/analytics/sessions` rend le
 * journal replié, une ligne par session, dont on tire ici le trafic quotidien,
 * les provenances et les totaux.
 *
 * Elles sont séparées pour deux raisons qui tiennent : elles ne coûtent pas la
 * même chose, et une panne de l'une ne doit pas effacer ce que l'autre a déjà
 * rendu.
 *
 * ## Trois requêtes, et la troisième ne sert qu'au graphique
 *
 * La période précédente est lue à part. Élargir la fenêtre courante à deux fois
 * sa longueur ferait répondre les provenances et les totaux sur soixante jours
 * au lieu de trente, sans que rien à l'écran ne le dise.
 *
 * ## Les visiteurs par jour sont revenus
 *
 * Ils avaient disparu avec la série que l'API ne produit plus, et ils ne se
 * reconstruisaient pas : un compte de valeurs distinctes n'est pas une somme.
 * Chaque ligne de session porte maintenant un alias de visiteur — opaque, tiré
 * au hasard à chaque appel — et `dailyVisitors` dédoublonne journée par
 * journée.
 */
function Analytics() {
  const { projectId } = Route.useParams();
  const { days, offset } = Route.useSearch();
  const navigate = Route.useNavigate();

  const summary = useQuery(summaryQuery(projectId, days, offset));
  const sessions = useQuery(sessionsQuery(projectId, days, offset));
  const before = useQuery(previousSessionsQuery(projectId, days, offset));
  const beforeSummary = useQuery(previousSummaryQuery(projectId, days, offset));
  const deployments = useQuery(deploymentsQuery(projectId, days, offset));
  const projects = useQuery(projectsQuery());

  // Le résumé de la période précédente ne sert qu'aux évolutions des cartes du
  // haut, et il est traité comme tel : sa panne ne rejoint pas la bannière
  // d'erreur — elle rend `null`, les cartes gardent leurs chiffres et
  // n'affichent pas de comparaison.
  //
  // Les trois états comptent, et se distinguent : `undefined` tant qu'on lit,
  // `null` quand la lecture a échoué, un résumé sinon.
  const compareTo = beforeSummary.isError ? null : beforeSummary.data;

  const project = projects.data?.find(({ id }) => id === projectId);

  // Les deux périodes ne sont mises en regard qu'une fois les **deux** lues :
  // apparier une série complète avec une série vide dessinerait une chute de
  // 100 % sur toute la largeur, le temps d'un rendu.
  const visitors =
    sessions.data &&
    before.data &&
    compareVisitors(dailyVisitors(sessions.data), dailyVisitors(before.data));

  // Une page vide n'est pas une panne, et ne se présente pas comme telle : sur
  // un projet fraîchement installé, c'est l'état normal tant que rien n'a été
  // envoyé. On ne l'affiche qu'une fois les *deux* lectures faites — un résumé
  // à zéro pendant que le journal charge clignoterait.
  const empty =
    summary.data?.pageViews === 0 && sessions.data?.sessions.length === 0;

  return (
    // Large, contrairement aux autres écrans. `setup` et `new` sont des
    // formulaires : une mesure courte s'y lit mieux, et `max-w-2xl` est là pour
    // ça. Un tableau de bord n'a pas de texte à faire lire — il a des séries à
    // faire comparer, et chaque pixel gagné en largeur est de la résolution en
    // plus sur l'axe des dates. Le plafond n'existe que pour les très grands
    // écrans, où une carte de 2 500 px ne dirait rien de plus.
    // `w-full` n'est pas décoratif : `main` est un flex en colonne, et un
    // enfant à `mx-auto` s'y dimensionne sur son **contenu** au lieu de
    // s'étirer. Sans lui, `max-w` ne plafonne rien — il ne s'applique qu'à une
    // largeur que la page n'atteint jamais.
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground text-sm">
            {project?.name ?? 'Loading…'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Reculer, c'est augmenter le décalage ; avancer, le réduire.
              L'arithmétique vit ici et pas dans le composant, qui ne sait pas
              ce qu'il fait défiler. Le suivant s'arrête à la période en cours —
              il n'y a rien à afficher au-delà d'aujourd'hui. */}
          <PeriodSelector
            // 28 px : le pas-à-pas suit la barre, pas l'inverse — le segmented
            // control d'à côté est un `TabsList` en `h-8`.
            size="sm"
            previousLabel={`Previous ${days} days`}
            nextLabel={`Next ${days} days`}
            canGoNext={offset > 0}
            onPrevious={() => {
              void navigate({ search: { days, offset: offset + 1 } });
            }}
            onNext={() => {
              void navigate({ search: { days, offset: offset - 1 } });
            }}
          >
            {periodLabel(days, offset)}
          </PeriodSelector>

          {/* Un segmented control, pas un groupe de bascules : les périodes
              s'excluent, il y en a toujours exactement une, et c'est ce que
              `Tabs` dit — `ToggleGroup` autorise le zéro et le multiple, deux
              états qui n'existent pas ici et qu'il fallait rattraper à la main.
              C'est aussi la forme que le design system nomme.

              Sans `TabsContent` : le contenu est la page entière, qui vit dans
              l'URL. */}
          <Tabs
            value={String(days)}
            onValueChange={(value) => {
              // Le décalage retombe à zéro : « il y a trois périodes » ne
              // désigne pas la même chose selon qu'une période dure sept ou
              // trente jours, et garder le nombre ferait sauter le lecteur
              // dans un passé qu'il n'a pas demandé.
              void navigate({
                search: { days: Number(value) as Period, offset: 0 },
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

      {(summary.error ?? sessions.error) ? (
        <Empty className="border">
          <EmptyTitle>Analytics unavailable</EmptyTitle>
          <EmptyDescription className="whitespace-pre-line">
            {(summary.error ?? sessions.error)?.message}
          </EmptyDescription>
        </Empty>
      ) : empty ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing over {periodLabel(days, offset)}</EmptyTitle>
            <EmptyDescription>
              No event reached this project over the period. If you have just
              installed the snippet, open your site once — or widen the window.
            </EmptyDescription>
          </EmptyHeader>

          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/projects/$projectId/setup" params={{ projectId }}>
                Check the install
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {/* Quatre colonnes sur grand écran, deux sur moyen. Trois cartes
              plus une case vide ne se rangent pas en trois colonnes : la
              quatrième tomberait seule sur une seconde ligne. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Unique visitors"
              value={summary.data?.uniqueVisitors}
              previous={compareTo && compareTo.uniqueVisitors}
            />
            <Metric
              label="Page views"
              value={summary.data?.pageViews}
              previous={compareTo && compareTo.pageViews}
            />
            <Metric
              label="Sessions"
              value={summary.data?.sessions}
              previous={compareTo && compareTo.sessions}
            />
            <BounceMetric summary={summary.data} previous={compareTo} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Unique visitors</CardTitle>
              <CardDescription>
                {visitors && visitors.length > 0
                  ? `${dayLabel.format(new Date(visitors[0].start))} – ${dayLabel.format(
                      new Date(visitors[visitors.length - 1].start),
                    )} (UTC), against the ${days} days before`
                  : 'Loading…'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {visitors ? (
                <VisitorsChart
                  days={visitors}
                  deployments={deployments.data ?? []}
                />
              ) : (
                <Skeleton className="h-[300px] w-full sm:h-[420px]" />
              )}
            </CardContent>
          </Card>

          {/* Acquisition et Pages, côte à côte comme sur la planche. La carte
              « Sessions » qui vivait ici a été retirée : le design system ne
              la porte pas, et ses deux totaux sont déjà dans les agrégats du
              haut. Ce qui part avec, et qu'il faut savoir : le temps actif, et
              les deux mises en garde qui l'accompagnaient. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Acquisition sessions={sessions.data} />
            <Pages summary={summary.data} sessions={sessions.data} />
          </div>

          <Locations projectId={projectId} days={days} offset={offset} />
        </>
      )}
    </div>
  );
}

/** Les noms de pays, dans la langue de l'interface. */
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Le nom d'un pays depuis son code ISO, ou le code lui-même.
 *
 * `Intl.DisplayNames` lève sur un code mal formé plutôt que de rendre l'entrée
 * telle quelle — et le code vient d'une base de données tierce, pas de nous.
 * Le `try` n'est donc pas de la prudence de principe.
 */
function countryName(code: string | null): string {
  if (code === null) return 'Unknown';

  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const GRAINS: { value: LocationGrain; label: string }[] = [
  { value: 'country', label: 'Country' },
  { value: 'region', label: 'Region' },
  { value: 'city', label: 'City' },
];

/**
 * D'où viennent les visiteurs, à trois grains.
 *
 * ## Une carte, un état, une requête
 *
 * L'onglet actif vit ici en `useState` et non dans l'URL, contrairement à la
 * période : la période fait partie de ce qu'on partage quand on envoie un lien
 * de dashboard, le grain d'un tableau non. Chaque grain a sa propre clé de
 * cache, donc revenir sur un onglet déjà vu est instantané et ne repart pas en
 * réseau.
 *
 * ## Ce que la part ne dit pas
 *
 * Elle est calculée sur le **total des visiteurs de la période**, pas sur la
 * somme des lignes — cette somme dépasse le total dès qu'un visiteur a été vu
 * depuis deux endroits, et elle est de toute façon tronquée par `limit`. Les
 * parts ne font donc pas 100 %, et la ligne du bas dit combien de visiteurs
 * n'ont pas pu être placés : sans elle, une couverture partielle se lirait
 * comme un total.
 */
function Locations({
  projectId,
  days,
  offset,
}: {
  projectId: string;
  days: Period;
  offset: number;
}) {
  const [grain, setGrain] = useState<LocationGrain>('country');
  const [hovered, setHovered] = useState<string | null>(null);

  const locations = useQuery(locationsQuery(projectId, days, offset, grain));

  // Le planisphère demande **toujours** le grain pays, quel que soit l'onglet :
  // c'est le seul grain qu'une carte du monde sache porter. Deux lectures de la
  // même route, donc — et quand l'onglet actif *est* Country, les deux clés de
  // cache sont identiques et TanStack Query n'en fait qu'une.
  //
  // 250 et pas 10 : la carte les veut tous, le tableau n'en montre que dix.
  const world = useQuery(
    locationsQuery(projectId, days, offset, 'country', 250),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Locations</CardTitle>
        <CardDescription>
          Where visitors connected from over the period.
        </CardDescription>
        <CardAction>
          {/* `Tabs` et non `ToggleGroup` : le choix est exclusif, et
              `ToggleGroup` autoriserait le zéro et le multiple — deux états à
              rattraper à la main quand ils n'existent pas. */}
          <Tabs
            value={grain}
            onValueChange={(value) => setGrain(value as LocationGrain)}
          >
            <TabsList>
              {GRAINS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      {/* La proportion de la planche : la carte prend un peu plus de la moitié,
          le tableau le reste. En dessous de `lg`, les deux s'empilent — une
          carte du monde à 300 px de large ne dit plus rien.

          Pas d'`items-start` : les deux moitiés s'étirent à la même hauteur, et
          la carte se centre dans la sienne. C'est ce que fait la planche, qui
          leur donne le même plancher — mais par la grille plutôt que par un
          nombre écrit à la main, qui serait faux dès que le pied du tableau
          gagne une ligne. */}
      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {world.data ? (
          <WorldMap
            hovered={hovered}
            onHover={setHovered}
            rows={world.data.rows}
          />
        ) : (
          <Skeleton className="aspect-[41/20] w-full" />
        )}

        {locations.data ? (
          <LocationRows
            hovered={hovered}
            onHover={setHovered}
            page={locations.data}
          />
        ) : (
          <Skeleton className="h-[220px] w-full" />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Les six paliers de remplissage, du plus clair au plus soutenu.
 *
 * Des **jetons**, pas des opacités. L'opacité était le repli tant que la rampe
 * n'existait pas : elle éclaircit `--chart-1` en le laissant se mélanger au
 * fond, ce qui donne cinq paliers honnêtes mais **plafonne à `--primary`** — le
 * pays le plus dense y portait donc exactement la couleur d'une barre à 100 %
 * dans Acquisition, et les pays denses ne se distinguaient plus entre eux.
 *
 * Les valeurs vivent dans `styles.css`, dérivées de `--primary` par
 * `color-mix`, et c'est là qu'il faut aller lire pourquoi. Ici on n'en garde
 * que les noms : la rampe suit le thème toute seule.
 */
const HEAT = [
  '--heat-1',
  '--heat-2',
  '--heat-3',
  '--heat-4',
  '--heat-5',
  '--heat-6',
];

/**
 * Le planisphère, en projection Equal Earth.
 *
 * ## Pourquoi Equal Earth
 *
 * Une part de visiteurs par pays est une **aire**. Mercator gonfle les hautes
 * latitudes d'un facteur qui dépasse deux vers la Scandinavie : le même nombre
 * de visiteurs y paraîtrait plus important qu'à l'équateur. La carte mentirait
 * exactement sur ce qu'elle est censée montrer.
 *
 * ## D'où viennent les tracés
 *
 * D'un dictionnaire `{ ISO2: chemin }` produit hors ligne par
 * `scripts/build-world-map.mjs`, et chargé en `import()` paresseux : ni `d3-geo`
 * ni la topologie du monde n'entrent dans le bundle, et le fichier n'est
 * demandé que si la carte s'affiche.
 *
 * ## Le grain reste le pays
 *
 * Même quand le tableau descend en région ou en ville. C'est le seul grain
 * qu'un planisphère sache porter honnêtement — dessiner une ville en aplat
 * demanderait de colorier son pays entier, ou un point dont la taille dirait
 * autre chose que ce que l'échelle annonce.
 */
function WorldMap({
  rows,
  hovered,
  onHover,
}: {
  rows: LocationsPage['rows'];
  hovered: string | null;
  onHover: (code: string | null) => void;
}) {
  const [atlas, setAtlas] = useState<WorldAtlas | null>(null);

  useEffect(() => {
    let alive = true;

    void import('#/lib/world-equal-earth.json').then((module) => {
      // La carte peut être démontée avant que les 117 Ko arrivent — changer de
      // projet, ou fermer l'onglet pendant le chargement.
      if (alive) setAtlas(module.default);
    });

    return () => {
      alive = false;
    };
  }, []);

  if (atlas === null) return <Skeleton className="aspect-[41/20] w-full" />;

  // ## L'échelle est un **rang**, pas une proportion
  //
  // Le trafic web est massivement déséquilibré : un pays fait souvent dix fois
  // le deuxième. Une échelle linéaire mettrait ce pays-là au maximum et
  // écraserait tous les autres sur le palier le plus clair — la carte ne
  // dirait plus qu'une chose, celle qu'on savait déjà. En classant par rang,
  // chaque palier reçoit une part comparable des pays et les écarts entre le
  // deuxième et le vingtième redeviennent lisibles.
  //
  // Ce que ça coûte, et qu'il faut savoir : deux pays de teintes voisines ne
  // sont pas forcément proches en volume. C'est le tableau qui porte les
  // chiffres ; la carte porte l'ordre de grandeur.
  const ranked = [...rows]
    .filter((row) => row.countryCode !== null)
    .sort((a, b) => b.visitors - a.visitors);

  const heat = new Map(
    ranked.map((row, rank) => [
      row.countryCode ?? '',
      HEAT[
        Math.min(
          HEAT.length - 1,
          HEAT.length - 1 - Math.floor((rank / ranked.length) * HEAT.length),
        )
      ] ?? HEAT[0],
    ]),
  );

  return (
    <div className="flex h-full flex-col justify-center gap-4">
      <svg
        aria-hidden
        className="w-full"
        viewBox={`0 0 ${atlas.width} ${atlas.height}`}
      >
        {Object.entries(atlas.shapes).map(([code, d]) => {
          const step = heat.get(code);

          return (
            <path
              key={code}
              className={`stroke-background transition-[fill] duration-100 ${
                step === undefined ? 'fill-muted' : 'cursor-pointer'
              }`}
              d={d}
              // Un seul accent : dès qu'un pays est désigné — ici ou depuis le
              // tableau — tous les autres tombent à `--muted`, celui-là garde
              // son palier. C'est la technique de la planche, et celle de la
              // mise en évidence de l'explorateur d'événements.
              //
              // La rampe n'a pas de repli à mi-chemin exprès : une teinte
              // atténuée resterait une teinte, donc une valeur, et on lirait
              // encore une donnée là où on ne veut plus qu'un fond.
              fill={
                step === undefined
                  ? undefined
                  : hovered === null || hovered === code
                    ? `var(${step})`
                    : 'var(--muted)'
              }
              onMouseEnter={() => step !== undefined && onHover(code)}
              onMouseLeave={() => onHover(null)}
              strokeWidth={0.5}
            />
          );
        })}

        {/* Les pastilles. Un pays de huit pixels de côté ne se voit pas
            s'allumer : sans ce cercle, survoler « Belgium » dans le tableau ne
            montrerait rien sur la carte. Le tri est fait au build, sur l'aire
            projetée — voir `PIN_BELOW` dans `build-world-map.mjs`.

            Tracé dans la couleur du pays, et pas dans une couleur à part : ce
            qu'on cerne est déjà la bonne information, on la rend seulement
            trouvable. */}
        {hovered !== null && atlas.pins[hovered] && heat.has(hovered) && (
          <circle
            cx={atlas.pins[hovered][0]}
            cy={atlas.pins[hovered][1]}
            fill="none"
            r={7}
            stroke={`var(${heat.get(hovered) ?? HEAT[0]})`}
            strokeWidth={1.4}
          />
        )}
      </svg>

      {/* Centrée sous la carte, comme sur la planche. Elle s'estompe avec elle :
          une légende de couleurs ne dit plus rien quand les couleurs sont
          éteintes, et la laisser vive attirerait l'œil là où il n'y a plus rien
          à lire. */}
      <div
        className={`text-subtle-foreground flex items-center justify-center gap-1.5 text-2xs transition-opacity duration-100 ${
          hovered === null ? '' : 'opacity-35'
        }`}
      >
        <span>Fewer visitors</span>
        {HEAT.map((step) => (
          <span
            key={step}
            className="h-2 w-7 rounded-[2px]"
            style={{ background: `var(${step})` }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/** La forme du dictionnaire produit par `scripts/build-world-map.mjs`. */
interface WorldAtlas {
  width: number;
  height: number;
  shapes: Record<string, string>;
  /**
   * Le centre des seuls pays trop petits pour se voir — voir `PIN_BELOW`.
   *
   * `number[]` et pas `[number, number]` : le type vient de l'import JSON, qui
   * ne sait pas produire de tuple. Le resserrer ici obligerait à mentir au
   * compilateur avec une assertion, pour une garantie que le script d'en face
   * donne déjà.
   */
  pins: Record<string, number[]>;
}

function LocationRows({
  page,
  hovered,
  onHover,
}: {
  page: LocationsPage;
  hovered: string | null;
  onHover: (code: string | null) => void;
}) {
  // Le plus grand, jamais le total : le rail dit « comparé au premier », et le
  // nombre d'à côté dit la part. Deux informations, pas une répétition — un
  // rail proportionnel au total serait la même chose écrite deux fois, et
  // resterait vide partout dès qu'une part des visiteurs n'est pas localisée.
  const highest = Math.max(page.rows[0]?.visitors ?? 0, 1);

  return (
    // `min-h-100` : la hauteur d'un tableau plein — `h-10` d'en-tête plus dix
    // rangs `h-9`, soit 352 px, la même arithmétique que `CARD_BODY`. Un
    // plancher, pas un plafond : sans lui, un projet avec quatre régions ferait
    // rétrécir la carte entière en changeant d'onglet, planisphère compris,
    // puisque les deux moitiés partagent désormais leur hauteur.
    <div className="flex min-h-100 flex-col gap-3">
      <DataTable
        columns={[
          {
            head: GRAINS.find(({ value }) => value === page.grain)?.label ?? '',
          },
          { head: 'Visitors', width: '5.5rem', align: 'right' },
          // À gauche, contrairement aux deux autres colonnes de chiffres : ce
          // qu'elle coiffe est une barre, pas un nombre, et un en-tête aligné à
          // droite pointerait vers le pourcentage plutôt que vers le rail.
          { head: 'Share', width: '7rem' },
        ]}
        empty={{
          title: 'Nowhere yet',
          description:
            'Visitors show up here once their address resolves to a place.',
        }}
        rows={page.rows.map((row) => ({
          // Le grain seul ne fait pas une clé : deux villes homonymes de deux
          // pays sont deux lignes, et c'est le couple qui les distingue.
          key: `${row.countryCode ?? ''}-${row.value}`,
          // Le survol relie les deux moitiés dans les deux sens : pointer une
          // ligne éclaire son pays, et inversement. Au grain région ou ville,
          // plusieurs lignes partagent donc le même pays — c'est voulu, elles
          // sont bien au même endroit.
          onEnter: () => onHover(row.countryCode),
          onLeave: () => onHover(null),
          state:
            hovered === null
              ? undefined
              : hovered === row.countryCode
                ? ('active' as const)
                : ('dimmed' as const),
          cells: [
            <span key="place" className="block truncate">
              {page.grain === 'country'
                ? countryName(row.countryCode)
                : row.value}
              {page.grain !== 'country' && (
                <span className="text-muted-foreground ml-1.5 text-xs">
                  {countryName(row.countryCode)}
                </span>
              )}
            </span>,
            number.format(row.visitors),
            <span key="share" className="flex items-center gap-2">
              {/* Le rail de la planche : 3,52 px de haut, le creux à
                  `--primary/20`, le remplissage plein. Pas d'ombre, pas de
                  dégradé — la proportion se lit sur la longueur. */}
              <span className="bg-primary/20 h-1 flex-1 overflow-hidden rounded-full">
                <span
                  className="bg-primary block h-full rounded-full"
                  style={{ width: `${(row.visitors / highest) * 100}%` }}
                />
              </span>
              <span className="text-muted-foreground w-11 shrink-0 text-right text-xs tabular-nums">
                {page.visitors === 0
                  ? '—'
                  : `${ratio.format((row.visitors / page.visitors) * 100)}%`}
              </span>
            </span>,
          ],
        }))}
      />

      {page.rows.length > 0 && (
        <div className="text-muted-foreground px-2 text-xs tabular-nums">
          {number.format(page.visitors)} visitors
          {page.unresolved > 0 &&
            ` · ${number.format(page.unresolved)} we couldn't place`}
          {' · '}
          {/* Obligation de la licence CC BY 4.0 de DB-IP, pas une politesse :
              elle exige un lien de retour sur les pages qui affichent la
              donnée. D'où la condition — sans donnée affichée, rien à créditer. */}
          <a
            className="hover:text-foreground underline underline-offset-2"
            href="https://db-ip.com"
            rel="noreferrer"
            target="_blank"
          >
            IP geolocation by DB-IP
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Un agrégat de la période, et son évolution par rapport à la précédente.
 *
 * ## `previous` a trois valeurs, et les trois disent autre chose
 *
 * `undefined` : la période précédente est en cours de lecture — un cadre de
 * chargement, pas un tiret, sinon le tiret changerait en chiffre sous les yeux
 * du lecteur après l'avoir laissé conclure qu'il n'y avait rien.
 *
 * `null` : la lecture a échoué. Il n'y aura pas de comparaison, on le dit tout
 * de suite. C'est le seul cas où l'échec d'une requête ne remonte pas en
 * bannière : le chiffre de la carte, lui, est arrivé.
 *
 * Un nombre : on compare. Zéro compris, qui vaut « rien à cette période » —
 * `percentChange` en fait un tiret, parce qu'une hausse depuis zéro n'a pas de
 * pourcentage.
 *
 * ## Pourquoi la valeur et l'évolution ne partagent pas leur chargement
 *
 * Ce sont deux requêtes. Le chiffre s'affiche dès que le résumé courant
 * arrive ; l'évolution suit. Les attendre ensemble retarderait le premier pour
 * la commodité du second.
 */
function Metric({
  label,
  value,
  previous,
}: {
  label: string;
  value: number | undefined;
  previous: number | null | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-4xl tabular-nums">
          {value === undefined ? (
            <Skeleton className="h-10 w-24" />
          ) : (
            number.format(value)
          )}
        </CardTitle>

        {/* `text-sm` ici plutôt que dans `Change`, qui sert aussi au tooltip
            où la taille vient du cadre. */}
        <CardAction className="text-sm">
          {value === undefined || previous === undefined ? (
            <Skeleton className="h-4 w-14" />
          ) : previous === null ? (
            <span className="text-muted-foreground text-sm tabular-nums">
              —
            </span>
          ) : (
            <Change
              current={value}
              previous={previous}
              change={percentChange(value, previous)}
            />
          )}
        </CardAction>
      </CardHeader>
    </Card>
  );
}

/**
 * Le taux de rebond.
 *
 * ## Son assiette ne s'affiche plus, et c'est une perte assumée
 *
 * La carte portait `N of M sessions` sous le chiffre. Retiré le 29/08/2026 :
 * la planche ne le porte pas, et le compte de sessions est déjà sur la carte
 * d'à côté.
 *
 * ⚠️ **Ce n'est pourtant pas le même nombre.** `settledSessions` n'est pas
 * `sessions` : il écarte les sessions encore en cours — dont on ne sait pas
 * encore si elles s'arrêteront à une page — et celles sans aucune vue, dont on
 * n'est parti de nulle part. L'écart est réel et se voit dès qu'on regarde
 * (413 contre 416 sur une fenêtre de sept jours), et le taux se lit désormais
 * comme portant sur tout le trafic alors qu'il porte sur ce sous-ensemble.
 *
 * À rouvrir si un jour le chiffre étonne : la donnée est toujours là, dans
 * `summary.bounces` et `summary.settledSessions`.
 *
 * ## L'évolution est en **points**, pas en pourcentage
 *
 * De 40 % à 50 %, on écrit `+10 pts`. Le relatif dirait `+25 %`, ce qui est
 * exact et se lit de travers : un pourcentage de pourcentage demande au lecteur
 * de savoir lequel des deux il regarde, et sur une carte qu'on balaye du regard
 * il ne le sait pas.
 *
 * ## Et le vert est inversé
 *
 * `higherIsBetter={false}` : une hausse du taux de rebond est une mauvaise
 * nouvelle. Sans ça la carte féliciterait le lecteur pendant que son site se
 * dégrade — c'est la seule des quatre où la flèche vers le haut est rouge.
 */
function BounceMetric({
  summary,
  previous,
}: {
  summary: AnalyticsSummary | undefined;
  previous: AnalyticsSummary | null | undefined;
}) {
  // Trois états qui se propagent : `undefined` en cours de lecture, `null`
  // quand il n'y a pas de dénominateur, un nombre sinon. `&&` les transporte
  // sans les confondre.
  const rate = summary && bounceRate(summary);
  const before = previous && bounceRate(previous);

  return (
    <Card>
      <CardHeader>
        <CardDescription>Bounce rate</CardDescription>
        <CardTitle className="text-4xl tabular-nums">
          {rate === undefined ? (
            <Skeleton className="h-10 w-24" />
          ) : rate === null ? (
            '—'
          ) : (
            `${ratio.format(rate)}%`
          )}
        </CardTitle>

        <CardAction className="text-sm">
          {rate === undefined || before === undefined ? (
            <Skeleton className="h-4 w-14" />
          ) : rate === null || before === null ? (
            <span className="text-muted-foreground tabular-nums">—</span>
          ) : (
            <Change
              current={rate}
              previous={before}
              // L'écart de deux taux est une différence, pas un rapport : c'est
              // ce que « point de pourcentage » veut dire.
              change={rate - before}
              unit="points"
              higherIsBetter={false}
            />
          )}
        </CardAction>
      </CardHeader>
    </Card>
  );
}

/**
 * Les visiteurs uniques par jour, période courante contre période précédente.
 *
 * ## Deux traitements, parce que les deux séries ne se lisent pas pareil
 *
 * La période courante est une **aire dégradée** : c'est le sujet, elle porte le
 * poids visuel. La précédente est un **trait pointillé sans remplissage** :
 * c'est une référence, et deux aplats superposés saliraient la partie commune
 * — qui est la plus grande — sans rien apprendre.
 *
 * Le pointillé n'est pas décoratif non plus. Il dit « ceci n'est pas ici », et
 * c'est utile : les deux courbes partagent un axe des abscisses qui n'appartient
 * qu'à l'une des deux. Le 12 mars affiché sous un point de la courbe pointillée
 * est le 12 février ; le tooltip est le seul endroit où la vraie date apparaît.
 *
 * ## `type="natural"`
 *
 * Le trait est lissé. Il faut savoir ce que ça coûte : entre deux journées, la
 * courbe passe par des valeurs qui n'ont pas été mesurées, et elle peut creuser
 * sous le plus bas de deux points voisins. Aucune de ces valeurs n'est lisible
 * — l'axe ne porte que des journées, et le tooltip ne rend que des points
 * mesurés — donc ce qui se lit reste vrai.
 *
 * ## Les deux `<Area>`
 *
 * La seconde est une aire à `fill="none"`, pas une `<Line>` : `AreaChart`
 * n'accepte que des aires, et mélanger les deux demanderait un
 * `ComposedChart` pour un résultat identique.
 *
 * ## Le graphique principal de la page, dimensionné comme tel
 *
 * C'est ce qu'on vient voir. Il occupe donc une hauteur qui le dit, et il porte
 * un axe des ordonnées gradué — sans lui, un pic « deux fois plus haut » ne se
 * lit qu'au survol, ce qui n'est pas ce qu'on demande à un graphique qu'on
 * balaye du regard.
 */
/**
 * Une journée du graphique : la comparaison, plus ce qui a été déployé ce
 * jour-là.
 *
 * Les deux champs de déploiement sont **absents** — et pas vides — quand rien
 * n'a été déployé. C'est ce qui fait qu'aucun point n'est dessiné ce jour-là :
 * Recharts saute les valeurs manquantes, là où un zéro explicite en poserait un.
 */
type ChartDay = ComparedDay & {
  /**
   * La valeur que la série des déploiements porte ce jour-là : zéro, ou rien.
   *
   * Zéro et pas un compte : le point est un **repère**, posé sur l'axe. Y mettre
   * le nombre de déploiements le ferait monter, donc le lirait sur l'échelle des
   * visiteurs, ce qu'il ne mesure pas. La clé absente veut dire « aucun ce
   * jour-là », et c'est ce qui fait qu'aucun point n'y est dessiné.
   */
  deployments?: number;
  /** Les versions du jour, pour le tooltip. Voir `DayDeployments.tags`. */
  deployedTags?: (string | null)[];
};

function VisitorsChart({
  days,
  deployments,
}: {
  days: ComparedDay[];
  deployments: DayDeployments[];
}) {
  // Le maximum des deux séries. Recharts le recalcule pour le domaine, mais les
  // graduations sont posées à la main et ne peuvent pas l'attendre.
  const ceiling = days.reduce(
    (highest, day) => Math.max(highest, day.current, day.previous),
    0,
  );

  // Les déploiements descendent **dans** la donnée du graphique plutôt que d'être
  // passés à part au tooltip. C'est ce qui fait que le jour survolé porte déjà
  // ses versions : Recharts ne transmet que le point, et un second canal
  // obligerait le tooltip à retrouver la journée par sa date — une jointure de
  // plus, sur une clé qui peut se décaler.
  const byDay = new Map(deployments.map((day) => [day.start, day.tags]));
  const data: ChartDay[] = days.map((day) => {
    const tags = byDay.get(day.start);

    return {
      ...day,
      ...(tags ? { deployments: 0, deployedTags: tags } : {}),
    };
  });

  return (
    <ChartContainer
      config={chartConfig}
      className="h-[300px] w-full sm:h-[420px]"
    >
      <AreaChart
        data={data}
        accessibilityLayer
        // Le dépassement de `natural` est absorbé par la réserve du domaine,
        // pas ici : ces quelques pixels ne servent qu'à décoller la graduation
        // du haut du bord de la carte. À gauche, rien — l'axe se dimensionne
        // tout seul et la carte porte déjà son propre retrait.
        margin={{ top: 8, left: 0, right: 8 }}
      >
        <defs>
          {/* Le dégradé est ce qui distingue la série du sujet de sa
              référence. Il descend jusqu'à l'opacité nulle : une aire qui
              s'arrête net en bas dessine une frontière que la donnée n'a
              pas.

              ⚠️ Ces opacités ne sont pas celles qu'on voit. Recharts applique
              un `fillOpacity` de 0,6 par défaut, qui se multiplie avec elles :
              l'aire monte donc à 0,42, là où la planche la porte à 0,7. Repéré
              le 29/08/2026 et **laissé tel quel** — l'écart a été jugé sans
              importance. Le corriger, c'est `fillOpacity={1}` sur l'`<Area>`
              d'en dessous, rien d'autre. */}
          <linearGradient id="visitors-current" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-current)"
              stopOpacity={0.7}
            />
            <stop
              offset="95%"
              stopColor="var(--color-current)"
              stopOpacity={0.05}
            />
          </linearGradient>
        </defs>

        {/* `syncWithTicks` : sans lui, Recharts ajoute une ligne sur la borne
            du domaine en plus des graduations — un trait sans valeur en face,
            qui se lit comme une graduation dont on aurait perdu l'étiquette. */}
        <CartesianGrid vertical={false} syncWithTicks />
        <XAxis
          dataKey="start"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          tickFormatter={(start: string) => dayLabel.format(new Date(start))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          // `auto` plutôt qu'une largeur en dur : l'axe prend ce que ses
          // étiquettes demandent, et pas un pixel de plus. Une valeur fixe est
          // forcément fausse deux fois — trop large sur `0 / 20 / 40`, trop
          // étroite le jour où un projet passe à `1 200 000`.
          width="auto"
          // Des visiteurs sont des entiers : sans ça, une échelle basse se
          // gradue en `0,5 / 1 / 1,5`.
          allowDecimals={false}
          tickFormatter={(visitors: number) => number.format(visitors)}
          // Base à zéro, jamais au minimum observé : une aire qui ne part pas
          // de zéro exagère les écarts, et c'est l'erreur de lecture la plus
          // facile à provoquer sur ce genre de courbe.
          //
          // Recharts passe le maximum des **deux** séries, donc la réserve
          // tient compte de la courbe de référence même quand elle domine.
          domain={[0, chartCeiling]}
          ticks={chartTicks(chartCeiling(ceiling))}
        />
        <ChartTooltip
          // `cursor` par défaut : la ligne verticale aide à voir de quel jour
          // on parle quand les deux courbes se croisent.
          content={<VisitorsTooltip />}
        />

        {/* La référence est dessinée **avant** le sujet : à valeurs égales, le
            trait plein du dessus reste lisible. */}
        <Area
          dataKey="previous"
          type="natural"
          stroke="var(--color-previous)"
          strokeDasharray="4 4"
          fill="none"
          strokeWidth={2}
          // Le point au survol suffit ; en poser un sur chaque journée
          // encombrerait une courbe qui n'est là que pour situer l'autre.
          dot={false}
        />
        <Area
          dataKey="current"
          type="natural"
          stroke="var(--color-current)"
          fill="url(#visitors-current)"
          strokeWidth={2}
          dot={false}
        />

        {/*
          Un point sur la journée, posé sur la ligne de base — pas une ligne
          verticale. Deux raisons, et la première est une question d'honnêteté :
          l'axe ne porte que des journées, donc un trait à un instant précis
          promettrait une précision que le graphique ne montre pas. La seconde
          est pratique — deux déploiements le même jour donneraient deux traits
          superposés, là où le point reste un repère unique dont le tooltip
          détaille le contenu.

          C'est une **série** et non des `ReferenceDot`, alors que les deux
          dessinent la même chose. La raison est la légende : un `ReferenceDot`
          n'est pas une série, Recharts ne le voit donc pas, et le point
          turquoise resterait sans nom pour qui ne le survole pas. Recharts
          n'accepte pas non plus qu'on lui dicte le contenu de sa légende.

          La valeur vaut zéro, donc le point tombe sur l'axe : le poser à la
          hauteur des visiteurs du jour laisserait croire qu'il en dit quelque
          chose. Les journées sans déploiement n'ont pas la clé du tout, et
          `connectNulls={false}` empêche de relier les points entre eux — ce
          serait une courbe, or il n'y a rien de continu ici.
        */}
        <Area
          dataKey="deployments"
          legendType="circle"
          // La couleur est portée par `stroke`, et l'épaisseur mise à zéro :
          // c'est de `stroke` que Recharts tire la pastille de la légende, et
          // `stroke="none"` la laisserait sans couleur. Aucun trait n'est
          // dessiné pour autant — il n'y a rien de continu à relier.
          stroke="var(--color-deployments)"
          strokeWidth={0}
          fill="none"
          connectNulls={false}
          activeDot={false}
          dot={{
            r: 4,
            fill: 'var(--color-deployments)',
            // ⚠️ Sans ça, le point est **translucide** et la courbe se voit au
            // travers. Recharts pose un `fillOpacity` de 0,6 par défaut sur
            // l'aire, et le point en hérite — c'est le même défaut que celui
            // déjà noté sur le dégradé plus haut, mais ici il ne se pardonne
            // pas : un repère à moitié transparent posé sur un trait bleu n'est
            // plus un repère.
            fillOpacity: 1,
            // L'anneau isole le point de ce qu'il y a dessous — le dégradé de
            // l'aire, la courbe, la grille — pour qu'il reste net quel que soit
            // l'endroit où il tombe.
            stroke: 'var(--background)',
            strokeWidth: 2,
            strokeOpacity: 1,
          }}
        />

        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * Le détail du jour survolé : les deux valeurs, la date que l'axe ne dit pas,
 * et l'écart.
 *
 * Écrit à la main plutôt que monté sur `ChartTooltipContent`, qui rend une
 * liste de séries et ne sait pas relier deux lignes par un troisième chiffre.
 * C'est justement ce troisième chiffre qu'on vient chercher ici.
 *
 * Recharts passe le point complet dans `payload[0].payload` : on lit la ligne
 * de données, pas les séries une par une.
 */
function VisitorsTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: ChartDay }[];
}) {
  const day = payload?.[0]?.payload;

  if (!active || !day) return null;

  return (
    <div className="border-border/50 bg-background grid min-w-[13rem] gap-1.5 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium">
          {dayWithYear.format(new Date(day.start))}
        </span>
        <Change {...day} />
      </div>

      <Series
        color="var(--color-current)"
        label={chartConfig.current.label}
        value={day.current}
      />
      <Series
        color="var(--color-previous)"
        label={chartConfig.previous.label}
        value={day.previous}
        // La date de la période précédente n'apparaît nulle part ailleurs :
        // l'axe porte celle de la période courante, pour les deux courbes.
        note={dayWithYear.format(new Date(day.previousStart))}
        dashed
      />

      <Deployments tags={day.deployedTags} />
    </div>
  );
}

/**
 * Les déploiements du jour, en **deux lignes au plus**.
 *
 * Un seul : la version, et c'est tout ce qu'il y a à en dire. Plusieurs : le
 * nombre, puis la dernière version — pas la liste.
 *
 * ## Pourquoi on ne détaille pas
 *
 * Parce que ce n'est pas l'écran pour ça. Un graphique de visiteurs répond à
 * « qu'est-ce qui a changé ce jour-là », et deux lignes y suffisent : *il y a eu
 * des déploiements*, et *voici où on en est arrivé*. Dérouler cinq versions
 * ferait grandir la bulle à chaque déploiement, jusqu'à couvrir la courbe qu'on
 * est venu lire — et pour une information que l'explorateur d'événements rend
 * déjà, avec ses heures et ses propriétés.
 *
 * `tags` est ordonné du plus ancien au plus récent (voir `readAll`), donc la
 * dernière entrée est le dernier déploiement de la journée.
 */
function Deployments({ tags }: { tags?: (string | null)[] }) {
  if (!tags || tags.length === 0) return null;

  const last = tags[tags.length - 1];

  return (
    <div className="border-border/50 mt-0.5 flex flex-col gap-1 border-t pt-1.5">
      {tags.length === 1 ? (
        // Un déploiement sans `release.tag` reste un déploiement : on l'affiche
        // sans inventer de version.
        <DeploymentLine label={chartConfig.deployments.label} value={last} />
      ) : (
        <>
          <DeploymentLine label={`Deployments ×${String(tags.length)}`} />
          <DeploymentLine label="Last deployment" value={last} />
        </>
      )}
    </div>
  );
}

/** Une ligne de la section déploiements : la pastille, un libellé, une valeur. */
function DeploymentLine({
  label,
  value,
}: {
  label: string;
  /** Absente sur la ligne de comptage, qui n'a pas de version à montrer. */
  value?: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: 'var(--color-deployments)' }}
      />
      <span className="text-muted-foreground">{label}</span>
      {value === undefined ? null : (
        <span className="ml-auto font-mono font-medium">{value ?? '—'}</span>
      )}
    </div>
  );
}

/** Une ligne du tooltip : la pastille de série, son libellé, sa valeur. */
function Series({
  color,
  label,
  value,
  note,
  dashed = false,
}: {
  color: string;
  label: string;
  value: number;
  note?: string;
  dashed?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {/* La pastille reprend le traitement de la courbe — pleine pour le
          sujet, évidée pour la référence — pour qu'on n'ait pas à deviner
          laquelle est laquelle. */}
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-[2px] border-2"
        style={{
          borderColor: color,
          backgroundColor: dashed ? 'transparent' : color,
        }}
      />
      <span className="text-muted-foreground">{label}</span>
      {note && <span className="text-muted-foreground/70">{note}</span>}
      <span className="ml-auto font-mono font-medium tabular-nums">
        {number.format(value)}
      </span>
    </div>
  );
}

/**
 * L'écart entre deux mesures, et ses quatre cas.
 *
 * | Cas                       | Chiffre | Icône       |
 * | ------------------------- | ------- | ----------- |
 * | rien avant, rien après    | `—`     | aucune      |
 * | rien n'a bougé            | `0%`    | aucune      |
 * | la référence était à zéro | `—`     | hausse      |
 * | le reste                  | `±N%`   | selon signe |
 *
 * Le tiret est le cas qui mérite d'être expliqué : passer de 0 à 5 est une
 * hausse, mais pas une hausse *de quelque chose* — la division n'a pas de
 * résultat. L'icône porte alors le sens que le chiffre ne peut pas porter, au
 * lieu d'écrire un `+∞` ou un `+100 %` inventé.
 *
 * Les deux premières lignes se ressemblent et ne disent pas la même chose. Zéro
 * contre zéro *est* une égalité, mais écrire `0%` dessus laisserait croire qu'on
 * a mesuré une stabilité alors qu'on n'a rien mesuré du tout — c'est ce qu'on
 * voit sur une période antérieure à l'installation du projet. Le tiret est
 * exact : il n'y a pas d'évolution à donner.
 *
 * À écart nul, rien ne se colore : une pastille verte sur « autant qu'avant »
 * dirait qu'il s'est passé quelque chose.
 *
 * Sert aux cartes du haut comme au tooltip du graphique — les deux comparent
 * une valeur à sa référence, et la lisent pareil.
 *
 * ## `change` n'est pas calculé ici
 *
 * L'appelant le passe, et c'est ce qui permet aux deux unités de coexister sans
 * que ce composant sache laquelle il rend. Un écart de comptes est un
 * **rapport** (`percentChange`), un écart de taux une **différence** — de 40 %
 * à 50 %, `+10 pts`. Lui faire choisir demanderait de lui dire ce qu'il compare,
 * c'est-à-dire de remettre ici la connaissance qu'on vient d'en sortir.
 *
 * ## `higherIsBetter`
 *
 * Le sens de la flèche vient des chiffres, sa couleur vient de la métrique.
 * Trois cartes sur quatre montent dans le bon sens ; le taux de rebond descend
 * dans le bon sens. Sans ce réglage, la carte félicite le lecteur pendant que
 * son site se dégrade.
 */
function Change({
  current,
  previous,
  change,
  unit = 'percent',
  higherIsBetter = true,
}: Pick<ComparedDay, 'current' | 'previous' | 'change'> & {
  unit?: 'percent' | 'points';
  higherIsBetter?: boolean;
}) {
  // La **grandeur** de l'écart, jamais son signe : celui-ci est porté par la
  // flèche, et l'écrire deux fois se lit comme deux informations. À écart nul
  // il n'y a pas de flèche, mais il n'y a pas de signe non plus — `0 pts` est
  // le même texte dans les deux branches.
  const written =
    change === null
      ? '—'
      : unit === 'points'
        ? `${ratio.format(Math.abs(change))} pts`
        : `${ratio.format(Math.abs(change))}%`;

  if (current === previous) {
    return (
      <span className="text-muted-foreground tabular-nums">{written}</span>
    );
  }

  const up = current > previous;
  const Icon = up ? TrendingUp : TrendingDown;

  return (
    <span
      // Deux jetons, et pas une couleur Tailwind d'un côté : `--success` vaut
      // exactement le vert de la planche et porte déjà ses deux thèmes, là où
      // `emerald-600` obligeait à écrire sa propre surcharge sombre — un
      // réglage à la main en face d'un `--destructive` qui n'en demandait pas.
      className={`flex items-center gap-1 font-medium tabular-nums ${
        up === higherIsBetter ? 'text-success' : 'text-destructive'
      }`}
    >
      <Icon aria-hidden className="size-3.5" />
      {written}
    </span>
  );
}

/**
 * Le nombre de lignes qu'un onglet montre, dans les deux cartes.
 *
 * C'est une coupe **d'affichage**, pas de calcul : les replis rendent le
 * classement entier, et c'est ici qu'on décide combien s'en lit. Un « voir
 * plus » viendra puiser plus loin dans le même tableau — d'où la coupe au plus
 * tard, à la ligne où elle se voit.
 *
 * Dix parce que c'est ce qu'une carte à mi-largeur porte sans devenir une page
 * à elle seule, et parce que la queue d'un classement de provenances ou de
 * chemins n'apprend plus rien passé la dixième.
 */
const ROWS = 10;

/**
 * La hauteur du corps des deux cartes à onglets — fixe, et la même.
 *
 * ## Pourquoi fixe
 *
 * Parce qu'elles ont six onglets à elles deux, et que sans plancher **ni**
 * plafond, chaque bascule redimensionnait la carte : le lecteur qui compare
 * Sources et Referrers voyait la page sauter sous ses yeux. Une hauteur fixe
 * fait de l'onglet ce qu'il doit être — un changement de contenu, pas de mise
 * en page.
 *
 * ## Pourquoi la même des deux côtés
 *
 * Elles sont côte à côte. Deux hauteurs voisines mais différentes se lisent
 * comme un défaut d'alignement, jamais comme une différence de contenu.
 *
 * ## D'où vient le chiffre
 *
 * De la plus haute des deux formes **à dix lignes**, mesurée et pas estimée :
 *
 * - le tableau tombe à `h-10 + 10 × h-9`, soit exactement 352 px ;
 * - les barres à `10 × h-7 + 9 × gap-3`, soit 341,3 px — mais Sources ajoute
 *   dessous la note d'attribution, qui en coûte 28 de plus. **369,3 px, et
 *   c'est ce cas-là qui commande.**
 *
 * Le piège est là : la note n'apparaît que si des sessions n'ont pas de
 * provenance observable, donc le cas le plus haut est aussi celui qu'on ne voit
 * pas en développant. Une hauteur réglée sur les barres seules tenait à 3 px
 * près et coupait la note le jour où elle sort.
 *
 * `106 × --spacing` = 373 px. Le tableau garde donc du mou en bas, et c'est le
 * bon sens de l'écart : du blanc sous une dernière ligne se lit comme une
 * marge, une ligne coupée se lit comme un bug.
 */
const CARD_BODY = 'h-106';

/**
 * Une colonne du tableau, telle que la planche la décrit.
 *
 * Les trois onglets de Pages n'ont pas les mêmes colonnes — ni les mêmes
 * largeurs, ni les mêmes alignements : `Exits` porte un `Kind` **à gauche** sur
 * 6 rem là où les deux autres alignent deux nombres à droite sur 5 rem. C'est
 * ce que cette description rend dicible, et c'est ce que l'ancien composant
 * cachait derrière un `grid-cols` unique.
 */
interface Column {
  head: string;
  /**
   * La piste de la grille. Absente, la colonne absorbe le reste — c'est celle
   * qui porte le libellé, et il n'y en a qu'une.
   */
  width?: string;
  /**
   * À droite, et alors les chiffres sont tabulaires.
   *
   * Les deux vont ensemble parce que dans ce tableau une colonne à droite est
   * toujours une colonne de nombres : les séparer aurait laissé la porte
   * ouverte à une colonne alignée sans être tabulaire, qui danse d'une ligne à
   * l'autre.
   */
  align?: 'right';
  /** Estompée : la seconde lecture d'une ligne, jamais la première. */
  dim?: boolean;
}

interface TableRow {
  key: string;
  /** Une cellule par colonne, dans l'ordre des colonnes. */
  cells: ReactNode[];
  /**
   * Le survol croisé avec le planisphère — voir `Locations`.
   *
   * Optionnels, et ils le restent : Pages n'a rien à désigner ailleurs, et un
   * tableau qui n'est relié à rien ne doit pas avoir à dire qu'il ne l'est pas.
   */
  onEnter?: () => void;
  onLeave?: () => void;
  /** `active` quand c'est cette ligne qui est désignée, `dimmed` quand c'en est une autre. */
  state?: 'active' | 'dimmed';
}

/**
 * Le tableau que partagent les trois onglets de Pages.
 *
 * ## Un tableau bordé, pas un classement à barres
 *
 * C'est l'écart n° 2 à la planche, et il portait sur la forme : ce qui vivait
 * ici était un classement à barre de fond, hérité du composant qu'Acquisition
 * partageait. La planche ne dessine de barre **nulle part** dans Pages — elle y
 * met une rangée d'en-tête, un filet sous chaque ligne, et des chemins en
 * mono.
 *
 * Ce n'est pas un choix de décoration. Une barre répond à « combien, comparé
 * aux autres ? », et Pages ne pose pas cette question : chaque ligne y porte
 * deux mesures indépendantes — des vues **et** des visiteurs, des entrées
 * **et** un taux de rebond — dont une barre unique ne saurait dire laquelle
 * elle représente. Acquisition, elle, n'en porte qu'une : d'où les barres là
 * et le tableau ici.
 *
 * ## La hauteur des rangs est fixée, pas déduite
 *
 * `h-10` pour l'en-tête, `h-9` pour les lignes, au lieu d'un retrait vertical
 * qui laisserait l'interligne décider. C'est ce qui rend la hauteur du tableau
 * calculable — dix lignes et un en-tête tombent sur un compte exact — et donc
 * ce qui permet aux deux cartes de partager une hauteur fixe. Voir `CARD_BODY`.
 *
 * Le filet disparaît sous la dernière ligne, pas sous les autres : il sépare,
 * il ne souligne pas. La hauteur ne bouge pas pour autant — `border-box`.
 */
function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: Column[];
  rows: TableRow[];
  empty: { title: string; description: string };
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyTitle>{empty.title}</EmptyTitle>
        <EmptyDescription>{empty.description}</EmptyDescription>
      </Empty>
    );
  }

  // En style et pas en classe : la piste se compose à l'exécution, et Tailwind
  // ne génère que ce qu'il lit dans le source.
  const template = columns
    .map((column) => column.width ?? 'minmax(0,1fr)')
    .join(' ');

  return (
    <div className="flex w-full flex-col text-sm">
      <div
        className="grid h-10 items-center border-b border-border"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((column) => (
          <div
            key={column.head}
            className={`px-2 font-medium whitespace-nowrap ${
              column.align === 'right' ? 'text-right' : ''
            }`}
          >
            {column.head}
          </div>
        ))}
      </div>

      {rows.map((row) => (
        <div
          key={row.key}
          className={`grid h-9 items-center border-b border-border transition-opacity duration-100 last:border-b-0 ${
            row.state === 'active'
              ? 'bg-muted/50'
              : row.state === 'dimmed'
                ? 'opacity-30'
                : ''
          }`}
          onMouseEnter={row.onEnter}
          onMouseLeave={row.onLeave}
          style={{ gridTemplateColumns: template }}
        >
          {row.cells.map((cell, rank) => (
            <div
              key={columns[rank].head}
              // `overflow-hidden` et `whitespace-nowrap` ici, l'ellipse dans la
              // cellule : c'est le découpage de la planche. La cellule tient la
              // ligne, ce qu'on y met décide comment il se coupe.
              className={`min-w-0 overflow-hidden px-2 whitespace-nowrap ${
                columns[rank].align === 'right' ? 'text-right tabular-nums' : ''
              } ${columns[rank].dim ? 'text-muted-foreground' : ''}`}
            >
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Les couleurs du monogramme, prises sur la palette de séries du design system. */
const MONOGRAM_COLORS = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/15 text-chart-2',
  'bg-chart-3/15 text-chart-3',
  'bg-chart-4/15 text-chart-4',
  'bg-chart-5/15 text-chart-5',
];

/**
 * L'icône d'un site, ou son initiale.
 *
 * ## Pourquoi elle passe par notre API
 *
 * `/v1/favicons/:host` relaie DuckDuckGo côté serveur. Aller la chercher
 * directement depuis le navigateur dirait à un tiers vers quels sites partent
 * les visiteurs de nos clients, une fois par hôte affiché — c'est le chemin que
 * Plausible a abandonné, et pour cette raison.
 *
 * ## Le repli n'est pas un cas d'erreur
 *
 * Beaucoup de sites n'ont pas d'icône exploitable, et la route rend alors 204.
 * Le monogramme est donc l'état **normal** d'une ligne sur deux, pas un signe
 * que quelque chose a échoué : sa couleur vient du nom de l'hôte, ce qui la
 * rend stable d'un chargement à l'autre et distincte d'une ligne à l'autre.
 */
function Favicon({ host }: { host: string }) {
  const [broken, setBroken] = useState(false);

  const hue = [...host].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const color = MONOGRAM_COLORS[hue % MONOGRAM_COLORS.length];

  if (broken) {
    return (
      <span
        aria-hidden
        className={`${color} flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold uppercase`}
      >
        {host.charAt(0)}
      </span>
    );
  }

  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-[4px]"
      // `onError` couvre les deux cas d'un coup : l'amont n'a rien, ou la
      // requête a échoué. Dans les deux, il n'y a pas d'icône à montrer.
      onError={() => setBroken(true)}
      src={`${API_URL}/v1/favicons/${host}`}
    />
  );
}

/**
 * L'hôte d'une origine : `https://www.x.com` → `x.com`.
 *
 * ## La même règle que le serveur, et ce n'est pas cosmétique
 *
 * Minuscules et **sans `www.`**, exactement comme `hostOf` dans
 * `entry-source.ts`, qui normalise déjà les provenances. Les deux formes
 * cohabitaient : Acquisition affichait `laposte.fr` parce que l'API l'avait
 * rabotée, Exits `www.laposte.fr` parce qu'ici on prenait l'hôte brut. Le même
 * site sous deux noms dans deux cartes voisines, donc deux lignes que rien ne
 * rapproche.
 *
 * ## Et ça cassait les icônes
 *
 * `/v1/favicons/:host` relaie DuckDuckGo, dont l'index porte sur l'hôte sans
 * `www.` — et de façon **inégale** : `www.lemonde.fr` répond, `www.laposte.fr`
 * non, alors que `laposte.fr` a bien son icône. Une ligne sur deux tombait donc
 * sur le monogramme sans raison lisible. C'est le repli qui masquait le
 * défaut : il est prévu pour les sites sans icône, et il servait ici à couvrir
 * une clé mal formée.
 */
function hostOf(origin: string): string {
  let host;

  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    // L'origine vient d'un événement, donc d'un tiers : elle n'est pas garantie
    // bien formée. On l'écrit telle quelle plutôt que de perdre la ligne.
    return origin;
  }

  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Une ligne du classement en barres : un libellé, une icône, une valeur.
 *
 * `host` est à part du libellé parce que ce sont deux faits distincts : le
 * libellé est ce qui s'écrit (`Google`), l'hôte est le site qui porte l'icône
 * (`google.com`). Les fondre aurait obligé cet écran à retrouver l'un depuis
 * l'autre — c'est-à-dire à réinventer côté client la table qui vit dans
 * `entry-source.ts`.
 *
 * `null` n'est pas un échec : `Direct` n'a pas de site, et un referrer
 * illisible n'en a pas donné. La place reste réservée pour que la colonne
 * d'icônes ne se déchire pas.
 */
interface BarRow {
  key: string;
  /** Ce qui s'écrit dans la gouttière, à droite. Voir `Bars` pour l'alignement. */
  label: ReactNode;
  /** Le domaine de l'icône, ou `null` quand la provenance n'a pas de site. */
  host: string | null;
  value: number;
}

/**
 * Le classement en **barres horizontales** — la forme que la planche donne à
 * l'acquisition.
 *
 * ## Pourquoi ce n'est pas un `Rank`
 *
 * Parce que la planche ne dit pas la même chose des deux cartes, et que l'écart
 * était réel : Acquisition y est un graphique — libellés à droite dans une
 * gouttière, barres pleines, repères verticaux — là où Pages est un tableau
 * bordé. Une seule question se pose ici (« combien, comparé aux autres ? »), et
 * une barre y répond mieux qu'une colonne de chiffres ; Pages en pose deux ou
 * trois par ligne, ce qu'une barre ne sait pas porter.
 *
 * ## Deux colonnes, pas une grille de lignes
 *
 * La gouttière et l'aire tracée sont deux colonnes indépendantes, alignées
 * parce que leurs rangs ont la même hauteur et le même écart. C'est ce qui
 * permet aux repères verticaux d'être **un seul** calque continu : dans une
 * grille ligne à ligne, ils se seraient interrompus à chaque gouttière.
 *
 * ## Le retrait de droite, et pourquoi il est en `ch`
 *
 * La valeur suit la barre au lieu d'être rangée dans une colonne — c'est ce qui
 * fait qu'elle **étiquette** la barre plutôt que de la commenter. Elle déborde
 * donc de la piste, et la place qu'elle réclame se réserve en retrait.
 *
 * En `ch` parce que c'est la largeur d'un chiffre : le retrait suit le nombre
 * le plus long au lieu de parier sur lui. Même raison que `width="auto"` sur
 * l'axe du graphique principal — une largeur en dur est fausse deux fois, trop
 * large sur `380` et trop étroite sur `1,204,918`.
 */
function Bars({
  rows,
  empty,
}: {
  rows: BarRow[];
  empty: { title: string; description: string };
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyTitle>{empty.title}</EmptyTitle>
        <EmptyDescription>{empty.description}</EmptyDescription>
      </Empty>
    );
  }

  // Le maximum, jamais le total : la barre dit « comparé à la plus grande »,
  // ce que le classement, tronqué ou non, sait toujours. Une part d'un tout
  // prétendrait connaître le tout.
  const highest = Math.max(...rows.map((row) => row.value), 1);

  const written = rows.map((row) => number.format(row.value));
  const widest = Math.max(...written.map((value) => value.length));

  return (
    <div className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 text-xs">
      {/* La gouttière. Alignée à droite, donc les libellés viennent buter
          contre leur barre plutôt que de la laisser flotter au bout d'un blanc.
          L'icône est au bout, côté barre : c'est le seul emplacement qui la
          garde en colonne nette sous un texte, lui, en drapeau. */}
      <div className="text-muted-foreground flex flex-col gap-3">
        {rows.map((row) => (
          <div
            key={row.key}
            // Plafonnée : un referrer peut être long, et la gouttière mangerait
            // l'aire tracée qui, elle, porte la comparaison.
            className="flex h-7 max-w-48 items-center justify-end gap-1.5"
          >
            {row.label}
            {/* La place est tenue même sans icône, sinon la colonne se
                déchire sur `Direct`. */}
            <span className="flex size-4 shrink-0 items-center justify-center">
              {row.host !== null && <Favicon host={row.host} />}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          paddingRight: `calc(${widest}ch + var(--spacing) * 2)`,
        }}
      >
        <div className="relative flex flex-col gap-3">
          {/* Quatre repères à 25, 50, 75 et 100 % — quatre cellules égales
              bordées à droite, plutôt que quatre positions calculées. Pas de
              trait à zéro : la gouttière marque déjà l'origine.

              `border-border/50` est le trait du graphique principal, où
              `CartesianGrid` le prend par la feuille de `ChartContainer`. Les
              deux graphiques de la page se lisent donc sur la même trame. */}
          <div aria-hidden className="absolute inset-0 flex">
            {[0, 1, 2, 3].map((mark) => (
              <div key={mark} className="border-border/50 flex-1 border-r" />
            ))}
          </div>

          {rows.map((row, rank) => (
            <div key={row.key} className="relative h-7">
              <div
                className="bg-chart-1 h-full rounded-[4px]"
                style={{ width: `${(row.value / highest) * 100}%` }}
              />
              {/* Posée au bout de la barre, pas dans une colonne : elle
                  étiquette la barre. Le retrait du parent lui garde la place. */}
              <span
                className="absolute inset-y-0 flex items-center pl-2 tabular-nums"
                style={{ left: `${(row.value / highest) * 100}%` }}
              >
                {written[rank]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const ACQUISITION_TABS = [
  { value: 'sources', label: 'Sources' },
  { value: 'referrers', label: 'Referrers' },
  { value: 'terms', label: 'Search terms' },
] as const;

type AcquisitionTab = (typeof ACQUISITION_TABS)[number]['value'];

/**
 * D'où viennent les sessions — trois lectures du même classement.
 *
 * `Sources` montre les provenances telles que le serveur les classe ; le
 * libellé vient de lui (`Source.label`), jamais d'une table écrite ici : une
 * seconde définition de ce qu'est « Google » aurait divergé de la sienne au
 * premier moteur ajouté.
 *
 * `Referrers` est le **même classement filtré** sur `referral`, pas un second
 * calcul. Les moteurs et les assistants ont leur ligne dans Sources, et les
 * remettre ici les compterait deux fois sous deux noms.
 *
 * `Search terms` est désactivé, et c'est une limite de la chaîne, pas un
 * chantier oublié : `document.referrer` de Google ne porte plus la requête
 * depuis 2013. Il faudra brancher Search Console.
 */
function Acquisition({ sessions }: { sessions: SessionsPage | undefined }) {
  const [tab, setTab] = useState<AcquisitionTab>('sources');

  const sources = sessions && trafficSources(sessions.sessions);
  const referral = sessions && referrers(sessions.sessions);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acquisition</CardTitle>
        <CardDescription>How each session reached the site.</CardDescription>
        <CardAction>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as AcquisitionTab)}
          >
            <TabsList>
              {ACQUISITION_TABS.map(({ value, label }) => (
                <TabsTrigger
                  key={value}
                  // Visible mais inerte : masquer l'onglet ferait croire que la
                  // vue n'est pas prévue, alors qu'elle attend une intégration.
                  disabled={value === 'terms'}
                  value={value}
                >
                  {label}
                  {value === 'terms' && (
                    <Badge className="ml-1.5" variant="secondary">
                      Soon
                    </Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className={CARD_BODY}>
        {sources === undefined || referral === undefined ? (
          <Skeleton className={`w-full ${CARD_BODY}`} />
        ) : tab === 'sources' ? (
          <>
            <Bars
              empty={{
                title: 'No sources yet',
                description:
                  'Sessions get a source from the referrer of their first page view.',
              }}
              rows={sources.rows.slice(0, ROWS).map((source) => ({
                key: `${source.kind}-${source.name ?? ''}`,
                host: source.host,
                label: (
                  <>
                    <span className="min-w-0 truncate">{source.label}</span>
                    {/* La nature reste écrite malgré l'icône : celle-ci lève
                        bien l'ambiguïté sur `Google`, mais pas sur `internal`,
                        où le favicon de notre propre site le ferait au
                        contraire passer pour un tiers. */}
                    {LABELLED_KINDS.has(source.kind) && (
                      <span className="shrink-0 text-2xs">{source.kind}</span>
                    )}
                  </>
                ),
                value: source.sessions,
              }))}
            />
            {/* Ce que l'attribution ne couvre pas. Une session sans vue de page
                n'a aucune provenance observable — et ce n'est pas `direct`, qui
                est une observation. Taire l'écart laisserait croire le total
                exhaustif. */}
            {sources.unattributed > 0 && (
              <p className="text-muted-foreground pt-3 text-xs">
                {number.format(sources.unattributed)} sessions without a page
                view
              </p>
            )}
          </>
        ) : (
          <Bars
            empty={{
              title: 'No referrers yet',
              description: 'Sites that link to you will show up here.',
            }}
            rows={referral.slice(0, ROWS).map((source) => ({
              key: source.name ?? '',
              // `referrers` a déjà écarté les lignes sans nom : sur un
              // `referral`, l'hôte est donc toujours là.
              host: source.host,
              label: <span className="min-w-0 truncate">{source.label}</span>,
              value: source.sessions,
            }))}
          />
        )}
      </CardContent>
    </Card>
  );
}

const PAGES_TABS = [
  { value: 'top', label: 'Top pages' },
  { value: 'entry', label: 'Entry pages' },
  { value: 'exit', label: 'Exits' },
] as const;

type PagesTab = (typeof PAGES_TABS)[number]['value'];

/**
 * Les chemins : vus, arrivés, quittés.
 *
 * Les trois onglets ne viennent pas de la même source, et ce n'est pas un
 * hasard. **Top pages** vient du résumé — un `group by` que Postgres fait sans
 * remonter une ligne, et le seul des trois qui compte des *vues*. Les deux
 * autres se replient depuis les lignes de session, parce qu'ils comptent des
 * *sessions* : une entrée est une session qui commence, une sortie une session
 * qui s'achève.
 */
function Pages({
  summary,
  sessions,
}: {
  summary: AnalyticsSummary | undefined;
  sessions: SessionsPage | undefined;
}) {
  const [tab, setTab] = useState<PagesTab>('top');

  const entries = sessions && entryPages(sessions.sessions);
  const leaving = sessions && exits(sessions.sessions);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pages</CardTitle>
        <CardDescription>
          The paths visitors viewed, arrived on and left from.
        </CardDescription>
        <CardAction>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as PagesTab)}
          >
            <TabsList>
              {PAGES_TABS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className={CARD_BODY}>
        {tab === 'top' ? (
          summary ? (
            <DataTable
              columns={[
                { head: 'Page' },
                { head: 'Views', width: '5rem', align: 'right' },
                { head: 'Visitors', width: '5rem', align: 'right', dim: true },
              ]}
              empty={{
                title: 'No pages yet',
                description: 'Page views carrying a path will show up here.',
              }}
              // Le serveur tronque déjà à dix, mais la coupe est répétée ici :
              // c'est la vue qui promet dix lignes, et elle ne doit pas se
              // reposer sur une limite qu'un autre étage peut relever.
              rows={summary.topPages.slice(0, ROWS).map((page) => ({
                key: page.value,
                cells: [
                  <Path key="path">{page.value}</Path>,
                  number.format(page.events),
                  number.format(page.visitors),
                ],
              }))}
            />
          ) : (
            <Skeleton className={`w-full ${CARD_BODY}`} />
          )
        ) : tab === 'entry' ? (
          entries ? (
            <DataTable
              columns={[
                { head: 'Entry page' },
                { head: 'Entries', width: '5rem', align: 'right' },
                { head: 'Bounce', width: '5rem', align: 'right', dim: true },
              ]}
              empty={{
                title: 'No entry pages yet',
                description:
                  'The first page view of each session lands in this list.',
              }}
              rows={entries.slice(0, ROWS).map((page) => ({
                key: page.path,
                cells: [
                  <Path key="path">{page.path}</Path>,
                  number.format(page.entries),
                  // Un tiret et pas `0 %` : aucune session close n'est partie
                  // d'ici, donc il n'y a pas de taux — pas un taux nul.
                  page.bounceRate === null
                    ? '—'
                    : `${ratio.format(page.bounceRate)}%`,
                ],
              }))}
            />
          ) : (
            <Skeleton className={`w-full ${CARD_BODY}`} />
          )
        ) : leaving ? (
          <DataTable
            columns={[
              { head: 'Exit destination' },
              // À gauche, et plus large que ses voisines : elle porte une
              // pastille, pas un nombre. C'est la planche qui la distingue
              // ainsi, et c'est ce que l'ancien tableau ne savait pas dire.
              { head: 'Kind', width: '6rem' },
              { head: 'Exits', width: '5rem', align: 'right' },
            ]}
            empty={{
              title: 'No exits yet',
              description:
                'Outbound clicks and finished sessions show up here.',
            }}
            rows={exitRows(leaving).map((exit) => ({
              key: exit.outbound ?? 'ended',
              cells: [
                exit.outbound === null ? (
                  <Path key="path">(session ended)</Path>
                ) : (
                  <span key="path" className="flex min-w-0 items-center gap-2">
                    <Favicon host={hostOf(exit.outbound)} />
                    {/* Du texte, jamais un lien — et ce n'est pas une
                        précaution de principe. `outbound` est une origine
                        relevée sur un clic sortant, donc une chaîne arrivée
                        par `/v1/events` : le SDK la compose chez le visiteur,
                        mais il n'est pas une frontière, et rien n'oblige un
                        émetteur à passer par lui.

                        La poser dans un `href` offrirait à cet émetteur un
                        lien sortant depuis notre origine, et sur `javascript:`
                        une exécution dedans. Le rendre cliquable a été essayé
                        puis annulé le 29/08/2026 : une liste blanche de
                        schémas ferme bien la porte, mais elle demande de ne
                        jamais se tromper, et l'affordance ne vaut pas ce
                        pari. */}
                    <Path>{hostOf(exit.outbound)}</Path>
                  </span>
                ),
                // La planche distingue les deux : `Outbound` est une
                // destination observée, donc pleine ; `Last seen` n'est pas une
                // destination du tout, et son contour le dit.
                <Badge
                  key="kind"
                  variant={exit.outbound === null ? 'outline' : 'secondary'}
                >
                  {exit.outbound === null ? 'Last seen' : 'Outbound'}
                </Badge>,
                number.format(exit.exits),
              ],
            }))}
          />
        ) : (
          <Skeleton className={`w-full ${CARD_BODY}`} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Les dix lignes de l'onglet Exits, sans perdre « (session ended) ».
 *
 * `exits` épingle cette ligne en **dernier**, hors classement — ce n'est pas
 * une destination, c'est ce qui reste quand il n'y en a pas eu. Une coupe
 * naïve à dix la ferait donc disparaître dès qu'un site a dix sorties
 * externes, sans que rien à l'écran ne le dise. La coupe porte sur les
 * destinations, la ligne finale est recollée derrière.
 */
function exitRows(rows: ExitRow[]): ExitRow[] {
  const ended = rows[rows.length - 1];

  return [...rows.slice(0, -1).slice(0, ROWS - 1), ended];
}

/**
 * Un chemin ou un hôte, en mono et coupé à l'ellipse.
 *
 * En mono parce que la planche le demande, et elle a raison : dans une colonne
 * de chemins, la chasse fixe aligne les `/` d'un rang à l'autre et fait
 * ressortir la profondeur de l'arborescence. C'est la même raison qui met le
 * code en mono, pas une coquetterie.
 */
function Path({ children }: { children: ReactNode }) {
  // `block` n'est pas décoratif : `text-overflow` ne s'applique pas à une boîte
  // en ligne. En `span` nu, un chemin trop long était coupé net, sans les trois
  // points qui disent qu'il continue.
  return <span className="block min-w-0 truncate font-mono">{children}</span>;
}
