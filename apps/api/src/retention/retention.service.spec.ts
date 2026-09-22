import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';

import { RetentionService } from './retention.service';

/**
 * Deux cas, et deux seulement.
 *
 * Tout le reste de ce module est du SQL : un `NOT EXISTS` corrélé, un `RESTRICT`
 * qui explose ou non, un verrou consultatif qui appartient à une connexion. Un
 * double de Drizzle ne dirait rien de vrai là-dessus — il confirmerait qu'on a
 * écrit ce qu'on a écrit. C'est `test/retention.e2e-spec.ts`, contre un vrai
 * Postgres, qui éprouve la purge.
 *
 * Ce qui se vérifie ici, ce sont les deux **portes** : le drapeau
 * d'environnement et le verrou. Les deux ont la même propriété — quand elles
 * sont fermées, il ne doit **rien** se passer, et « rien » n'est observable
 * qu'en comptant les appels à la base.
 */

/** `ConfigService` réduit à ce que le service consomme : un drapeau. */
const config = (enabled?: string) =>
  ({ get: () => enabled }) as unknown as ConfigService;

describe('RetentionService', () => {
  it('ne demande aucune connexion quand la purge planifiée est désactivée', async () => {
    const pool = { connect: jest.fn() };

    const service = new RetentionService(
      pool as unknown as Pool,
      config('false'),
    );

    await service.scheduled();

    // Prendre une connexion pour la rendre aussitôt serait sans conséquence sur
    // une instance au repos, et coûterait une connexion du pool à chaque tick
    // sur une instance qui en manque déjà. Le drapeau se lit avant, pas après.
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('n’exécute aucune écriture quand le verrou est tenu ailleurs', async () => {
    const statements: string[] = [];

    const client = {
      query: jest.fn((query: { text: string }) => {
        statements.push(query.text);

        return Promise.resolve({ rows: [{ locked: false }], rowCount: 1 });
      }),
      release: jest.fn(),
    };

    const pool = { connect: jest.fn().mockResolvedValue(client) };

    const service = new RetentionService(pool as unknown as Pool, config());

    const report = await service.purge();

    expect(report.ran).toBe(false);

    // La sonde de verrou, et rien d'autre. Pas même le `unlock` : relâcher un
    // verrou qu'on n'a pas pris relâcherait celui de l'instance qui travaille.
    expect(statements).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
    ]);

    // Rendue quoi qu'il arrive : une connexion retenue par une purge qui n'a
    // rien fait finirait par assécher le pool, un tick par nuit.
    expect(client.release).toHaveBeenCalled();
  });
});
