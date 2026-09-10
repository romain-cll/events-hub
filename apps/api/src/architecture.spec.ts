import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Test d'architecture : rien, hors des modules métier, ne connaît un type
 * d'événement.
 *
 * C'est la garantie qui rend la suite possible — « ajouter un module » doit
 * vouloir dire « ajouter du code », pas « modifier le socle partout ». Elle ne
 * tient pas toute seule : il suffit d'un `if (event.type === …)` glissé dans un
 * service du socle pour la perdre, et rien d'autre ne le signalerait.
 *
 * ## Pourquoi le test scanne tout et déclare des exceptions
 *
 * Il a d'abord ciblé `core/`, via `sourcesOf(__dirname)`. Le défaut de cette
 * forme est que la couverture suivait passivement le contenu d'un dossier :
 * déplacer un fichier hors de `core/` le sortait du scan, et le test restait
 * vert sans rien signaler. L'invariant dépendait d'un rangement.
 *
 * Ici c'est l'inverse. On scanne `src/` en entier et on nomme les endroits
 * *autorisés* à connaître un type :
 *
 * - un fichier nouveau est couvert par défaut, où qu'il soit rangé ;
 * - déplacer un fichier ne change rien à ce qui est vérifié — la garantie
 *   voyage avec le fichier, pas avec son dossier ;
 * - retirer quelque chose de la couverture demande d'ajouter une ligne à
 *   `MAY_KNOW_EVENT_TYPES`, dans un diff, dans le fichier de l'invariant.
 *
 * Le test lit les sources plutôt que d'observer un comportement, parce que
 * c'est une contrainte sur la *forme* du code : aucune exécution ne pourrait la
 * révéler. Son pendant vivant est `test/event-stream.e2e-spec.ts`, qui vérifie
 * la même promesse par le comportement — un type jamais vu doit traverser tout
 * le pipeline.
 */

/**
 * Les seuls endroits autorisés à connaître la signification d'un type
 * d'événement : les modules métier. L'interpréter est précisément leur travail.
 *
 * Toute autre entrée ajoutée ici est un renoncement, pas un réglage.
 */
const MAY_KNOW_EVENT_TYPES = ['features/'];

/**
 * La racine de composition assemble les modules : elle les importe tous, par
 * définition. C'est le seul endroit du socle où une dépendance vers un module
 * métier n'inverse pas la frontière — c'est le câblage, pas une connaissance.
 *
 * L'exception ne porte que sur la règle d'import : `app.module.ts` reste tenu
 * de ne nommer aucun type d'événement.
 */
const COMPOSITION_ROOT = 'app.module.ts';

/**
 * Garde-fou contre un scan qui se viderait sans le dire.
 *
 * Une exception trop large — ou un `sourcesOf` qui ne trouve plus rien — ferait
 * passer le test en ne vérifiant plus rien. Ces trois fichiers sont le cœur du
 * chemin d'ingestion : qu'ils sortent de la couverture est une erreur, jamais
 * une intention.
 */
const MUST_BE_COVERED = [
  'session-assigner.service.ts',
  'visitor-key.service.ts',
  'event-store.service.ts',
];

/** Tout le TypeScript de `src/`, tests compris. */
function allSourcesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return allSourcesOf(path);

    return path.endsWith('.ts') ? [path] : [];
  });
}

function sourcesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourcesOf(path);

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * Le vocabulaire que le SDK produit aujourd'hui, sous les formes qu'il
 * prendrait en se glissant dans du code : `page_view` dans une comparaison,
 * `pageView` dans un identifiant, `pageViews` dans un nom de collection.
 */
const EVENT_TYPES = [
  'page_view',
  'page_leave',
  'click',
  'submit',
  'outbound_click',
];

function variantsOf(type: string): string[] {
  const camel = type.replace(/_(.)/g, (_, letter: string) =>
    letter.toUpperCase(),
  );

  return [...new Set([type, camel, `${camel}s`])];
}

/**
 * Les formes que prend un aiguillage par type.
 *
 * Une liste de noms interdits ne rattrape que ce à quoi on a déjà pensé — elle
 * serait muette le jour où quelqu'un branche le socle sur `error` ou sur
 * `deployment`. Ces motifs-là visent la *structure* : quelle que soit la valeur
 * comparée, dès que le socle décide quelque chose à partir d'un `type`, il a
 * cessé d'être générique.
 */
const BRANCHING = [
  ['compare un type à un littéral', /\btype\s*[!=]==?\s*['"`]/],
  ['compare un littéral à un type', /['"`]\s*[!=]==?\s*[\w.]*\btype\b/],
  ['aiguille sur un type', /\bswitch\s*\(\s*[\w.]*\btype\b/],
  ['indexe un comportement par type', /\[\s*[\w.]*\btype\s*\]/],
] as const;

describe('frontière des types d’événement', () => {
  const sources = sourcesOf(__dirname).filter((path) => {
    const relativePath = relative(__dirname, path).split(sep).join('/');

    return !MAY_KNOW_EVENT_TYPES.some((prefix) =>
      relativePath.startsWith(prefix),
    );
  });

  const offenders = (matches: (source: string) => boolean) =>
    sources.filter((path) => matches(readFileSync(path, 'utf8')));

  // Sans ça, tout ce qui suit passerait sur une liste vide.
  describe('couvre bien le chemin d’ingestion', () => {
    it.each(MUST_BE_COVERED)('scanne %s', (file) => {
      expect(sources.filter((path) => path.endsWith(`${sep}${file}`))).toEqual([
        expect.any(String),
      ]);
    });
  });

  describe('ne nomme aucun type d’événement', () => {
    it.each(EVENT_TYPES.flatMap(variantsOf))(
      'ne mentionne nulle part « %s »',
      (needle) => {
        expect(offenders((source) => source.includes(needle))).toEqual([]);
      },
    );
  });

  describe('ne décide rien à partir d’un type', () => {
    it.each(BRANCHING)('%s nulle part', (_label, pattern) => {
      expect(offenders((source) => pattern.test(source))).toEqual([]);
    });
  });

  it('ne nomme aucune clé inventée par le SDK', () => {
    // `attributes` et `properties` sont des sacs opaques pour le socle. Qu'il
    // nomme `navigation.type` ou `leave.reason` voudrait dire qu'il a commencé
    // à lire dedans.
    const keys = [
      'page.path',
      'sdk.version',
      'navigation.type',
      'navigation.from',
      'leave.reason',
      'link.origin',
      'element.tag',
      'form.action',
    ];

    for (const key of keys) {
      expect(offenders((source) => source.includes(key))).toEqual([]);
    }
  });

  it('n’importe rien depuis un module métier', () => {
    // La dépendance ne va que dans un sens : les modules connaissent le socle,
    // jamais l'inverse. La règle se dérive de `MAY_KNOW_EVENT_TYPES` pour que
    // renommer le dossier des modules ne laisse pas cette vérification derrière.
    for (const prefix of MAY_KNOW_EVENT_TYPES) {
      const pattern = new RegExp(`from '.*${prefix}`);

      expect(
        offenders((source) => pattern.test(source)).filter(
          (path) => !path.endsWith(`${sep}${COMPOSITION_ROOT}`),
        ),
      ).toEqual([]);
    }
  });
});

/**
 * Second invariant de forme : `@events-hub/api-contract` n'entre ici qu'en
 * types.
 *
 * ## Ce qui casse si la règle saute
 *
 * Le paquet de contrat est du **TypeScript source**, sans étape de compilation
 * — c'est ce qui lui évite un `dist` à tenir à jour. L'API peut s'en servir
 * parce qu'elle n'en prend que des types, effacés par le compilateur : rien du
 * paquet n'atteint jamais le programme émis.
 *
 * Qu'un seul `import` de valeur apparaisse, et le fichier du paquet entre dans
 * le programme de tsc. La racine commune devient celle du monorepo, la sortie
 * part dans `dist/apps/api/src/main.js` au lieu de `dist/main.js`, et
 * `node dist/main` ne trouve plus rien. La panne survient **au build**, pas à
 * l'écriture, et son message ne parle ni de contrat ni d'import.
 *
 * D'où cette règle ici plutôt qu'une convention : le seul autre signal serait
 * un déploiement cassé.
 *
 * ## Si le besoin devient réel
 *
 * Importer une valeur — un schéma à exécuter, pour valider une entrée — est une
 * demande légitime. La réponse n'est pas d'ajouter une exception mais de donner
 * une compilation au paquet (CJS + ESM + `.d.ts`). C'est un chantier, pas un
 * réglage, et cette règle est là pour qu'on le décide au lieu de le subir.
 */
describe('frontière du contrat d’API', () => {
  const CONTRACT = '@events-hub/api-contract';

  /**
   * Ce scan-ci inclut les `.spec.ts`, contrairement à `sourcesOf`.
   *
   * Ce n'est pas un détail : le contrat n'est aujourd'hui importé que depuis
   * `contract.spec.ts`, et c'est délibéré — c'est ce nom qui le tient hors du
   * build. Reprendre le scan qui exclut les specs ferait porter la règle sur
   * zéro fichier, donc ne vérifierait plus rien. La sonde ci-dessous existe
   * parce que c'est exactement ce qui s'est produit à l'écriture.
   *
   * Ce fichier-ci est écarté : il **nomme** le paquet dans sa propre constante,
   * ce qui en ferait un contrevenant permanent.
   */
  const scanned = allSourcesOf(__dirname).filter(
    (path) => !path.endsWith(`${sep}architecture.spec.ts`),
  );

  const importsOfContract = scanned.filter((path) =>
    readFileSync(path, 'utf8').includes(CONTRACT),
  );

  it('est bien importé quelque part, sinon la règle ne vérifie rien', () => {
    // Sans cette sonde, supprimer le dernier import rendrait les vérifications
    // ci-dessous vertes en ne regardant plus aucun fichier.
    expect(importsOfContract.length).toBeGreaterThan(0);
  });

  it('n’est jamais importé en valeur', () => {
    // Seule la forme `import type { … } from` est acceptée.
    //
    // `import { type A }` serait techniquement effacé lui aussi, et il est
    // pourtant refusé ici : il suffit d'y ajouter un binding non marqué pour
    // que l'instruction devienne un import de valeur, sans que rien dans sa
    // forme ne change. `import type` au niveau de l'instruction ne peut pas
    // glisser — le compilateur refuserait le binding de valeur.
    const valueImports = importsOfContract.filter((path) => {
      const source = readFileSync(path, 'utf8');

      // Chaque instruction est découpée séparément, jusqu'à son `';`. Un motif
      // qui partirait du premier `import` du fichier avalerait ceux d'avant et
      // testerait la forme du mauvais.
      const statements = source.match(/import[\s\S]*?from\s*'[^']*';/g) ?? [];

      return statements
        .filter((statement) => statement.includes(CONTRACT))
        .some((statement) => !/^import\s+type\b/.test(statement));
    });

    expect(valueImports).toEqual([]);
  });

  it('n’est pas importé dynamiquement non plus', () => {
    // `await import('…')` contournerait la règle ci-dessus tout en produisant
    // exactement la même dépendance à l'exécution.
    const pattern = new RegExp(`import\\s*\\(\\s*['"\`]${CONTRACT}`);

    expect(
      importsOfContract.filter((path) =>
        pattern.test(readFileSync(path, 'utf8')),
      ),
    ).toEqual([]);
  });
});

/**
 * Troisième invariant de forme : la clé visiteur ne quitte pas le socle.
 *
 * ## Ce qu'il ferme
 *
 * `visitor_key` est un HMAC : dérivé du réseau et rotatif à la journée sans
 * consentement, dérivé d'un identifiant durable et stable avec. Il vit sur
 * `sessions`, et depuis le lot revenu sur `events` aussi — un paiement a un
 * visiteur sans avoir de visite. Les modules métier, eux, reçoivent un **alias**
 * tiré au hasard à chaque lecture, qui dit « même visiteur, dans cette réponse »
 * et rien de plus.
 *
 * ## Ce n'est pas une règle de confidentialité
 *
 * On pourrait croire qu'elle protège le visiteur, et qu'elle devient donc
 * caduque dès qu'il a consenti. C'est l'inverse : elle dit que **le socle est
 * seul à décider ce qu'est une identité**. Le consentement a changé ce qu'on
 * stocke, pas qui en décide.
 *
 * Le jour où un module métier a le droit de *nommer* une clé visiteur, il a
 * aussi celui d'en *fabriquer* une — `VisitorKeyService.computeStable` est
 * public, et il accepte n'importe quelle chaîne. Un module la calculerait depuis
 * un email, un autre depuis un identifiant de client d'un fournisseur de
 * paiement, et on aurait deux espaces d'identité qui ne se recoupent pas, sans
 * que rien ne dise lequel fait foi.
 *
 * C'est le raisonnement d'`EventStore.where()`, appliqué à l'identité : une
 * règle posée dans un module de `features/` sera oubliée par le suivant.
 *
 * Le coût de la tenir est une signature — une attribution exposée par le socle,
 * qui prend en **argument** ce qu'il ne doit pas nommer.
 *
 * Cette frontière ne tient pas toute seule. Il suffit d'ajouter `visitorKey`
 * au `select` de `EventStore.events()` — une ligne, dans un fichier qui a
 * légitimement accès à la colonne — pour que la clé descende jusqu'à un module,
 * puis jusqu'au fil, puis dans le navigateur. Rien d'autre ne le signalerait :
 * le code compilerait, les tests passeraient, et la seule trace serait un champ
 * de plus dans une réponse que personne ne relit.
 *
 * ## Pourquoi la règle porte sur `features/` et non sur `core/`
 *
 * C'est l'exact miroir de la première règle. Là, on nomme les endroits
 * autorisés à connaître un type d'événement ; ici, on nomme celui qui a le
 * droit de connaître la clé. Un module métier qui l'écrirait aurait forcément
 * commencé à la recevoir.
 *
 * `privacy/` et `sessions/` la fabriquent et l'utilisent, `database/schema` la
 * déclare, `events/` la lit pour l'aliaser : ces quatre-là sont le socle de la
 * clé, et le test ne les regarde pas.
 */
describe('frontière de la clé visiteur', () => {
  /**
   * Les formes sous lesquelles la clé se nommerait : la colonne, la propriété
   * TypeScript, et le champ tel qu'il apparaîtrait sérialisé.
   */
  const NEEDLES = ['visitorKey', 'visitor_key'];

  const businessSources = allSourcesOf(__dirname).filter((path) => {
    const relativePath = relative(__dirname, path).split(sep).join('/');

    return MAY_KNOW_EVENT_TYPES.some((prefix) =>
      relativePath.startsWith(prefix),
    );
  });

  it('couvre bien les modules métier, sinon la règle ne vérifie rien', () => {
    // Sans ce garde, un renommage de dossier viderait le scan et laisserait le
    // test vert en ne regardant plus aucun fichier.
    expect(businessSources.length).toBeGreaterThan(0);
  });

  it.each(NEEDLES)('aucun module métier ne nomme « %s »', (needle) => {
    expect(
      businessSources.filter((path) =>
        readFileSync(path, 'utf8').includes(needle),
      ),
    ).toEqual([]);
  });
});
