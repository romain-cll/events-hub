import type {
  AnalyticsSummary,
  RevenueSeriesPage,
  SessionRow,
  SessionsPage,
  Source,
} from '@events-hub/api-contract';

import { startOfUtcDay } from './analytics';

/**
 * Le repliage que l'API ne fait plus, et qu'elle a rendu au lecteur exprès.
 *
 * `GET /analytics/sessions` sert des sessions **datées** : une ligne par
 * session, avec ses vues de page, son temps actif et sa provenance déjà
 * classée. Le pas de temps, le fuseau et le calendrier sont des décisions
 * d'affichage — le serveur ne les prend pas, ce fichier les prend.
 *
 * ## Pourquoi c'est à part de la page
 *
 * Ce sont des fonctions **pures** : des lignes entrent, des lignes sortent,
 * aucun `useState`, aucun rendu. Les laisser dans le composant mêlerait la
 * définition de « une journée de trafic » à du JSX, et il n'y a rien de plus
 * facile à casser sans le voir qu'un regroupement écrit au milieu d'une vue.
 *
 * ## Ce qu'elles ne font pas
 *
 * Elles ne recomptent **rien** que l'API rende déjà sur le même périmètre.
 * `pageViews`, `uniqueVisitors` et `topPages` viennent du résumé et sont
 * affichés tels quels ; ce fichier ne touche qu'à ce qui n'existe que sous
 * forme de lignes. Recalculer un total que le serveur donne, c'est se doter
 * d'une seconde opinion sur ce qui est vrai.
 *
 * `dailyVisitors` est l'exception qui confirme la règle : elle compte des
 * visiteurs distincts, ce que le résumé fait aussi — mais **sur une autre
 * fenêtre**. Le résumé répond à la période entière, cette fonction à chacune de
 * ses journées. Ce ne sont pas deux opinions sur un même nombre.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Une journée UTC de la fenêtre, et ce qu'on y a vu de monde. */
export interface VisitorDay {
  /** Début de la journée UTC, en ISO — l'axe des abscisses. */
  start: string;
  visitors: number;
}

/** Une journée de la période courante, en regard de son homologue précédente. */
export interface ComparedDay {
  /** Début de la journée UTC de la période **courante**. */
  start: string;
  /** Début de la journée UTC qui lui répond dans la période précédente. */
  previousStart: string;
  current: number;
  previous: number;
  /**
   * L'écart en pourcentage, ou `null` quand il ne s'exprime pas.
   *
   * `null` veut dire « la veille était à zéro » : passer de 0 à 5 est une
   * hausse, mais pas une hausse de *quelque chose* — la division n'a pas de
   * résultat. Rendre `Infinity`, ou `100`, inventerait une grandeur. La vue
   * dit la hausse autrement, sans chiffre.
   */
  change: number | null;
}

/** Une provenance et le nombre de sessions qu'on lui attribue. */
export interface SourceRow {
  kind: Source['kind'];
  name: string | null;
  /** Écrit par le serveur — voir `sourceSchema.label`. Jamais reconstruit ici. */
  label: string;
  /**
   * Le domaine qui porte l'icône, ou `null` — voir `sourceSchema.host`.
   *
   * Il vient du serveur pour la même raison que `label`, et il n'est **pas**
   * `name` : celui-ci vaut `google` là où l'icône se demande à `google.com`.
   */
  host: string | null;
  sessions: number;
}

export interface Sources {
  rows: SourceRow[];
  /**
   * Sessions sans provenance observable — aucune vue de page dans la fenêtre.
   *
   * À ne **pas** confondre avec `direct`, qui est une observation : la page a
   * été vue, le navigateur n'a pas donné de referrer. Les fondre gonflerait
   * `direct` d'un bruit sans rapport avec l'acquisition.
   */
  unattributed: number;
}

export interface SessionTotals {
  sessions: number;
  pageViews: number;
  withPageView: number;
  withoutPageView: number;
  /**
   * Somme des présences **fermées**, en millisecondes.
   *
   * Sous-estime dès que `stillOpen` est non nul, et ne doit jamais s'afficher
   * sans lui.
   */
  activeMs: number;
  /** Sessions dont un `page_leave` n'est jamais arrivé. */
  stillOpen: number;
  /**
   * Sessions déjà ouvertes quand la fenêtre commence.
   *
   * Leur ligne est **tronquée** : les vues de page comptées sont celles de la
   * fenêtre, et `entryPath` comme `source` décrivent l'endroit où la fenêtre
   * nous a fait entrer, pas le vrai début. Élargir la période les récupère.
   */
  truncated: number;
}

/**
 * Les visiteurs distincts de chaque journée UTC de la fenêtre.
 *
 * ## Ce que ça compte, exactement
 *
 * Des **alias distincts** parmi les sessions ouvertes ce jour-là. L'alias est
 * le jeton opaque que porte chaque ligne : il dit « ces sessions sont du même
 * visiteur », et il ne vaut que dans la réponse d'où il sort. C'est ce qui rend
 * ce compte possible côté lecteur — sans lui, deux visites d'une même personne
 * dans la journée feraient deux visiteurs.
 *
 * ## Une session est rangée sur le jour où elle s'ouvre
 *
 * Et elle peut déborder sur le lendemain : le serveur garde la clé visiteur de
 * la veille pendant trente minutes après minuit UTC, pour qu'une navigation de
 * 23 h 58 à 00 h 02 reste une seule visite. Une session à cheval compte donc
 * une fois, sur son jour de **début**.
 *
 * Corollaire pour la première journée de la fenêtre : une session ouverte
 * *avant* `from` y est rabattue par le `Math.max` plus bas, au lieu d'être
 * écartée. C'est voulu — elle a bien de l'activité dans la fenêtre, et
 * `uniqueVisitors`, qui compte les événements de la période, la comptera aussi.
 * L'exclure ferait diverger le graphique de son propre total.
 *
 * (Le taux de rebond, lui, l'exclut : là il faut connaître le *nombre* de vues
 * de la session, et une session amputée mentirait. Voir `settledSessions`.)
 *
 * ## Les journées vides sont créées ici
 *
 * Sans ce remplissage, une journée sans visiteur serait **absente** du tableau,
 * et Recharts relierait la veille au lendemain — un creux disparaîtrait purement
 * et simplement, ce qui est le pire genre d'erreur sur un graphique : invisible.
 */
export function dailyVisitors({
  from,
  to,
  sessions,
}: SessionsPage): VisitorDay[] {
  const first = startOfUtcDay(from).getTime();
  // `to` est une borne **exclue** : reculer d'une milliseconde évite d'ouvrir
  // une journée de plus quand la fenêtre s'arrête pile à minuit.
  const last = startOfUtcDay(new Date(to).getTime() - 1).getTime();

  // On accumule des ensembles plutôt que des compteurs : un visiteur peut avoir
  // plusieurs sessions dans la journée, et c'est justement ce qu'il ne faut pas
  // compter deux fois.
  const days = new Map<number, Set<string>>();

  for (let day = first; day <= last; day += DAY_MS) {
    days.set(day, new Set());
  }

  for (const session of sessions) {
    const day = Math.max(first, startOfUtcDay(session.startedAt).getTime());

    // Une session postérieure à `to` n'existe pas — la fenêtre est celle de la
    // requête. Le test protège d'un décalage d'horloge, pas d'un cas métier.
    days.get(day)?.add(session.visitorAlias);
  }

  return [...days].map(([day, visitors]) => ({
    start: new Date(day).toISOString(),
    visitors: visitors.size,
  }));
}

/**
 * Le taux de rebond de la fenêtre, en pourcentage, ou `null`.
 *
 * ## Une division, et rien d'autre
 *
 * Les deux comptes viennent de l'API, qui les rend séparés exprès : un taux
 * sans son assiette se lit comme s'il portait sur tout le trafic, alors que le
 * dénominateur écarte les sessions en cours et celles sans vue de page. La
 * carte affiche donc les deux — le taux, et les sessions sur lesquelles il
 * porte.
 *
 * Ce fichier ne recompte rien : le repli par session est fait côté serveur, et
 * un e2e vérifie qu'il donne le même résultat que le repli des lignes.
 *
 * ## `null` quand il n'y a rien à diviser
 *
 * Même règle que `percentChange` : un dénominateur nul ne rend pas zéro, il ne
 * rend rien. Ça arrive plus souvent qu'on ne croit — un projet qui vient
 * d'être installé, une période antérieure à la première visite, ou une fenêtre
 * si récente que toutes ses sessions courent encore.
 */
export function bounceRate({
  bounces,
  settledSessions,
}: AnalyticsSummary): number | null {
  if (settledSessions === 0) return null;

  return (bounces / settledSessions) * 100;
}

/**
 * L'écart entre deux mesures, en pourcentage, ou `null` quand il n'existe pas.
 *
 * `null` veut dire « la référence était à zéro » : passer de 0 à 5 est une
 * hausse, mais pas une hausse *de quelque chose* — la division n'a pas de
 * résultat. Rendre `Infinity`, ou `100`, inventerait une grandeur ; c'est à la
 * vue de dire la hausse autrement, sans chiffre.
 *
 * Vaut aussi pour « il n'y a pas de période précédente » : une fenêtre
 * antérieure à l'installation du projet rend zéro partout, ce qui est
 * exactement le cas ci-dessus. La vue n'a donc pas deux absences à distinguer.
 */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return null;

  return ((current - previous) / previous) * 100;
}

/**
 * Deux périodes de même longueur, mises en regard jour par jour.
 *
 * ## L'appariement se fait par rang, pas par date
 *
 * Le septième jour de la période courante répond au septième de la précédente.
 * C'est ce qu'on veut comparer — « ce lundi contre le lundi d'avant » suppose
 * des périodes multiples de sept, et sur trente jours ça ne tombe juste pour
 * personne. Le rang, lui, marche toujours.
 *
 * ## Les deux séries **doivent** avoir la même longueur
 *
 * Elles l'ont par construction : les deux fenêtres couvrent le même nombre de
 * journées UTC pleines. Si elles divergeaient, la comparaison serait décalée
 * d'un jour partout — le genre de faute qu'on ne voit pas à l'écran. On
 * s'arrête donc sur la plus courte plutôt que de laisser un `undefined` filer
 * dans un calcul.
 *
 * ## Le dernier jour n'est pas à égalité
 *
 * La période courante s'arrête à maintenant, la précédente couvrait des
 * journées entières. Le dernier point est donc structurellement plus bas. C'est
 * vrai de toute comparaison à période glissante ; ce n'est pas corrigé ici — le
 * corriger demanderait d'extrapoler la journée en cours, c'est-à-dire
 * d'inventer.
 */
export function compareVisitors(
  current: VisitorDay[],
  previous: VisitorDay[],
): ComparedDay[] {
  return current.slice(0, previous.length).map((day, rank) => {
    const before = previous[rank].visitors;

    return {
      start: day.start,
      previousStart: previous[rank].start,
      current: day.visitors,
      previous: before,
      change: percentChange(day.visitors, before),
    };
  });
}

/**
 * La clé d'une provenance : deux lignes ne se confondent qu'à nature égale.
 *
 * Le séparateur est un NUL parce qu'il ne peut apparaître ni dans un `kind`
 * (quatre valeurs littérales) ni dans un hôte — donc aucune paire ne peut se
 * déguiser en une autre. Il s'écrit `\0` et **jamais en clair** : un octet nul
 * posé dans le fichier le fait classer « binaire » par `grep`, `file` et les
 * outils de diff, qui le sautent alors en silence.
 */
function keyOf({ kind, name }: Source): string {
  return `${kind}\0${name ?? ''}`;
}

/**
 * Les provenances, classées par nombre de sessions décroissant.
 *
 * Le départage est fait sur le libellé, pas laissé à l'ordre d'apparition : à
 * égalité, deux chargements de la même page doivent donner le même classement.
 * Un ordre qui bouge tout seul se lit comme une donnée qui bouge.
 */
export function trafficSources(sessions: SessionRow[]): Sources {
  const rows = new Map<string, SourceRow>();
  let unattributed = 0;

  for (const { source } of sessions) {
    if (!source) {
      unattributed += 1;

      continue;
    }

    const key = keyOf(source);
    const row = rows.get(key) ?? { ...source, sessions: 0 };

    row.sessions += 1;
    rows.set(key, row);
  }

  return {
    rows: [...rows.values()].sort(
      (a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label),
    ),
    unattributed,
  };
}

/**
 * Les totaux de la fenêtre, et les deux compteurs qui disent ce qu'ils valent.
 *
 * `stillOpen` et `truncated` ne sont pas des détails d'implémentation remontés
 * par paresse : le premier dit de combien `activeMs` sous-estime, le second
 * combien de lignes décrivent un morceau de session plutôt qu'une session. Un
 * total affiché sans eux se lirait comme exact.
 */
export function sessionTotals({ from, sessions }: SessionsPage): SessionTotals {
  const opened = new Date(from).getTime();

  return sessions.reduce<SessionTotals>(
    (totals, session) => ({
      sessions: totals.sessions + 1,
      pageViews: totals.pageViews + session.pageViews,
      withPageView: totals.withPageView + (session.pageViews > 0 ? 1 : 0),
      withoutPageView: totals.withoutPageView + (session.pageViews > 0 ? 0 : 1),
      activeMs: totals.activeMs + session.activeMs,
      stillOpen: totals.stillOpen + (session.presencesStillOpen > 0 ? 1 : 0),
      truncated:
        totals.truncated +
        (new Date(session.startedAt).getTime() < opened ? 1 : 0),
    }),
    {
      sessions: 0,
      pageViews: 0,
      withPageView: 0,
      withoutPageView: 0,
      activeMs: 0,
      stillOpen: 0,
      truncated: 0,
    },
  );
}

/** Une page d'entrée, ce qu'elle a fait entrer, et ce qu'elle a laissé filer. */
export interface EntryPageRow {
  path: string;
  entries: number;
  /**
   * Part des sessions ouvertes ici qui n'ont vu qu'une page, en pourcentage.
   *
   * `null` quand aucune session close n'est partie de cette page : une division
   * sans dénominateur ne rend pas zéro, elle ne rend rien. Un `0 %` affiché là
   * se lirait « personne ne rebondit » au lieu de « on ne sait pas ».
   */
  bounceRate: number | null;
}

/**
 * Les pages par lesquelles on entre, et le rebond de chacune.
 *
 * ## Le dénominateur n'est pas `entries`
 *
 * Le taux ne porte que sur les sessions **closes** — celles dont `settled` est
 * vrai. C'est la même exclusion que `settledSessions` applique à la fenêtre
 * entière, et pour la même raison : une session encore en cours montre une page
 * et en aura peut-être quatre. La compter ferait passer la queue de la période
 * pour un pic de rebond, sur la page d'entrée la plus récente.
 *
 * `entries`, lui, compte **tout** ce qui est entré par là. Les deux colonnes ne
 * répondent donc pas à la même population, et c'est voulu : « combien sont
 * entrés » est une observation complète, « combien ont rebondi » un jugement
 * qu'on refuse de porter sur ce qui n'est pas fini.
 *
 * ## Ce que `settled` évite d'écrire ici
 *
 * Le seuil des trente minutes. Il vit dans l'ingestion, le serveur l'applique,
 * et la ligne de session porte le résultat. Le refaire ici en comparant
 * `endedAt` à `to` marcherait aujourd'hui et divergerait le jour où le seuil
 * change — sans que rien ne le signale.
 */
export function entryPages(sessions: SessionRow[]): EntryPageRow[] {
  const rows = new Map<
    string,
    { entries: number; closed: number; single: number }
  >();

  for (const session of sessions) {
    // Une session sans page d'entrée n'est entrée par nulle part : elle n'a pas
    // de ligne, plutôt qu'une ligne « (inconnue) » qui inviterait à la lire
    // comme une page du site.
    if (session.entryPath === null) continue;

    const row = rows.get(session.entryPath) ?? {
      entries: 0,
      closed: 0,
      single: 0,
    };

    row.entries += 1;

    if (session.settled) {
      row.closed += 1;
      if (session.pageViews === 1) row.single += 1;
    }

    rows.set(session.entryPath, row);
  }

  return [...rows]
    .map(([path, { entries, closed, single }]) => ({
      path,
      entries,
      bounceRate: closed === 0 ? null : (single / closed) * 100,
    }))
    .sort((a, b) => b.entries - a.entries || a.path.localeCompare(b.path));
}

/** Une sortie : vers quel site, ou nulle part. */
export interface ExitRow {
  /**
   * L'origine du site de destination, ou `null` pour les sessions qui se sont
   * éteintes sur place.
   *
   * `null` ne veut pas dire « le visiteur est resté » : on n'a simplement vu
   * aucun clic sortant. Fermer l'onglet et taper une autre adresse se
   * ressemblent depuis ici, et la vue le dit avec ses mots.
   */
  outbound: string | null;
  exits: number;
}

/**
 * Par où les sessions s'en vont.
 *
 * Une ligne par site de destination, plus **une ligne pour tout le reste** —
 * celles dont on n'a pas vu la sortie. Cette ligne-là est toujours rendue, même
 * à zéro : c'est la seule façon de faire lire les autres comme une part et non
 * comme un total. Sans elle, dix lignes de destinations laisseraient croire que
 * dix sites se partagent tout le trafic sortant.
 *
 * Elle est mise en dernier quel que soit son poids, parce qu'elle n'est pas une
 * destination : la trier avec les autres la ferait passer pour l'une d'elles.
 */
export function exits(sessions: SessionRow[]): ExitRow[] {
  const rows = new Map<string, number>();
  let ended = 0;

  for (const { exit } of sessions) {
    if (exit.outbound === null) {
      ended += 1;

      continue;
    }

    rows.set(exit.outbound, (rows.get(exit.outbound) ?? 0) + 1);
  }

  const destinations = [...rows]
    .map(([outbound, exits]) => ({ outbound, exits }))
    .sort((a, b) => b.exits - a.exits || a.outbound.localeCompare(b.outbound));

  return [...destinations, { outbound: null, exits: ended }];
}

/**
 * Les sites qui nous envoient du monde, hors moteurs et assistants.
 *
 * Un sous-ensemble de `trafficSources`, pas un second calcul : c'est la même
 * classification, filtrée sur `referral`. Les moteurs et les assistants ont
 * leur ligne dans l'onglet Sources, et les remettre ici les compterait deux
 * fois sous deux noms.
 *
 * Les referrers **sans nom** — un referrer illisible — sont écartés : il n'y a
 * pas d'hôte à écrire, et une ligne vide dans un classement d'hôtes n'apprend
 * rien. Leur nombre reste visible dans l'onglet Sources, sous `Referral`.
 */
export function referrers(sessions: SessionRow[]): SourceRow[] {
  return trafficSources(sessions).rows.filter(
    (row) => row.kind === 'referral' && row.name !== null,
  );
}

/**
 * Les visiteurs distincts par axe d'acquisition, repliés depuis les sessions.
 *
 * ## Pourquoi ici et pas côté serveur
 *
 * Parce que la donnée est **déjà chargée**. La page lit la liste des sessions
 * pour tracer le trafic quotidien ; chacune porte sa provenance, sa campagne,
 * sa page d'entrée et un alias de visiteur. Demander les mêmes comptes à l'API
 * ajouterait une route pour un repli de trente lignes.
 *
 * ## Des visiteurs, pas des sessions
 *
 * La déduplication porte sur l'alias : quelqu'un revenu trois fois compte pour
 * un. C'est le dénominateur qu'un taux de conversion demande — rapporté aux
 * sessions, il dirait qu'un visiteur fidèle convertit moins bien qu'un visiteur
 * de passage.
 *
 * ⚠️ L'alias ne vaut que dans **une** réponse et ne franchit pas la journée :
 * deux fenêtres ne se recoupent pas, et c'est voulu. Voir `SessionRow`.
 */
export interface AxisVisitors {
  source: Map<string, number>;
  campaign: Map<string, number>;
  landing: Map<string, number>;
}

export function visitorsByAxis(sessions: SessionRow[]): AxisVisitors {
  const seen = {
    source: new Map<string, Set<string>>(),
    campaign: new Map<string, Set<string>>(),
    landing: new Map<string, Set<string>>(),
  };

  const add = (axis: keyof typeof seen, key: string, alias: string) => {
    const aliases = seen[axis].get(key) ?? new Set<string>();

    aliases.add(alias);
    seen[axis].set(key, aliases);
  };

  for (const session of sessions) {
    if (session.source) add('source', session.source.label, session.visitorAlias);

    if (session.campaign) {
      const { source, medium, name } = session.campaign;

      add(
        'campaign',
        [source, medium, name].filter(Boolean).join(' / '),
        session.visitorAlias,
      );
    }

    if (session.entryPath) {
      add('landing', session.entryPath, session.visitorAlias);
    }
  }

  const counted = (aliases: Map<string, Set<string>>) =>
    new Map([...aliases].map(([key, set]) => [key, set.size]));

  return {
    source: counted(seen.source),
    campaign: counted(seen.campaign),
    landing: counted(seen.landing),
  };
}

/**
 * La devise qui pèse le plus dans la série.
 *
 * Le graphique n'en dessine qu'une : empiler des euros et des dollars
 * demanderait un taux de change, donc une date de taux, donc une décision qui
 * n'appartient pas à un dessin. Montrer la seconde par défaut ferait passer
 * l'essentiel du revenu pour du vide.
 *
 * `null` quand la série est vide — le graphique n'affiche alors aucune barre, ce
 * qui est exact. Les autres devises restent lisibles dans la carte de qualité de
 * la mesure, en bas de page.
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
 * Le revenu d'une devise, aligné sur les journées du trafic.
 *
 * La route ne rend **pas** les pas vides : un jour sans paiement n'a aucun
 * point, parce qu'un `group by` ne fabrique pas les lignes qu'il n'a pas.
 * Combler appartient donc au lecteur — et c'est ici, parce que lui seul sait
 * quelles journées il affiche.
 *
 * Un jour absent devient **zéro** et non une absence : les deux se ressemblent
 * sur un graphique en barres, mais l'absence décalerait la série par rapport à
 * la courbe du trafic, qui porte toutes les journées.
 */
export function revenueByDay(
  starts: string[],
  series: RevenueSeriesPage | undefined,
  currency: string | null,
): Map<string, { revenue: number; payments: number }> {
  const byDay = new Map(
    (series?.points ?? [])
      .filter((point) => point.currency === currency)
      .map((point) => [
        new Date(point.start).toISOString(),
        { revenue: point.amount, payments: point.payments },
      ]),
  );

  return new Map(
    starts.map((start) => [start, byDay.get(start) ?? { revenue: 0, payments: 0 }]),
  );
}
