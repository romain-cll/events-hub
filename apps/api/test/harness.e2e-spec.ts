import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Aucune suite ne démarre son application elle-même.
 *
 * `harness.ts` explique pourquoi l'application doit écouter une fois pour
 * toutes, et ce que coûte l'oubli : une suite qui rebâtit les cinq lignes à la
 * main laisse supertest lier et fermer un port éphémère à chaque requête, et
 * **rend toutes les autres instables**, pas la sienne. Le symptôme est un
 * `Parse Error: Expected HTTP/` sur une suite au hasard, qui ne désigne jamais
 * celle qui l'a causé.
 *
 * C'est exactement la forme d'erreur qu'une relecture ne rattrape pas : le code
 * fautif est correct, il ressemble à ce qui l'entoure, et sa suite passe. D'où
 * un test sur la forme plutôt qu'une ligne dans un CONTRIBUTING — même idée que
 * `src/architecture.spec.ts`, qui lit les sources pour les mêmes raisons.
 *
 * Il n'a pas besoin de base : il lit des fichiers. Il vit avec la suite e2e
 * parce que c'est elle qu'il protège, et que `jest.config` de `src/` ne voit
 * pas ce dossier.
 */

/**
 * Toutes les suites, sauf celle-ci : elle ne démarre aucune application, et le
 * nom qu'elle interdit figure forcément dans l'assertion qui l'interdit.
 */
const SUITES = readdirSync(__dirname).filter(
  (f) => f.endsWith('.e2e-spec.ts') && f !== 'harness.e2e-spec.ts',
);

/**
 * Garde-fou contre une règle qui se viderait sans le dire : si le filtre ne
 * trouve plus rien, le test passerait en ne vérifiant plus personne.
 */
it('voit bien les suites, sinon la règle ne vérifie rien', () => {
  expect(SUITES.length).toBeGreaterThan(10);
});

describe.each(SUITES)('%s', (suite) => {
  const source = readFileSync(join(__dirname, suite), 'utf8');

  it('passe par createTestApp', () => {
    expect(source).not.toContain('createNestApplication');
  });

  /**
   * La symétrique : ce qu'une suite crée, elle le reprend.
   *
   * Sans ça, une suite laisse derrière elle des projets, des comptes et surtout
   * des **organisations** — `organizations` n'ayant aucune clé étrangère vers
   * `users`, supprimer le compte n'emporte pas la sienne. La base locale en
   * comptait vingt-cinq mille, pour trois projets réels.
   *
   * Rien ne le signale : les suites restent vertes, le slug des organisations
   * est unique sur six caractères, et le jour où deux se heurtent c'est une
   * inscription qui échoue en 500, dans une suite qui ne parle pas
   * d'organisations.
   *
   * La règle vise l'appel, pas la fixture : une suite qui n'en crée aucune n'a
   * rien à reprendre, et `createProject`/`signUp` sont les deux seules portes
   * d'entrée.
   */
  it('reprend ce qu’il a créé', () => {
    const cree = /\b(createProject|signUp)\s*\(/.test(source);

    if (!cree) return;

    // L'appel, pas la mention : retirer la ligne laisse l'import derrière elle,
    // et `toContain` resterait vert sur un fichier qui ne nettoie plus rien.
    expect(source).toMatch(/cleanupFixtures\s*\(/);
  });
});
