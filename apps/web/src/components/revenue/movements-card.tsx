import type { MovementsPage } from '@events-hub/api-contract';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts';

import { Hint } from '#/components/hint';
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
  ChartTooltipContent,
  type ChartConfig,
} from '#/components/ui/chart';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';

const number = new Intl.NumberFormat('en-US');

/**
 * Le mois sur l'axe, puis le mois dans le tooltip.
 *
 * L'axe n'écrit pas l'année : sur douze mois elle est vraie partout et pousse
 * les graduations à se chevaucher. Le tooltip l'écrit, parce que c'est là qu'on
 * lit une valeur précise et qu'une fenêtre de mouvements traverse souvent un 31
 * décembre.
 *
 * `timeZone: 'UTC'` explicite : sans lui, le serveur et le navigateur
 * n'accorderaient pas leurs libellés pour un lecteur à l'ouest de Greenwich, ce
 * qui est une erreur d'hydratation avant d'être un mois de travers.
 */
const axisMonth = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  timeZone: 'UTC',
});

const fullMonth = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function label(month: string, format: Intl.DateTimeFormat): string {
  const date = new Date(`${month}-01T00:00:00Z`);

  return Number.isNaN(date.getTime()) ? month : format.format(date);
}

/**
 * ⚠️ `ended` prend `--destructive` et pas une couleur de série.
 *
 * C'est le seul endroit de ces cartes où le rouge est justifié : une résiliation
 * est une perte, et la lire d'un coup d'œil est tout l'intérêt du graphique. La
 * nuance — un départ n'est pas toujours une mauvaise nouvelle — appartient au
 * lecteur, qui connaît son produit.
 *
 * `active` prend `--chart-3` : ni le bleu des entrées ni le rouge des sorties,
 * parce que ce n'est **pas** un mouvement. Reprendre l'une des deux teintes
 * suggérerait une somme qui n'existe pas.
 */
const chartConfig = {
  started: { label: 'Started', color: 'var(--chart-1)' },
  ended: { label: 'Ended', color: 'var(--destructive)' },
  active: { label: 'Active', color: 'var(--chart-3)' },
} satisfies ChartConfig;

/**
 * Les entrées et les sorties d'abonnement, mois par mois.
 *
 * ## Aucun taux, et c'est une décision
 *
 * Le churn se divise d'au moins trois façons défendables — par les actifs du
 * début de mois, par leur moyenne, par la cohorte — et elles ne donnent pas le
 * même chiffre. En figer une ici la ferait passer pour *le* taux, et priverait
 * les deux autres de leurs termes. La carte rend donc des comptes, et le lecteur
 * divise ce qu'il veut par ce qu'il veut.
 *
 * ## `active` n'est pas le cumul des barres, et il ne doit pas le devenir
 *
 * Un abonnement pris et résilié dans le même mois compte dans les **deux**
 * mouvements et dans **aucun** solde : `active` n'est jamais
 * `précédent + started − ended`. L'écart est réel, et le combler par un cumul
 * effacerait la seule chose qu'il apprend — qu'il y a eu des allers-retours.
 *
 * C'est pour ça qu'`active` est une **ligne sur son propre axe**, à droite, et
 * pas une troisième barre. Un stock et deux flux ne partagent ni l'unité ni
 * l'ordre de grandeur : sur un axe commun, une base de mille abonnés écraserait
 * les vingt entrées du mois à un pixel. Ce que ça coûte, et qu'il faut savoir :
 * deux échelles sur un même cadre laissent croiser des courbes qui ne se
 * comparent pas. D'où l'axe de droite teinté de la couleur de la ligne — il dit
 * à qui il appartient.
 */
export function MovementsCard({ page }: { page: MovementsPage | undefined }) {
  const last = page?.movements.at(-1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription movements</CardTitle>
        <CardDescription>
          Started and ended per{' '}
          <Hint title="A month in progress would show exits without the entries that have not happened yet — it reads like a haemorrhage and is not one.">
            closed
          </Hint>{' '}
          month — counts, never a{' '}
          <Hint title="Churn divides at least three defensible ways: by start-of-month actives, by their average, by the cohort. Fixing one here would deny you the other two.">
            rate
          </Hint>
          .
        </CardDescription>
        <CardAction>
          {last && (
            <span className="text-muted-foreground text-xs tabular-nums">
              <Hint title="Subscriptions live at the month's close. Not the previous month plus started minus ended: one taken and cancelled inside the same month counts in both movements and in no balance.">
                Active
              </Hint>{' '}
              at {label(last.month, fullMonth)} close:{' '}
              <span className="text-foreground font-medium">
                {number.format(last.active)}
              </span>
            </span>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {page ? (
          <Movements page={page} />
        ) : (
          <Skeleton className="h-[240px] w-full sm:h-[300px]" />
        )}
      </CardContent>
    </Card>
  );
}

function Movements({ page }: { page: MovementsPage }) {
  if (page.movements.length === 0) {
    return (
      <Empty>
        <EmptyTitle>No closed month yet</EmptyTitle>
        <EmptyDescription>
          A month shows up here once it is over — the one in progress never
          does.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      // Les graduations en chiffres tabulaires, comme partout ailleurs. Écrit
      // en déclaration brute plutôt qu'en utilitaire : la variante vise du texte
      // SVG que Recharts génère, et l'utilitaire `tabular-nums` passe par une
      // variable que ce texte-là n'hérite pas toujours.
      className="h-[240px] w-full sm:h-[300px] [&_.recharts-cartesian-axis-tick_text]:[font-variant-numeric:tabular-nums]"
    >
      <ComposedChart
        accessibilityLayer
        data={page.movements}
        // À gauche rien : l'axe se dimensionne seul et la carte porte déjà son
        // retrait. En haut, de quoi décoller la graduation du bord.
        margin={{ top: 8, left: 0, right: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="month"
          minTickGap={8}
          tickFormatter={(month: string) => label(month, axisMonth)}
          tickLine={false}
          tickMargin={8}
        />
        {/* Les deux flux partagent un axe : ce sont les mêmes unités, et c'est
            ce qui rend la comparaison entrées/sorties immédiate. Leur donner
            chacun le sien la rendrait fausse. */}
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          width={36}
          yAxisId="flow"
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          orientation="right"
          // Teinté : c'est ce qui rattache l'axe à sa ligne. Sans ça, deux axes
          // gris encadrent trois séries et rien ne dit laquelle lit lequel.
          stroke="var(--color-active)"
          tickLine={false}
          tickMargin={8}
          width={36}
          yAxisId="stock"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(month: unknown) =>
                label(String(month), fullMonth)
              }
            />
          }
        />
        <Bar
          dataKey="started"
          fill="var(--color-started)"
          maxBarSize={26}
          // Le pied reste carré : une barre arrondie en bas décolle de son axe
          // et fait douter du zéro.
          radius={[2, 2, 0, 0]}
          yAxisId="flow"
        />
        <Bar
          dataKey="ended"
          fill="var(--color-ended)"
          maxBarSize={26}
          radius={[2, 2, 0, 0]}
          yAxisId="flow"
        />
        <Line
          dataKey="active"
          // `monotone` et pas `natural` : la spline naturelle dépasse entre deux
          // points, et un stock d'abonnés qui déborde sous son minimum entre
          // deux mois montrerait une valeur que personne n'a mesurée.
          type="monotone"
          dot={false}
          stroke="var(--color-active)"
          strokeWidth={2}
          yAxisId="stock"
        />
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}
