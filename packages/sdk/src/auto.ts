/**
 * Le point d'entrée « balise `<script>` » — celui du snippet d'installation.
 *
 *     <script defer src="https://hub.example/v1/eh.js"
 *             data-api-key="eh_pk_…"></script>
 *
 * Une ligne, rien à écrire, rien à builder. C'est la forme que prennent tous
 * les outils de mesure, et elle n'est pas un raccourci pédagogique : elle
 * couvre les sites qui n'ont **pas** de bundler — WordPress, Webflow, Shopify,
 * un `index.html` — c'est-à-dire la majorité de ceux qu'on mesure. `index.ts`
 * reste la porte d'entrée des applications qui en ont un.
 *
 * ## Ce fichier n'ajoute aucune capacité
 *
 * Il ne fait que **lire une configuration là où elle est écrite** : sur la
 * balise elle-même. Tout ce qui suit est le même `Analytics` que celui d'un
 * `import`, avec les mêmes collecteurs — d'où l'absence totale de logique de
 * mesure ici. Le jour où le SDK apprend quelque chose, les deux entrées en
 * héritent sans que celle-ci bouge.
 *
 * ## L'endpoint se déduit du `src`
 *
 * C'est le seul vrai choix de ce fichier. Le script sait d'où il a été chargé ;
 * or il est servi **par le hub lui-même** (`GET /v1/eh.js`), donc l'adresse
 * d'ingestion est à côté de lui : `new URL('events', src)` rend
 * `https://hub.example/v1/events`. La résolution est relative, donc elle
 * emporte la version : un `/v2/eh.js` posterait sur `/v2/events` sans qu'une
 * ligne change.
 *
 * Ce qu'on évite ainsi est concret — un second attribut à recopier, qu'on
 * recopie mal, et qui produit une intégration silencieuse : le hub ne répond
 * rien à qui n'arrive pas.
 *
 * ## Les attributs
 *
 * | attribut         | rôle                                                     |
 * | ---------------- | -------------------------------------------------------- |
 * | `data-api-key`   | **requis** — la clé publique du projet (`eh_pk_…`)        |
 * | `data-endpoint`  | force l'adresse d'ingestion, au lieu de la déduire du src |
 * | `data-exclude`   | collecteurs facultatifs à couper, séparés par des virgules |
 * | `data-debug`     | journalise les échecs d'envoi dans la console             |
 */
import { Analytics, type CollectorOptions } from './index.ts';

/**
 * Les collecteurs qu'on a le droit de couper depuis la balise.
 *
 * Les deux écritures sont acceptées — `outbound_click` comme `outboundClick` —
 * parce que la première est le nom de l'événement reçu, et que c'est celui
 * qu'on a sous les yeux quand on décide de le couper.
 *
 * ## `page_view` et `page_leave` n'y sont pas
 *
 * Ce sont les deux seuls dont tout le reste dépend : sans `page_view`, une
 * session n'a ni page d'entrée, ni provenance, ni vue à compter ; sans
 * `page_leave`, aucune présence ne se ferme, donc le temps actif vaut zéro et
 * toutes les sessions paraissent encore ouvertes. Les couper ne réduit pas la
 * mesure, il l'annule.
 *
 * L'API programmatique les garde optionnels (`start({ pageView: false })`), et
 * ce n'est pas une incohérence : `envelope()` attache `page.path`, `page.url` et
 * `page.referrer` à **tout** événement, `track()` compris. Une application avec
 * bundler peut donc couper le collecteur et émettre son propre
 * `track('page_view')` — un routage maison, un framework où le monkey-patch de
 * l'History API ne convient pas.
 *
 * Cette porte-ci vise exactement les sites qui n'ont pas de bundler — WordPress,
 * Webflow, Shopify, un `index.html`. Ils n'ont aucun endroit où écrire ce
 * `track()`. Le seul effet possible de `data-exclude="page_view"` sur la balise
 * est donc un tableau de bord vide sous une installation qui a l'air correcte,
 * et c'est le mode de panne que ce fichier existe pour éviter.
 */
const COLLECTORS: Record<string, keyof CollectorOptions> = {
  click: 'click',
  submit: 'submit',
  outbound_click: 'outboundClick',
  outboundClick: 'outboundClick',
};

/**
 * Les noms qu'on reconnaît pour mieux les refuser.
 *
 * Sans eux, `data-exclude="page_view"` recevrait « n'est pas un collecteur » —
 * ce qui est faux, et envoie chercher une faute de frappe là où il y a un
 * malentendu. On nomme donc la raison.
 */
const SPINE: Record<string, true> = {
  page_view: true,
  pageView: true,
  page_leave: true,
  pageLeave: true,
};

declare global {
  interface Window {
    /**
     * L'instance démarrée par la balise, pour les événements métier.
     *
     *     window.eventsHub?.track('checkout_completed', { plan: 'pro' });
     *
     * Optionnelle dans le type, et ce n'est pas de la prudence gratuite : la
     * balise est en `defer`, donc du code inline qui s'exécute plus tôt ne la
     * trouvera pas.
     */
    eventsHub?: Analytics;
  }
}

/**
 * La balise qui nous a chargés.
 *
 * `document.currentScript` est la réponse exacte tant qu'on est dans un script
 * classique — ce que produit le build IIFE de cette entrée. Le repli couvre les
 * cas où il vaut `null` : injection par un gestionnaire de balises, ou quelqu'un
 * qui aurait ajouté `type="module"` de son côté.
 */
function hostScript(): HTMLScriptElement | null {
  const current = document.currentScript;

  if (current instanceof HTMLScriptElement) return current;

  return document.querySelector<HTMLScriptElement>('script[data-api-key]');
}

/**
 * Où poster : ce qui est déclaré, sinon le voisin du script.
 *
 * `script.src` est déjà absolu — le DOM le résout — donc `new URL` a toujours
 * une base valable, sauf sur une balise sans `src`. Ce cas rend `null` plutôt
 * que de lever : l'appelant en fait un message lisible.
 */
function endpointOf(script: HTMLScriptElement): string | null {
  const declared = script.dataset.endpoint;

  if (declared) return declared;
  if (!script.src) return null;

  return new URL('events', script.src).toString();
}

/**
 * Les collecteurs à ne pas démarrer.
 *
 * Un nom inconnu est **signalé**, pas ignoré : `data-exclude="clicks"` ne
 * couperait rien, et sans ce message la personne conclurait que l'attribut ne
 * marche pas — ou pire, croirait avoir coupé ce qui continue d'arriver.
 */
function collectorsOf(script: HTMLScriptElement): CollectorOptions {
  const options: CollectorOptions = {};

  for (const name of (script.dataset.exclude ?? '').split(',')) {
    const trimmed = name.trim();

    if (!trimmed) continue;

    if (SPINE[trimmed]) {
      console.warn(
        `[events-hub] data-exclude : « ${trimmed} » ne peut pas être coupé depuis la balise — toute la mesure en dépend. Il reste collecté.`,
      );

      continue;
    }

    const collector = COLLECTORS[trimmed];

    if (!collector) {
      console.warn(
        `[events-hub] data-exclude : « ${trimmed} » n'est pas un collecteur. Attendu : ${Object.keys(COLLECTORS).join(', ')}.`,
      );

      continue;
    }

    options[collector] = false;
  }

  return options;
}

/**
 * Démarre la mesure à partir de ce que porte la balise.
 *
 * Les deux refus possibles sont journalisés en `error`, et c'est le seul
 * endroit du SDK où on se permet d'écrire dans la console sans y être invité :
 * l'interlocuteur est un développeur en train d'installer, la page ne mesure
 * rien, et se taire ferait chercher la panne côté hub.
 */
function boot(): void {
  const script = hostScript();

  if (!script) {
    console.error(
      '[events-hub] Balise introuvable : impossible de lire la configuration. Ajoutez data-api-key sur la balise <script> qui charge ce fichier.',
    );

    return;
  }

  const apiKey = script.dataset.apiKey;

  if (!apiKey) {
    console.error(
      '[events-hub] Attribut data-api-key manquant sur la balise <script>. La clé publique du projet se trouve dans les réglages du hub.',
    );

    return;
  }

  const endpoint = endpointOf(script);

  if (!endpoint) {
    console.error(
      "[events-hub] Adresse d'ingestion indéterminable : la balise n'a pas de src. Ajoutez data-endpoint.",
    );

    return;
  }

  const debug = script.dataset.debug !== undefined;

  const analytics = new Analytics({
    apiKey,
    endpoint,
    // Muet par défaut, comme partout ailleurs : un hub injoignable ne doit pas
    // remplir la console d'un site qui n'y peut rien, à chaque interaction.
    // `data-debug` renverse ce choix le temps d'une installation.
    onError: debug
      ? (error) => {
          console.error('[events-hub]', error);
        }
      : undefined,
  });

  window.eventsHub = analytics;

  analytics.start(collectorsOf(script));

  if (debug) {
    console.info(`[events-hub] Démarré — envoi vers ${endpoint}.`);
  }
}

boot();
