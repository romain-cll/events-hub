import type {
  AnalyticsSummary,
  LocationGrain,
  LocationsPage,
  SessionsPage,
  TechnologyGrain,
} from '@events-hub/api-contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Maximize2Icon, TrendingDown, TrendingUp } from 'lucide-react';

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '#/components/ui/empty';
import { Button } from '#/components/ui/button';
import { Hint } from '#/components/hint';
import { TrafficRevenueChart } from '#/components/traffic-revenue-chart';
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
  technologyQuery,
  type Period,
} from '#/lib/analytics';
import {
  acquisitionTraffic,
  bounceRate,
  campaignLabel,
  compareVisitors,
  dailyVisitors,
  entryPages,
  exits,
  percentChange,
  type AcquisitionAxis,
  type ComparedDay,
  type ExitRow,
} from '#/lib/analytics-rollup';
import { DataTable, type DataColumn } from '#/components/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '#/components/ui/drawer';
import { useIsMobile } from '#/hooks/use-mobile';
import { API_URL } from '#/lib/api';
import { deploymentsQuery } from '#/lib/deployments';
import { ingestionQuery, projectsQuery } from '#/lib/projects';
import {
  ACQUISITION_AXES,
  AUDIENCE_AXES,
  LOCATION_AXES,
  MAX_ATTRIBUTION_LIMIT,
  attributionQuery,
  revenueSeriesQuery,
  type AttributionAxis,
  type RevenueAttributionPage,
} from '#/lib/revenue';

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

/** Le nom d'un axe d'attribution, tel que l'onglet et l'en-tête l'affichent. */
const AXIS_LABELS: Record<AttributionAxis, string> = {
  campaign: 'Campaign',
  source: 'Source',
  referrer: 'Referrer',
  landing: 'Landing page',
  country: 'Country',
  browser: 'Browser',
  os: 'System',
  device: 'Device',
};

/**
 * Un montant, tel que Stripe l'a écrit — en centimes, dans sa devise.
 *
 * La division par cent se fait **ici et nulle part ailleurs** : l'API rend des
 * entiers parce que toutes les devises n'ont pas deux décimales, et
 * `Intl.NumberFormat` sait lesquelles en ont combien. Le faire plus haut ferait
 * entrer des flottants dans une donnée comptable.
 *
 * `null` en devise veut dire que l'événement n'en portait pas : on montre le
 * nombre nu plutôt qu'un symbole inventé.
 */
function money(amount: number, currency: string | null): string {
  if (!currency) return number.format(amount);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
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
  // Un seul appel pour les deux cartes du bas : des appels séparés laisseraient
  // leurs totaux diverger dès qu'un paiement arrive entre les deux.
  const attribution = useQuery(attributionQuery(projectId, days, offset));
  // Même clé que la carte Locations, donc servie par le cache : elle fournit le
  // dénominateur de l'onglet Country, que les sessions ne portent pas.
  const countries = useQuery(
    locationsQuery(projectId, days, offset, 'country', 250),
  );
  // Le second panneau du graphique. Un pas quotidien : il doit tomber sur les
  // mêmes journées que le trafic, qui est replié au jour.
  const series = useQuery(revenueSeriesQuery(projectId, days, offset, 'day'));
  const projects = useQuery(projectsQuery());
  const ingestion = useQuery(ingestionQuery(projectId));

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
  const emptyPeriod =
    summary.data?.pageViews === 0 && sessions.data?.sessions.length === 0;

  // Mais « rien sur cette fenêtre » et « rien depuis toujours » sont deux états
  // différents, et les confondre coûte la seule information qui compte : qu'un
  // projet qui recevait ne reçoit plus. Renvoyer vers l'installation dans ce
  // cas-là répondrait à côté, et cacherait la chute derrière un problème qui
  // n'existe pas. Une fenêtre à zéro sur un projet vivant est une **mesure** :
  // elle s'affiche comme telle, tableau complet, chiffres à zéro.
  //
  // La distinction ne se lit pas dans les analytics — une fenêtre ne sait rien
  // de ce qui l'a précédée. Elle vient de la route d'ingestion, une existence
  // sur tout l'historique du projet, déjà en cache pour qui arrive de l'écran
  // d'attente.
  //
  // Trois états, et le troisième compte : tant que la réponse n'est pas là on
  // ne trancherait que sur une hypothèse, et se tromper afficherait le tableau
  // à zéro le temps d'un battement avant de le remplacer. Une panne de cette
  // lecture penche en revanche vers le tableau : des zéros restent vrais, alors
  // que l'écran d'installation affirmerait quelque chose qu'on ne sait pas.
  const everIngested = ingestion.isError ? true : ingestion.data?.hasEvents;

  const undecided = emptyPeriod && everIngested === undefined;
  const neverIngested = emptyPeriod && everIngested === false;

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
          <h1 className="text-2xl font-semibold tracking-tight">
            Audience &amp; revenue
          </h1>
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
      ) : undecided ? null : neverIngested ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No event yet</EmptyTitle>
            <EmptyDescription>
              Nothing has ever reached this project. If you have just installed
              the snippet, open your site once.
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
          {/* Cinq cartes, et une seule ligne sur tout écran de bureau.
              À six, le seuil tombait à `2xl` (1 536 px) : en dessous, un
              portable de 1 440 px héritait de deux rangées, ce qu'un tableau de
              bord ne mérite pas.

              Le seuil est **mesuré, pas choisi dans la liste**. `xl` donnait des
              cartes de 192 px, où « 16.3 pts » passait encore à la ligne sous le
              taux de rebond — c'est le libellé le plus long du bandeau, et c'est
              lui qui commande. À 1 400 px il reste 1 136 px de contenu, soit
              216 px par carte, et tout tient. Aucun palier de Tailwind ne tombe
              là, d'où `wide` — défini dans `styles.css`, et **pas** une variante
              arbitraire : celles-ci sont émises avant les paliers nommés, donc
              le `lg:` qui suit les écrase.

              La carte qui est partie est `Payments` : le compte des paiements
              se relit dans la colonne du même nom d'Acquisition, et il ne
              décidait rien en haut de page. Le revenu, lui, reste — c'est la
              question du produit.

              En dessous, le repli suit la place : trois colonnes sur tablette,
              deux sur petit écran, une sur téléphone.

              Le revenu ne porte pas de comparaison avec la période précédente —
              il faudrait une seconde lecture d'attribution pour une flèche, et
              elle coûte quatre agrégations. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 wide:grid-cols-5">
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
            <RevenueMetric attribution={attribution.data} />
          </div>

          {/* Un seul dessin, deux échelles. Ce que ça coûte et ce qui le rend
              lisible malgré tout sont écrits dans `TrafficRevenueChart` — c'est
              là que la décision vit, pas ici. */}
          <Card>
            <CardHeader>
              <CardTitle>Traffic and revenue</CardTitle>
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
                <TrafficRevenueChart
                  days={visitors}
                  deployments={deployments.data ?? []}
                  series={series.data}
                  formatAmount={money}
                  formatDay={(start) => dayLabel.format(new Date(start))}
                  formatDayWithYear={(start) =>
                    dayWithYear.format(new Date(start))
                  }
                  formatNumber={(value) => number.format(value)}
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
          <Acquisition revenue={attribution.data} visits={sessions.data} />

          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Audience
              projectId={projectId}
              days={days}
              offset={offset}
              attribution={attribution.data}
              locations={countries.data}
            />
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

  // Le revenu de la période rangé par pays. Il ne vient pas de l'appel
  // d'attribution de la page : l'axe y était demandé sans que rien ne
  // l'affiche, et il a déménagé ici — c'est une agrégation déplacée, pas une
  // agrégation de plus.
  //
  // Le plafond de la route plutôt que dix, pour la raison qui vaut partout où
  // deux classements se joignent : celui-ci trie par montant, le tableau d'à
  // côté par visiteurs, et un pays qui encaisse sans être dans les dix
  // premiers du revenu afficherait un tiret là où on connaît son chiffre.
  const attribution = useQuery(
    attributionQuery(
      projectId,
      days,
      offset,
      LOCATION_AXES,
      MAX_ATTRIBUTION_LIMIT,
    ),
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
            revenue={attribution.data?.country}
            revenuePending={attribution.isPending}
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
  revenue,
  revenuePending,
  hovered,
  onHover,
}: {
  page: LocationsPage;
  revenue: RevenueAttributionPage['country'];
  revenuePending: boolean;
  hovered: string | null;
  onHover: (code: string | null) => void;
}) {
  // Le plus grand, jamais le total : le rail dit « comparé au premier », et le
  // nombre d'à côté dit la part. Deux informations, pas une répétition — un
  // rail proportionnel au total serait la même chose écrite deux fois, et
  // resterait vide partout dès qu'une part des visiteurs n'est pas localisée.
  const highest = Math.max(page.rows[0]?.visitors ?? 0, 1);

  // Le revenu ne se joint **qu'au grain pays**, parce que c'est le seul que
  // l'attribution sache ranger — une région n'a pas d'axe côté serveur. La
  // colonne disparaît donc sur les deux autres onglets plutôt que de s'y
  // afficher vide : un tiret dit « rien encaissé », pas « rien demandé ».
  const showRevenue = page.grain === 'country';

  // Indexé sur le code ISO, qui est le libellé que l'attribution rend sur cet
  // axe — c'est ce qui permet de joindre sans traduire des deux côtés.
  //
  // Une liste par pays et non un total : deux devises additionnées feraient un
  // montant qui n'existe dans aucun compte. Le cas est rare — un classement ne
  // porte en pratique que la devise du compte connecté — mais il se produit, et
  // la ligne montre alors celle qui pèse le plus en le disant.
  //
  // Mémoïsé parce que le survol re-rend ce composant à chaque ligne pointée.
  const earned = useMemo(() => {
    const byCountry = new Map<string, NonNullable<typeof revenue>['rows']>();

    for (const row of revenue?.rows ?? []) {
      byCountry.set(row.label, [...(byCountry.get(row.label) ?? []), row]);
    }

    for (const rows of byCountry.values()) {
      rows.sort((first, second) => second.amount - first.amount);
    }

    return byCountry;
  }, [revenue]);

  return (
    // `min-h-100` : la hauteur d'un tableau plein — `h-10` d'en-tête plus dix
    // rangs `h-9`, soit 352 px, la même arithmétique que `CARD_BODY`. Un
    // plancher, pas un plafond : sans lui, un projet avec quatre régions ferait
    // rétrécir la carte entière en changeant d'onglet, planisphère compris,
    // puisque les deux moitiés partagent désormais leur hauteur.
    <div className="flex min-h-100 flex-col gap-3">
      <LegacyTable
        columns={[
          {
            head: GRAINS.find(({ value }) => value === page.grain)?.label ?? '',
          },
          { head: 'Visitors', width: '5.5rem', align: 'right' },
          ...(showRevenue
            ? [
                {
                  head: 'Revenue',
                  width: '6rem',
                  align: 'right' as const,
                  // Les deux colonnes ne parlent pas du même moment, et les
                  // lire comme un taux de conversion par pays serait faux :
                  // les visiteurs sont ceux d'ici, le revenu est celui des
                  // clients dont la **première** visite venait d'ici.
                  hint: 'Revenue from customers whose first visit came from this country — first touch, like Acquisition. Visitors, next to it, are the ones who connected from here over the period: someone can be counted in one country and pay in another.',
                },
              ]
            : []),
          // À gauche, contrairement aux autres colonnes de chiffres : ce
          // qu'elle coiffe est une barre, pas un nombre, et un en-tête aligné à
          // droite pointerait vers le pourcentage plutôt que vers le rail.
          { head: 'Share', width: '7rem' },
        ]}
        empty={{
          title: 'Nowhere yet',
          description:
            'Visitors show up here once their address resolves to a place.',
        }}
        rows={page.rows.map((row) => {
          const [top, ...others] = earned.get(row.countryCode ?? '') ?? [];

          return {
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
              ...(showRevenue
                ? [
                    // Le tiret veut dire « aucun paiement rattaché à ce pays »,
                    // et il doit pouvoir le dire : l'afficher pendant la lecture
                    // le rendrait faux le temps qu'elle arrive.
                    <span key="revenue">
                      {revenuePending ? (
                        <Skeleton className="ml-auto h-4 w-12" />
                      ) : !top ? (
                        '—'
                      ) : others.length === 0 ? (
                        money(top.amount, top.currency)
                      ) : (
                        <Hint
                          title={[top, ...others]
                            .map((paid) => money(paid.amount, paid.currency))
                            .join(' · ')}
                        >
                          {money(top.amount, top.currency)}
                        </Hint>
                      )}
                    </span>,
                  ]
                : []),
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
          };
        })}
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
 * Ce que la carte montre d'un coup.
 *
 * Huit parce qu'un rang `roomy` mesure une fois et demie un rang ordinaire :
 * dix ne tiendraient plus dans la hauteur que les cartes voisines partagent.
 *
 * Le panneau, lui, n'a pas de chiffre : il mesure la place qu'on lui laisse et
 * pagine en conséquence. Un nombre figé y laisserait un tiers de vide sur un
 * grand moniteur et déborderait sur un portable.
 */
const CARD_ROWS = 8;

/** Le seul libellé de nature que cet écran ait à écrire lui-même. */
const NATURE_LABEL_DIRECT = 'Direct';

/**
 * Le même corps, mais en **plancher**, pour les cartes de revenu.
 *
 * Elles portent souvent moins de dix lignes — un projet sans Stripe branché n'en
 * a aucune — et la hauteur fixe y creusait un trou blanc de 420 px sous un état
 * vide. Le plancher garde l'alignement entre les deux cartes voisines sans
 * imposer le vide.
 *
 * Écrit en toutes lettres, et pas dérivé de `CARD_BODY` par interpolation : le
 * scanner de Tailwind lit les **littéraux** du source. Une classe composée à
 * l'exécution ne serait jamais générée, et la carte n'aurait aucune hauteur.
 */
const CARD_BODY_MIN = 'min-h-106';

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
  /**
   * La définition du mot, quand c'en est un de métier.
   *
   * Présente, l'en-tête prend un souligné pointillé et rend la définition au
   * survol — voir `Hint`. Le public de ce produit n'est pas analyste, et un
   * tableau qui emploie « conversion » ou « revenu par visiteur » sans les
   * définir laisse son lecteur deviner, ou croire qu'il a compris.
   */
  hint?: string;
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
 * ⚠️ **En sursis.** Il reçoit des cellules déjà rendues, donc il ne sait pas
 * trier — voir `components/data-table.tsx`, qui le remplace carte par carte.
 * Les cartes qui l'emploient encore migreront à leur tour.
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
function LegacyTable({
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
            {column.hint ? (
              <Hint title={column.hint}>{column.head}</Hint>
            ) : (
              column.head
            )}
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
/**
 * Le revenu de la période, dans la devise qui pèse le plus.
 *
 * ## Pourquoi une seule devise, et pas un total
 *
 * Parce qu'additionner des euros et des dollars demanderait un taux de change,
 * donc une date de taux, donc une décision qui n'appartient pas à un tableau de
 * bord. Quand il y en a plusieurs, la carte le dit au lieu de choisir en
 * silence.
 *
 * Le montant agrège les trois ensembles d'un axe — classé, direct, non
 * attribué — parce que c'est le revenu **de la période**, pas celui qu'on sait
 * rattacher. Le second se lira dans la carte de qualité de la mesure, à l'écran
 * v2.
 */
function RevenueMetric({
  attribution,
}: {
  attribution: RevenueAttributionPage | undefined;
}) {
  const [top, second, ...rest] = totalsByCurrency(attribution);

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardDescription>Revenue</CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {attribution ? (
            money(top?.amount ?? 0, top?.currency ?? null)
          ) : (
            <Skeleton className="h-8 w-24" />
          )}
        </CardTitle>

        {/* La seconde devise **en clair**, et pas un badge « +1 more » : celui-ci
            ne disait rien à qui encaisse 2 000 $ et 1 400 €, et laissait lire le
            premier montant comme un total. Au-delà de deux, le compte reprend son
            sens — il est alors précédé de deux montants, pas d'un seul. */}
        {second && (
          <p className="text-muted-foreground text-xs tabular-nums">
            {money(second.amount, second.currency)}
            {rest.length > 0 && ` · +${String(rest.length)} more`}
          </p>
        )}
      </CardHeader>
    </Card>
  );
}

/**
 * Les totaux par devise, du plus gros au plus petit.
 *
 * Lus sur **un seul axe** — n'importe lequel : les mêmes paiements y sont tous,
 * seulement rangés autrement. Les additionner sur deux axes les compterait deux
 * fois.
 */
function totalsByCurrency(
  attribution: RevenueAttributionPage | undefined,
): { currency: string | null; amount: number }[] {
  const axis = attribution?.campaign;

  if (!axis) return [];

  const totals = new Map<string | null, number>();

  for (const row of [...axis.rows, ...axis.direct, ...axis.unattributed]) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  }

  return [...totals]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * La profondeur du classement d'audience de la carte « Who they are ».
 *
 * Dix suffiraient à un affichage ; ici la lecture sert de **table de
 * correspondance**, pas de liste. Les deux classements ne trient pas sur la
 * même chose — le revenu par montant, l'audience par visiteurs — et un
 * navigateur qui rapporte sans figurer au top 10 du trafic afficherait un
 * tiret alors qu'on connaît son compte.
 *
 * Le plafond ne coûte rien parce que ces axes sont de faible cardinalité par
 * nature : une poignée de navigateurs, autant de systèmes, trois types
 * d'appareil. « Tout » tient dessous, et c'est le but.
 */
const TECHNOLOGY_DEPTH = 250;

/**
 * Qui sont les visiteurs, et lesquels rapportent.
 *
 * Trois onglets — navigateur, système, appareil — chacun croisant deux
 * lectures : les visiteurs viennent du classement d'audience, le revenu de
 * l'attribution. C'est le même croisement que dans Acquisition, sur des axes que
 * le visiteur ne choisit pas.
 *
 * Le pays n'y est pas : il a sa propre carte, avec son planisphère.
 */
function Audience({
  projectId,
  days,
  offset,
  attribution,
  locations,
}: {
  projectId: string;
  days: Period;
  offset: number;
  attribution: RevenueAttributionPage | undefined;
  locations: LocationsPage | undefined;
}) {
  const [tab, setTab] = useState<TechnologyGrain>('browser');

  // Les trois onglets nomment le même axe des deux côtés : le classement
  // d'audience et celui du revenu lisent la même colonne de session, sous le
  // même nom. C'est ce qui rend la jointure par libellé légitime plus bas.
  const axis: AttributionAxis = tab;

  // Le classement d'audience suit l'onglet, une lecture par grain. Les trois
  // ne sortent pas d'une même passe côté serveur — c'est une agrégation par
  // colonne — et les charger toutes à l'ouverture en paierait deux que
  // personne ne regarde. React Query garde celles déjà vues, donc une bascule
  // ne coûte qu'à la première.
  const technology = useQuery(
    technologyQuery(projectId, days, offset, tab, TECHNOLOGY_DEPTH),
  );

  const seen = technology.data
    ? new Map(technology.data.rows.map((row) => [row.value, row.visitors]))
    : undefined;

  const breakdown = attribution?.[axis];

  const classified: TableRow[] = (breakdown?.rows ?? []).map((row, index) => {
    const visitors = seen?.get(row.label);

    return {
      key: `${row.label}-${String(row.currency)}-${String(index)}`,
      cells: [
        <span key="label" className="truncate">
          {row.label || 'Unknown'}
        </span>,
        // Le tiret dit « ce navigateur n'a pas de visite sur la période »,
        // et il doit pouvoir le dire : l'afficher pendant le chargement le
        // rendrait faux une fraction de seconde sur chaque bascule d'onglet,
        // le temps que la lecture du grain arrive.
        <span key="visitors">
          {technology.isPending ? (
            <Skeleton className="ml-auto h-4 w-10" />
          ) : visitors === undefined ? (
            '—'
          ) : (
            number.format(visitors)
          )}
        </span>,
        <span key="customers">{number.format(row.visitors)}</span>,
        <span key="revenue">{money(row.amount, row.currency)}</span>,
      ],
    };
  });

  const rows = classified;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who they are</CardTitle>
        <CardDescription>
          {locations
            ? 'The same payments, split by what the visitor brought with them.'
            : 'Loading…'}
        </CardDescription>
        <CardAction>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as TechnologyGrain)}
          >
            <TabsList>
              {AUDIENCE_AXES.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {AXIS_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>

      {/* Un **plancher**, pas une hauteur fixe : `CARD_BODY` est calibré sur dix
          lignes, et l'appliquer à l'état vide creusait un trou blanc de 420 px.
          Le plancher garde l'alignement entre les deux cartes voisines sans
          imposer le vide. */}
      <CardContent className={CARD_BODY_MIN}>
        {attribution ? (
          <LegacyTable
            columns={[
              { head: AXIS_LABELS[axis] },
              { head: 'Visitors', width: '5rem', align: 'right' },
              { head: 'Customers', width: '5.5rem', align: 'right' },
              { head: 'Revenue', width: '6rem', align: 'right' },
            ]}
            rows={rows}
            empty={{
              title: 'No revenue yet',
              description:
                'Payments appear here once a Stripe account is connected and a first payment has been attributed.',
            }}
          />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Une ligne du tableau d'acquisition : le trafic, puis ce qu'il a rapporté.
 *
 * `visitors` vient des sessions, `customers` et `revenue` de l'attribution. Les
 * deux moitiés sont sur la page, et le croisement se fait ici plutôt qu'au
 * serveur : le demander ajouterait une route pour un repli de trente lignes.
 */
interface AcquisitionRow {
  key: string;
  label: string;
  /** Ce qui qualifie le libellé sans le remplacer — voir `campaignLabel`. */
  note: string | null;
  /** Le domaine qui porte l'icône, quand la ligne désigne un site. */
  host: string | null;
  visitors: number;
  customers: number;
  /** En centimes **réglés** — voir le contrat du revenu. */
  revenue: number;
  currency: string | null;
}

/**
 * Les colonnes, et ce que chacune trie.
 *
 * `undefined` n'est pas zéro, et c'est la distinction qui compte : une ligne
 * dont on ne connaît pas les visiteurs n'a pas un taux de conversion nul, elle
 * n'en a pas. La trier comme une ligne à zéro la mettrait au même rang que
 * celles qui ne convertissent réellement pas.
 */
function acquisitionColumns(
  axis: AttributionAxis,
  rows: AcquisitionRow[],
): DataColumn<AcquisitionRow>[] {
  const busiest = rows.reduce((most, row) => Math.max(most, row.visitors), 0);

  // La moyenne pondérée, pas la moyenne des lignes : c'est le revenu par
  // visiteur de la carte entière, et c'est à lui qu'une source se compare.
  const totals = rows.reduce(
    (sum, row) => ({
      revenue: sum.revenue + row.revenue,
      visitors: sum.visitors + row.visitors,
    }),
    { revenue: 0, visitors: 0 },
  );
  const average = totals.visitors === 0 ? 0 : totals.revenue / totals.visitors;

  const perVisitor = (row: AcquisitionRow) =>
    row.visitors === 0 ? undefined : row.revenue / row.visitors;

  const rate = (row: AcquisitionRow) =>
    row.visitors === 0 ? undefined : (row.customers / row.visitors) * 100;

  return [
    {
      key: 'label',
      head: AXIS_LABELS[axis],
      sortBy: (row) => `${row.label} ${row.note ?? ''}`.toLowerCase(),
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {row.host && <Favicon host={row.host} />}
            <span className="truncate">{row.label}</span>
            {/* Sur la même ligne et non dessous : le rang porte déjà la barre
                de part, et un troisième étage ne tiendrait pas dans sa hauteur.
                En retrait pour que le nom reste ce qu'on lit d'abord. */}
            {row.note && (
              <span className="truncate text-xs text-muted-foreground">
                {row.note}
              </span>
            )}
          </span>
          {/* La part du trafic, sous le libellé et non dans une colonne : elle
              répond à « combien, comparé aux autres ? », que la colonne
              Visitors seule laisse calculer de tête. */}
          {/* La barre à pleine intensité, la gouttière dans la version atténuée
              de la même couleur — celle que portait la barre jusqu'ici : la
              piste dit « voici le maximum », le remplissage « voici cette
              ligne ». Les deux dans deux teintes sans rapport se lisaient comme
              deux mesures. */}
          <span className="block h-1 w-full rounded-full bg-chart-1/40">
            <span
              className="block h-1 rounded-full bg-chart-1"
              style={{
                width: `${String(busiest === 0 ? 0 : (row.visitors / busiest) * 100)}%`,
              }}
            />
          </span>
        </div>
      ),
    },
    {
      key: 'visitors',
      head: 'Visitors',
      width: '5.5rem',
      align: 'right',
      sortBy: (row) => row.visitors,
      cell: (row) => number.format(row.visitors),
    },
    {
      key: 'customers',
      head: 'Customers',
      width: '7rem',
      align: 'right',
      sortBy: (row) => row.customers,
      cell: (row) => number.format(row.customers),
    },
    {
      key: 'rate',
      head: 'Conv.',
      width: '5rem',
      align: 'right',
      dim: true,
      hint: 'Share of the visitors this source brought who became customers. First touch: a visitor is credited to the source that brought them first, not the one they came back through.',
      sortBy: rate,
      cell: (row) => {
        const value = rate(row);

        return value === undefined ? '—' : `${value.toFixed(1)}%`;
      },
    },
    {
      key: 'revenue',
      head: 'Revenue',
      width: '7rem',
      align: 'right',
      sortBy: (row) => row.revenue,
      cell: (row) =>
        row.revenue === 0 ? '—' : money(row.revenue, row.currency),
    },
    {
      key: 'per',
      head: 'Per visitor',
      width: '7rem',
      align: 'right',
      hint: 'Revenue ÷ visitors. The column that reveals a low-volume, high-value source — absolute revenue always buries it under the big channels.',
      sortBy: perVisitor,
      cell: (row) => {
        const value = perVisitor(row);

        if (value === undefined || value === 0) return '—';

        // Vert au-dessus de la moyenne de la carte, et rien en dessous : une
        // seconde couleur ferait lire « mauvais » là où il n'y a que « moins
        // que la moyenne », ce qui est le cas de la moitié des lignes.
        return (
          <span className={value > average ? 'font-medium text-success' : ''}>
            {money(Math.round(value), row.currency)}
          </span>
        );
      },
    },
  ];
}

/**
 * D'où viennent les nouveaux clients — et d'où vient le trafic qui n'en produit
 * pas.
 *
 * ## Les lignes viennent du trafic, le revenu s'y joint
 *
 * C'est l'inverse de ce que cette carte faisait, et c'est le changement de
 * fond. Pilotée par l'attribution, elle n'affichait que les sources ayant
 * encaissé quelque chose : une campagne qui amène cent quatre-vingts visiteurs
 * et zéro euro en était absente, alors que c'est exactement la ligne qu'on vient
 * chercher. Trier par trafic n'avait pas davantage de sens sur un classement
 * qui n'en contenait qu'une partie.
 *
 * ## Quatre onglets, deux grains
 *
 * `Sources` rend la **nature** — Direct, Search, Social, Campaign — et
 * `Referrers` les hôtes. Le même classement à deux niveaux de zoom, pas deux
 * calculs. Le pays n'y est plus : il a sa carte, avec son planisphère.
 */
function Acquisition({
  // Nommés autrement que dans la route, exprès : là-haut ce sont des résultats
  // de `useQuery`, ici ce sont leurs données déjà extraites. Reprendre les
  // mêmes noms ferait lire deux choses différentes de la même façon — et le
  // garde-fou de TanStack Query, qui interdit un résultat de requête dans un
  // tableau de dépendances, s'y trompait aussi.
  revenue,
  visits,
}: {
  revenue: RevenueAttributionPage | undefined;
  visits: SessionsPage | undefined;
}) {
  const [tab, setTab] = useState<AcquisitionAxis>('source');
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  const traffic = useMemo(
    () => (visits ? acquisitionTraffic(visits.sessions) : undefined),
    [visits],
  );

  const rows = useMemo<AcquisitionRow[]>(() => {
    if (!traffic) return [];

    // Le revenu, indexé sur la clé que chaque axe définit — la même des deux
    // côtés, sans quoi une ligne aurait des visiteurs ici et du revenu là.
    //
    // Les quatre axes sont lus un par un plutôt qu'au travers d'un
    // `attribution[tab]` : leurs lignes n'ont pas la même forme — une nature
    // ici, une provenance classée là — et l'index dynamique les réduirait à ce
    // qu'elles ont en commun, c'est-à-dire à rien de ce dont on a besoin.
    const earned = new Map<
      string,
      {
        amount: number;
        visitors: number;
        currency: string | null;
        label: string;
        note: string | null;
      }
    >();

    // Chaque branche rend la **même** forme, `note` comprise : laisser les
    // formes de l'API remonter telles quelles réduisait l'union à ce qu'elles
    // ont en commun, c'est-à-dire à rien de ce dont l'affichage a besoin.
    const keyed: {
      key: string;
      label: string;
      note: string | null;
      amount: number;
      visitors: number;
      currency: string | null;
    }[] =
      tab === 'source'
        ? (revenue?.source?.rows ?? []).map((row) => ({
            ...row,
            key: row.nature,
            note: null,
          }))
        : tab === 'referrer'
          ? (revenue?.referrer?.rows ?? []).map((row) => ({
              ...row,
              key: row.source.name ?? row.label,
              note: null,
            }))
          : tab === 'campaign'
            ? (revenue?.campaign?.rows ?? []).map((row) => ({
                ...row,
                // Le libellé joint du serveur reste la **clé** — c'est sur lui
                // que le trafic se recoupe — mais l'affichage sépare le nom de
                // ce qui le qualifie.
                key: row.label,
                ...campaignLabel(row.campaign),
              }))
            : (revenue?.landing?.rows ?? []).map((row) => ({
                ...row,
                key: row.label,
                note: null,
              }));

    // Sur l'axe des natures, l'ensemble `direct` du serveur **est** la ligne
    // `Direct` : un visiteur connu sans campagne ni referrer n'a rien à ranger
    // sur cet axe, et c'est exactement ce que « direct » veut dire. Le laisser
    // en pied afficherait la nature deux fois — ses visiteurs en haut, son
    // revenu en bas — sans que rien ne dise que c'est la même population.
    //
    // Les trois autres axes n'ont pas cette coïncidence : « aucune campagne »
    // n'est pas une campagne, et « aucun referrer » n'est pas un site.
    const withDirect =
      tab === 'source'
        ? [
            ...keyed,
            ...(revenue?.source?.direct ?? []).map((row) => ({
              ...row,
              key: 'direct',
              // Le trafic porte déjà le libellé de cette ligne ; ceux-ci ne
              // servent qu'au cas où aucune visite de la fenêtre ne la
              // réclame.
              label: NATURE_LABEL_DIRECT,
              note: null,
            })),
          ]
        : keyed;

    for (const { key, ...row } of withDirect) {
      const seen = earned.get(key);

      if (seen) {
        seen.amount += row.amount;
        seen.visitors += row.visitors;
      } else {
        earned.set(key, {
          amount: row.amount,
          visitors: row.visitors,
          currency: row.currency,
          label: row.label,
          note: row.note,
        });
      }
    }

    const merged = traffic[tab].map<AcquisitionRow>((row) => {
      const money = earned.get(row.key);
      earned.delete(row.key);

      return {
        key: row.key,
        label: row.label,
        note: row.note,
        host: row.host,
        visitors: row.visitors,
        customers: money?.visitors ?? 0,
        revenue: money?.amount ?? 0,
        currency: money?.currency ?? null,
      };
    });

    // Ce qui a rapporté sans apparaître dans le trafic de la fenêtre : un
    // client dont la première visite est antérieure à ce qu'on affiche. Son
    // revenu lui est bien attribué — le serveur remonte plus loin que nous — et
    // le taire ferait mentir la colonne Revenue.
    const older = [...earned].map<AcquisitionRow>(([key, money]) => ({
      key,
      label: money.label,
      note: money.note,
      host: null,
      visitors: 0,
      customers: money.visitors,
      revenue: money.amount,
      currency: money.currency,
    }));

    return [...merged, ...older];
  }, [traffic, revenue, tab]);

  const columns = useMemo(() => acquisitionColumns(tab, rows), [tab, rows]);

  const table = (size: number | 'fit') => (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      density="roomy"
      initialSort={{ key: 'visitors', descending: true }}
      {...(size === 'fit'
        ? { fit: true }
        : { pageSize: size, paginate: false })}
      empty={{
        title: 'No traffic yet',
        description:
          'Sources appear here as soon as the SDK reports a first visit.',
      }}
    />
  );

  const tabs = (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as AcquisitionAxis);
      }}
    >
      <TabsList>
        {ACQUISITION_AXES.map((axis) => (
          <TabsTrigger key={axis} value={axis}>
            {AXIS_LABELS[axis]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  /**
   * Le contenu du panneau, à hauteur **imposée**.
   *
   * Les onglets gardent leur taille, le tableau prend le reste — `flex-1
   * min-h-0`, sans quoi un enfant de flex refuse de descendre sous la hauteur
   * de son contenu et déborderait. C'est cette boîte-là que le tableau mesure
   * pour décider combien de rangs il pagine, et elle ne dépend pas de lui :
   * c'est ce qui empêche la mesure de se remettre en cause elle-même.
   */
  const full = (
    <>
      {tabs}
      <div className="min-h-0 flex-1">{table('fit')}</div>
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acquisition</CardTitle>
        <CardDescription>
          First touch — the first visit of the visitor, not the one that paid.
        </CardDescription>
        <CardAction>{tabs}</CardAction>
      </CardHeader>

      {/* Hauteur **fixe**, et pas un plancher. Les quatre onglets n'ont pas le
          même nombre de lignes — cinq natures, onze referrers — et sans plafond
          commun chaque bascule redimensionnait la carte sous le curseur du
          lecteur qui compare. Un onglet est un changement de contenu, pas de
          mise en page.

          `h-106` tombe juste par une arithmétique qui vaut d'être écrite :
          l'en-tête `h-10` plus huit rangs `roomy` `h-12` font 10 + 96 = 106
          unités d'espacement, soit 373 px. C'est la même constante que les
          cartes à dix rangs ordinaires, où 10 + 90 = 100 laisse du mou. */}
      <CardContent className={CARD_BODY}>
        {visits ? table(CARD_ROWS) : <Skeleton className="h-full w-full" />}
      </CardContent>

      {/* Toujours rendu, quel que soit l'onglet, et c'est le point : le
          dialogue appartient à la **carte**, pas à l'onglet courant — il porte
          les quatre. Le faire apparaître au gré du nombre de lignes ferait
          sauter le pied de carte d'un onglet à l'autre, exactement ce que la
          hauteur fixe au-dessus existe pour éviter.

          Son libellé ne compte donc rien : « See 7 more » aurait changé à
          chaque bascule, pour désigner la même chose. */}
      <CardFooter className="justify-center border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          {/* L'icône dit **où** ça s'ouvre — un panneau par-dessus la page, pas
              une ligne de plus dépliée en dessous. */}
          <Maximize2Icon />
          See all
        </Button>
      </CardFooter>

      {/* Un tiroir par le bas sur mobile, un dialogue au centre sur bureau. Le
          même contenu : ce qui change est la façon dont l'écran l'ouvre, pas ce
          qu'il montre. */}
      {isMobile ? (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="h-[88vh]">
            <DrawerHeader className="text-left">
              <DrawerTitle>Acquisition</DrawerTitle>
              <DrawerDescription>
                First touch — the first visit of the visitor, not the one that
                paid.
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-6">
              {full}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          {/* Une hauteur **fixe**, pas un plafond : `max-h` laissait le panneau
              se dimensionner sur son contenu, donc changer de taille d'un
              onglet à l'autre — cinq natures contre onze referrers — et le
              tableau n'avait alors aucune hauteur stable à mesurer. */}
          <DialogContent className="flex h-[85vh] flex-col gap-3 sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>Acquisition</DialogTitle>
              <DialogDescription>
                First touch — the first visit of the visitor, not the one that
                paid.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-3">{full}</div>
          </DialogContent>
        </Dialog>
      )}
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
            <LegacyTable
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
            <LegacyTable
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
          <LegacyTable
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
