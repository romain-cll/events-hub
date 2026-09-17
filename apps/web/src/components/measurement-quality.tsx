import type {
  AnalyticsSummary,
  RevenueAttributionPage,
  UnsourcedRevenue,
} from '@events-hub/api-contract';

import { Hint } from '#/components/hint';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card';
import { Separator } from '#/components/ui/separator';
import { Skeleton } from '#/components/ui/skeleton';

/**
 * Formateur figé sur une locale, pour la raison qui vaut partout dans l'app :
 * le défaut du navigateur rendrait autre chose au serveur qu'au client, donc
 * une erreur d'hydratation.
 */
const number = new Intl.NumberFormat('en-US');

/**
 * Un taux tel qu'on l'écrit sur une carte, une décimale.
 *
 * Deux feraient croire à une précision que l'assiette n'a pas : cette part se
 * déplace de plusieurs points dès qu'un seul gros paiement retrouve — ou perd
 * — son parcours.
 */
const ratio = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/**
 * Un montant, tel que Stripe l'a écrit — en centimes, dans sa devise.
 *
 * La division par cent se fait **ici et nulle part ailleurs** : l'API rend des
 * entiers parce que toutes les devises n'ont pas deux décimales, et
 * `Intl.NumberFormat` sait lesquelles en ont combien. La faire plus haut — au
 * chargement, dans un `lib/` — ferait entrer des flottants dans une donnée
 * comptable, et un total en flottants finit par ne plus tomber juste face au
 * tableau de bord Stripe.
 *
 * `null` en devise veut dire que l'événement n'en portait pas : on montre le
 * nombre nu plutôt qu'un symbole inventé.
 *
 * ## Pourquoi il est recopié
 *
 * `analytics.tsx` a le même, et ne l'exporte pas. Le coût de la copie est deux
 * définitions à faire bouger ensemble ; le coût de l'export aurait été un
 * import croisé entre un écran et un composant, dans le sens où il ne va
 * jamais. Le jour où un troisième appelant apparaît, les deux vont dans
 * `lib/`.
 */
function money(amount: number, currency: string | null): string {
  if (!currency) return number.format(amount);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

/**
 * Ce qu'un axe d'attribution pèse, réduit à ce que cette carte lit.
 *
 * Les lignes classées portent en plus un libellé — une campagne, un pays — dont
 * on n'a rien à faire ici : on ne compare pas des valeurs d'axe, on les somme
 * toutes.
 */
interface AxisBreakdown {
  rows: UnsourcedRevenue[];
  direct: UnsourcedRevenue[];
  unattributed: UnsourcedRevenue[];
}

/** Les trois seaux d'une devise, et leur somme. */
interface CurrencySplit {
  currency: string | null;
  classified: number;
  direct: number;
  unattributed: number;
  total: number;
}

/**
 * Ce que la mesure ne voit pas, dit en même temps que ce qu'elle voit.
 *
 * ## Pourquoi cette carte existe
 *
 * « Annoncer un revenu attribué sans dire quelle part échappe à la mesure est
 * un mensonge par omission » — `docs/croisements-revenu.md`, et c'est tout le
 * mandat de ce composant. Le cas s'est déjà produit à l'écran : le bandeau
 * annonçait 20 $, les cartes d'attribution affichaient « No revenue yet », et
 * tout le revenu était là, non rattaché.
 *
 * ## Un seul axe, jamais deux
 *
 * Les totaux sont lus sur **un seul** axe — le premier présent, et n'importe
 * lequel ferait l'affaire : les mêmes paiements sont sur tous, seulement rangés
 * autrement. Les sommer sur deux axes les compterait deux fois.
 *
 * Ce qui change d'un axe à l'autre est la frontière entre `rows` et `direct`,
 * pas leur somme : un visiteur connu sans campagne tombe en `direct` sur l'axe
 * campagne et dans `rows` sur l'axe pays. La part rattachée à une visite, elle,
 * ne bouge pas — c'est pour ça que c'est elle qui fait le titre, et pas la part
 * classée.
 *
 * ## Deux causes là où la doc en veut trois
 *
 * `docs/page-audience-revenu.md` ouvre le non-attribué en trois — client
 * antérieur à l'installation, refus de consentement, metadata manquante. Le
 * contrat n'en rend qu'un seau, `unattributed`, qui les fond. Les séparer
 * demande une lecture serveur qui n'existe pas ; les répartir au jugé ici
 * serait pire que de n'en montrer qu'un, parce que la seule des trois qui soit
 * réparable — la metadata manquante — deviendrait invérifiable.
 *
 * ## Pas de taux de consentement
 *
 * Aucun pourcentage sur les compteurs de visite, et c'est le contrat qui le
 * veut : le dénominateur dépend de la question posée — performance du bandeau,
 * ou couverture de la mesure — et en figer un ici priverait l'autre de ses
 * termes. Surtout, `granted + declined` ne fait pas `sessions` : l'écart est ce
 * qu'on n'a **pas demandé**, et le ranger en refus ferait passer un site sans
 * bandeau pour un site que tout le monde refuse.
 */
export function MeasurementQuality({
  attribution,
  summary,
}: {
  attribution: RevenueAttributionPage | undefined;
  summary: AnalyticsSummary | undefined;
}) {
  const axis = pickAxis(attribution);
  const currencies = axis ? splitByCurrency(axis) : [];

  // Le plancher à zéro n'est pas une coquetterie : les trois nombres sortent de
  // la même passe, donc un écart négatif serait un bug de la lecture. L'écrire
  // tel quel enverrait le lecteur douter de son trafic plutôt que de notre SQL.
  const neverAsked =
    summary &&
    Math.max(
      0,
      summary.sessions - summary.consentGranted - summary.consentDeclined,
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Measurement quality</CardTitle>
        <CardDescription>
          What the revenue above can and cannot see.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          {attribution === undefined ? (
            <Skeleton className="h-16 w-full" />
          ) : axis === undefined ? (
            // Une clé d'axe absente veut dire « pas demandée », jamais
            // « calculée et vide » — le contrat est explicite là-dessus.
            // Afficher 0 % rattaché ici inventerait une mesure qu'on n'a pas
            // faite, ce qui est exactement le travers que la carte combat.
            <p className="text-muted-foreground text-xs">
              Revenue attribution was not requested for this period.
            </p>
          ) : currencies.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No payments in this period.
            </p>
          ) : (
            currencies.map((split) => (
              <CurrencyReach
                key={split.currency ?? 'none'}
                split={split}
                // Le code ISO n'apparaît qu'au-delà d'une devise. Sur le cas
                // ordinaire il ne dit rien que le symbole d'à côté ne dise
                // déjà, et il ferait du bruit sur chaque bloc.
                showCode={currencies.length > 1}
              />
            ))
          )}
        </div>

        <Separator />

        {/* Les visites changent d'unité, pas de sujet : ce sont les mêmes
            paiements vus par le bout du consentement, qui décide de ce qui
            pourra être rattaché demain. D'où le filet plutôt qu'une seconde
            carte — les séparer laisserait lire la part non attribuée sans sa
            cause principale. */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Tile
            label="Consent granted"
            hint="Visits whose visitor accepted the cross-referencing cookie. Consent covers revenue attribution only — audience measurement asks for nothing and stores nothing. This is how many visits a payment can be tied back to."
            value={summary?.consentGranted}
          />
          <Tile
            label="Consent declined"
            hint="Visits whose visitor refused the cross-referencing cookie. Their payments can still be counted, never attributed."
            value={summary?.consentDeclined}
          />
          <Tile
            label="Never asked"
            hint="Sessions minus granted minus declined: visits where no question was put. No banner, or a page that never wired one — the default, not a gap."
            value={neverAsked}
          />
          <Tile
            label="Bot visits filtered"
            hint="Bot sessions removed from every other counter here. It only rises from the day detection went live: earlier visits all count as human, and the User-Agent that would have judged them was never stored."
            value={summary?.botSessions}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Une devise, sa part rattachée, et ce qui lui échappe.
 *
 * Jamais de total mêlé : additionner des euros et des dollars demanderait un
 * taux de change, donc une date de taux, donc une décision qui n'appartient pas
 * à un tableau de bord. Deux devises font deux blocs, et chacun se lit seul.
 */
function CurrencyReach({
  split,
  showCode,
}: {
  split: CurrencySplit;
  showCode: boolean;
}) {
  const tied = split.classified + split.direct;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          <Hint title="Revenue from a payment we can place on a known visit — classified on the axis, or direct. Read on a single axis: the same payments sit on all of them, only filed differently.">
            Tied to a visit
          </Hint>
        </span>

        {showCode && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {split.currency?.toUpperCase() ?? 'No currency'}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-2xl tabular-nums">
          {money(tied, split.currency)}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {/* À zéro il n'y a pas de part : une division sans dénominateur ne
              rend pas zéro, elle ne rend rien. Le cas existe — une période
              dont les remboursements annulent les encaissements. */}
          {split.total <= 0
            ? '—'
            : `${ratio.format((tied / split.total) * 100)}%`}{' '}
          of {money(split.total, split.currency)}
        </span>
      </div>

      {/* `aria-hidden` : la barre ne dit rien que les trois montants d'en
          dessous ne disent, et un lecteur d'écran y annoncerait trois éléments
          vides. Plus haute que le rail des classements (`h-1`) parce qu'elle
          porte trois segments : c'est la frontière entre eux qu'il faut voir,
          pas seulement une longueur. */}
      <div
        aria-hidden
        className="bg-muted flex h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-primary shrink-0"
          style={{ width: barWidth(split.classified, split.total) }}
        />
        {/* Le même bleu, dilué : `direct` est du rattaché, pas un reste. Une
            seconde teinte de la palette de séries en aurait fait une catégorie
            à part, alors qu'il forme le titre avec le segment précédent. */}
        <div
          className="bg-primary/40 shrink-0"
          style={{ width: barWidth(split.direct, split.total) }}
        />
        {/* Le gris est la seule rupture de famille de la barre, et elle est
            voulue : c'est le seul segment qui ne soit pas de la mesure. */}
        <div
          className="bg-muted-foreground/30 shrink-0"
          style={{ width: barWidth(split.unattributed, split.total) }}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Cause
          swatch="bg-primary"
          label="Classified"
          hint="Revenue a value of the attribution axis claims — a campaign, a source, a landing page."
          amount={split.classified}
          currency={split.currency}
        />
        <Cause
          swatch="bg-primary/40"
          label="Direct"
          hint="A visitor we know, who arrived with nothing on this axis. An observation, not a gap — nothing here is broken."
          amount={split.direct}
          currency={split.currency}
        />
        <Cause
          swatch="bg-muted-foreground/30"
          label="Unattributed"
          hint="A payment no journey claims: consent refused, no identifier ever set, or a customer who predates the install. The only one of the three worth chasing."
          amount={split.unattributed}
          currency={split.currency}
        />
      </div>
    </div>
  );
}

/**
 * Une cause, sa pastille et son montant.
 *
 * Les trois causes n'appellent pas la même action — l'une ne se répare pas,
 * l'autre n'a rien à réparer, la troisième est un défaut d'intégration. Les
 * fondre en un seul « non attribué » ferait passer du trafic direct pour une
 * panne, et une panne pour du trafic direct.
 */
function Cause({
  swatch,
  label,
  hint,
  amount,
  currency,
}: {
  swatch: string;
  label: string;
  hint: string;
  amount: number;
  currency: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-[2px] ${swatch}`}
        />
        <Hint title={hint}>{label}</Hint>
      </span>
      <span className="truncate text-sm tabular-nums">
        {money(amount, currency)}
      </span>
    </div>
  );
}

/**
 * Un compteur de visites, et sa définition au survol.
 *
 * Rien sous le chiffre : la nuance de chacun de ces quatre nombres tient en
 * deux phrases, et deux phrases sous une métrique font une carte qu'on ne
 * balaye plus. Elles vivent dans le `Hint`, où elles n'occupent de place que
 * pour qui les demande.
 */
function Tile({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: number | undefined;
}) {
  return (
    <div className="border-border flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-xs">
        <Hint title={hint}>{label}</Hint>
      </div>
      <div className="text-xl tabular-nums">
        {value === undefined ? (
          <Skeleton className="h-5 w-12" />
        ) : (
          number.format(value)
        )}
      </div>
    </div>
  );
}

/**
 * Le premier axe que la réponse porte.
 *
 * L'ordre n'a aucune importance et c'est le point : les mêmes paiements sont
 * sur les sept, seulement rangés autrement. Ce qui compte est qu'il n'y en ait
 * qu'un — deux les compteraient deux fois.
 *
 * Trier par « le plus informatif » aurait été une fausse bonne idée : ça aurait
 * fait dépendre le total affiché des axes que l'appelant a demandés, donc du
 * `?axes=` d'une autre carte.
 */
function pickAxis(
  attribution: RevenueAttributionPage | undefined,
): AxisBreakdown | undefined {
  return (
    attribution?.campaign ??
    attribution?.source ??
    attribution?.landing ??
    attribution?.country ??
    attribution?.browser ??
    attribution?.os ??
    attribution?.device
  );
}

/**
 * Les trois seaux d'un axe, repliés par devise, du plus gros total au plus
 * petit.
 *
 * Le tri est sur le total et non sur la part rattachée : c'est la devise qui
 * pèse qu'on veut en tête, y compris — surtout — quand c'est elle qui échappe
 * le plus à la mesure.
 */
function splitByCurrency(axis: AxisBreakdown): CurrencySplit[] {
  const splits = new Map<string | null, CurrencySplit>();

  const bucket = (currency: string | null): CurrencySplit => {
    const seen = splits.get(currency);

    if (seen) return seen;

    const created: CurrencySplit = {
      currency,
      classified: 0,
      direct: 0,
      unattributed: 0,
      total: 0,
    };

    splits.set(currency, created);

    return created;
  };

  for (const row of axis.rows) {
    const split = bucket(row.currency);
    split.classified += row.amount;
    split.total += row.amount;
  }

  for (const row of axis.direct) {
    const split = bucket(row.currency);
    split.direct += row.amount;
    split.total += row.amount;
  }

  for (const row of axis.unattributed) {
    const split = bucket(row.currency);
    split.unattributed += row.amount;
    split.total += row.amount;
  }

  return [...splits.values()].sort((a, b) => b.total - a.total);
}

/**
 * La largeur d'un segment, en pourcentage de la barre.
 *
 * ⚠️ Un seau négatif est ramené à zéro. Des remboursements peuvent faire passer
 * un seau sous zéro, et une barre empilée ne sait pas dessiner ça — elle
 * déborderait les autres segments. Le coût est borné et assumé : les trois
 * montants d'à côté, eux, gardent leur signe et disent la vérité, et c'est là
 * que le lecteur la lit.
 *
 * En style plutôt qu'en classe parce que la largeur se calcule à l'exécution,
 * et que Tailwind ne génère que ce qu'il lit dans le source.
 */
function barWidth(amount: number, total: number): string {
  if (total <= 0) return '0%';

  return `${String((Math.max(0, amount) / total) * 100)}%`;
}
