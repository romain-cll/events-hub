import { Injectable } from '@nestjs/common';

/** Les trois familles d'appareil qu'un User-Agent permet de distinguer. */
export type DeviceType = 'desktop' | 'mobile' | 'tablet';

/**
 * Ce qu'on retient d'un User-Agent, et rien de plus.
 *
 * Trois libellés grossiers et un drapeau. Tout le reste — versions, moteur de
 * rendu, marque d'appareil, architecture — est jeté, et les raisons sont
 * détaillées sur `UserAgentService`.
 *
 * `null` n'est pas une anomalie : un navigateur qu'on ne nomme pas est le cas
 * normal de la longue traîne, et les lectures doivent le compter plutôt que le
 * taire.
 */
export interface Client {
  browser: string | null;
  os: string | null;
  deviceType: DeviceType | null;
  isBot: boolean;
}

/** Ce qu'on rend quand on ne sait pas. Gelé : c'est une valeur, pas un état. */
const UNKNOWN_CLIENT: Client = Object.freeze({
  browser: null,
  os: null,
  deviceType: null,
  isBot: false,
});

/**
 * Un en-tête HTTP peut faire plusieurs kilo-octets ; un vrai User-Agent en fait
 * moins de deux cents. Au-delà, ce n'est plus un navigateur qui se présente, et
 * scanner la suite ne ferait que donner du travail à des expressions régulières.
 */
const SCANNED = 512;

/**
 * Les navigateurs, **dans l'ordre**, et l'ordre est toute la connaissance.
 *
 * Chaque navigateur moderne se déclare aussi comme ceux qu'il a remplacés :
 * Edge dit « Chrome » puis « Safari », Chrome dit « Safari », Opera dit
 * « Chrome ». Une table non ordonnée nommerait donc tout le monde Safari.
 *
 * Sur iOS, tous les navigateurs sont obligés d'embarquer WebKit et se déclarent
 * « Safari » : seuls leurs préfixes propres (`CriOS`, `FxiOS`, `EdgiOS`) les
 * distinguent, d'où leur place avant les versions de bureau.
 */
const BROWSERS: readonly (readonly [string, string])[] = [
  ['Edge', 'Edg'],
  ['Opera', 'OPR/'],
  ['Opera', 'Opera'],
  ['Samsung Internet', 'SamsungBrowser'],
  ['Chrome', 'CriOS/'],
  ['Firefox', 'FxiOS/'],
  ['Firefox', 'Firefox/'],
  ['Chrome', 'Chrome/'],
  ['Safari', 'Safari/'],
];

/**
 * Les systèmes, même principe et mêmes pièges.
 *
 * Android se déclare « Linux », ChromeOS aussi ; l'iPhone se déclare
 * « Mac OS X ». Les plus spécifiques passent donc avant.
 */
const SYSTEMS: readonly (readonly [string, string])[] = [
  ['Android', 'Android'],
  ['ChromeOS', 'CrOS'],
  ['iOS', 'iPhone'],
  ['iOS', 'iPad'],
  ['iOS', 'iPod'],
  ['Windows', 'Windows'],
  ['macOS', 'Macintosh'],
  ['macOS', 'Mac OS X'],
  ['Linux', 'Linux'],
];

/**
 * Les robots, **et uniquement ceux qui se déclarent**.
 *
 * La règle est volontairement conservatrice, et c'est structurel : un faux
 * positif ne dégrade pas une statistique, il **supprime** du trafic réel de tous
 * les compteurs, en silence. On ne déduit donc jamais un robot de l'absence de
 * quelque chose — un User-Agent vide, ou qui ne ressemble à aucun navigateur,
 * n'est pas un robot. C'est un visiteur qu'on ne sait pas nommer, et la suite de
 * tests de bout en bout ingère justement sous des noms pareils.
 *
 * Le jour où cette liste devient insuffisante, `botSessions` le dira : c'est
 * pour ça qu'il est publié plutôt que gardé pour nous.
 */
const ROBOTS: readonly string[] = [
  'bot',
  'crawl',
  'spider',
  'slurp',
  'headlesschrome',
  'phantomjs',
  'puppeteer',
  'playwright',
  'lighthouse',
  'facebookexternalhit',
  'python-requests',
  'go-http-client',
  'java/',
  'okhttp',
  'curl/',
  'wget',
  'node-fetch',
  'axios',
  'monitor',
  'pingdom',
  'uptimerobot',
  'preview',
  'scraper',
  'fetcher',
];

/**
 * Dérive d'un User-Agent trois libellés grossiers, et le jette.
 *
 * ## Pourquoi ce module, et pourquoi il ressemble à `geoip/`
 *
 * Même place dans la chaîne, même promesse. Une donnée identifiante entre, trois
 * libellés non réversibles sortent, et l'entrée ne survit pas à la requête.
 * Comme pour la géolocalisation, ce n'est pas ce service qui protège quoi que ce
 * soit : c'est son emplacement. Il est appelé par `CoreService.assignSession`,
 * là où l'identité réseau s'arrête déjà.
 *
 * ## Ce qu'on jette, et pourquoi ce n'est pas un manque
 *
 * **La version mineure** est du bruit pur : `Chrome/141.0.6800.114` a quatre
 * composantes dont trois ne répondent à aucune question, et chacune multiplie le
 * nombre de valeurs distinctes sur une ligne de session — donc la surface de
 * ré-identification.
 *
 * **La version majeure** est le cas limite, et elle est jetée aussi. Elle sert
 * une matrice de compatibilité, qui est un autre produit que celui-ci ; et c'est
 * aujourd'hui le champ à plus forte entropie restante, Chrome ayant gelé tout le
 * reste de son en-tête. Une colonne facultative pourra l'accueillir le jour où
 * la question existe.
 *
 * **La version du système** est jetée parce qu'elle est **fausse** : Windows 11
 * se déclare « Windows NT 10.0 », macOS se déclare « 10_15_7 » depuis des
 * années. Une colonne qu'on sait erronée une fois sur deux est pire qu'une
 * colonne absente — elle finira par être lue.
 *
 * **Le moteur de rendu** se déduit du nom du navigateur partout où il est
 * intéressant, et ment dans le seul cas où il ne l'est pas : sur iOS, tout le
 * monde est WebKit. **La marque et le modèle** sont de l'empreinte, pas de
 * l'audience — c'est le même raisonnement qui a écarté la latitude de `Location`.
 *
 * ## Pourquoi une table maison plutôt qu'une bibliothèque
 *
 * `ua-parser-js` v2 est sous AGPL-3.0 ; seule sa v1 est MIT, et une dépendance
 * qu'on ne peut jamais monter de version, sur un domaine dont la valeur *est*
 * d'être à jour, ne vaut pas mieux qu'une table. Elle porterait par ailleurs
 * deux cents navigateurs et des marques de téléphones, dont on n'appellerait
 * rien, et déciderait à notre place de ce qui compte.
 *
 * Ce qu'il faut tient dans deux tables ordonnées. Le coût est connu : un
 * navigateur nouveau ou exotique rend `null` — jamais un libellé faux — et il
 * faut y ajouter une ligne le jour où il mérite d'être nommé. C'est exactement
 * le compromis déjà assumé pour les moteurs de recherche dans `features/`.
 *
 * ## Ce que ça n'ajoute pas au risque
 *
 * Ces libellés ne rendent pas un visiteur plus reconnaissable qu'il ne l'était :
 * la clé visiteur est déjà dérivée du User-Agent **entier**. Ce qui borne le
 * risque n'est pas leur finesse mais leur emplacement — ils vivent sur la
 * session, qui tourne avec la clé, et ne franchissent le fil qu'agrégés.
 */
@Injectable()
export class UserAgentService {
  /**
   * Ne lève jamais, comme `GeoIpService.locate`. C'est une lecture d'agrément
   * sur le chemin d'ingestion : la faire échouer coûterait un événement, pour
   * une information de confort.
   */
  describe(userAgent: string): Client {
    const raw = userAgent.slice(0, SCANNED);

    if (!raw.trim()) return UNKNOWN_CLIENT;

    const lower = raw.toLowerCase();

    // Un robot déclaré n'a ni navigateur ni appareil à nommer : ce qu'on veut
    // savoir de lui tient dans le drapeau, et lui inventer un profil le ferait
    // entrer dans des classements d'où il doit sortir.
    if (ROBOTS.some((needle) => lower.includes(needle))) {
      return { browser: null, os: null, deviceType: null, isBot: true };
    }

    return {
      browser: firstMatch(BROWSERS, raw),
      os: firstMatch(SYSTEMS, raw),
      deviceType: deviceOf(raw),
      isBot: false,
    };
  }
}

function firstMatch(
  table: readonly (readonly [string, string])[],
  raw: string,
): string | null {
  for (const [label, needle] of table) {
    if (raw.includes(needle)) return label;
  }

  return null;
}

/**
 * La famille d'appareil.
 *
 * ⚠️ **Les tablettes sont structurellement sous-comptées.** Depuis iPadOS 13,
 * Safari envoie par défaut un en-tête de bureau — littéralement celui d'un Mac —
 * et la majorité des iPad est donc rangée en `desktop`. Aucune table ne peut
 * corriger ça : l'information n'est pas dans l'en-tête. C'est à dire à qui lit
 * le chiffre, pas à maquiller ici.
 */
function deviceOf(raw: string): DeviceType {
  if (raw.includes('iPad') || raw.includes('Tablet')) return 'tablet';

  // Android sans le marqueur `Mobi` est une tablette : c'est la convention que
  // Google demande à ses propres navigateurs de respecter, et la seule
  // distinction disponible.
  if (raw.includes('Android') && !raw.includes('Mobi')) return 'tablet';

  if (
    raw.includes('Mobi') ||
    raw.includes('iPhone') ||
    raw.includes('iPod') ||
    raw.includes('Android')
  ) {
    return 'mobile';
  }

  return 'desktop';
}
