import { UserAgentService } from './user-agent.service';

/**
 * Des User-Agents réels, et l'ordre des tables qui les départage.
 *
 * Toute la difficulté de ce service est là : chaque navigateur moderne se
 * déclare aussi comme ceux qu'il a remplacés. Les cas ci-dessous sont donc
 * choisis pour leurs **collisions**, pas pour leur variété — un test qui ne
 * vérifierait que Firefox ne vérifierait rien.
 */

const service = new UserAgentService();

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/141.0.0.0`;
const OPERA_WINDOWS = `${CHROME_WINDOWS} OPR/120.0.0.0`;
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const CHROME_ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPAD_LEGACY =
  'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROMEBOOK =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('UserAgentService — le navigateur', () => {
  it.each([
    ['Edge, qui se déclare aussi Chrome et Safari', EDGE_WINDOWS, 'Edge'],
    ['Opera, qui se déclare aussi Chrome', OPERA_WINDOWS, 'Opera'],
    ['Chrome, qui se déclare aussi Safari', CHROME_WINDOWS, 'Chrome'],
    ['Chrome sur iOS, qui n’a que son préfixe', CHROME_IOS, 'Chrome'],
    ['Safari, qui ne se déclare que lui-même', SAFARI_MAC, 'Safari'],
    ['Firefox', FIREFOX_LINUX, 'Firefox'],
  ])('reconnaît %s', (_cas, ua, attendu) => {
    expect(service.describe(ua).browser).toBe(attendu);
  });
});

describe('UserAgentService — le système', () => {
  it.each([
    ['Windows', CHROME_WINDOWS, 'Windows'],
    ['macOS', SAFARI_MAC, 'macOS'],
    ['iOS, qui se déclare aussi « Mac OS X »', SAFARI_IPHONE, 'iOS'],
    ['Android, qui se déclare aussi Linux', CHROME_ANDROID, 'Android'],
    ['ChromeOS, qui se déclare aussi Linux', CHROMEBOOK, 'ChromeOS'],
    ['Linux', FIREFOX_LINUX, 'Linux'],
  ])('reconnaît %s', (_cas, ua, attendu) => {
    expect(service.describe(ua).os).toBe(attendu);
  });
});

describe('UserAgentService — l’appareil', () => {
  it.each([
    ['un ordinateur', CHROME_WINDOWS, 'desktop'],
    ['un téléphone', SAFARI_IPHONE, 'mobile'],
    ['un téléphone Android', CHROME_ANDROID, 'mobile'],
    [
      'une tablette Android, reconnue par l’absence de « Mobi »',
      CHROME_ANDROID_TABLET,
      'tablet',
    ],
    ['un iPad d’avant iPadOS 13', SAFARI_IPAD_LEGACY, 'tablet'],
  ])('range %s', (_cas, ua, attendu) => {
    expect(service.describe(ua).deviceType).toBe(attendu);
  });

  it('range un iPad récent en ordinateur, et c’est irrécupérable', () => {
    // Depuis iPadOS 13, Safari envoie par défaut l'en-tête d'un Mac —
    // littéralement celui-ci. L'information n'est pas dans la chaîne : aucune
    // table ne peut la retrouver. Ce test existe pour que le sous-comptage des
    // tablettes soit une décision écrite plutôt qu'une surprise.
    expect(service.describe(SAFARI_MAC).deviceType).toBe('desktop');
  });
});

describe('UserAgentService — les robots', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
    'facebookexternalhit/1.1',
    'curl/8.7.1',
    'python-requests/2.32.3',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  ])('reconnaît « %s »', (ua) => {
    expect(service.describe(ua).isBot).toBe(true);
  });

  it('ne leur invente ni navigateur ni appareil', () => {
    // Un robot déclaré n'a pas de profil à nommer, et lui en donner un le ferait
    // entrer dans des classements d'où il doit sortir.
    const bot = service.describe('Mozilla/5.0 (compatible; Googlebot/2.1)');

    expect(bot.browser).toBeNull();
    expect(bot.os).toBeNull();
    expect(bot.deviceType).toBeNull();
  });

  it.each([
    ['une chaîne vide', ''],
    ['des espaces', '   '],
    ['un identifiant maison', 'sonde-interne/1.0'],
    ['un nom sans rapport', 'visiteur-a'],
    ['une chaîne tronquée', 'Mozilla/5.0 (Win'],
  ])('ne prend pas %s pour un robot', (_cas, ua) => {
    // La détection ne déduit **jamais** un robot de l'absence de quelque chose.
    // Un faux positif ne dégrade pas un chiffre, il supprime du trafic réel de
    // tous les compteurs, en silence — et la suite de bout en bout ingère
    // justement sous des noms de ce genre.
    expect(service.describe(ua).isBot).toBe(false);
  });
});

describe('UserAgentService — ce qu’il ne sait pas', () => {
  it('rend une valeur vide plutôt que de lever', () => {
    // C'est une lecture d'agrément sur le chemin d'ingestion : la faire échouer
    // coûterait un événement pour une information de confort.
    expect(service.describe('')).toEqual({
      browser: null,
      os: null,
      deviceType: null,
      isBot: false,
    });
  });

  it('ne nomme pas un navigateur qu’il ne connaît pas', () => {
    const inconnu = service.describe('Mozilla/5.0 (Windows NT 10.0) Lynx/9.0');

    // `null`, jamais un libellé faux : la table ne reconnaît que ce qu'elle nomme.
    expect(inconnu.browser).toBeNull();
    expect(inconnu.os).toBe('Windows');
  });

  it('ne scanne pas un en-tête démesuré en entier', () => {
    // Un en-tête HTTP peut faire plusieurs kilo-octets. Ce qui dépasse la borne
    // n'est pas lu — et ne peut donc pas décider du libellé.
    const bourrage = `${'x'.repeat(600)} Firefox/130.0`;

    expect(service.describe(bourrage).browser).toBeNull();
  });
});
