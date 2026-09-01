import { Injectable } from '@nestjs/common';

import {
  EventStore,
  type EventScope,
  type SessionColumn,
  type ValueCount,
} from '../../events/event-store.service';
import { SESSION_GAP_MS } from '../../sessions/session-assigner.service';
import type {
  AnalyticsLocationsDto,
  AnalyticsWindowDto,
} from './dto/analytics-query.dto';
import { sourceOf, type Source } from './entry-source';
import { sessionsOf, type SessionExit } from './sessions';

/**
 * Le seul endroit du backend qui sait ce qu'est une page vue.
 *
 * Le Core ingère, valide, anonymise et stocke des événements dont il ne connaît
 * que la forme. C'est ici — et nulle part ailleurs — qu'on décide que le type
 * `page_view` mérite un compteur. Un `grep page_view src/core` doit rester
 * vide : c'est le test de la frontière.
 */
const EVENT_TYPE = 'page_view';

/** Le grain d'un classement géographique, tel que la route l'accepte. */
export type LocationGrain = 'country' | 'region' | 'city';

/**
 * Le grain, traduit en colonne de `sessions`.
 *
 * Deux vocabulaires distincts, et c'est délibéré : « region » est le mot du
 * produit, `region` la colonne. Ils coïncident aujourd'hui pour deux des trois
 * — `country` vise `countryCode` — et rien ne garantit qu'ils continueront. Une
 * table explicite laisse le nom d'une colonne changer sans casser une URL déjà
 * en favori, et c'est ici que la valeur de l'appelant cesse d'être une chaîne.
 */
const GRAIN_COLUMNS: Record<LocationGrain, SessionColumn> = {
  country: 'countryCode',
  region: 'region',
  city: 'city',
};

/**
 * La clé où le SDK range le chemin de la page visitée.
 *
 * Le Core sait extraire et grouper une clé JSON ; il ne sait pas que
 * `page.path` en désigne une. C'est cette ligne — et le type ci-dessus — qui
 * font la traduction entre un fait brut de l'event stream et une question
 * analytique. Un `grep 'page.path' src/core` doit rester vide, au même titre
 * qu'un `grep page_view`.
 */
const PATH_ATTRIBUTE = 'page.path';

/**
 * Combien de pages le classement retient.
 *
 * Décidé ici, pas exposé dans l'API publique : c'est le module qui répond à
 * « quelles sont les pages les plus vues », et dix lignes est la réponse à
 * cette question-là. Le jour où un appelant voudra en choisir le nombre, ce
 * sera un paramètre de requête ajouté délibérément, avec une borne haute — pas
 * un `limit` laissé ouvert par oubli.
 */
const TOP_PAGES_LIMIT = 10;

/**
 * Ce que `GET /analytics` promet : le résumé global d'une fenêtre.
 *
 * Que des agrégats, tous calculés par Postgres. C'est ce qui distingue cette
 * route de sa voisine — elle répond sans faire remonter une seule ligne, donc
 * elle reste bon marché quel que soit le volume de la fenêtre.
 *
 * ## Il n'y a plus de série temporelle
 *
 * `interval` et `timeseries` ont disparu à l'étape 33. Le découpage en journées
 * faisait décider au serveur du pas, du fuseau et du calendrier — trois
 * décisions d'affichage. Le lecteur reçoit maintenant des sessions datées par
 * `GET /analytics/sessions` et les regroupe comme il l'entend.
 *
 * La série des visiteurs uniques par jour est partie avec — et elle est revenue
 * par l'autre bout. Elle a manqué tant que le lecteur ne pouvait pas
 * dédupliquer : un compte de valeurs distinctes n'est pas une somme, et la clé
 * visiteur ne sort pas du Core. Ce n'est plus le cas depuis que chaque ligne de
 * `GET /analytics/sessions` porte un **alias de visiteur**, opaque et valable
 * dans la réponse seule ; le lecteur compte ses distincts au grain qu'il veut,
 * et le serveur ne reprend toujours aucun calendrier. Voir
 * `SessionRow.visitorAlias`.
 *
 * Ce qui n'a pas bougé : `uniqueVisitors` reste ici. Il répond à la fenêtre
 * entière, il coûte un `count(distinct)` au lieu d'une lecture de journal, et
 * il ne dépend pas d'un alias.
 */
export interface AnalyticsSummary {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  /**
   * Sessions distinctes ayant au moins un événement dans la fenêtre.
   *
   * **Exactement la longueur de `GET /analytics/sessions`** sur la même
   * fenêtre : les deux répondent au même périmètre, et l'égalité est éprouvée en
   * e2e. Deux compteurs qui prétendraient tous deux compter « les sessions »
   * finiraient par s'afficher côte à côte, et rien ne dirait lequel a raison.
   *
   * Il est ici parce qu'un résumé doit pouvoir donner ce nombre sans payer le
   * détail — c'est un `count(distinct)`, pas une lecture du journal.
   */
  sessions: number;
  /** Vues de page de la fenêtre. Le seul total franchement additif. */
  pageViews: number;
  /**
   * Clés visiteur distinctes de la fenêtre, tous types d'événements confondus.
   *
   * **Ce n'est pas un nombre de personnes.** La clé tourne chaque nuit UTC :
   * quelqu'un revenu trois jours y vaut trois. Voir `EventStore.countVisitors`,
   * qui porte la démonstration.
   *
   * Il a longtemps été le seul chiffre qui ne pouvait pas descendre chez le
   * lecteur : la déduplication porte sur une clé que le Core ne laisse pas
   * sortir. L'alias de `SessionRow` a levé ça — le lecteur sait maintenant
   * compter ses distincts.
   *
   * Ce champ reste, et ce n'est pas une redondance. Il répond **sans faire
   * remonter une ligne**, là où le refaire côté lecteur coûte le journal
   * entier. Un résumé doit pouvoir donner ce nombre sans payer le détail.
   */
  uniqueVisitors: number;
  /**
   * Sessions **terminées** n'ayant vu qu'une seule page.
   *
   * Le numérateur du taux de rebond, au sens de Plausible : une visite est un
   * rebond si le visiteur n'a pas vu de seconde page. Pas de seuil de temps —
   * celui de PostHog (« moins de dix secondes, aucune interaction ») s'appuie
   * sur un compteur d'interactions par session que la chaîne ne porte pas
   * encore.
   *
   * À diviser par `settledSessions`, jamais par `sessions`. Le rapport n'est
   * pas rendu tout fait pour la même raison que la carte des sessions n'affiche
   * aucune moyenne : un taux séparé de son assiette se lit comme s'il portait
   * sur tout.
   */
  bounces: number;
  /**
   * Sessions **terminées** ayant vu au moins une page. Le dénominateur.
   *
   * Trois populations en sont exclues, et les trois exclusions comptent :
   *
   * Les **sessions en cours** — dernier événement à moins de trente minutes de
   * `to`. Elles montrent une page et en auront peut-être quatre ; les laisser
   * ferait lire la queue de la période comme un pic de rebond. On ne peut pas
   * non plus se fier à `presencesStillOpen` pour les reconnaître : ce compteur
   * confond « en cours » avec « le `page_leave` s'est perdu », et la perte
   * corrèle avec les sorties abruptes, donc avec les rebonds.
   *
   * Les **sessions sans vue de page** — troncature par le bas, `page_view`
   * perdu à l'ingestion, ou site qui n'émet que des événements métier. Sans
   * page vue, il n'y a rien dont on soit parti.
   *
   * Les **sessions ouvertes avant `from`** — leurs vues d'avant la fenêtre ne
   * sont pas comptées, donc une visite profonde ressemblerait à un rebond.
   *
   * Ne dépasse donc jamais `sessions`, et l'égalité est un cas normal quand les
   * trois exclusions sont vides. L'écart, quand il existe, n'est pas une perte :
   * c'est ce sur quoi on refuse de se prononcer.
   */
  settledSessions: number;
  /**
   * Les pages les plus vues, la plus vue en tête. Au plus dix.
   *
   * La forme est celle que le Core rend : `value` est le chemin, tel que le SDK
   * l'a émis. Le module ne le renomme pas en `path` — ce serait affirmer qu'il
   * l'a normalisé, alors qu'il ne fait que le transmettre.
   *
   * Un **classement, pas une décomposition** : la somme de ses `events` est
   * inférieure à `pageViews` dès qu'il existe plus de dix pages, ou qu'un
   * `page_view` n'a pas de `page.path`.
   */
  topPages: ValueCount[];
}

/**
 * Une session, telle que `GET /analytics/sessions` la rend.
 *
 * ## Des faits datés, pas des conclusions
 *
 * C'est le renversement de l'étape 33. Cette route rendait six totaux — sessions
 * comptées, pages additionnées, temps actif sommé — et une route voisine rendait
 * la répartition par provenance des mêmes sessions. Les deux lisaient le même
 * journal, le repliaient par la même fonction, et deux de leurs compteurs
 * étaient numériquement identiques ; deux requêtes pour un seul travail, et deux
 * nombres qui pouvaient se contredire à l'écran si un événement arrivait entre
 * les deux appels.
 *
 * Il n'y a plus qu'une lecture, et elle rend des lignes. Tous ces totaux se
 * refont chez le lecteur, par des sommes et des filtres, sur une donnée qui ne
 * peut plus se désaccorder avec elle-même :
 *
 *     sessions attribuées        source !== null
 *     tronquées par la fenêtre   source === null && startedAt <  from
 *     sans vue de page           source === null && startedAt >= from
 *     répartition par source     groupBy sur source
 *     vues, temps actif          deux sommes
 *     présences ouvertes         presencesStillOpen > 0
 *     étendue d'une session      endedAt − startedAt
 *
 * ## Ce que le serveur garde quand même
 *
 * La **classification** du referrer. Décider que `google.com` est un moteur de
 * recherche est une interprétation métier, elle vit dans `entry-source.ts` et
 * elle est éprouvée là-bas. Regrouper des lignes déjà classées, non : c'est de
 * la présentation.
 *
 * ## Ce qui n'y est pas
 *
 * `durationMs` : les deux bornes sont dans la ligne, la soustraction appartient
 * au lecteur. La mise en garde reste — cette étendue part du **début réel** de
 * la session, même antérieur à `from`, donc deux fenêtres adjacentes qui
 * portent chacune un morceau de la même session comptent chacune tout ce qui
 * précède leur propre borne. Leur somme dépasse le total. C'est désormais une
 * note, plus une rétention : `startedAt` est là pour que le lecteur le voie.
 *
 * `presences[]` : les intervalles de présence, un par couple vue/sortie. Une
 * heatmap de temps actif par heure en aurait besoin ; rien ne la demande, et la
 * ligne doublerait de taille pour du poids mort. Une addition d'un champ le jour
 * où la question se pose.
 *
 * `sessionId` : il a existé ici, et il est parti avec l'arrivée de
 * `visitorAlias`. Stable d'un appel à l'autre, il aurait suffi à recoller les
 * alias de deux réponses et à leur rendre la stabilité qu'on leur retire
 * exprès. Rien ne le réclamait : une ligne *est* une session.
 */
export interface SessionRow {
  /**
   * Le visiteur, sous une forme qui ne vaut **que dans cette réponse**.
   *
   * ## Ce qu'il rend possible
   *
   * Compter des visiteurs distincts, à n'importe quel grain, chez le lecteur.
   * C'était le seul chiffre qui ne pouvait pas descendre — la déduplication
   * porte sur une clé que le Core ne laisse pas sortir — et c'est ce qui
   * interdisait une série quotidienne de visiteurs. L'alias lève l'interdit
   * sans rendre la clé, et sans que le serveur reprenne le découpage temporel
   * qu'il a rendu à l'affichage à l'étape 33.
   *
   * ## Ce qu'il ne rend pas possible
   *
   * Suivre quelqu'un. L'alias est **retiré à chaque appel** : deux lectures de
   * la même fenêtre ne rendent pas les mêmes valeurs, donc aucun rapprochement
   * ne survit à une réponse. Et il ne franchit pas la journée pour une raison
   * plus profonde que ce champ : la clé qu'il aliase tourne à minuit UTC, donc
   * la même personne en porte une nouvelle le lendemain, alias ou pas.
   *
   * Ce qui reste joignable est donc exactement ce qui l'était déjà côté
   * serveur : les sessions d'une même journée. C'est la ligne assumée ici. Un
   * mode à consentement, le jour où il existera, pourra rouvrir ce calcul —
   * ce n'est pas ce champ qui le décidera.
   *
   * ## Pourquoi `sessionId` a disparu en même temps
   *
   * Il était stable d'un appel à l'autre. Le laisser à côté d'un alias tiré au
   * hasard aurait annulé le tirage : deux réponses se joignent par
   * `sessionId`, et les alias se recollent par transitivité. Aucun lecteur ne
   * le réclamait — une ligne *est* une session, la compter n'a jamais demandé
   * de l'identifier.
   */
  visitorAlias: string;
  /**
   * Le début **réel** de la session, même antérieur à `from`.
   *
   * C'est la seule valeur de la réponse qui puisse sortir de la fenêtre, et
   * c'est voulu : la fenêtre décide de quelles lignes sortent, pas de ce qu'une
   * ligne dit d'elle-même. Comparé à `from`, il dit au lecteur si la session a
   * été vue s'ouvrir ou si elle existait déjà — distinction qu'aucun autre champ
   * ne porte, le premier événement visible valant `from` ou plus dans les deux
   * cas.
   */
  startedAt: Date;
  /**
   * Le dernier instant **observé** de la session.
   *
   * Jamais `to`. Une session encore ouverte au bord de la fenêtre n'est pas
   * prolongée jusqu'à la borne : ce serait faire dépendre la mesure du moment où
   * on pose la question, et la même session durerait plus longtemps si on
   * l'interrogeait plus tard.
   */
  endedAt: Date;
  /**
   * Somme des présences **fermées**, en millisecondes.
   *
   * Toujours inférieur ou égal à `endedAt − startedAt` : ce qui les sépare, c'est
   * le temps où l'onglet n'était pas au premier plan, plus les présences dont on
   * n'a pas vu la fin, plus le début de session tombé hors fenêtre.
   */
  activeMs: number;
  /** Vues de page de la session **dans la fenêtre**. Peut valoir zéro. */
  pageViews: number;
  /**
   * Présences dont le `page_leave` n'est jamais arrivé.
   *
   * Ce qu'`activeMs` ne compte pas. Zéro veut dire « tout a été mesuré » ; au
   * moins un veut dire que la valeur du dessus sous-estime, et de combien de
   * présences.
   */
  presencesStillOpen: number;
  /**
   * La page par laquelle la session a commencé, ou `null`.
   *
   * Figée au premier `page_view` **visible dans la fenêtre**. Sur une session
   * tronquée (`startedAt < from`) ce n'est donc pas la vraie page d'entrée, mais
   * celle où la fenêtre nous a fait entrer — le lecteur a de quoi le savoir.
   */
  entryPath: string | null;
  /**
   * Par où la session s'est terminée : la dernière page vue, et le dernier site
   * vers lequel on a cliqué.
   *
   * `outbound` à `null` ne veut **pas** dire que le visiteur est resté : fermer
   * l'onglet, taper une autre adresse ou suivre un lien qu'on ne capte pas se
   * ressemblent tous depuis ici. C'est pourquoi la lecture parle de « session
   * terminée sur le site » et jamais de « visiteur resté ».
   *
   * Sur une session non close (voir `settled`), « la dernière » veut dire « la
   * dernière qu'on ait vue » — pas la dernière qu'il y aura.
   */
  exit: SessionExit;
  /**
   * La session est-elle **close** — plus rien ne peut la rejoindre ?
   *
   * Rendu plutôt que déductible, et c'est tout l'intérêt : la règle est
   * « dernier événement à plus de `SESSION_GAP_MS` de `to` », et ce seuil vit
   * dans l'ingestion. Le lecteur qui voudrait le refaire devrait le recopier
   * chez lui, où il divergerait le jour où il change.
   *
   * Sans ce champ, aucun taux de rebond par page d'entrée n'est calculable côté
   * lecteur : il faut pouvoir écarter les sessions en cours du dénominateur,
   * exactement comme le fait `settledSessions` sur la fenêtre entière.
   */
  settled: boolean;
  /**
   * D'où vient la session, ou `null` quand il n'y a rien à en dire.
   *
   * `null` **n'est pas `direct`** : c'est « aucune page vue », donc aucune
   * provenance observable. `direct` est une observation — on a vu la page, le
   * navigateur n'a pas donné de referrer. Les confondre gonflerait `direct` d'un
   * bruit qui n'a rien à voir avec l'acquisition. Voir `sourceOf`.
   */
  source: Source | null;
}

/**
 * La réponse de `GET /analytics/sessions` : la fenêtre, et ce qu'elle contient.
 *
 * Les bornes sont renvoyées en écho pour une raison précise. Le lecteur doit
 * comparer `startedAt` à `from` pour reconnaître une session tronquée ; se fier
 * à la valeur qu'il a lui-même envoyée marcherait tant que rien ne s'interpose,
 * et cesserait de marcher au premier défaut appliqué côté serveur — c'est
 * exactement le cas quand la query est vide et que la fenêtre des sept derniers
 * jours s'applique.
 */
export interface SessionsPage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  sessions: SessionRow[];
}

/** Un endroit et son poids, tel que la route le rend. */
export interface LocationRow {
  countryCode: string | null;
  value: string;
  visitors: number;
  sessions: number;
}

/**
 * `GET /analytics/locations` — d'où viennent les visiteurs, à un grain choisi.
 *
 * Les trois mises en garde de lecture sont dans le contrat partagé
 * (`locationsPageSchema`) : `visitors` ne s'additionne pas, le classement est
 * tronqué, et `unresolved` change avec le grain.
 */
export interface LocationsPage {
  /** Borne incluse. */
  from: Date;
  /** Borne exclue. */
  to: Date;
  grain: LocationGrain;
  rows: LocationRow[];
  /** Le dénominateur des parts. Rendu, jamais reconstitué par somme. */
  visitors: number;
  unresolved: number;
}

/**
 * L'instant au-delà duquel une session est **close** pour cette fenêtre.
 *
 * ## Pourquoi `to` et pas `now()`
 *
 * Sur la période en cours, les deux valent la même chose — `to` *est*
 * maintenant, le contrôleur le résout ainsi quand la requête ne le porte pas.
 *
 * Sur une période passée, `to` est le seul des deux qui soit juste. Avec
 * `now()`, une session encore en cours au bord de la fenêtre serait déclarée
 * close — elle l'est depuis longtemps — alors que ses vues de page, elles,
 * restent coupées par `to`. On la compterait comme un rebond sur la foi d'une
 * seule page, alors qu'on n'a simplement pas regardé la suite.
 *
 * Avec `to`, la réponse d'une fenêtre passée ne bouge plus jamais. C'est la
 * même exigence que partout ailleurs dans la chaîne : une mesure ne doit pas
 * dépendre du moment où on pose la question.
 *
 * ## Le seuil n'est pas redéfini ici
 *
 * `SESSION_GAP_MS` est importé de `sessions/session-assigner`, où il est
 * appliqué. Les trente minutes n'ont qu'un domicile — c'est ce qui fait qu'un
 * agrégat et un découpage ne peuvent pas diverger.
 */
function settledBefore(to: Date): Date {
  return new Date(to.getTime() - SESSION_GAP_MS);
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly events: EventStore) {}

  /**
   * Le résumé global d'un projet sur une fenêtre.
   *
   * ## Deux périmètres, deux portées
   *
   * `pageViews` ne compte que les `page_view` : c'est une mesure de pages, pas
   * d'événements. `uniqueVisitors` et `sessions` comptent **tous types
   * confondus** — quelqu'un qui n'a déclenché qu'un `checkout_completed` est
   * venu, même s'il n'a pas de `page_view` dans la fenêtre. D'où deux scopes :
   * l'un porte le type, l'autre non.
   *
   * C'est précisément ce croisement que le Core ne pouvait pas deviner, et
   * c'est pour ça qu'il expose des primitives unitaires plutôt qu'un résumé
   * tout fait. Les quatre requêtes partent ensemble : leur coût est un
   * aller-retour, pas quatre.
   *
   * ## `sessions` est le même nombre que la route voisine
   *
   * Le périmètre du `count(distinct session_id)` est celui d'`events()` : même
   * projet, même fenêtre, aucun type. C'est ce qui garantit qu'il vaut la
   * longueur de `GET /analytics/sessions`, et un e2e le vérifie. Filtrer sur
   * `page_view` ici ferait disparaître du résumé toute session sans vue de page
   * — c'est-à-dire précisément celles qu'on tient à ne pas taire.
   */
  async summarize(
    projectId: string,
    { from, to }: AnalyticsWindowDto,
  ): Promise<AnalyticsSummary> {
    const audience: EventScope = { projectId, from, to };
    const pages: EventScope = { ...audience, types: [EVENT_TYPE] };

    const [sessions, pageViews, uniqueVisitors, topPages, byPageCount] =
      await Promise.all([
        this.events.countSessions(audience),
        this.events.countEvents(pages),
        this.events.countVisitors(audience),
        this.events.topValues(pages, {
          source: 'attributes',
          key: PATH_ATTRIBUTE,
          limit: TOP_PAGES_LIMIT,
        }),
        // Le périmètre **sans** type : la répartition compte des `page_view`,
        // mais la clôture se juge sur le dernier événement quel qu'il soit.
        // Voir `countSessionsBySingleEvent`.
        this.events.countSessionsBySingleEvent(audience, {
          type: EVENT_TYPE,
          settledBefore: settledBefore(to),
        }),
      ]);

    return {
      from,
      to,
      sessions,
      pageViews,
      uniqueVisitors,
      bounces: byPageCount.single,
      settledSessions: byPageCount.single + byPageCount.several,
      topPages,
    };
  }

  /**
   * Les sessions de la fenêtre, une par ligne.
   *
   * ## Pourquoi le périmètre ne porte pas de type
   *
   * Parce que la règle en lit **deux** — celui qui ouvre une présence et celui
   * qui la ferme — et que `EventScope.type` n'en nomme qu'un. Restreindre à
   * l'un ou l'autre rendrait un journal dont toutes les présences seraient
   * ouvertes, ou dont aucune ne le serait : `activeMs` tomberait à zéro partout
   * sans que rien ne le signale. Et une session sans vue de page disparaîtrait
   * de la liste, ce qui ferait mentir le décompte.
   *
   * C'est ce qui distingue cette lecture de `summarize`, qui demande au Core de
   * filtrer parce qu'un seul type l'intéresse. Ici le sens naît de
   * l'**enchaînement** de plusieurs types, donc rien ne peut être écarté avant
   * que la règle ait vu passer la suite. Un Core qui aurait su filtrer « les
   * vues et les sorties » aurait su ce que ces mots veulent dire.
   *
   * ## Rien n'est recalculé ici
   *
   * `sessionId` arrive avec la ligne, écrit à l'ingestion. Ce service ne passe
   * aucun seuil au Core et n'en applique aucun ; les trente minutes n'existent
   * qu'à un seul endroit, `sessions/session-assigner`. Il ne lit pas la clé
   * visiteur — elle ne lui parvient pas —, ne refait aucune durée, et ne classe
   * aucun referrer lui-même.
   *
   * L'alias de visiteur non plus n'est pas fabriqué ici : il vient du Core,
   * tiré au hasard une fois par lecture. Ce service le transporte sans jamais
   * le comparer à un autre — compter des visiteurs distincts est le travail du
   * lecteur, à qui cet alias sert précisément à le rendre.
   *
   * ## Trois étages, et aucun n'additionne
   *
   * `sessionsOf` replie le journal en sessions ; `sourceOf` classe la provenance
   * de chacune ; cette méthode projette le tout en lignes. Le premier ne sait pas
   * ce qu'est une provenance, le deuxième ne sait pas lire un journal, le
   * troisième ne sait ni l'un ni l'autre — et plus personne ne fait de total.
   *
   * ## Ce qui n'est pas borné
   *
   * Le nombre de lignes. Une fenêtre large sur un projet bavard en rend
   * beaucoup, et c'est le sens même de « rendre le détail » — la fenêtre est le
   * garde-fou. `GET /analytics` est là pour la jauger avant de la demander : son
   * `sessions` dit exactement combien de lignes celle-ci rendra.
   */
  async sessions(
    projectId: string,
    { from, to }: AnalyticsWindowDto,
  ): Promise<SessionsPage> {
    const journal = await this.events.events({ projectId, from, to });
    const closedBefore = settledBefore(to);

    // Aucun adaptateur : une ligne du Core satisfait `ActivityEvent` telle
    // quelle. S'il en fallait un, ce serait le signe que la primitive rend
    // autre chose que ce que la règle demande.
    const sessions = sessionsOf(journal).map((session) => ({
      // `sessionId` s'arrête ici : il sert de clé de regroupement au repli, il
      // ne franchit pas le fil. Voir `SessionRow.visitorAlias`.
      visitorAlias: session.visitorAlias,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      activeMs: session.activeMs,
      pageViews: session.pageViews,
      presencesStillOpen: session.presencesStillOpen,
      // `?? null` plutôt que l'absence : un champ manquant et un champ nul se
      // lisent pareil en JSON côté client mais pas au typage, et une ligne dont
      // les champs apparaissent et disparaissent selon la donnée est une ligne
      // dont personne n'écrit le schéma correctement.
      entryPath: session.entry.path ?? null,
      exit: session.exit,
      // Le même `settledBefore(to)` que le résumé, sur la même fenêtre : les
      // deux lectures ne peuvent donc pas se contredire sur ce qui est clos.
      settled: session.endedAt < closedBefore,
      source: sourceOf(session),
    }));

    // L'ordre est celui du journal, donc chronologique sur l'ouverture — hérité
    // de l'ordre total garanti par `EventStore.events()`. Retrier ici rétablirait
    // une propriété qui n'a jamais été perdue, et masquerait un jour l'appelant
    // qui l'aurait perdue en chemin.
    return { from, to, sessions };
  }

  /**
   * D'où viennent les visiteurs, au grain demandé.
   *
   * ## Une route, et le grain est un paramètre
   *
   * La carte Locations a trois onglets et n'appelle qu'une route : c'est
   * `grain` qui choisit la colonne. Trois routes auraient rendu trois fois la
   * même requête sous trois noms, et le planisphère — qui voudra toujours le
   * grain pays, quel que soit l'onglet ouvert — en aurait demandé une
   * quatrième.
   *
   * ## Deux lectures, pas une
   *
   * Le classement et le **total** des visiteurs de la fenêtre partent
   * ensemble. Le total ne se déduit pas des lignes : leur somme dépasse le
   * compte réel dès qu'un visiteur a été vu depuis deux endroits, et elle est
   * de toute façon tronquée par `limit`. Le rendre est donc la seule façon
   * qu'une part affichée veuille dire quelque chose.
   *
   * Aucune ligne de session ne remonte : tout est compté par Postgres, comme
   * pour le résumé.
   */
  async locations(
    projectId: string,
    { from, to, grain, limit }: AnalyticsLocationsDto,
  ): Promise<LocationsPage> {
    const scope: EventScope = { projectId, from, to };

    const [{ rows, unresolved }, visitors] = await Promise.all([
      this.events.topSessionValues(scope, {
        column: GRAIN_COLUMNS[grain],
        limit,
      }),
      this.events.countVisitors(scope),
    ]);

    return { from, to, grain, rows, visitors, unresolved };
  }
}
