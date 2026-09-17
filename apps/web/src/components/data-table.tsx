import { useMemo, useState, type ReactNode } from 'react';
import {
  createCoreRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
} from 'lucide-react';

import { Hint } from '#/components/hint';
import { Button } from '#/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '#/components/ui/empty';

/**
 * Le tableau triable de la page, et pourquoi il remplace la grille d'avant.
 *
 * ## Ce que l'ancien rendait impossible
 *
 * Le tableau précédent recevait des cellules **déjà rendues** — un
 * `ReactNode[]` par ligne. C'était suffisant tant qu'on affichait un classement
 * que le serveur avait ordonné, et rédhibitoire dès qu'on a voulu trier : on ne
 * trie pas des nœuds React, on trie des valeurs. D'où le passage à une colonne
 * qui sait **extraire** (`sortBy`) autant que **dessiner** (`cell`).
 *
 * ## Pourquoi `@tanstack/react-table` plutôt qu'un `useMemo` et un `slice`
 *
 * Trier et paginer trois cents lignes en mémoire tient en quinze lignes ; ce
 * n'est pas le calcul qui coûte, c'est l'état. Direction du tri, colonne
 * active, page courante, remise à la première page quand le tri change,
 * bornes qui ne sortent pas du tableau quand les données rétrécissent — chacun
 * est une ligne, et chacun est un bogue qu'on écrit une fois par tableau. La
 * dépendance était déjà là, jamais utilisée.
 *
 * ## Le rendu reste une grille CSS, pas un `<table>`
 *
 * Les hauteurs sont **fixées** — `h-10` pour l'en-tête, `h-9` pour les lignes —
 * et non déduites d'un retrait vertical. C'est ce qui rend la hauteur du
 * tableau calculable, donc ce qui permet à deux cartes voisines de partager une
 * hauteur sans que l'interligne en décide. Un `<table>` reprendrait cette
 * décision au navigateur.
 */

/**
 * Ce qu'on active, et rien de plus.
 *
 * La version 9 rend les fonctionnalités **explicites** : filtrage, groupement,
 * sélection, épinglage ne sont pas dans le bundle tant qu'on ne les nomme pas.
 * Les trois fonctions de tri sont déclarées pour la même raison — importer le
 * registre entier embarquerait les dix autres.
 */
const FEATURES = tableFeatures({
  coreRowModel: createCoreRowModel(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    basic: sortFn_basic,
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
  },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export interface DataColumn<Row> {
  /** Identifie la colonne, et sert de clé de tri. */
  key: string;
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
   * toujours une colonne de nombres : les séparer laisserait la porte ouverte à
   * une colonne alignée sans être tabulaire, qui danse d'une ligne à l'autre.
   */
  align?: 'right';
  /** Estompée : la seconde lecture d'une ligne, jamais la première. */
  dim?: boolean;
  /**
   * La définition du mot, quand c'en est un de métier.
   *
   * Le public de ce produit n'est pas analyste, et un tableau qui emploie
   * « conversion » ou « revenu par visiteur » sans les définir laisse son
   * lecteur deviner, ou croire qu'il a compris. Voir `Hint`.
   */
  hint?: string;
  /**
   * La valeur sur laquelle trier. Absente, la colonne ne se trie pas.
   *
   * Rendre `undefined` veut dire « pas de valeur » et **non** « zéro » : un
   * taux de conversion qu'on ne sait pas calculer n'est pas un taux nul, et le
   * trier comme tel mettrait les lignes qu'on ne mesure pas au même rang que
   * celles qui ne convertissent pas. Ces lignes-là tombent en fin de classement,
   * quel que soit le sens.
   */
  sortBy?: (row: Row) => number | string | undefined;
  cell: (row: Row) => ReactNode;
}

export function DataTable<Row extends RowData>({
  columns,
  rows,
  rowKey,
  empty,
  initialSort,
  pageSize,
  paginate = true,
  density = 'compact',
  onRowEnter,
  onRowLeave,
  rowState,
}: {
  columns: DataColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty: { title: string; description: string };
  /** La colonne ordonnée au premier rendu, et son sens. */
  initialSort?: { key: string; descending?: boolean };
  /**
   * Combien de lignes sont rendues d'un coup. Absent, tout l'est.
   *
   * Il **coupe**, il ne trie pas : le classement porte toujours sur la totalité
   * des lignes. Trier ce qui a déjà été coupé rendrait le premier rang d'un
   * sous-ensemble, ce qui est faux et ne se voit pas.
   */
  pageSize?: number;
  /**
   * Les boutons de page. `false` coupe sans les offrir.
   *
   * C'est le cas de la carte : elle montre les huit premières lignes et renvoie
   * au tiroir pour le reste. Y ajouter « Précédent / Suivant » en plus du bouton
   * « See more » donnerait deux façons de faire la même chose à dix pixels
   * d'écart, dont une qui pagine dans une hauteur calibrée pour huit rangs.
   */
  paginate?: boolean;
  /**
   * `roomy` quand une cellule porte deux étages — un libellé et sa barre de
   * part, par exemple.
   *
   * Deux valeurs et non une hauteur libre : les classes sont écrites en toutes
   * lettres parce que le scanner de Tailwind lit les **littéraux** du source, et
   * une classe composée à l'exécution ne serait jamais générée.
   */
  density?: 'compact' | 'roomy';
  /** Le survol croisé avec le planisphère — voir `Locations`. */
  onRowEnter?: (row: Row) => void;
  onRowLeave?: () => void;
  /** `active` quand c'est cette ligne qui est désignée, `dimmed` quand c'en est une autre. */
  rowState?: (row: Row) => 'active' | 'dimmed' | undefined;
}) {
  const [sorting, setSorting] = useState<SortingState>(
    initialSort
      ? [{ id: initialSort.key, desc: initialSort.descending ?? true }]
      : [],
  );

  const definitions = useMemo<ColumnDef<typeof FEATURES, Row>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        // Une colonne sans `sortBy` garde un accesseur constant : le modèle de
        // lignes en demande un, et `enableSorting` est ce qui décide vraiment.
        accessorFn: column.sortBy ?? (() => undefined),
        enableSorting: Boolean(column.sortBy),
        // Les valeurs absentes tombent toujours en bas, dans les deux sens.
        // C'est le seul rangement qui ne fabrique pas de faux classement.
        sortUndefined: 'last',
        cell: ({ row }) => column.cell(row.original),
      })),
    [columns],
  );

  const table = useTable({
    features: FEATURES,
    data: rows,
    columns: definitions,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => rowKey(row),
    initialState: {
      // La pagination n'est pas désactivable à la carte en v9 — la
      // fonctionnalité est déclarée une fois pour toutes. Une page assez grande
      // pour tout contenir revient au même et évite deux jeux de
      // fonctionnalités à maintenir.
      pagination: {
        pageIndex: 0,
        pageSize: pageSize ?? Math.max(rows.length, 1),
      },
    },
    // Un tri qui ne ramène pas à la première page laisse le lecteur devant la
    // page 4 d'un classement qu'il vient de retourner.
    autoResetPageIndex: true,
    // Le troisième clic **n'annule pas** le tri. Par défaut il le retire, et la
    // table retombe alors sur l'ordre des données — qui ressemble à un
    // classement sans en être un : le lecteur croit avoir trié par une colonne
    // et regarde l'ordre d'une autre. Deux sens suffisent, et ils se devinent.
    enableSortingRemoval: false,
  });

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

  const paginated =
    paginate && pageSize !== undefined && rows.length > pageSize;
  const pageIndex = table.state.pagination?.pageIndex ?? 0;
  const shown = table.getRowModel().rows.length;

  return (
    /* Six colonnes ne tiennent pas dans 390 px, et il n'y a rien à y faire :
       les rétrécir rendrait les montants illisibles, en cacher ferait
       disparaître la comparaison que le tableau existe pour porter. Il défile
       donc **dans son cadre**, la page restant fixe — un tableau qui pousse la
       page entière vers la droite emporte tout le reste avec lui. */
    <div className="w-full overflow-x-auto">
      <div className="flex min-w-[42rem] flex-col text-sm">
        <div
          className="grid h-10 items-center border-b border-border"
          style={{ gridTemplateColumns: template }}
        >
          {table.getHeaderGroups()[0].headers.map((header, rank) => {
            const column = columns[rank];
            const sortable = header.column.getCanSort();
            const direction = header.column.getIsSorted();

            const label = column.hint ? (
              <Hint title={column.hint}>{column.head}</Hint>
            ) : (
              column.head
            );

            return (
              <div
                key={header.id}
                className={`flex min-w-0 items-center gap-1 px-2 font-medium whitespace-nowrap ${
                  column.align === 'right' ? 'justify-end' : ''
                }`}
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={header.column.getToggleSortingHandler()}
                    className={`group flex min-w-0 items-center gap-1 ${
                      column.align === 'right' ? 'flex-row-reverse' : ''
                    }`}
                  >
                    <span className="truncate">{label}</span>
                    {direction === 'asc' ? (
                      <ChevronUpIcon className="size-3.5 shrink-0" />
                    ) : direction === 'desc' ? (
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    ) : (
                      // Invisible mais **présent** : sans lui, la largeur de
                      // l'en-tête changerait au premier tri et toute la ligne
                      // bougerait sous le curseur.
                      <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    )}
                  </button>
                ) : (
                  label
                )}
              </div>
            );
          })}
        </div>

        {table.getRowModel().rows.map((row) => {
          const state = rowState?.(row.original);

          return (
            <div
              key={row.id}
              className={`grid items-center border-b border-border transition-opacity duration-100 last:border-b-0 ${
                density === 'roomy' ? 'h-12' : 'h-9'
              } ${
                state === 'active'
                  ? 'bg-muted/50'
                  : state === 'dimmed'
                    ? 'opacity-30'
                    : ''
              }`}
              onMouseEnter={
                onRowEnter ? () => onRowEnter(row.original) : undefined
              }
              onMouseLeave={onRowLeave}
              style={{ gridTemplateColumns: template }}
            >
              {/* `getAllCells` et non `getVisibleCells` : masquer une colonne est
                une fonctionnalité qu'on n'a pas activée, donc l'accesseur qui
                la suppose n'existe pas. Les deux seraient identiques ici. */}
              {row.getAllCells().map((cell, rank) => (
                <div
                  key={cell.id}
                  // `overflow-hidden` et `whitespace-nowrap` ici, l'ellipse dans
                  // la cellule : la cellule tient la ligne, ce qu'on y met décide
                  // comment il se coupe.
                  className={`min-w-0 overflow-hidden px-2 whitespace-nowrap ${
                    columns[rank].align === 'right'
                      ? 'text-right tabular-nums'
                      : ''
                  } ${columns[rank].dim ? 'text-muted-foreground' : ''}`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          );
        })}

        {paginated && (
          <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
            {/* Les bornes plutôt qu'un numéro de page : « 11–20 sur 42 » dit
              combien il reste, « page 2 sur 5 » demande de le calculer. */}
            <span className="tabular-nums">
              {pageIndex * (pageSize ?? 0) + 1}–
              {pageIndex * (pageSize ?? 0) + shown} of {rows.length}
            </span>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
