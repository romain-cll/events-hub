import { ConfigService } from '@nestjs/config';

import type { DrizzleDatabase } from '../database/database.module';
import type { EventTypeRegistry } from '../event-types/event-type-registry.service';
import type { EventStore } from '../events/event-store.service';
import type { GeoIpService, Location } from '../geoip/geoip.service';
import { VisitorKeyService } from '../privacy/visitor-key.service';
import type {
  SessionAssigner,
  SessionCandidate,
} from '../sessions/session-assigner.service';
import { CoreService, type IngestCommand } from './core.service';

/**
 * La décision du tampon de minuit, et rien d'autre.
 *
 * Tout le reste de `CoreService` — la transaction, le verrou, la traduction
 * d'une violation de clé étrangère — est éprouvé contre un vrai Postgres dans
 * `test/`. Ce qui se teste utilement ici est la seule chose que la base ne peut
 * pas montrer : **avec quelle clé de repli l'assigneur est appelé**, selon
 * l'heure d'arrivée de la requête.
 *
 * `VisitorKeyService` est le vrai, pas un double : c'est lui qui décide où
 * tombe la frontière de journée, et un double la réécrirait ici.
 */

const identity = { ip: '203.0.113.42', userAgent: 'Mozilla/5.0' };

const PROJECT_ID = '2e95b1b6-2a96-443a-919f-2b3661106689';

const command: IngestCommand = {
  projectId: PROJECT_ID,
  type: 'page_view',
  occurredAt: new Date('2026-08-22T00:02:00.000Z'),
  attributes: {},
  properties: {},
  // Le tampon de minuit n'existe que sur le chemin navigateur : c'est le seul
  // qui dérive une clé visiteur. L'identité réseau voyage donc dans la commande,
  // et l'union discriminée d'`IngestCommand` refuserait de la porter sur l'autre
  // branche — c'est exactement ce qu'on veut qu'elle refuse.
  source: 'browser',
  network: identity,
};

/** Trente minutes, la valeur du tampon — importée nulle part exprès. */
const TRENTE_MINUTES = 30 * 60 * 1000;

const UNKNOWN: Location = { countryCode: null, region: null, city: null };

describe('CoreService — le tampon de minuit', () => {
  const visitorKeys = new VisitorKeyService({
    getOrThrow: () => 'secret-de-test',
  } as unknown as ConfigService);

  let assign: jest.Mock;
  let service: CoreService;

  const cleDu = (instant: string) =>
    visitorKeys.compute(
      { projectId: PROJECT_ID, ...identity },
      new Date(instant),
    );

  /** Le candidat que l'assigneur a reçu. */
  const recu = (): SessionCandidate => {
    const calls = assign.mock.calls as [unknown, SessionCandidate][];

    return calls[0][1];
  };

  beforeEach(() => {
    assign = jest.fn().mockResolvedValue('session-1');

    service = new CoreService(
      // La transaction se réduit à « exécute le corps » : ce test ne regarde
      // pas ce qui est écrit, seulement ce qui est décidé avant.
      {
        transaction: (run: (tx: unknown) => unknown) => run({}),
      } as unknown as DrizzleDatabase,
      visitorKeys,
      // La géo ne joue aucun rôle dans ce que ce fichier éprouve : un service
      // qui ne sait rien suffit, et évite de faire dépendre un test de décision
      // d'un fichier de 124 Mo.
      { locate: () => UNKNOWN } as unknown as GeoIpService,
      { assign } as unknown as SessionAssigner,
      // Le registre des types est appelé sur les deux chemins, mais ce fichier
      // n'éprouve pas ce qu'il inscrit : un double muet suffit.
      {
        register: jest.fn().mockResolvedValue(undefined),
      } as unknown as EventTypeRegistry,
      { insert: jest.fn().mockResolvedValue({}) } as unknown as EventStore,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Fige l'heure d'*arrivée* de la requête — c'est elle qui dérive la clé. */
  const arriveeA = (instant: string) => {
    jest.useFakeTimers().setSystemTime(new Date(instant));
  };

  it('pose la clé de la veille dans les trente minutes qui suivent minuit', async () => {
    arriveeA('2026-08-22T00:02:00.000Z');

    await service.ingest(command);

    // La clé du jour, et celle qu'il portait deux minutes plus tôt : les deux
    // sont attendues, et elles sont différentes.
    expect(recu().visitorKey).toBe(cleDu('2026-08-22T00:02:00.000Z'));
    expect(recu().fallbackKey).toBe(cleDu('2026-08-21T23:58:00.000Z'));
    expect(recu().fallbackKey).not.toBe(recu().visitorKey);
  });

  it('n’en pose aucune en pleine journée', async () => {
    arriveeA('2026-08-22T12:00:00.000Z');

    await service.ingest(command);

    // Le repli vaudrait la même clé : le poser ferait chercher deux fois la
    // même chose, et laisserait croire à un cas particulier là où il n'y en a
    // pas.
    expect(recu().fallbackKey).toBeUndefined();
  });

  it('pose le repli jusqu’à la dernière milliseconde du tampon', async () => {
    arriveeA(
      new Date(Date.UTC(2026, 7, 22) + TRENTE_MINUTES - 1).toISOString(),
    );

    await service.ingest(command);

    expect(recu().fallbackKey).toBe(cleDu('2026-08-21T23:59:59.999Z'));
  });

  it('n’en pose plus une fois le tampon écoulé', async () => {
    // Minuit pile plus trente minutes : `now - 30 min` retombe sur minuit,
    // donc sur le jour même. Rien n'est perdu — à cet instant, le dernier
    // événement de la veille est à plus de trente minutes et échouerait de
    // toute façon au seuil d'inactivité de l'assigneur.
    arriveeA(new Date(Date.UTC(2026, 7, 22) + TRENTE_MINUTES).toISOString());

    await service.ingest(command);

    expect(recu().fallbackKey).toBeUndefined();
  });
});
