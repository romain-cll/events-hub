import type { CohortsPage } from '@events-hub/api-contract';
import type { CSSProperties } from 'react';

import { Hint } from '#/components/hint';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';
import { Skeleton } from '#/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip';

/**
 * Les six paliers, repris du planisphère d'`analytics`.
 *
 * Des **jetons**, pas des opacités : la rampe est dérivée de `--primary` par
 * `color-mix` dans `styles.css`, elle suit le thème toute seule, et ses deux
 * derniers paliers sont plus *soutenus* que `--primary` — ce qu'une opacité ne
 * sait pas faire, elle qui ne peut qu'éclaircir vers la surface.
 *
 * Recopiés et non importés : ce sont trois lignes contre un couplage entre une
 * carte de revenu et une route d'analytics, où la première n'a rien à faire.
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
 * La trame des mois non clos.
 *
 * ⚠️ Le contrat est formel : `null` dans `active` **n'est pas zéro**, c'est un
 * mois qu'aucune mesure ne couvre encore. Lui donner le palier le plus clair
 * suffirait à dessiner une falaise au bord de la matrice — un mois à venir se
 * lirait comme un effondrement. Une trame, donc, et volontairement **hors de la
 * rampe** : une teinte, même pâle, reste une valeur, et la rampe ne doit coder
 * que des mesures.
 *
 * `--border` plutôt qu'une couleur posée à la main : c'est le trait le plus
 * discret du thème, et il s'inverse tout seul en sombre.
 */
const UNCLOSED: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--border) 0 1px, transparent 1px 5px)',
};

const number = new Intl.NumberFormat('en-US');

/** Une décimale : deux promettraient une précision que la cohorte n'a pas. */
const ratio = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/**
 * Le mois de cohorte en toutes lettres.
 *
 * `timeZone: 'UTC'` explicite, et le fuseau du serveur ne s'en mêle pas : sans
 * lui, `2026-03` s'afficherait « Feb 2026 » pour un lecteur à l'ouest de
 * Greenwich, et le rendu serveur et le rendu client ne tomberaient pas d'accord
 * — une erreur d'hydratation, pas seulement un libellé de travers.
 */
const monthLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function cohortLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);

  // Le mois vient du serveur, mais il traverse du JSON : un `Invalid Date`
  // rendrait « Invalid Date » sur toute une ligne plutôt que la clé, qui est au
  // moins lisible.
  return Number.isNaN(date.getTime()) ? month : monthLabel.format(date);
}

/**
 * La rétention des cohortes d'acquisition, en matrice triangulaire.
 *
 * ## L'échelle code une **part**, pas un compte
 *
 * Le dénominateur est `customers` — la cohorte entière, pas les seuls
 * convertis. Deux raisons. Sur les comptes bruts, la couleur ne dirait que la
 * taille de la cohorte : un mois de gros trafic serait sombre de bout en bout et
 * on ne comparerait plus rien d'une ligne à l'autre. Et rapporter aux convertis
 * partirait de cent pour cent par construction — c'est exactement la cohorte
 * d'abonnement que le contrat écarte, celle qui masque le délai entre la
 * découverte et l'achat.
 *
 * La part est ensuite rapportée au **maximum de la matrice**, une seule échelle
 * pour toutes les lignes. Normaliser ligne par ligne donnerait à chaque cohorte
 * sa propre case sombre et rendrait les lignes incomparables, ce qui est
 * précisément ce qu'on vient lire.
 *
 * Ce que ça coûte : deux cases de teinte voisine ne portent pas forcément le
 * même effectif. Le compte est écrit dans la case, et le survol donne les deux
 * termes de la part.
 *
 * ## La ligne peut foncer vers la droite
 *
 * Et ce n'est pas une anomalie : la cohorte est celle de la **première visite**,
 * pas de l'abonnement. Quelqu'un vu en mars qui s'abonne en juin entre dans la
 * cohorte de mars et n'apparaît qu'en M+3. C'est le délai découverte → achat
 * qu'on regarde, et il se voit comme une montée.
 */
export function CohortsCard({ page }: { page: CohortsPage | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Acquisition cohorts</CardTitle>
        <CardDescription>
          Subscribers at each month&apos;s close, by month of first visit.
        </CardDescription>
        <CardAction>
          <Legend />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {page ? <Matrix page={page} /> : <Skeleton className="h-64 w-full" />}
      </CardContent>
    </Card>
  );
}

/**
 * La rampe, et la trame à côté d'elle.
 *
 * Les deux ensemble ou aucune : c'est la légende qui apprend au lecteur que la
 * case hachurée n'est pas une case vide. Sortie de la légende, la trame reste
 * un motif que rien ne nomme.
 */
function Legend() {
  return (
    <div className="text-subtle-foreground flex items-center gap-3 text-2xs">
      <span className="flex items-center gap-1.5">
        <span>Fewer</span>
        {HEAT.map((step) => (
          <span
            key={step}
            className="h-2 w-5 rounded-[2px]"
            style={{ background: `var(${step})` }}
          />
        ))}
        <span>More</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="border-border h-2 w-5 rounded-[2px] border"
          style={UNCLOSED}
        />
        <span>Not closed</span>
      </span>
    </div>
  );
}

function Matrix({ page }: { page: CohortsPage }) {
  // `depth` compte les mois **après** M+0 : le contrat décrit `active` comme
  // « M+0, M+1, … M+depth ».
  const months = Array.from({ length: page.depth + 1 }, (_, index) => index);

  // Le sommet de l'échelle, sur les parts et jamais sur les comptes — voir la
  // docstring de la carte. Zéro reste possible (aucun abonné nulle part) et il
  // est rattrapé dans `heatStep`, faute de quoi la division le propagerait en
  // `NaN` sur toute la matrice.
  const peak = page.cohorts.reduce(
    (highest, cohort) =>
      cohort.customers === 0
        ? highest
        : cohort.active.reduce<number>(
            (rowHighest, value) =>
              value === null
                ? rowHighest
                : Math.max(rowHighest, value / cohort.customers),
            highest,
          ),
    0,
  );

  const counted = page.cohorts.reduce(
    (total, cohort) => total + cohort.customers,
    0,
  );

  // En style et pas en classe : la piste dépend de `depth`, qui vient du
  // serveur, et Tailwind ne génère que les littéraux qu'il lit dans le source.
  const template = `9rem 5rem 5rem repeat(${months.length}, 2.75rem)`;

  return (
    <>
      {page.cohorts.length === 0 ? (
        <Empty>
          <EmptyTitle>No cohort yet</EmptyTitle>
          <EmptyDescription>
            A cohort appears once a customer&apos;s first visit is on record.
          </EmptyDescription>
        </Empty>
      ) : (
        // La matrice déborde plutôt qu'elle ne rétrécit : à treize colonnes sur
        // un écran de portable, des cases de 20 px ne portent plus leur compte,
        // et une matrice dont on ne lit que la couleur ne se vérifie plus.
        <div className="overflow-x-auto">
          <div className="flex w-max flex-col gap-0.5 text-xs">
            <div
              className="grid h-8 items-center gap-0.5"
              style={{ gridTemplateColumns: template }}
            >
              <div className="px-2 font-medium">
                <Hint title="The month of the customer's first visit — not of their subscription. Someone seen in March who subscribes in June belongs to March and shows up at M+3, so a row can grow to the right.">
                  Cohort
                </Hint>
              </div>
              <div className="px-2 text-right font-medium">Customers</div>
              <div className="px-2 text-right font-medium">
                <Hint title="Customers of this cohort who took a subscription at some point, even one cancelled since.">
                  Converted
                </Hint>
              </div>
              {months.map((month) => (
                <div
                  key={month}
                  className="text-subtle-foreground text-center text-2xs tabular-nums"
                >
                  M+{month}
                </div>
              ))}
            </div>

            {page.cohorts.map((cohort) => (
              <div
                key={cohort.month}
                className="grid h-7 items-center gap-0.5"
                style={{ gridTemplateColumns: template }}
              >
                <div className="truncate px-2">{cohortLabel(cohort.month)}</div>
                <div className="px-2 text-right tabular-nums">
                  {number.format(cohort.customers)}
                </div>
                <div className="text-muted-foreground px-2 text-right tabular-nums">
                  {number.format(cohort.converted)}
                </div>
                {months.map((month) => (
                  <Cell
                    key={month}
                    customers={cohort.customers}
                    label={cohortLabel(cohort.month)}
                    month={month}
                    peak={peak}
                    // Trois valeurs, trois choses différentes. `undefined` :
                    // hors du tableau rendu — ni zéro ni « pas clos », une
                    // profondeur que le serveur n'a pas servie, et la case
                    // reste nue. La borne est explicite parce qu'un accès hors
                    // limites rend `undefined` sans que le type le dise.
                    value={
                      month < cohort.active.length
                        ? cohort.active[month]
                        : undefined
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* `unmeasured` s'affiche même à zéro, et même sans une seule cohorte.
          C'est le seul chiffre qui dise ce que la matrice **ne couvre pas** :
          sans lui, une matrice qui porte un tiers des clients ressemble trait
          pour trait à une matrice qui les porte tous. Le masquer quand il est
          nul priverait aussi le lecteur de l'information inverse — que la
          couverture est complète. */}
      <div className="text-muted-foreground px-2 text-xs tabular-nums">
        {number.format(counted)} customers in cohorts ·{' '}
        {number.format(page.unmeasured)}{' '}
        <Hint title="Customers no cohort contains, for lack of a known first visit: they predate the install, or never consented. They are counted nowhere in the matrix.">
          unmeasured
        </Hint>
      </div>
    </>
  );
}

/**
 * Une case, et ce qu'elle dit au survol.
 *
 * ## Trois états, trois rendus, et deux d'entre eux ne sont pas des couleurs
 *
 * Un compte positif prend un palier de la rampe. **Zéro prend `--muted`** — un
 * gris plat, hors rampe : le palier le plus clair est déjà une teinte de marque,
 * donc une valeur, et la case à zéro se lirait comme « un peu ». Le mois non
 * clos prend la trame, et rien d'autre.
 *
 * ## Un `Tooltip` par case, et pas un état de survol remonté à la carte
 *
 * Le second aurait coûté moins de nœuds, mais il aurait fallu écrire le détail
 * quelque part — sous la matrice, donc, c'est-à-dire un paragraphe sous une
 * métrique, que le design system refuse. Le tooltip ne prend de place que
 * pendant qu'on le demande, et son contenu n'est monté qu'à l'ouverture.
 */
function Cell({
  customers,
  label,
  month,
  peak,
  value,
}: {
  customers: number;
  label: string;
  month: number;
  peak: number;
  value: number | null | undefined;
}) {
  if (value === undefined) return <span />;

  const share = customers === 0 || value === null ? 0 : value / customers;
  const step = heatStep(share, peak);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`flex h-full items-center justify-center rounded-[3px] text-2xs tabular-nums ${
            value === null
              ? 'border-border/60 border'
              : value === 0
                ? 'bg-muted text-muted-foreground'
                : // À partir de `--heat-4`, la case **est** `--primary` ou plus
                  // soutenue : c'est `--primary-foreground` qui se lit dessus,
                  // dans les deux thèmes, puisque la rampe en est dérivée. En
                  // dessous, ce sont des mélanges avec `--card`, donc la
                  // couleur de texte de la carte.
                  step >= 3
                  ? 'text-primary-foreground'
                  : 'text-foreground'
          }`}
          style={
            value === null
              ? UNCLOSED
              : value === 0
                ? undefined
                : { background: `var(${HEAT[step]})` }
          }
        >
          {value === null ? '' : number.format(value)}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">
          {label} · M+{month}
        </p>
        {value === null ? (
          <p>Not closed yet — no measure covers this month.</p>
        ) : (
          <p className="tabular-nums">
            {number.format(value)} of {number.format(customers)} subscribed
            {customers > 0 && ` · ${ratio.format(share * 100)}%`}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Le palier d'une part, de 0 à `HEAT.length - 1`.
 *
 * Linéaire sur le maximum, là où le planisphère classe par rang. L'écart est
 * assumé : le trafic par pays est une queue longue où le premier écrase tout,
 * et il faut le rang pour que la carte dise encore quelque chose. Une matrice de
 * rétention tient sur un ordre de grandeur unique — la part varie d'un facteur
 * trois ou quatre, pas cent — et le rang y écraserait l'inverse : il donnerait
 * la même teinte à 2 % et à 20 % dès qu'ils sont voisins dans le classement.
 */
function heatStep(share: number, peak: number): number {
  if (peak <= 0) return 0;

  return Math.min(HEAT.length - 1, Math.floor((share / peak) * HEAT.length));
}
