/**
 * La session — ce qu'on en lit, une fois qu'elle est donnée.
 *
 * **Rien n'est branché.** Ce fichier ne connaît ni `EventStore`, ni Nest, ni
 * HTTP : il prend un journal déjà lu et rend des sessions.
 *
 * ## Ce module ne découpe plus rien
 *
 * C'était le cas jusqu'à l'étape 25.5, et c'était l'erreur. Le découpage —
 * « même visiteur, moins de trente minutes d'écart » — est désormais fait à
 * **l'ingestion** par le Core, et persisté : chaque événement porte le
 * `sessionId` auquel il appartient (voir `sessions/session-assigner`).
 *
 * Ce qui change, et c'est tout le sujet : deux modules qui lisent le même
 * journal voient forcément les mêmes sessions, parce qu'ils lisent une colonne
 * au lieu de refaire un calcul chacun de leur côté. Le seuil ne peut plus
 * diverger entre deux appelants, ni entre deux appels du même appelant.
 *
 * Corollaire direct : la clé visiteur n'arrive toujours pas jusqu'ici. Elle vit
 * sur la table `sessions`, elle sert au Core à rattacher un événement entrant,
 * et elle s'arrête là.
 *
 * Ce qui arrive à sa place est un **alias** — un jeton opaque, retiré à chaque
 * lecture, qui dit seulement « ces lignes sont du même visiteur, dans cette
 * réponse ». Ce module le transporte sans jamais raisonner dessus : il ne
 * découpe pas par visiteur, ne compte pas de visiteurs, ne compare pas deux
 * alias. `sessionId` reste la seule clé avec laquelle il travaille.
 *
 * ## Une session est une visite
 *
 * Il n'y a plus deux étages. La distinction présence / visite tenait tant que le
 * découpage était fait ici sur un fait observable (`page_leave`) et que le
 * regroupement par inactivité venait par-dessus. Maintenant que la convention
 * des trente minutes *est* le découpage, une session **est** le parcours : elle
 * survit à un changement d'onglet, à une pause café courte, à un retour depuis
 * un autre site.
 *
 * ## Ce qui reste de la présence
 *
 * Le fait observable ne disparaît pas pour autant, il devient une mesure *à
 * l'intérieur* de la session :
 *
 * > Une **présence** s'ouvre sur un `page_view` si aucune n'est ouverte, et se
 * > ferme sur le `page_leave` suivant.
 *
 * Une session contient donc une ou plusieurs présences, séparées par les
 * moments où l'onglet était en arrière-plan. C'est cette somme qui donne
 * `activeMs` — le temps **mesuré** — là où `durationMs` donne l'étendue de la
 * session, temps mort compris. Les deux sont utiles et ne disent pas la même
 * chose : une session de vingt minutes dont deux d'actives, c'est un onglet
 * oublié ; vingt minutes dont dix-huit, c'est une lecture.
 *
 * Les règles de l'automate n'ont pas bougé :
 *
 * - un `page_view` pendant une présence **n'en ouvre pas une seconde** : il
 *   compte une page de plus. Naviguer dans le site, c'est rester ;
 * - les autres types — clics, soumissions, événements métier — traversent la
 *   présence sans la délimiter ;
 * - un `page_leave` sans présence ouverte ne ferme rien ; un second à la suite
 *   non plus ;
 * - un `page_view` après un `page_leave` ouvre une nouvelle présence, **dans la
 *   même session**.
 *
 * ## Une présence ouverte n'a pas de durée
 *
 * Si le journal s'arrête avant le `page_leave`, la présence ne produit aucune
 * période et ne compte pour rien dans `activeMs`. On ne ferme pas à la borne de
 * la fenêtre : ce serait faire dépendre la mesure du **moment où on pose la
 * question**, et la même présence durerait plus longtemps si on l'interrogeait
 * plus tard. Le manque se compte — `presencesStillOpen` — au lieu d'être comblé.
 *
 * ## L'ordre est un prérequis, pas une supposition
 *
 * La règle lit une suite : elle exige le journal dans l'ordre où il s'est
 * produit. C'est exactement ce que `EventStore.events()` garantit — `occurred_at`
 * puis `id`, un ordre total. Rien n'est retrié ici : retrier masquerait un
 * appelant qui aurait perdu l'ordre en chemin, et c'est le genre de bogue qu'on
 * veut voir.
 */

/** Ouvre une présence, ou compte une page de plus dans celle qui court. */
export const VIEW_TYPE = 'page_view';

/** Ferme la présence en cours, s'il y en a une. */
export const LEAVE_TYPE = 'page_leave';

/**
 * Un départ vers un autre site.
 *
 * Il ne délimite aucune présence et ne compte aucune page : ce qu'il apporte,
 * c'est **la seule sortie observable**. Sans lui, une session qui s'éteint
 * après un clic vers Stripe et une session qui s'éteint sur place se
 * ressemblent exactement.
 */
export const OUTBOUND_TYPE = 'outbound_click';

/**
 * La clé où le SDK range le chemin de la page vue.
 *
 * Le Core ne sait pas qu'elle existe ; c'est ici que le vocabulaire du SDK entre
 * dans l'interprétation. Nommer cette clé est le prix à payer pour que
 * `Session` sache par quelle page elle a commencé.
 */
const PATH_ATTRIBUTE = 'page.path';

/** La provenance, telle que le navigateur la donne au chargement du document. */
const REFERRER_ATTRIBUTE = 'page.referrer';

/**
 * L'origine visée par un clic sortant, telle que le SDK la range.
 *
 * L'**origine** et pas l'URL complète : c'est le SDK qui a déjà fait ce choix
 * (voir `outbound-click.ts`), et pour la bonne raison — « vers quels sites
 * partent nos visiteurs » se lit par un regroupement, pas par un parsing d'URL
 * à chaque lecture. L'URL entière reste dans `element.href` pour qui la veut.
 */
const LINK_ORIGIN_PROPERTY = 'link.origin';

/**
 * L'URL complète de la page vue.
 *
 * Elle est là pour une seule raison, et il faut la nommer : c'est le seul moyen
 * de reconnaître **notre propre origine**. Sans elle, un referrer pointant sur
 * nous — rechargement, ancre, session attrapée après un changement de
 * document — serait indiscernable d'une recommandation venue d'un autre site.
 *
 * `path` ne peut pas jouer ce rôle : il ne porte pas l'hôte. Ce module ne fait
 * toujours que recopier un fait ; c'est `entry-source.ts` qui décide ce que la
 * comparaison des deux origines veut dire.
 */
const URL_ATTRIBUTE = 'page.url';

/**
 * Ce qu'un événement doit porter pour que la règle s'applique.
 *
 * `sessionId` a remplacé la clé visiteur, et ce n'est pas un renommage : c'est
 * le découpage qui a changé de camp. Ce module ne reçoit plus de quoi *décider*
 * à quelle session un événement appartient, il reçoit la réponse. Impossible
 * d'y réintroduire un seuil par distraction — il n'y a plus rien sur quoi
 * l'appliquer.
 *
 * `attributes` n'est lu qu'**une fois par session** — sur le `page_view` qui
 * l'ouvre, pour en tirer `entry` — et jamais pour décider quoi que ce soit du
 * découpage des présences. Le type dit ce que l'événement fait à la présence,
 * l'instant dit quand, la session dit où.
 *
 * `properties` est là, et il ne l'a pas toujours été. Il est resté **absent**
 * tant que rien n'avait à y être lu, et c'était plus fort qu'une note disant
 * qu'on n'y touchait pas. Il est entré pour **une seule clé** — `link.origin`,
 * l'origine d'un clic sortant — parce qu'une sortie ne se lit nulle part
 * ailleurs.
 *
 * ⚠️ Ce qui reste interdit n'a pas changé d'un pouce, et le sac déclaré ne
 * l'autorise pas : `leave.reason` et `navigation.from` **n'ont toujours pas le
 * droit d'influer sur le découpage**. Une perte de présence la ferme quelle
 * qu'en soit la cause, et la provenance ne se déduit pas de la page précédente.
 * La règle est maintenant tenue par la lecture — une seule clé, dans une seule
 * branche, sur un type qui ne touche ni aux présences ni aux compteurs — et
 * plus par l'absence du champ. C'est un cran plus faible : si une deuxième clé
 * apparaît ici un jour, c'est le moment de se demander pourquoi.
 *
 * Une ligne rendue par `EventStore.events()` satisfait cette forme telle quelle,
 * elle en porte simplement davantage.
 */
/**
 * La campagne d'une visite, telle que le Core la rend.
 *
 * Redéclarée ici plutôt qu'importée, comme `ActivityEvent` l'est de `EventRow` :
 * ce fichier ne connaît ni le Core, ni Nest, ni HTTP, et c'est ce qui le rend
 * testable sans rien brancher.
 */
export interface SessionCampaign {
  source: string | null;
  medium: string | null;
  name: string | null;
}

export interface ActivityEvent {
  type: string;
  sessionId: string;
  /** Figée à l'ouverture de la session : identique sur tous ses événements. */
  campaign: SessionCampaign | null;
  /**
   * Le début **réel** de la session, tel que le Core le porte en colonne.
   *
   * Il est identique sur tous les événements d'une même session, et il peut être
   * antérieur au premier d'entre eux : c'est exactement ce qui arrive quand la
   * fenêtre coupe le début. Le recopier ici plutôt que de le déduire est ce qui
   * évite qu'un bord de fenêtre passe pour une ouverture de session.
   */
  sessionStartedAt: Date;
  /**
   * Le visiteur, sous la forme que le Core rend — valable dans cette lecture
   * seule.
   *
   * Ce module ne sait pas ce qu'elle aliase, et c'est le point : il transporte
   * un jeton opaque, exactement comme il transporte un `sessionId`. La clé
   * visiteur, elle, ne lui parvient toujours pas.
   */
  visitorAlias: string;
  occurredAt: Date;
  attributes: Record<string, unknown>;
  /** Lu pour `link.origin`, et pour rien d'autre — voir l'en-tête ci-dessus. */
  properties: Record<string, unknown>;
}

/**
 * Une période de présence active, du `page_view` qui l'ouvre au `page_leave` qui
 * la ferme.
 *
 * Seules les périodes **fermées** existent : une présence dont on n'a pas vu la
 * fin ne produit rien. C'est la même règle que partout ailleurs dans la chaîne —
 * on ne comble pas, on compte ce qui manque.
 */
export interface ActivePeriod {
  /** Instant du `page_view` d'ouverture. */
  start: Date;
  /** Instant du `page_leave` de fermeture. */
  end: Date;
  /** `end - start`. Toujours positif ou nul, le journal étant ordonné. */
  activeMs: number;
}

/**
 * Par quelle page la session a commencé.
 *
 * Un **fait recopié**, pas une conclusion. `referrer` est l'URL brute que le
 * navigateur a donnée ; savoir qu'elle désigne un moteur de recherche, un autre
 * site ou nous-mêmes est le travail de `entry-source.ts`, et il n'a rien à faire
 * ici. Ce module transporte, il ne classe pas.
 *
 * Les deux clés sont **omises quand la valeur est absente ou vide**, comme
 * partout ailleurs dans la chaîne : une chaîne vide n'est pas une information,
 * et forcer un `null` obligerait chaque lecteur en aval à distinguer deux cas
 * qui n'en font qu'un. `entry` lui-même est toujours là, mais il peut être vide
 * — une session peut commencer sur un clic si le `page_view` qui la précède est
 * tombé hors fenêtre.
 */
export interface SessionEntry {
  /** `page.path` du `page_view` d'ouverture. */
  path?: string;
  /** `page.referrer` du même événement. Absent si le navigateur n'en donne pas. */
  referrer?: string;
  /**
   * `page.url` du même événement — l'URL complète, hôte compris.
   *
   * Recopiée pour que l'aval puisse comparer l'origine du referrer à la nôtre.
   * Elle ne dit rien de plus que `path` sur *quelle* page a été vue ; ce qu'elle
   * ajoute, c'est **où le site vit**, et c'est une information qu'aucun autre
   * champ ne porte.
   */
  url?: string;
}

/**
 * Par où une session s'est terminée.
 *
 * ## Deux champs, et ils ne s'excluent pas
 *
 * `path` est la dernière page vue ; `outbound` le dernier site vers lequel on a
 * cliqué. Une session peut avoir les deux — on lit `/panier`, on clique vers
 * Stripe — et c'est même le cas intéressant : le couple dit « parti de cette
 * page-là, vers ce site-là ».
 *
 * ## Ce que `outbound` à `null` ne dit pas
 *
 * Il ne dit **pas** que le visiteur est resté. Il dit qu'on n'a pas vu de clic
 * sortant : fermer l'onglet, taper une autre adresse, suivre un lien qu'on ne
 * capte pas — tout ça ressemble à la même chose depuis ici. C'est pour ça que
 * la lecture parle de « session terminée sur le site » et pas de « visiteur
 * resté ».
 *
 * ## Pourquoi le dernier clic sortant et pas le premier
 *
 * Parce qu'un visiteur peut revenir. Ouvrir GitHub dans un onglet, revenir
 * lire deux pages, puis partir vers Stripe : la sortie, c'est Stripe. Le
 * premier clic dirait le contraire, et il le dirait d'autant plus souvent que
 * la visite est longue.
 */
export interface SessionExit {
  /** Le chemin de la dernière `page_view` vue. `null` s'il n'y en a aucune. */
  path: string | null;
  /** L'origine du dernier clic sortant. `null` si on n'en a pas vu. */
  outbound: string | null;
}

export interface Session {
  /** L'identifiant attribué à l'ingestion. La clé de regroupement du repli. */
  sessionId: string;
  /**
   * Le visiteur, recopié depuis le premier événement de la session.
   *
   * Pris sans vérification : une session est portée par le couple projet ×
   * visiteur — voir `sessions/session-assigner` — donc tous ses événements
   * portent le même alias par construction. Le contrôler ici testerait le Core
   * depuis l'aval.
   *
   * Deux sessions peuvent le partager : la même personne revenue après plus de
   * trente minutes en ouvre une seconde, avec la même clé tant qu'on est dans
   * la journée. C'est exactement ce qui rend cet alias utile — sans lui, deux
   * lignes seraient deux visiteurs.
   */
  visitorAlias: string;
  /**
   * La campagne qui a amené la visite, quand il y en a une.
   *
   * Recopiée du premier événement vu, comme `startedAt` et pour la même raison :
   * le Core la fige à l'ouverture de la session, donc tous ses événements la
   * portent identique.
   *
   * `null` est le cas ordinaire — la plupart des visites n'arrivent par aucune
   * campagne. C'est au lecteur de regrouper : un classement par campagne se fait
   * sur ces lignes, sans route supplémentaire, comme les sources et les pages
   * d'entrée.
   */
  campaign: SessionCampaign | null;
  /**
   * Le début **réel** de la session — le premier de ses événements, y compris
   * hors fenêtre.
   *
   * Il vient de la colonne, pas du journal lu : une session commencée à 09:00 et
   * lue sur `[09:30, 10:00)` porte bien 09:00 ici. C'est ce qui permet à
   * l'appelant de reconnaître une session que sa fenêtre a tronquée — il compare
   * à sa propre borne basse — au lieu de confondre un bord de fenêtre avec une
   * ouverture.
   */
  startedAt: Date;
  /**
   * Instant du **dernier événement visible** de la session, quel que soit son
   * type.
   *
   * Symétrique de `startedAt` ? Non, et c'est délibéré. Le début est une valeur
   * persistée, la fin est une observation : le Core ne stocke pas de
   * `ended_at`, parce qu'une session n'a pas de fin tant qu'un événement peut
   * encore lui arriver. On rend donc ce qu'on a vu, et jamais `to`.
   */
  endedAt: Date;
  /**
   * `endedAt - startedAt` : l'étendue de la session, temps mort compris.
   *
   * Vaut zéro pour une session d'un seul événement — ce qui est le cas normal
   * d'un `page_view` dont le `page_leave` n'est jamais arrivé, et non une
   * anomalie.
   *
   * Sur une session tronquée par le bas, il **couvre du temps qu'on n'a pas
   * observé** : de 09:00 à 09:50 alors que la fenêtre commence à 09:30. Ce n'est
   * pas une extrapolation — la session a réellement duré ça — mais c'est ce qui
   * rend ce total non additif entre fenêtres, et le README le dit.
   */
  durationMs: number;
  /**
   * Somme des présences **fermées**.
   *
   * Toujours inférieure ou égale à `durationMs` : ce qui les sépare, c'est le
   * temps où l'onglet n'était pas au premier plan, plus les présences dont on
   * n'a pas vu la fin.
   */
  activeMs: number;
  /** Vues de page de la session, celle qui l'a ouverte comprise. */
  pageViews: number;
  /**
   * La page qui a ouvert la session, et d'où venait le visiteur.
   *
   * Figée au premier `page_view` : les suivants comptent une page de plus mais
   * ne la remplacent pas — y compris ceux qui rouvrent une présence après un
   * retour d'arrière-plan. C'est ce qui la rend utilisable : la page d'entrée
   * d'une session est celle par laquelle on est entré, pas la dernière vue.
   */
  entry: SessionEntry;
  /**
   * Par où la session s'est terminée — le miroir d'`entry`.
   *
   * `entry` prend la **première** vue et n'en démord pas ; celui-ci prend la
   * **dernière**, et se laisse remplacer jusqu'au bout du journal. Les deux
   * répondent à deux questions différentes : par où on entre, et par où on
   * s'en va.
   *
   * ⚠️ Sur une session encore en cours, « la dernière » veut dire « la dernière
   * qu'on ait vue » — pas la dernière qu'il y aura. C'est le même avertissement
   * que pour `endedAt`, et l'appelant le lève de la même façon : en regardant
   * si la session est close.
   */
  exit: SessionExit;
  /** Les périodes de présence fermées, dans l'ordre où elles se sont ouvertes. */
  presences: ActivePeriod[];
  /**
   * Présences ouvertes dont le `page_leave` n'est jamais arrivé.
   *
   * Au plus une par session en pratique — une présence ouverte empêche d'en
   * ouvrir une autre, et seule la dernière peut rester béante à la fin du
   * journal. Le compteur dit de combien `activeMs` sous-estime.
   */
  presencesStillOpen: number;
}

/**
 * Lit une chaîne non vide, ou rien.
 *
 * Jumeau de celui d'`entry-source.ts`. Les deux sont volontairement laissés
 * séparés pour l'instant : à l'étape suivante, l'attribution lira `entry` plutôt
 * que les sacs bruts, et il est probable que l'un des deux disparaisse. Les
 * factoriser maintenant créerait un module partagé pour trois lignes qui n'ont
 * peut-être plus qu'un seul appelant demain.
 */
function readString(
  bag: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = bag[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Recopie du `page_view` d'ouverture ce dont l'aval aura besoin. */
function entryOf(event: ActivityEvent): SessionEntry {
  const entry: SessionEntry = {};

  const path = readString(event.attributes, PATH_ATTRIBUTE);
  if (path !== undefined) entry.path = path;

  const referrer = readString(event.attributes, REFERRER_ATTRIBUTE);
  if (referrer !== undefined) entry.referrer = referrer;

  const url = readString(event.attributes, URL_ATTRIBUTE);
  if (url !== undefined) entry.url = url;

  return entry;
}

/**
 * L'état de l'automate pendant qu'on parcourt une session.
 *
 * Deux choses seulement : la présence ouverte, et si l'entrée a déjà été prise.
 * Les tenir à part de la `Session` évite qu'elles n'apparaissent dans ce qui
 * sort — ce sont des rouages du parcours, pas des faits sur la session.
 */
interface Progress {
  session: Session;
  openedAt: Date | null;
  entryTaken: boolean;
}

/**
 * Le journal, replié sur les sessions que le Core a déjà découpées.
 *
 * C'est la **seule** chose que ce module fait, depuis l'étape 27. Il repliait
 * aussi le résultat en totaux ; ces totaux vivent maintenant dans
 * `session-metrics.ts`, et il n'y a donc plus qu'un endroit au monde qui sait
 * additionner des sessions. Deux façons de répondre à la même question
 * finissent toujours par diverger.
 *
 * ## L'ordre
 *
 * Les sessions sortent dans l'ordre où elles **apparaissent dans le journal**,
 * pas dans l'ordre de leurs `startedAt`. La nuance ne se voit que sur les
 * sessions tronquées par le bas : deux d'entre elles peuvent avoir commencé
 * avant la fenêtre dans un ordre, et s'y montrer dans l'autre.
 *
 * C'est l'ordre honnête — celui de ce qu'on a lu — et il est totalement
 * déterministe puisque `EventStore.events()` l'est. Retrier sur `startedAt`
 * classerait sur une valeur dont une partie n'a pas été observée.
 *
 * Un seul passage. La `Map` fait deux choses à la fois : elle regroupe par
 * session, et son ordre d'insertion **est** l'ordre chronologique d'ouverture,
 * puisque le journal est ordonné et qu'une session apparaît au premier événement
 * qui la mentionne. Aucun tri.
 *
 * Les « cas limites » qu'on croirait devoir traiter à part n'existent pas — ils
 * sont l'état neutre de la table :
 *
 * - deux `page_view` de suite : le second trouve une présence ouverte et compte
 *   une page ;
 * - deux `page_leave` de suite : le second ne trouve rien à fermer ;
 * - un `page_leave` en tête de session : idem, il n'y a rien ;
 * - une session sans aucun `page_view` — une salve de clics dont la vue est
 *   tombée hors fenêtre : elle sort avec `entry` vide et `activeMs` à zéro,
 *   parce que c'est exactement ce qu'on en sait.
 */
export function sessionsOf(events: readonly ActivityEvent[]): Session[] {
  const progress = new Map<string, Progress>();

  for (const event of events) {
    let current = progress.get(event.sessionId);

    if (current === undefined) {
      current = {
        session: {
          sessionId: event.sessionId,
          // Même raison que `startedAt` juste en dessous : identique sur tous
          // les événements de la session, donc le premier vu fait foi.
          visitorAlias: event.visitorAlias,
          // Figée à l'ouverture par le Core : identique sur tous les événements
          // de la session, donc le premier vu fait foi.
          campaign: event.campaign,
          // Lu, pas déduit : c'est la colonne du Core, identique sur tous les
          // événements de la session. La prendre sur le premier vu suffit donc,
          // et prendre un minimum reviendrait à se protéger d'une incohérence
          // que la base rend impossible.
          startedAt: event.sessionStartedAt,
          // `endedAt` et `durationMs` sont posés à vide : le tronc commun,
          // juste en dessous, les calcule pour *cet* événement comme pour tous
          // les suivants. Les initialiser vraiment ici dupliquerait ce calcul,
          // et la copie pourrait diverger de l'original sans que rien ne le dise.
          endedAt: event.occurredAt,
          durationMs: 0,
          activeMs: 0,
          pageViews: 0,
          entry: {},
          exit: { path: null, outbound: null },
          presences: [],
          presencesStillOpen: 0,
        },
        openedAt: null,
        entryTaken: false,
      };
      progress.set(event.sessionId, current);
    }

    const { session } = current;

    // Tout événement recule la borne de fin, y compris ceux qui ne délimitent
    // aucune présence : l'étendue de la session est celle de son journal.
    session.endedAt = event.occurredAt;
    session.durationMs =
      session.endedAt.getTime() - session.startedAt.getTime();

    // Un clic sortant : il ne compte aucune page et ne délimite aucune
    // présence — il ne fait que déplacer la sortie. Testé avant les autres
    // parce qu'il sort ensuite du parcours sans rien perturber.
    if (event.type === OUTBOUND_TYPE) {
      const origin = readString(event.properties, LINK_ORIGIN_PROPERTY);

      // `??` et pas une affectation nue : un clic sortant dont l'origine est
      // illisible ne doit pas **effacer** celle du clic d'avant. Une sortie
      // connue vaut mieux qu'une sortie perdue en route.
      if (origin !== undefined) session.exit.outbound = origin;

      continue;
    }

    if (event.type === VIEW_TYPE) {
      session.pageViews += 1;

      // La dernière vue gagne, contrairement à l'entrée où la première gagne.
      // Pas de drapeau ici : c'est l'écrasement répété qui *est* la règle.
      session.exit.path =
        readString(event.attributes, PATH_ATTRIBUTE) ?? session.exit.path;

      if (!current.entryTaken) {
        // Le premier `page_view` de la session, et lui seul, décide de
        // l'entrée. Le drapeau plutôt qu'un test sur `entry` : une entrée
        // légitimement vide — pas de `page.path` — ne doit pas laisser le
        // `page_view` suivant prendre sa place.
        session.entry = entryOf(event);
        current.entryTaken = true;
      }

      // Navigation interne : la présence court déjà, on ne la rouvre pas.
      if (current.openedAt === null) current.openedAt = event.occurredAt;

      continue;
    }

    // Un clic, une soumission, un événement métier : il arrive *pendant* la
    // présence, il ne la délimite pas. Un `page_leave` sans présence ouverte
    // non plus, faute d'avoir quoi que ce soit à fermer.
    if (event.type !== LEAVE_TYPE || current.openedAt === null) continue;

    const activeMs = event.occurredAt.getTime() - current.openedAt.getTime();
    session.presences.push({
      start: current.openedAt,
      end: event.occurredAt,
      activeMs,
    });
    session.activeMs += activeMs;
    current.openedAt = null;
  }

  return [...progress.values()].map(({ session, openedAt }) => {
    // Compté à la fin, une fois le journal épuisé : avant, une présence
    // « ouverte » n'est que le déroulé normal, et le seul moment où l'absence de
    // fermeture devient un fait, c'est quand il n'y a plus rien à lire.
    if (openedAt !== null) session.presencesStillOpen = 1;

    return session;
  });
}
