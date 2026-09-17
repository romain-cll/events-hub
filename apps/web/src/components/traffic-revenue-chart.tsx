import type { RevenueSeriesPage } from '@events-hub/api-contract';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  XAxis,
  YAxis,
} from 'recharts';

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from '#/components/ui/chart';
import {
  dominantCurrency,
  revenueByDay,
  type ComparedDay,
} from '#/lib/analytics-rollup';
import type { DayDeployments } from '#/lib/deployments';

/**
 * Le trafic et le revenu sur **un seul dessin**, et pourquoi c'est défendable.
 *
 * ## Deux axes Y, et ce que ça coûte
 *
 * La maquette les mettait en deux panneaux empilés, et le cadrage l'écrivait
 * comme une règle : jamais deux axes Y. La raison tient toujours — deux échelles
 * arbitraires laissent croire qu'un croisement des tracés veut dire quelque
 * chose, alors que déplacer l'une des deux le déplace aussi.
 *
 * Le choix a été fait de les réunir malgré ça, parce qu'un seul dessin répond
 * mieux à la question qu'on vient poser : *ce pic de trafic a-t-il rapporté ?*
 * Quatre choses rendent la lecture honnête à défaut d'être neutre :
 *
 * - **deux formes, pas deux courbes** — des barres pour le revenu, un trait pour
 *   le trafic. Deux courbes s'invitent à être comparées point par point ; une
 *   barre et un trait se lisent comme deux natures différentes ;
 * - **chaque axe porte la couleur de sa série**, pour qu'on sache lequel lit
 *   quoi sans revenir à la légende ;
 * - **le revenu est derrière**, déclaré en premier, la courbe par-dessus ;
 * - **pas d'aire dégradée** sous la courbe : elle noierait les barres, et une
 *   aire pleine par-dessus se lirait comme un empilement, ce que ce n'est pas.
 *
 * ## Ce qui a été retiré
 *
 * La courbe de la période précédente. Trois tracés sur un dessin qui porte déjà
 * deux échelles, c'était le tracé de trop. L'écart reste annoncé en chiffres par
 * les cartes du bandeau, qui lisent la même donnée.
 *
 * ## Une seule devise
 *
 * Celle qui pèse le plus, son code écrit sur l'axe de droite. Empiler deux
 * devises demanderait un taux de change et une date de taux. Les autres restent
 * lisibles dans la carte de qualité de la mesure, en bas de page.
 */

/** La réserve au-dessus du point le plus haut, en proportion. */
const HEADROOM = 1.2;

/**
 * Celle du revenu est plus large, parce qu'une barre n'est pas une courbe.
 *
 * Une crête de courbe qui frôle le haut du cadre se lit encore comme une crête.
 * Une barre qui monte jusqu'au bord se lit comme une barre **coupée** : rien ne
 * dit que le dessin s'arrête là plutôt que la valeur. Sur une fenêtre à un seul
 * paiement, cette barre unique occupait toute la hauteur du graphique et
 * écrasait la courbe de trafic à côté.
 */
const REVENUE_HEADROOM = 1.3;

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
 * Une courbe qui touche le haut de son cadre paraît tassée et donne
 * l'impression d'être coupée. La réserve tenait aussi, un temps, au dépassement
 * de la spline `natural` — ce motif-là est tombé avec elle, `monotone` ne sort
 * pas de l'intervalle de ses points. Il reste le premier, qui suffit.
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
  current: { label: 'Unique visitors', color: 'var(--chart-1)' },
  // La rampe de séries, et non `--success` : le vert du design system porte un
  // **jugement** — une variation qui va dans le bon sens — là où le revenu d'un
  // jour n'en porte aucun. Un montant n'est ni bon ni mauvais, il est.
  revenue: { label: 'Revenue', color: 'var(--chart-3)' },
  // Une troisième couleur, parce que les deux premières sont prises et qu'un
  // marqueur qui reprendrait l'une d'elles se lirait comme un point de mesure.
  // Elle est dans la légende pour la même raison : un rond isolé sur l'axe
  // n'explique pas ce qu'il marque.
  deployments: { label: 'Deployment', color: 'var(--chart-2)' },
} satisfies ChartConfig;

/**
 * Une journée du graphique : le trafic, le revenu, et ce qui s'y est passé.
 */
type ChartDay = {
  start: string;
  current: number;
  /** En centimes, dans la devise du graphique. Zéro les jours sans paiement. */
  revenue: number;
  payments: number;
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

export function TrafficRevenueChart({
  days,
  deployments,
  series,
  formatAmount,
  formatDay,
  formatDayWithYear,
  formatNumber,
}: {
  days: ComparedDay[];
  deployments: DayDeployments[];
  series: RevenueSeriesPage | undefined;
  /** Les formateurs viennent de la page : une seule façon d'écrire un nombre. */
  formatAmount: (amount: number, currency: string | null) => string;
  formatDay: (start: string) => string;
  formatDayWithYear: (start: string) => string;
  formatNumber: (value: number) => string;
}) {
  const currency = dominantCurrency(series);
  const revenue = revenueByDay(
    days.map((day) => day.start),
    series,
    currency,
  );

  // Les déploiements descendent **dans** la donnée du graphique plutôt que
  // d'être passés à part au tooltip. C'est ce qui fait que le jour survolé porte
  // déjà ses versions : Recharts ne transmet que le point, et un second canal
  // obligerait le tooltip à retrouver la journée par sa date — une jointure de
  // plus, sur une clé qui peut se décaler.
  const byDay = new Map(deployments.map((day) => [day.start, day.tags]));

  const data: ChartDay[] = days.map((day) => {
    const tags = byDay.get(day.start);
    const money = revenue.get(day.start) ?? { revenue: 0, payments: 0 };

    return {
      start: day.start,
      current: day.current,
      ...money,
      ...(tags ? { deployments: 0, deployedTags: tags } : {}),
    };
  });

  const trafficCeiling = chartCeiling(
    data.reduce((highest, day) => Math.max(highest, day.current), 0),
  );
  // Le pic et le plafond sont deux choses : le pic porte les graduations, le
  // plafond porte le vide au-dessus. Les confondre remettrait la barre la plus
  // haute contre le bord.
  const revenuePeak = data.reduce(
    (highest, day) => Math.max(highest, day.revenue),
    0,
  );
  const revenueCeiling = Math.ceil(revenuePeak * REVENUE_HEADROOM);

  // Aucun paiement sur la fenêtre : l'axe de droite disparaît au lieu d'être
  // gradué à zéro. Un axe sans série est un axe qui ment — il promet une mesure
  // que le dessin ne porte pas.
  const hasRevenue = revenuePeak > 0;

  return (
    <ChartContainer
      config={chartConfig}
      className="h-[300px] w-full sm:h-[420px]"
    >
      <ComposedChart
        data={data}
        accessibilityLayer
        margin={{ top: 8, left: 0, right: 8 }}
      >
        {/* `syncWithTicks` : sans lui, Recharts ajoute une ligne sur la borne
            du domaine en plus des graduations — un trait sans valeur en face,
            qui se lit comme une graduation dont on aurait perdu l'étiquette. */}
        <defs>
          {/* Le dégradé descend jusqu'à l'opacité nulle : une aire qui s'arrête
              net en bas dessine une frontière que la donnée n'a pas.

              Il part plus discret que sur l'ancien graphique — 0,45 au lieu de
              0,7 — parce qu'il passe maintenant **par-dessus** les barres de
              revenu. À pleine opacité il les noierait ; à celle-ci elles se
              lisent au travers, et l'aire garde son volume. */}
          <linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-current)"
              stopOpacity={0.45}
            />
            <stop
              offset="95%"
              stopColor="var(--color-current)"
              stopOpacity={0.02}
            />
          </linearGradient>
        </defs>

        <CartesianGrid vertical={false} syncWithTicks />
        <XAxis
          dataKey="start"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          tickFormatter={formatDay}
        />
        <YAxis
          yAxisId="traffic"
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
          // La couleur dit quel axe lit quelle série. Sans elle, deux échelles
          // sur un même dessin obligent à revenir à la légende pour savoir
          // laquelle porte quoi.
          tick={{ fill: 'var(--color-current)' }}
          tickFormatter={formatNumber}
          // Base à zéro, jamais au minimum observé : une courbe qui ne part pas
          // de zéro exagère les écarts, et c'est l'erreur de lecture la plus
          // facile à provoquer.
          domain={[0, trafficCeiling]}
          ticks={chartTicks(trafficCeiling)}
        />
        {hasRevenue && (
          <YAxis
            yAxisId="revenue"
            orientation="right"
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            width="auto"
            tick={{ fill: 'var(--color-revenue)' }}
            // Les centimes sont tus **sur l'axe** : une graduation n'a pas à
            // être juste au centime, et `$1,250.00` prendrait la place de la
            // courbe. Le survol, lui, les rend.
            tickFormatter={(amount: number) =>
              formatAmount(Math.round(amount / 100) * 100, currency).replace(
                /[.,]00$/,
                '',
              )
            }
            domain={[0, revenueCeiling]}
            // Trois graduations et non quatre : l'axe de gauche en porte
            // davantage, et deux échelles également graduées invitent à lire
            // une correspondance ligne à ligne qui n'existe pas.
            // Graduées sur le **pic**, pas sur le plafond : la dernière dit
            // « voici le plus gros jour », pas « voici le bord du cadre ».
            ticks={[0, Math.round(revenuePeak / 2), revenuePeak].filter(
              (tick, index, all) => all.indexOf(tick) === index,
            )}
          />
        )}
        <ChartTooltip
          // `cursor` par défaut : la ligne verticale aide à voir de quel jour on
          // parle quand la courbe passe au-dessus d'une barre.
          content={
            <ChartTooltipBody
              currency={currency}
              formatAmount={formatAmount}
              formatDayWithYear={formatDayWithYear}
              formatNumber={formatNumber}
            />
          }
        />

        {/* Le revenu est déclaré **en premier** : c'est l'ordre qui décide de la
            profondeur, et les barres doivent rester derrière la courbe. */}
        {hasRevenue && (
          <Bar
            yAxisId="revenue"
            dataKey="revenue"
            fill="var(--color-revenue)"
            // Pleine, et pas atténuée. L'atténuation servait à faire passer la
            // courbe au-dessus de barres qui portaient la même famille de vert
            // que son aire ; sur une couleur de série distincte elle ne
            // distingue plus rien et ne fait que rendre les petits jours
            // illisibles.
            fillOpacity={1}
            radius={3}
            // Sans plafond, Recharts donne à chaque barre toute la largeur de sa
            // case : un mois à un seul paiement dessine une colonne de quarante
            // pixels qui se lit comme une période, pas comme un jour. Le plafond
            // la ramène à la largeur d'un repère — assez large pour qu'un petit
            // montant reste visible, assez étroit pour qu'un jour isolé ne se
            // lise pas comme une semaine.
            maxBarSize={20}
          />
        )}

        <Area
          yAxisId="traffic"
          dataKey="current"
          // `monotone`, et surtout pas `natural`. Une spline naturelle ne passe
          // pas seulement par les points, elle cherche une courbure continue :
          // entre 0 et 3 elle plonge **sous** zéro avant de remonter, et
          // dépasse le 3 avant de redescendre. Sur une série qui ne peut pas
          // être négative, ce creux est un mensonge, en plus de sortir du
          // cadre. `monotone` borne chaque tronçon aux deux points qui
          // l'encadrent : arrondi là où la donnée l'est, jamais au-delà.
          type="monotone"
          stroke="var(--color-current)"
          fill="url(#traffic-area)"
          // ⚠️ Recharts multiplie ce facteur avec les opacités du dégradé : le
          // laisser à son défaut de 0,6 ramènerait le haut de l'aire à 0,27 et
          // effacerait le volume qu'on vient d'y remettre.
          fillOpacity={1}
          strokeWidth={2}
          // Le point au survol suffit ; en poser un sur chaque journée
          // encombrerait la courbe.
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
          turquoise resterait sans nom pour qui ne le survole pas.
        */}
        <Area
          yAxisId="traffic"
          dataKey="deployments"
          legendType="circle"
          // La couleur est portée par `stroke`, et l'épaisseur mise à zéro :
          // c'est de `stroke` que Recharts tire la pastille de la légende, et
          // `stroke="none"` la laisserait sans couleur.
          stroke="var(--color-deployments)"
          strokeWidth={0}
          fill="none"
          connectNulls={false}
          activeDot={false}
          dot={{
            r: 5,
            fill: 'var(--color-deployments)',
            // ⚠️ Sans ça, le point est **translucide** et ce qu'il y a dessous
            // se voit au travers : Recharts pose un `fillOpacity` de 0,6 par
            // défaut, et un repère à moitié transparent n'est plus un repère.
            fillOpacity: 1,
            // L'anneau isole le point de ce qu'il y a dessous — une barre, la
            // courbe, la grille — pour qu'il reste net où qu'il tombe.
            stroke: 'var(--background)',
            // L'anneau s'épaissit avec le point : à rayon 5 un liseré de deux
            // pixels ne le décolle plus de la barre qu'il chevauche.
            strokeWidth: 2.5,
            strokeOpacity: 1,
          }}
        />

        {/* La légende nomme les trois séries, et surtout le point de
            déploiement : un rond turquoise isolé sur la ligne de base n'explique
            pas ce qu'il marque à qui ne le survole pas. */}
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}

/**
 * Le détail d'une journée : les deux séries dans une seule carte.
 *
 * C'est ce qu'un dessin unique appelle — deux bulles pour un graphique
 * obligeraient le lecteur à choisir laquelle il survole, alors qu'il pose une
 * seule question sur une seule journée.
 */
function ChartTooltipBody({
  active,
  payload,
  currency,
  formatAmount,
  formatDayWithYear,
  formatNumber,
}: {
  active?: boolean;
  payload?: { payload?: ChartDay }[];
  currency: string | null;
  formatAmount: (amount: number, currency: string | null) => string;
  formatDayWithYear: (start: string) => string;
  formatNumber: (value: number) => string;
}) {
  const day = payload?.[0]?.payload;

  if (!active || !day) return null;

  return (
    <div className="border-border/50 bg-background grid min-w-[13rem] gap-1.5 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
      <div className="font-medium">{formatDayWithYear(day.start)}</div>

      <TooltipRow
        color="var(--color-current)"
        label={chartConfig.current.label}
        value={formatNumber(day.current)}
      />

      {/* Le revenu n'apparaît que les jours où il y en a. Une ligne à zéro sur
          vingt-neuf jours sur trente ne dit rien et occupe la bulle. */}
      {day.revenue > 0 && (
        <TooltipRow
          color="var(--color-revenue)"
          label={chartConfig.revenue.label}
          value={formatAmount(day.revenue, currency)}
          note={
            day.payments === 1
              ? '1 payment'
              : `${formatNumber(day.payments)} payments`
          }
        />
      )}

      <Deployments tags={day.deployedTags} />
    </div>
  );
}

/** Une ligne du détail : la pastille de la série, son nom, sa valeur. */
function TooltipRow({
  color,
  label,
  value,
  note,
}: {
  color: string;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground">{label}</span>
      {note && <span className="text-muted-foreground/70">{note}</span>}
      <span className="ml-auto font-mono font-medium tabular-nums">
        {value}
      </span>
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
