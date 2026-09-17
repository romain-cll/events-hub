import type { RevenueSeriesPage } from '@events-hub/api-contract';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '#/components/ui/chart';

/**
 * Le revenu encaissé, sous le trafic et sur le même axe des dates.
 *
 * ## Deux panneaux, jamais deux axes Y
 *
 * C'est la règle que le cadrage pose noir sur blanc, et elle n'est pas
 * esthétique : superposer une courbe de visiteurs et une d'euros sur deux
 * échelles laisse le lecteur croire qu'un croisement veut dire quelque chose.
 * Il ne veut rien dire — les deux axes sont arbitraires, et déplacer l'un
 * déplace le point de croisement.
 *
 * Deux panneaux empilés qui partagent l'abscisse gardent la comparaison
 * possible — « ce pic de trafic a-t-il rapporté ? » — sans promettre une
 * corrélation que le dessin fabriquerait.
 *
 * ## Des barres, pas une aire
 *
 * Le revenu est **discret** : il y a des paiements des jours où il y en a, et
 * rien les autres. Une aire relierait les points et dessinerait un encaissement
 * continu qui n'existe pas. Le trafic, lui, est continu — d'où l'aire au-dessus
 * et les barres ici.
 *
 * ## Une devise, choisie par l'appelant
 *
 * La série rend un point par pas **et par devise** ; ce panneau n'en dessine
 * qu'une, celle qu'on lui passe. Les empiler additionnerait des euros et des
 * dollars, ce qui demanderait un taux de change et une date de taux — une
 * décision qui n'appartient pas à un graphique.
 */

/**
 * La largeur des deux axes Y, en pixels, et pourquoi elle est figée.
 *
 * `width="auto"` est le bon réglage sur un graphique seul : l'axe prend ce que
 * ses étiquettes demandent, et une valeur en dur est forcément fausse deux fois.
 * Sur **deux panneaux empilés**, il devient faux d'une autre façon : `120` et
 * `$20.00` n'occupent pas la même place, si bien que les deux tracés ne
 * commencent pas à la même abscisse — vingt-cinq pixels d'écart, mesurés.
 *
 * Or c'est l'alignement qui fait tout l'intérêt de l'empilement : un pic de
 * trafic doit tomber exactement au-dessus de la barre du même jour. Une largeur
 * commune coûte quelques pixels de blanc sur le panneau qui en demande moins,
 * et c'est le bon prix.
 *
 * Elle est exportée pour que le panneau du dessus l'emploie aussi : deux
 * constantes égales par hasard cesseraient de l'être au premier ajustement.
 */
export const AXIS_WIDTH = 56;

/** Un jour de l'axe, garni de ce que la série y a mis. */
export interface RevenueDay {
  /** Début de la journée UTC — la même clé que le panneau du trafic. */
  start: string;
  /** En centimes, dans la devise du panneau. Zéro quand rien n'a été encaissé. */
  revenue: number;
  /** Nombre de paiements du jour, pour le survol. */
  payments: number;
}

/**
 * Aligne la série sur les journées du trafic.
 *
 * La route ne rend **pas** les pas vides : un jour sans paiement n'a aucun
 * point, parce qu'un `group by` ne fabrique pas les lignes qu'il n'a pas.
 * Combler appartient donc au lecteur, et c'est ici — le panneau est le seul à
 * savoir quelles bornes il affiche, et il les tient du panneau du dessus pour
 * que les deux axes tombent exactement l'un sur l'autre.
 *
 * Un jour absent devient **zéro** et non une absence : une barre manquante et
 * une barre nulle se ressemblent à l'œil, mais l'absence casserait l'alignement
 * des deux panneaux.
 */
export function revenueDays(
  starts: string[],
  series: RevenueSeriesPage | undefined,
  currency: string | null,
): RevenueDay[] {
  const byDay = new Map(
    (series?.points ?? [])
      .filter((point) => point.currency === currency)
      .map((point) => [
        new Date(point.start).toISOString(),
        { revenue: point.amount, payments: point.payments },
      ]),
  );

  return starts.map((start) => ({
    start,
    ...(byDay.get(start) ?? { revenue: 0, payments: 0 }),
  }));
}

/**
 * La devise qui pèse le plus dans la série.
 *
 * Le panneau n'en dessine qu'une, et c'est celle-là : montrer la seconde par
 * défaut ferait passer l'essentiel du revenu pour du vide. `null` quand la
 * série est vide — le panneau se dessine alors à plat, ce qui est exact.
 */
export function dominantCurrency(
  series: RevenueSeriesPage | undefined,
): string | null {
  const totals = new Map<string | null, number>();

  for (const point of series?.points ?? []) {
    totals.set(point.currency, (totals.get(point.currency) ?? 0) + point.amount);
  }

  const [top] = [...totals].sort(([, a], [, b]) => b - a);

  return top?.[0] ?? null;
}

/**
 * Le vert du succès, et pas une couleur de la série des graphiques.
 *
 * `--chart-1` à `--chart-6` sont un **jeu qualitatif** : elles distinguent des
 * catégories sans les hiérarchiser, et deux d'entre elles sont déjà prises par
 * les deux périodes du panneau du dessus. En emprunter une troisième ferait
 * lire le revenu comme une troisième courbe de trafic.
 *
 * `--success` dit autre chose, et c'est ce qu'on veut : de l'argent encaissé.
 * C'est aussi la couleur que la maquette lui donne.
 */
const config = {
  revenue: { label: 'Revenue', color: 'var(--success)' },
} satisfies ChartConfig;

export function RevenuePanel({
  days,
  currency,
  formatAmount,
  formatDay,
}: {
  days: RevenueDay[];
  currency: string | null;
  /** Le formateur de montant du parent — une seule façon d'écrire l'argent. */
  formatAmount: (amount: number, currency: string | null) => string;
  formatDay: (start: string) => string;
}) {
  const ceiling = days.reduce((highest, day) => Math.max(highest, day.revenue), 0);

  return (
    <ChartContainer config={config} className="h-[120px] w-full sm:h-[150px]">
      <BarChart
        data={days}
        accessibilityLayer
        // Les mêmes marges que le panneau du dessus, à la réserve du haut près :
        // c'est ce qui fait tomber les deux axes l'un sur l'autre. Les dissocier
        // décalerait les deux dessins de quelques pixels, et toute la lecture
        // croisée avec.
        margin={{ top: 8, left: 0, right: 8 }}
      >
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
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          width={AXIS_WIDTH}
          // Trois graduations et pas quatre : le panneau fait un tiers de la
          // hauteur de celui du dessus, et y poser autant de repères les
          // tasserait jusqu'à l'illisible.
          ticks={[0, Math.round(ceiling / 2), ceiling].filter(
            (tick, index, all) => all.indexOf(tick) === index,
          )}
          domain={[0, ceiling === 0 ? 1 : ceiling]}
          // Les centimes sont tus **sur l'axe** : une graduation n'a pas à être
          // exacte au centime, et `$1,250.00` ne tient pas dans la largeur que
          // les deux panneaux partagent. Le survol, lui, les rend.
          tickFormatter={(amount: number) =>
            formatAmount(Math.round(amount / 100) * 100, currency).replace(
              /[.,]00$/,
              '',
            )
          }
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;

            const day = payload[0].payload as RevenueDay;

            return (
              <div className="border-border/50 bg-background grid min-w-36 gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
                <div className="font-medium">{formatDay(String(label))}</div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Revenue</span>
                  <span className="font-mono font-medium tabular-nums">
                    {formatAmount(day.revenue, currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Payments</span>
                  <span className="font-mono font-medium tabular-nums">
                    {day.payments}
                  </span>
                </div>
              </div>
            );
          }}
        />
        <Bar dataKey="revenue" fill="var(--color-revenue)" radius={2} />
      </BarChart>
    </ChartContainer>
  );
}
