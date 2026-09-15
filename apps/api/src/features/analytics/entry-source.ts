import type { Session } from './sessions';

/**
 * D'où vient une session — la règle, isolée et éprouvable.
 *
 * **Rien n'est branché.** Ce fichier ne connaît ni `EventStore`, ni Nest, ni
 * HTTP : il prend une session déjà repliée et rend sa provenance.
 *
 * ## La règle
 *
 * > La source d'une session est le **`page.referrer` du premier `page_view` de
 * > cette session** — donc `Session.entry.referrer`, et rien d'autre.
 *
 * `page.referrer` est `document.referrer` : l'URL exacte de la page d'où vient
 * le visiteur, telle que le navigateur la donne. C'est *la* provenance, et rien
 * d'autre dans le flux ne la porte.
 *
 * ## Une session, une provenance
 *
 * C'est le niveau qui évite les deux erreurs symétriques.
 *
 * Par **visiteur**, un visiteur venu par Google le matin puis en direct le soir
 * ne compterait qu'une fois, par Google — c'est ce que faisait ce module avant
 * l'étape 26, et c'était le blocage.
 *
 * Par **événement**, une visite de trois pages dirait « trois arrivées de
 * Google », parce que le referrer est figé au chargement du document et voyage
 * avec chaque événement. L'erreur serait exactement proportionnelle à la
 * profondeur des visites — invisible, et d'autant plus grosse que le site est
 * bon.
 *
 *     session A
 *       page_view  /pricing    referrer = google
 *       page_view  /checkout   referrer = google
 *       page_leave
 *
 * → **une** visite venue de Google.
 *
 * ## Ce module ne lit pas d'événements
 *
 * Il reçoit une `Session`, dont l'`entry` a déjà été extraite par `sessions.ts`.
 * Deux conséquences voulues :
 *
 * - la clé visiteur ne l'atteint pas, et il ne peut donc pas raisonner sur des
 *   personnes même par accident ;
 * - `properties` non plus, donc `navigation.from` est structurellement hors de
 *   portée. Il servait à dire « on a attrapé la visite en cours de route » ; ce
 *   n'était pas une provenance, et le rôle a disparu avec l'étage visiteur.
 *
 * ## Ce module classe, il ne compte pas
 *
 * Il a rendu une répartition jusqu'à l'étape 33 — un tableau de sources avec
 * leurs comptes, et la ventilation de ce qu'il n'avait pas su attribuer. Cette
 * moitié est partie chez le lecteur : regrouper des lignes déjà classées est de
 * la présentation, et l'API rend désormais une provenance par session plutôt
 * qu'un total par provenance.
 *
 * Ce qui reste ici est ce qui ne peut pas partir : décider que `google.com` est
 * un moteur de recherche est une interprétation métier, pas un regroupement.
 *
 * ## Ce que la règle ne peut pas savoir, et qu'elle ne prétend pas savoir
 *
 * - Une session ne peut pas traverser minuit UTC : la clé visiteur tourne, le
 *   Core en ouvre une neuve, et elle est classée à nouveau. L'attribution est
 *   donc quotidienne au mieux — c'est une conséquence de la vie privée, pas une
 *   limite technique.
 * - `page.referrer` est absent dès que le navigateur ne le donne pas (entrée
 *   directe, mais aussi `Referrer-Policy` restrictive, HTTPS → HTTP, certaines
 *   apps natives). `direct` veut donc dire « aucune provenance connue », pas
 *   « quelqu'un a tapé l'URL ».
 * - Une session dont la fenêtre ne montre pas le début est classée sur ce
 *   qu'elle montre. Voir `sourceOf` : c'est le cas limite qui mérite d'être lu
 *   en entier.
 */

/**
 * Les moteurs de recherche, par **label d'hôte** et non par domaine complet.
 *
 * Un moteur vit sur des dizaines de domaines (`google.com`, `google.fr`,
 * `www.google.co.uk`) : lister les domaines demanderait de suivre les ccTLD,
 * lister les labels demande une ligne. `news.google.com` tombe donc dans
 * `google`, ce qui est le comportement voulu — la question posée est « quel
 * moteur », pas « quelle page du moteur ».
 *
 * C'est une heuristique, et elle a un mode d'échec assumé :
 * `blog.google.exemple.test` serait classé « google ». Le jour où ça coûte
 * quelque chose, cette constante devient une table — sans qu'une ligne du Core
 * bouge.
 *
 * Les assistants n'y sont **pas** : ils ont leur propre ensemble juste en
 * dessous. C'est le `kind` de plus que ce commentaire annonçait, et il est
 * arrivé le jour où la planche a demandé de lire « ChatGPT » à côté de
 * « Google » sans les confondre.
 */
const SEARCH_ENGINES = new Set([
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'yandex',
  'baidu',
  'ecosia',
  'qwant',
  'startpage',
  'brave',
  'naver',
  'seznam',
]);

/**
 * Les assistants, par **label d'hôte** comme les moteurs.
 *
 * Ils méritent leur nature parce qu'ils ne répondent pas à la même question :
 * un moteur envoie vers une page, un assistant a **déjà répondu** et n'envoie
 * qu'accessoirement. Les fondre dans `search` ferait lire « la recherche
 * m'apporte X visites » en y comptant du trafic qui n'a rien à voir ; les
 * laisser dans `referral` les noierait parmi les sites.
 *
 * `copilot` n'y est pas : Copilot répond sur `bing.com` et `copilot.microsoft.com`
 * selon le chemin, et trancher demanderait de lire l'URL complète. Le jour où
 * ça compte, c'est une ligne ici — pas une exception ailleurs.
 */
const ASSISTANTS = new Set([
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'copilot',
  'mistral',
]);

/**
 * Les cinq natures de provenance.
 *
 * `internal` n'est pas de l'acquisition : c'est un referrer qui pointe sur nous
 * — rechargement, navigation vers une ancre, ou session dont la fenêtre a coupé
 * le début. Il est **rendu** plutôt qu'écarté, parce qu'un chiffre jeté en
 * silence est un chiffre que personne ne sait manquant : sa part dit à quel
 * point la lecture est polluée. L'acquisition, c'est
 * `direct + search + assistant + referral`.
 */
export type SourceKind =
  'direct' | 'search' | 'assistant' | 'referral' | 'internal';

/**
 * Ce qu'on sait d'une provenance nommée : comment elle s'écrit, et quel domaine
 * porte son icône.
 *
 * ## Pourquoi le libellé vient du serveur
 *
 * Parce que la casse d'un nom propre est une **connaissance métier**, pas de la
 * mise en forme : `duckduckgo` ne se capitalise pas comme `google`, et
 * `chatgpt` encore moins. Une table côté client aurait été une seconde
 * définition de ce qu'est une source, qui aurait divergé de celle-ci au premier
 * moteur ajouté — c'est exactement ce que le dashboard refusait de faire, et il
 * avait raison.
 *
 * ## Pourquoi le domaine vient d'ici aussi, et de la même table
 *
 * Même raison, plus une qui lui est propre : `name` est un **label d'hôte**
 * (`google`), pas un nom d'hôte. Le dashboard demande l'icône d'une provenance
 * à `/v1/favicons/:host`, qui exige un hôte complet et refuse `google` — le
 * compléter côté client aurait remis là-bas la liste des moteurs qui vit ici.
 *
 * Les deux colonnes tiennent dans **une** table exprès : ce sont deux façons
 * d'écrire le même fait. Séparées, un moteur ajouté à l'une seulement serait un
 * libellé sans icône, ou l'inverse — et rien ne l'aurait dit.
 *
 * ## Le domaine est celui de la marque, pas celui d'où vient le clic
 *
 * `brave` rend `brave.com` et non `search.brave.com`, `gemini` rend
 * `gemini.google.com` parce que Google n'a pas d'autre porte pour lui. Ce qu'on
 * cherche est l'icône que le lecteur reconnaît, pas l'URL exacte du referrer —
 * celle-ci a déjà été réduite à un label deux lignes plus haut.
 *
 * Ce qui ne figure pas dans la table prend son `name` tel quel, pour les deux
 * colonnes : un hôte s'écrit déjà comme il se lit, et il est déjà son domaine.
 */
const KNOWN: Record<string, { label: string; host: string }> = {
  google: { label: 'Google', host: 'google.com' },
  bing: { label: 'Bing', host: 'bing.com' },
  duckduckgo: { label: 'DuckDuckGo', host: 'duckduckgo.com' },
  yahoo: { label: 'Yahoo', host: 'yahoo.com' },
  yandex: { label: 'Yandex', host: 'yandex.com' },
  baidu: { label: 'Baidu', host: 'baidu.com' },
  ecosia: { label: 'Ecosia', host: 'ecosia.org' },
  qwant: { label: 'Qwant', host: 'qwant.com' },
  startpage: { label: 'Startpage', host: 'startpage.com' },
  brave: { label: 'Brave', host: 'brave.com' },
  naver: { label: 'Naver', host: 'naver.com' },
  seznam: { label: 'Seznam', host: 'seznam.cz' },
  chatgpt: { label: 'ChatGPT', host: 'chatgpt.com' },
  claude: { label: 'Claude', host: 'claude.ai' },
  perplexity: { label: 'Perplexity', host: 'perplexity.ai' },
  gemini: { label: 'Gemini', host: 'gemini.google.com' },
  copilot: { label: 'Copilot', host: 'copilot.microsoft.com' },
  mistral: { label: 'Mistral', host: 'mistral.ai' },
};

/** Ce qu'on écrit quand il n'y a pas de nom à écrire. */
const KIND_LABELS: Record<SourceKind, string> = {
  direct: 'Direct',
  search: 'Search',
  assistant: 'Assistant',
  referral: 'Referral',
  internal: 'Internal',
};

export interface Source {
  kind: SourceKind;
  /**
   * Le moteur (`google`) ou l'hôte (`blog.autre.test`), en minuscules et sans
   * `www.`. `null` pour `direct`, et pour un referrer qu'on n'a pas su lire.
   */
  name: string | null;
  /**
   * Le même fait, écrit pour un humain : `Google`, `ChatGPT`, `Direct`,
   * `news.ycombinator.com`.
   *
   * Toujours présent — un libellé absent obligerait chaque affichage à inventer
   * son repli, donc à réinventer cette table. Voir `KNOWN`.
   */
  label: string;
  /**
   * Le domaine qui porte l'**icône** de cette provenance, ou `null`.
   *
   * Ce n'est pas `name` : celui-ci est un label d'hôte pour un moteur ou un
   * assistant (`google`, `chatgpt`), et un label d'hôte n'est pas un nom
   * d'hôte. Pour un `referral` ou un `internal`, les deux coïncident — le nom
   * *est* déjà le domaine.
   *
   * `null` là où il n'y a rien à montrer : `direct` n'a pas de site, et un
   * referrer illisible n'en a pas donné. Ce n'est pas une icône manquante, c'est
   * une provenance sans site — l'affichage laisse la place vide plutôt que de
   * proposer un repli qui mentirait sur l'existence d'une source.
   */
  host: string | null;
}

/** Le libellé d'une provenance : son nom connu, son hôte, ou sa nature. */
function labelOf(kind: SourceKind, name: string | null): string {
  if (name === null) return KIND_LABELS[kind];

  return KNOWN[name]?.label ?? name;
}

/**
 * Le domaine d'une provenance : celui de la marque, ou son nom tel quel.
 *
 * Pas de repli sur la nature, contrairement à `labelOf` : `Direct` s'écrit,
 * mais ne s'illustre pas.
 */
function iconHostOf(name: string | null): string | null {
  if (name === null) return null;

  return KNOWN[name]?.host ?? name;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** L'hôte sous sa forme comparable : minuscules, sans `www.`. */
function hostOf(url: URL): string {
  const host = url.hostname.toLowerCase();

  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * La nature d'un referrer, relativement à la page où il a été observé.
 *
 * `pageUrl` sert à une seule chose : reconnaître notre propre origine. Sans
 * elle, un rechargement de `/pricing` ressemblerait à une recommandation venue
 * de `shop.test` — donc en son absence on ne devine pas, on classe en
 * `referral` et la ligne se voit.
 *
 * La comparaison porte sur l'**origine**, comme dans le SDK : un sous-domaine
 * est donc externe. Décider que `docs.shop.test` et `shop.test` sont le même
 * site demande de savoir quels hôtes appartiennent au projet — une
 * configuration, pas une donnée d'événement. Tant qu'elle n'existe pas, on
 * préfère une ligne `referral` visible à un rapprochement silencieux et faux.
 *
 * ## Deux portes, et elles n'ont pas le même garde-fou
 *
 * `sourceOf` prend une session repliée et refuse de classer celle dont aucune
 * page n'a été vue. C'est la porte de l'analytics, et ce refus est ce qui
 * empêche de gonfler `direct` d'un bruit qui n'a rien à voir avec
 * l'acquisition.
 *
 * Cette fonction-ci est l'autre porte, ouverte pour la lecture du revenu : elle
 * reçoit un referrer déjà isolé par le Core, sur une ligne qui **existe par
 * construction** — il a fallu un événement pour la produire. Le garde-fou de
 * `sourceOf` n'aurait rien à y garder, et l'exiger obligerait à fabriquer une
 * session de façade pour le satisfaire.
 *
 * La règle de classement, elle, reste écrite **une seule fois**. C'est tout ce
 * qui compte : deux classements qui divergeraient au premier moteur ajouté
 * seraient pires que deux portes.
 */
export function classifyReferrer(
  referrer: string | null,
  pageUrl: string | null,
): Source {
  // Un seul point de sortie : la nature et le nom se décident, le libellé s'en
  // déduit. Le construire à la main dans chaque branche laisserait tôt ou tard
  // une branche sans libellé, ou avec un libellé qui ment.
  const source = (kind: SourceKind, name: string | null): Source => ({
    kind,
    name,
    label: labelOf(kind, name),
    host: iconHostOf(name),
  });

  if (referrer === null) return source('direct', null);

  const from = parseUrl(referrer);
  // Quelque chose était là : ce n'est pas une entrée directe. Mais on ne sait
  // pas quoi, et inventer un nom serait pire que de ne pas en donner.
  if (from === null || from.hostname === '') return source('referral', null);

  const site = pageUrl === null ? null : parseUrl(pageUrl);
  if (site !== null && from.origin === site.origin) {
    return source('internal', hostOf(from));
  }

  const host = hostOf(from);
  const labels = host.split('.');

  // Les assistants avant les moteurs : `gemini.google.com` porte les deux
  // étiquettes, et c'est un assistant. L'ordre inverse le classerait « Google »
  // et rendrait la catégorie assistant vide là où elle est la plus utile.
  const assistant = labels.find((label) => ASSISTANTS.has(label));
  if (assistant !== undefined) return source('assistant', assistant);

  const engine = labels.find((label) => SEARCH_ENGINES.has(label));

  return engine === undefined
    ? source('referral', host)
    : source('search', engine);
}

/**
 * La provenance d'une session, ou `null` quand il n'y a rien à en dire.
 *
 * ## `null` n'est pas `direct`
 *
 * Une session dont aucun `page_view` n'apparaît dans la fenêtre rend `null`
 * plutôt que `direct` : « aucune provenance connue » et « aucune page vue » sont
 * deux choses différentes, et les confondre gonflerait `direct` d'un bruit qui
 * n'a rien à voir avec l'acquisition.
 *
 * Une session dont on a vu une page mais dont le `referrer` manque, elle, est
 * bien `direct` : là, on a vu la page, et le navigateur n'a simplement pas donné
 * de provenance. C'est une observation, pas un trou.
 *
 * ## Ce que le lecteur fait de `null`
 *
 * Il le qualifie, avec `startedAt` et sa propre borne basse — les deux sortent
 * avec la ligne, précisément pour ça :
 *
 *     source !== null                    → provenance connue
 *     source === null
 *       ├── startedAt < from             → tronquée par la fenêtre
 *       └── startedAt >= from            → réellement sans vue de page
 *
 * La distinction n'est pas cosmétique, et les deux causes appellent des
 * réactions opposées. Une session tronquée **a** une provenance, elle est
 * simplement hors cadre : élargir la lecture la récupère, rien à corriger sur le
 * site. Une session réellement sans vue de page signale une instrumentation
 * partielle — un SDK qui envoie des `click` sans `page_view` — et élargir n'y
 * changera rien.
 *
 * `startedAt < from` est **strict** : une session qui commence pile sur `from` a
 * été vue s'ouvrir, la fenêtre étant `[from, to)`. Même convention que partout
 * ailleurs dans la chaîne.
 *
 * ## Quand la fenêtre coupe le début de la session
 *
 * Le cas est réel et il mérite d'être écrit noir sur blanc, parce que la
 * réponse n'est pas « on gère », c'est « voilà exactement ce qui se passe ».
 *
 * Une session peut commencer avant `from` et n'exposer que sa fin. `sessions.ts`
 * ne voit alors que les événements de la fenêtre, donc `entry` vient du premier
 * `page_view` **visible**, qui n'est pas le vrai début. Trois cas, et aucun ne
 * produit de fausse acquisition :
 *
 * - **rien de visible avant la fin** — la fenêtre ne montre aucun `page_view` de
 *   la session : `entry` est vide, `pageViews` vaut zéro, la source est `null`.
 *   On ne la classe pas, mais le lecteur sait dire pourquoi : son `startedAt`
 *   est antérieur à `from` ;
 * - **site multi-pages** — chaque vue recharge le document, donc le referrer de
 *   la vue visible est *notre propre page précédente* : la session est classée
 *   `internal`, qui est précisément la catégorie « on n'a pas vu l'arrivée ».
 *   Elle est exclue de l'acquisition et sa part se lit ;
 * - **application monopage** — le document n'a pas été rechargé, donc
 *   `document.referrer` porte encore la vraie provenance externe :
 *   **la classification est juste**. C'est `entry.path` qui ne l'est pas — ce
 *   n'est pas une page d'atterrissage, c'est celle où la fenêtre nous a fait
 *   entrer.
 *
 * Le seul défaut résiduel est donc ce `path`, et le lecteur a de quoi le
 * repérer : `startedAt < from` le lui dit. Ce qu'on ne fait pas, c'est aller
 * chercher hors fenêtre le `page_view` manquant pour compléter la ligne. Ce
 * serait facile — le `sessionId` est là — et ce serait faux : le résultat d'une
 * lecture dépendrait alors d'événements que le cadrage a explicitement exclus,
 * et deux fenêtres différentes rendraient des provenances différentes pour des
 * raisons qu'aucune borne n'expliquerait.
 *
 * En pratique, la fenêtre doit être large devant les sessions — sur une journée,
 * seules celles qui chevauchent minuit sont concernées, et la rotation de la clé
 * visiteur en ouvre déjà une neuve à cet instant-là.
 */
export function sourceOf(session: Session): Source | null {
  // `pageViews` et non « `entry` est vide » : les deux coïncident presque
  // toujours, mais pas quand une vue de page arrive sans aucun attribut
  // exploitable. Celle-là a bien été vue, elle vaut `direct`, et la ranger parmi
  // les non-classables serait perdre une session pour rien.
  if (session.pageViews === 0) return null;

  return classifyReferrer(
    session.entry.referrer ?? null,
    session.entry.url ?? null,
  );
}
