/**
 * Produit la géométrie du planisphère, une fois pour toutes.
 *
 * ## Pourquoi un script et pas une dépendance
 *
 * La projection d'un pays ne change jamais. La calculer dans le navigateur
 * ferait embarquer `d3-geo`, `topojson-client` et une topologie du monde à
 * chaque chargement, pour refaire un travail dont le résultat est constant. Ici
 * les trois restent en **devDependencies** : elles ne franchissent pas le
 * bundle, et le front n'importe qu'un dictionnaire de chaînes.
 *
 * Le prix de ce choix : reprojeter ou changer de simplification demande de
 * relancer ce script et de commiter le résultat. C'est un geste explicite, et
 * c'est très bien — une carte qui change toute seule serait une surprise.
 *
 * ## Equal Earth, et pas Mercator
 *
 * Une part de visiteurs par pays est une **aire**. Mercator gonfle les hautes
 * latitudes d'un facteur qui dépasse deux à la latitude de la Scandinavie : le
 * même nombre de visiteurs y paraîtrait plus important qu'à l'équateur. Equal
 * Earth conserve les aires tout en restant lisible, contrairement aux
 * projections équivalentes classiques.
 *
 *     node scripts/build-world-map.mjs
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoEqualEarth, geoPath } from 'd3-geo';
import countries from 'i18n-iso-countries';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topology = require('world-atlas/countries-110m.json');

/** La boîte de rendu. Le rapport suit celui d'Equal Earth, ~2,05:1. */
const WIDTH = 820;
const HEIGHT = 400;

/**
 * Décimales gardées dans les chemins.
 *
 * Une seule suffit largement : à cette échelle, un dixième de pixel est
 * invisible, et chaque décimale de plus pèse une dizaine de kilo-octets sur le
 * fichier entier.
 */
const PRECISION = 1;

/**
 * L'aire projetée en deçà de laquelle un pays reçoit une **pastille**.
 *
 * Un pays de quelques pixels ne se voit pas s'allumer : survoler « Belgium »
 * dans le tableau n'apprend rien si la Belgique fait huit pixels de côté. La
 * carte lui pose alors un cercle au survol, et c'est ce dictionnaire qui dit
 * pour qui.
 *
 * 60 px² sur une boîte de 820 × 400, c'est un carré d'environ 8 px. Les mesures
 * qui ont servi à caler le seuil : Belgique 17, Pays-Bas 23, Suisse 26,
 * Danemark 24, Irlande 33, Autriche 49, Portugal 54 — tous dedans ; Grèce 76,
 * Royaume-Uni 143, Italie 180, Espagne 288, France 369 — tous dehors.
 *
 * La planche fait le même tri, mais à la main : elle ne pose de cercle que sur
 * la Belgique, la Suisse et les Pays-Bas. Une maquette peut choisir ses cas ;
 * du code a besoin d'une règle, et l'aire est la bonne — c'est exactement la
 * propriété qui rend un pays invisible.
 */
const PIN_BELOW = 60;

const world = feature(topology, topology.objects.countries);

const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], world);
const path = geoPath(projection);

/** `{ FR: "M…", US: "M…" }` — la clé est le code ISO-3166-1 alpha-2. */
const shapes = {};
/** `{ BE: [x, y] }` — le centre des seuls pays trop petits pour se voir. */
const pins = {};
const skipped = [];

for (const country of world.features) {
  // `world-atlas` identifie par le code **numérique** ISO-3166-1. Le dashboard,
  // lui, joint sur l'alpha-2 que rend l'API — d'où la conversion, faite ici une
  // fois plutôt qu'à chaque rendu.
  const alpha2 = countries.numericToAlpha2(String(country.id));
  const d = path(country);

  // Les territoires sans code alpha-2 (Kosovo, zones contestées) et les
  // géométries vides sont écartés : sans code, rien ne pourrait les relier à
  // une ligne du classement.
  if (alpha2 === undefined || !d) {
    skipped.push(country.properties?.name ?? country.id);

    continue;
  }

  shapes[alpha2] = d.replace(/\d+\.\d+/g, (n) => Number(n).toFixed(PRECISION));

  // Seulement sous le seuil : une pastille sur la France ferait du bruit sur un
  // pays qu'on voit déjà très bien.
  if (path.area(country) < PIN_BELOW) {
    pins[alpha2] = path
      .centroid(country)
      .map((n) => Number(n.toFixed(PRECISION)));
  }
}

const output = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/lib/world-equal-earth.json',
);

writeFileSync(
  output,
  `${JSON.stringify({ width: WIDTH, height: HEIGHT, shapes, pins })}\n`,
);

const bytes = JSON.stringify(shapes).length;

console.log(`${Object.keys(shapes).length} pays → ${output}`);
console.log(`${(bytes / 1024).toFixed(1)} Ko de chemins`);
console.log(`${Object.keys(pins).length} pays sous ${PIN_BELOW} px² → pastille`);

if (skipped.length > 0) {
  // Jamais en silence : un territoire absent de la carte doit se voir ici, pas
  // se découvrir à l'écran des mois plus tard.
  console.log(`écartés, faute de code alpha-2 : ${skipped.join(', ')}`);
}
