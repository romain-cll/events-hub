import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';

import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import { isForeignKeyViolation } from '../database/postgres-errors';
import type { EventSource } from '../database/schema';
import { EventTypeRegistry } from '../event-types/event-type-registry.service';
import { EventStore, type PublicEvent } from '../events/event-store.service';
import { GeoIpService } from '../geoip/geoip.service';
import {
  VisitorKeyService,
  type VisitorIdentity,
} from '../privacy/visitor-key.service';
import {
  SESSION_GAP_MS,
  SessionAssigner,
} from '../sessions/session-assigner.service';

/** Ce qu'une requête HTTP apporte du réseau, et qui ne sort jamais d'ici. */
export type NetworkIdentity = Omit<VisitorIdentity, 'projectId'>;

/** Ce que tout événement porte, quelle que soit sa provenance. */
interface IngestBase {
  projectId: string;
  type: string;
  occurredAt: Date;
  attributes: Record<string, unknown>;
  properties: Record<string, unknown>;
}

/**
 * Ce qu'il faut au socle pour ingérer un événement.
 *
 * Le type est déclaré ici et **pas importé du DTO Zod** de `ingestion/`. C'est
 * délibéré : le DTO est le contrat *du fil*, versionné avec l'API HTTP, tandis
 * que ceci est la commande du domaine. Les faire coïncider par un import ferait
 * dépendre le socle de son adaptateur — et le jour où l'ingestion accepte un
 * second format (un lot, un webhook, une file), c'est le socle qu'il faudrait
 * rouvrir.
 *
 * ## L'union est discriminée, et c'est le cœur du lot
 *
 * Un événement navigateur **exige** une identité réseau ; un événement serveur
 * n'en a pas. Un paramètre optionnel aurait laissé les deux erreurs possibles :
 * un chemin navigateur sans IP (donc une clé visiteur dérivée du vide, donc tous
 * les visiteurs confondus en un seul), et un chemin serveur *avec* IP (donc la
 * tentation de s'en servir un jour).
 *
 * Ici, les deux sont des erreurs de compilation. Le chemin serveur ne peut pas
 * recevoir d'IP, donc il ne peut pas en faire quelque chose.
 */
export type IngestCommand =
  | (IngestBase & { source: 'browser'; network: NetworkIdentity })
  | (IngestBase & { source: 'server' });

/**
 * Le socle d'ingestion, et il ne fait que ça.
 *
 * ## Deux chemins, un seul point de commit
 *
 * Un événement **navigateur** traverse quatre collaborateurs : la clé visiteur
 * en est dérivée (`privacy/`), une session lui est attribuée (`sessions/`), son
 * type est inscrit au vocabulaire du projet (`event-types/`), puis il est écrit
 * (`events/`).
 *
 * Un événement **serveur** n'en traverse que deux : le vocabulaire et
 * l'écriture. Il n'a pas de visiteur, donc rien à dériver et rien à rattacher —
 * lui fabriquer une session depuis l'IP du runner qui l'émet produirait un faux
 * visiteur, compté dans les visiteurs uniques du projet.
 *
 * Ce service n'est le lieu d'aucun des collaborateurs — il est le lieu de
 * **leur enchaînement**, et surtout du point de commit qui les rend atomiques.
 *
 * Il ne connaît la signification d'aucun type d'événement, ne valide aucune
 * forme (le pipe Zod a tourné avant lui) et n'expose aucune route : c'est
 * `ingestion/` qui le branche sur HTTP.
 */
@Injectable()
export class CoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDatabase,
    private readonly visitorKeys: VisitorKeyService,
    private readonly geoIp: GeoIpService,
    private readonly sessionAssigner: SessionAssigner,
    private readonly eventTypes: EventTypeRegistry,
    private readonly eventStore: EventStore,
  ) {}

  /**
   * Ingère un événement et rend la ligne écrite, `sessionId` mis à part.
   *
   * L'existence du projet n'est pas vérifiée par un `SELECT` préalable : ça
   * coûterait un aller-retour de plus *et* laisserait une fenêtre entre la
   * vérification et l'insertion. On laisse la clé étrangère trancher — elle
   * est la seule à le faire de façon atomique — et on traduit son refus en
   * 422 : le corps est bien formé, mais il désigne un projet qui n'existe pas.
   *
   * La transaction n'est pas une précaution de principe : l'attribution de
   * session prend un verrou consultatif qui ne tient que jusqu'au `COMMIT`.
   * Attribuer puis insérer hors transaction rouvrirait la course que le verrou
   * empêche — deux onglets pourraient créer deux sessions pour le même visiteur.
   * Le chemin serveur n'a pas ce besoin, mais il partage la transaction pour que
   * l'inscription du type et l'écriture de l'événement restent solidaires.
   */
  async ingest(command: IngestCommand): Promise<PublicEvent> {
    try {
      return await this.db.transaction(async (tx) => {
        const sessionId =
          command.source === 'browser'
            ? await this.assignSession(tx, command.projectId, command)
            : null;

        await this.eventTypes.register(tx, command.projectId, command.type);

        return await this.eventStore.insert(tx, {
          projectId: command.projectId,
          type: command.type,
          occurredAt: command.occurredAt,
          attributes: command.attributes,
          properties: command.properties,
          source: command.source,
          sessionId,
        });
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new UnprocessableEntityException(
          `Le projet ${command.projectId} n'existe pas.`,
        );
      }

      throw error;
    }
  }

  /**
   * Le chemin navigateur, isolé pour que le chemin serveur ne puisse pas
   * l'emprunter par distraction.
   *
   * L'IP et le User-Agent s'arrêtent ici : ils ne sont ni écrits, ni
   * journalisés, ni renvoyés. Seuls en sortent la clé visiteur et trois libellés
   * géographiques grossiers, tous non réversibles, et tous sur la ligne
   * `sessions`. `network` sort de portée avec la requête.
   */
  private async assignSession(
    tx: Parameters<typeof this.sessionAssigner.assign>[0],
    projectId: string,
    { network, occurredAt }: { network: NetworkIdentity; occurredAt: Date },
  ): Promise<string> {
    const identity = { projectId, ...network };
    const now = new Date();
    const visitorKey = this.visitorKeys.compute(identity, now);

    return await this.sessionAssigner.assign(tx, {
      projectId,
      visitorKey,
      fallbackKey: this.previousKey(identity, now, visitorKey),
      occurredAt,
      // Résolue à chaque événement, écrite seulement à l'ouverture d'une
      // session — c'est l'assigneur qui le sait, pas nous. Le lookup est en
      // mémoire et synchrone : le tester ici demanderait de savoir si une
      // session existe déjà, donc de dupliquer sa décision.
      location: this.geoIp.locate(network.ip),
    });
  }

  /**
   * La clé de la veille, pendant les trente minutes qui suivent minuit UTC.
   *
   * ## Le problème
   *
   * La clé visiteur est dérivée du **jour UTC** : à minuit elle change, donc
   * `SessionAssigner` ne reconnaît plus le voisin et ouvre une session neuve.
   * Quelqu'un qui navigue de 23 h 58 à 00 h 02 compte alors pour deux visites
   * d'une page au lieu d'une visite de deux pages — `sessions` est gonflé, et
   * le taux de rebond avec, tous les jours, sur la même tranche horaire.
   *
   * C'est la borne de confidentialité qui déborde sur le découpage, et rien ne
   * l'exige : la clé peut tourner sans que la session se coupe.
   *
   * ## La règle
   *
   * On recalcule la clé **telle qu'elle était il y a trente minutes**. En
   * pleine journée elle est identique, et il n'y a pas de repli. Dans les
   * trente minutes qui suivent minuit elle diffère, et c'est exactement le
   * tampon voulu : aucune arithmétique de minuit n'est écrite ici, la
   * comparaison des deux clés *est* le test.
   *
   * Le tampon vaut `SESSION_GAP_MS` et pas une constante à lui : au-delà de
   * trente minutes, le voisin d'hier échouerait de toute façon au test
   * d'inactivité de l'assigneur. Un tampon plus large serait du code mort, un
   * tampon plus court recouperait des sessions.
   *
   * ## Ce que ça coûte côté vie privée
   *
   * Pendant ces trente minutes, deux clés du même visiteur coexistent, donc la
   * rotation quotidienne est franchissable sur ce créneau — c'est le prix
   * assumé, et il est borné. La session qui traverse minuit **garde la clé de
   * la veille** : rien n'est réécrit, et une session n'appartient toujours
   * qu'à un seul visiteur.
   */
  private previousKey(
    identity: VisitorIdentity,
    now: Date,
    current: string,
  ): string | undefined {
    const previous = this.visitorKeys.compute(
      identity,
      new Date(now.getTime() - SESSION_GAP_MS),
    );

    return previous === current ? undefined : previous;
  }
}
