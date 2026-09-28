# @events-hub/sdk

Client d'ingestion pour `POST /v1/events`, et collecteur des signaux du
navigateur.

## Deux façons de l'installer

### La balise, servie par le hub

C'est le chemin par défaut, et celui du snippet affiché à la création d'un
projet. Rien à installer, rien à builder :

```html
<script
  defer
  src="http://localhost:3003/v1/eh.js"
  data-api-key="eh_pk_2e95b1b62a96443a919f2b3661106689"
></script>
```

**L'adresse d'ingestion n'est pas dans la balise**, et c'est délibéré : le
script est servi par le hub (`GET /v1/eh.js`), donc il résout `events`
relativement à son propre `src` et trouve `/v1/events` tout seul. La résolution
étant relative, elle emporte la version — un `/v2/eh.js` posterait sur
`/v2/events`. Une valeur de moins à recopier, sur un chemin dont l'échec est
silencieux.

`defer` et non `async` : les collecteurs branchent des écouteurs sur le
document, qui doit donc être parcouru.

| attribut        | rôle                                                        |
| --------------- | ----------------------------------------------------------- |
| `data-api-key`  | **requis** — la clé publique du projet (`eh_pk_…`)          |
| `data-endpoint` | force l'adresse d'ingestion, au lieu de la déduire du `src` |
| `data-exclude`  | collecteurs à ne pas démarrer, séparés par des virgules     |
| `data-debug`    | journalise les envois et leurs échecs dans la console       |

```html
<!-- Tout sauf les clics et les soumissions de formulaire. -->
<script
  defer
  src="…/v1/eh.js"
  data-api-key="eh_pk_…"
  data-exclude="click,submit"
></script>
```

L'instance démarrée est posée sur `window.eventsHub`, pour les événements
métier :

```js
window.eventsHub?.track('checkout_completed', { plan: 'pro', cartValue: 49 });
```

L'optionnel n'est pas de la prudence gratuite : la balise est en `defer`, donc
du code inline qui s'exécute plus tôt ne la trouvera pas.

### Le paquet, pour une application qui a un bundler

Meilleur là où il s'applique — typé, sans requête réseau supplémentaire — mais
il suppose une étape de build, que la majorité des sites mesurés n'ont pas.

```ts
import { Analytics } from '@events-hub/sdk';

const analytics = new Analytics({
  apiKey: 'eh_pk_2e95b1b62a96443a919f2b3661106689',
  endpoint: 'http://localhost:3003/v1/events',
});

// Les événements comportementaux, sans une ligne de plus.
const stop = analytics.start();

// Le métier, que le SDK ne peut pas deviner.
await analytics.track('checkout_completed', { plan: 'pro', cartValue: 49 });
```

C'est une **clé publique** (`eh_pk_…`), pas un `projectId` : le hub ne laisse
plus le client désigner sa cible, la clé la désigne pour lui. Elle est en clair
dans le bundle par construction — elle identifie, elle n'authentifie pas.

`new Analytics()` ne fait rien d'observable : pas d'écouteur branché, pas de
requête. C'est `start()` qui démarre les collecteurs, et il rend de quoi les
débrancher. Hors navigateur (SSR), `start()` est un non-événement.

Le SDK reste sans file d'attente, sans batching et sans retry : un événement,
une requête. Ni session, ni identification, ni suivi d'erreurs.

## Les événements collectés

| type             | quand                                                          |
| ---------------- | -------------------------------------------------------------- |
| `page_view`      | chargement, `pushState`, `replaceState`, `popstate`            |
| `click`          | clic sur `a, button, input, select, textarea, [role="button"]` |
| `submit`         | soumission d'un formulaire                                     |
| `outbound_click` | clic sur un lien `http(s)` vers une autre origine              |
| `page_leave`     | onglet masqué, `pagehide`, ou clic sortant qui emporte la page |

Chacun se désactive séparément :

```ts
analytics.start({ click: false, submit: false });
```

### `page_view`

Un seul type d'événement pour toutes les navigations — il n'existe pas
d'événement `navigation` à côté. Le geste est une propriété de la vue de page :

```json
{ "navigation.type": "push_state", "navigation.from": "/pricing" }
```

`navigation.type` vaut `initial`, `push_state`, `replace_state` ou `pop_state`.

**`navigation.from` est la page précédente du même site, ou rien.** Même clé,
même forme (chemin + query, sans origine), que le site soit une SPA ou un MPA :

| parcours                                       | `navigation.from` | `page.referrer`        |
| ---------------------------------------------- | ----------------- | ---------------------- |
| `/pricing` → `/checkout` en SPA (`pushState`)  | `/pricing`        | inchangé               |
| `/pricing` → `/checkout` en MPA (rechargement) | `/pricing`        | `https://site/pricing` |
| Google → `/pricing`                            | _absente_         | `https://google.com/…` |
| entrée directe → `/pricing`                    | _absente_         | _absente_              |
| `/pricing` → `/pricing#faq`                    | _absente_         | `https://site/pricing` |

Les deux moitiés viennent de sources différentes — la dernière page comptée en
SPA, `document.referrer` au premier chargement en MPA — et c'est justement ce
que le SDK recolle. Sans ça, un consommateur devrait écrire
`coalesce(navigation.from, page.referrer)` **et** savoir à quel type de site il
a affaire pour interpréter le résultat.

Une origine différente ne compte pas comme une page précédente : c'est une
_source_, et elle reste intégralement dans `page.referrer`, qui ne perd rien.
Un sous-domaine compte donc comme externe — l'origine est la seule frontière
que le navigateur définit sans ambiguïté.

**Granularité :** `navigation.from` porte le chemin **et la query**
(`/list?page=2`) — c'est l'identité qui sert au SDK à décider que deux vues sont
deux pages différentes. `page.path`, lui, ne porte que le chemin (`/list`). Les
deux clés ne se recoupent donc pas telles quelles : un consommateur qui groupe
ses pages par `page.path` doit appliquer la même troncature à `navigation.from`
avant de les croiser. C'est délibérément dans ce sens-là — la valeur la plus
fine est toujours réductible, l'inverse est perdu — et « ce qui compte comme une
page » est une décision qui appartient au consommateur, pas au SDK.

La clé est **absente** plutôt que `null` : au lecture, `properties->>'navigation.from'`
rend `NULL` dans les deux cas, et omettre évite d'avoir à distinguer « pas de
page précédente » de « page précédente vide ». C'est la convention de tout le
SDK.

**Anti-doublon** : deux vues consécutives de la même URL n'en font qu'une. La
comparaison porte sur `pathname + search`, le hash est ignoré (il sert aussi
bien de route que d'ancre, et compter un `page_view` par ancre cliquée
gonflerait le trafic sans que ça se voie). Sans ce garde, tout site dont le
routeur normalise l'URL au montage — un `replaceState` vers l'URL courante —
compterait son trafic deux fois.

### `click` et `outbound_click`

Un clic sur un lien sortant produit `click` **puis** `outbound_click` : ce n'est
pas un clic d'un autre genre, c'est un fait supplémentaire sur le même clic.

```json
{
  "element.tag": "a",
  "element.id": "cta-docs",
  "element.href": "https://autre.test/docs",
  "link.origin": "https://autre.test"
}
```

Les clés possibles sont `element.tag`, `element.id`, `element.name`,
`element.type`, `element.role`, `element.href` — celles qui n'ont pas de valeur
sont omises. `element.class` n'existe pas : avec du CSS utilitaire elle fait des
centaines d'octets de style par clic et n'identifie rien de stable.

**Ni texte du DOM, ni valeur de champ.** Sans exception : le libellé d'un bouton
peut contenir un nom, la valeur d'un champ contient par définition ce que
l'utilisateur a tapé. Tout ce qui est capturé est écrit par l'auteur du site
dans son propre HTML.

`mailto:`, `tel:` et `javascript:` ne comptent pas comme sortants : ils n'ont
pas d'origine au sens du navigateur et ne provoquent pas de navigation.

### `submit`

```json
{ "form.id": "inscription", "form.method": "post", "form.action": "…" }
```

**Aucune valeur de champ, et pas même leur nom.** `form.action` n'est renseignée
que si l'attribut est écrit : la propriété DOM d'un formulaire sans `action`
rend l'URL de la page courante, déjà présente dans `page.url`.

### `page_leave`

```json
{ "leave.reason": "outbound_click" }
```

`leave.reason` vaut `page_hidden` (l'onglet passe en arrière-plan), `pagehide`
(le document se décharge) ou `outbound_click`. **Le SDK ne déduit pas** que le
visiteur a quitté le site : il rapporte le signal observé, l'interprétation se
fait en aval.

Un même départ produit plusieurs signaux à la file — un clic sortant est suivi
de `visibilitychange` puis de `pagehide` : seul le premier est émis. Le compteur
est remis à zéro quand la page redevient visible, pour qu'un aller-retour entre
onglets ne fasse pas perdre le vrai départ une heure plus tard.

L'envoi passe par `fetch` + `keepalive` (repli `navigator.sendBeacon`) : un
`fetch` ordinaire lancé depuis `pagehide` est annulé avec la page. C'est aussi
ce qui permet de ne pas retarder la navigation sortante — la requête est confiée
au navigateur et rend la main immédiatement.

`sendBeacon` serait l'outil canonique, et il ne marche pas ici : le hub parse du
`application/json`, donc la requête est précédée d'un preflight CORS, que
`sendBeacon` ne garde pas en vie au déchargement — mesuré sur Chrome, le
preflight part et le POST jamais. `keepalive` couvre les deux. Le beacon reste
en repli pour les navigateurs qui ignorent `keepalive`.

Tous les clics sortants n'emportent pas la page : Cmd/Ctrl-clic,
`target="_blank"`, `download` ou un `preventDefault()` du site produisent bien
un `outbound_click`, mais pas de `page_leave`.

## Ce que le SDK remplit, ce que tu remplis

`attributes` est **entièrement généré par le SDK** et identique quel que soit
l'événement. L'appelant n'y écrit pas :

| clé                | source                              |
| ------------------ | ----------------------------------- |
| `page.path`        | `location.pathname`                 |
| `page.url`         | `location.href`                     |
| `page.referrer`    | `document.referrer` (omise si vide) |
| `browser.language` | `navigator.language`                |
| `screen.width`     | `screen.width`                      |
| `screen.height`    | `screen.height`                     |

Ces clés sont relues à chaque événement : après une navigation SPA, `page.path`
décrit la page où le clic a eu lieu. `page.referrer`, lui, est figé au
chargement du document — c'est `navigation.from` sur `page_view` qui porte
l'enchaînement interne.

Hors navigateur (SSR), `attributes` est vide plutôt que de lever.

`properties` décrit **l'événement lui-même** : rempli par le collecteur pour un
événement collecté, par toi pour un `track()` manuel. C'est cette frontière qui
garantit en aval que `page.path` veut dire la même chose sur tous les sites
instrumentés — rien de ce que passe un site ne peut se faire passer pour du
contexte collecté.

## Erreurs

`track()` rejette si le hub refuse, avec le statut **et** le corps (les 400
détaillent les champs fautifs). Les événements collectés, eux, ne peuvent rejeter
nulle part : ils passent par `onError`, qui ne fait rien par défaut — un endpoint
injoignable ne doit pas remplir la console d'un site à chaque clic.

```ts
new Analytics({ apiKey, endpoint, onError: console.warn });
```

## Structure

```
src/
  index.ts              # Analytics : track() et start()
  types.ts              # types partagés
  browser/              # lecture du navigateur
    attributes.ts       #   contexte page/écran/langue
    element.ts          #   sélection et description privacy-safe
    history.ts          #   pushState/replaceState/popstate
    url.ts              #   identité de page, origine sortante
  tracking/             # un collecteur par fichier, indépendants
    page-view.ts
    page-leave.ts
    click.ts
    submit.ts
    outbound-click.ts
  transport/
    send.ts             # fetch, et sendBeacon pour les départs
```

## Vérifications

```sh
pnpm --filter @events-hub/sdk test        # 62 tests, jsdom
pnpm --filter @events-hub/sdk demo        # un POST depuis Node
pnpm --filter @events-hub/sdk demo:site   # page HTML externe sur :4000
```

Les tests portent sur les **comportements** — pas sur « `track()` a été appelé ».
La séquence complète d'une visite et l'anti-doublon `chargement + replaceState
identique = 1 événement` sont vérifiés dans `src/index.test.ts`.
