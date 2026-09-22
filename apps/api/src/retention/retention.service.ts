import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { PG_POOL } from '../database/database.module';
import { events, sessions } from '../database/schema';
import { RETENTION_MONTHS, retentionCutoff } from './cutoff';

/**
 * Combien de sessions la passe A emporte par transaction.
 *
 * Le découpage n'est pas là pour le verrou — il ne bloque personne — mais pour
 * trois choses qu'une seule grande transaction coûterait : l'`xmin` figé, qui
 * empêche l'autovacuum de nettoyer quoi que ce soit **sur toute la base** tant
 * qu'elle dure ; le volume de WAL qu'une réplique devrait avaler d'un coup ; et
 * un rollback dont la durée serait celle du travail déjà fait.
 *
 * Mille sessions parce que c'est l'ordre de grandeur où le coût par transaction
 * devient négligeable devant le travail qu'elle fait. Rien de plus précis :
 * ajuster ce chiffre ne changera jamais la correction, seulement le grain.
 *
 * Exporté pour la seule suite e2e, qui doit en poser davantage pour éprouver
 * que la boucle repasse. Écrire le nombre en dur là-bas ferait passer le test
 * en vert le jour où on baisserait la taille de lot ici.
 */
export const SESSION_BATCH = 1_000;

/** Combien d'événements la passe B anonymise par instruction. Même raison. */
const EVENT_BATCH = 10_000;

/**
 * Le temps qu'une purge s'autorise avant de rendre la main.
 *
 * La reprise est **gratuite**, et c'est ce qui rend ce budget possible : les
 * deux prédicats rétrécissent à mesure que le travail avance, donc le tick
 * suivant repart exactement où celui-ci s'est arrêté, sans curseur à mémoriser
 * ni état à écrire. C'est aussi ce qui rend le premier passage sur vingt-cinq
 * mois d'arriéré supportable — il s'étale sur autant de nuits qu'il faut.
 */
const BUDGET_MS = 10 * 60 * 1_000;

/**
 * Les deux entiers du verrou consultatif.
 *
 * La forme à **deux** arguments est délibérée. `SessionAssigner` occupe déjà
 * l'espace à un seul argument avec `hashtext(project || key)`, et son verrou est
 * **bloquant** : une collision entre les deux espaces ferait attendre un
 * visiteur pendant toute la durée d'une purge. Postgres traite les deux formes
 * comme des espaces de noms disjoints — ils ne peuvent pas se rencontrer.
 *
 * Les valeurs elles-mêmes n'ont pas de sens à défendre : elles doivent
 * seulement être stables d'une version à l'autre, sinon deux instances de
 * versions différentes se croiseraient sans se voir.
 */
const LOCK_CLASS = 1;
const LOCK_OBJECT = 1;

/**
 * Drizzle branché sur **une** connexion, et pas sur le pool.
 *
 * Le type est nommé pour que les deux passes ne puissent pas être appelées avec
 * l'instance globale par distraction : elles seraient correctes à la lecture et
 * fausses à l'exécution, puisque le verrou vit sur la connexion.
 */
type PinnedDatabase = NodePgDatabase;

/** Ce qu'une purge a fait, pour le log et pour les tests. */
export interface PurgeReport {
  /** Faux si une autre instance tenait le verrou : rien n'a été tenté. */
  ran: boolean;
  /** Sessions supprimées, avec tous leurs événements. */
  sessionsDeleted: number;
  /** Événements supprimés parce que leur visite entière était expirée. */
  eventsDeleted: number;
  /** Événements sans visite dont l'identité durable a été effacée. */
  eventsAnonymised: number;
  /** Vrai si le budget de temps a coupé avant d'avoir épuisé le travail. */
  interrupted: boolean;
}

/**
 * La purge : au-delà de vingt-cinq mois, l'identité part.
 *
 * ## Anonymiser plutôt que détruire, partout où c'est possible
 *
 * C'est l'arbitrage central du module, et il vient du produit : la question
 * posée est « qu'est-ce qui a un impact sur le revenu », et y répondre sur
 * plusieurs années demande de garder les montants. Ce que le cadre exige, ce
 * n'est pas d'oublier qu'un paiement a eu lieu, c'est d'oublier **qui** l'a
 * fait.
 *
 * Un événement sans visite — une ligne rapportée par un serveur — n'a donc pas à
 * disparaître : il perd sa clé visiteur et garde tout le reste. Un événement de
 * visite, lui, ne survit pas à sa session : sa valeur *est* le parcours, et un
 * parcours dont on a retiré le visiteur ne décrit plus rien.
 *
 * ## Pourquoi ce module est dans le socle et non dans `features/`
 *
 * Ce n'est pas un rangement : `architecture.spec.ts` interdit à tout fichier
 * sous `features/` de **nommer** la clé visiteur, et la purge doit précisément
 * la passer à `NULL`. Le code ne peut littéralement pas y vivre.
 *
 * Il est monté dans `AppModule` comme `IngestionModule`, pour la raison
 * inverse de celle des autres modules du socle : rien ne le tire, il n'a aucun
 * appelant.
 *
 * ## Les deux formulations naïves sont fausses
 *
 * `DELETE FROM events WHERE occurred_at < borne` laisse derrière lui des
 * sessions vides, que plus rien ne rattrape et que toutes les lectures de
 * sessions comptent. `DELETE FROM sessions WHERE started_at < borne` viole le
 * `restrict` dès qu'un seul événement récent y pointe — et **le cas est réel** :
 * le commentaire de `sessions.ts` affirme qu'une session ne traverse pas minuit
 * parce que la clé tourne, ce qui est vrai sans consentement et faux avec. Une
 * session consentie peut s'étaler sur des jours, et son `started_at` peut en
 * plus reculer sur un événement arrivé en retard.
 *
 * La sortie est de **piloter par la session, jamais par la date de
 * l'événement** : on ne retient que les sessions dont *aucun* événement n'est
 * au-delà de la borne, puis on supprime leurs événements par `session_id`. Ni
 * orpheline, ni `restrict`, par construction — et non pas parce qu'on y aurait
 * pensé.
 *
 * ## Aucun cloisonnement par projet
 *
 * La purge balaie la plateforme. Cloisonner ouvrirait la possibilité qu'un
 * projet y échappe — par un appelant qui l'oublie, ou par une liste de projets
 * qu'on aurait construite avant qu'un dernier n'arrive.
 *
 * ⚠️ C'est aussi ce qui rend `purge()` dangereuse pour les suites de tests :
 * toute fixture datée à plus de vingt-cinq mois est emportée, quelle que soit la
 * suite qui l'a posée.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  /**
   * Ne gouverne **que** le déclenchement planifié, jamais `purge()`.
   *
   * Un drapeau qui court-circuiterait aussi la méthode rendrait la purge
   * intestable : les suites l'appellent explicitement, et elles le font
   * justement pour ne pas dépendre d'une horloge.
   */
  private readonly enabled: boolean;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    config: ConfigService,
  ) {
    // Activée par défaut : une rétention qu'il faut penser à allumer est une
    // rétention qu'on découvre absente le jour où on en a besoin.
    this.enabled = config.get<string>('RETENTION_ENABLED') !== 'false';
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.logger.log(
        `Purge à ${RETENTION_MONTHS} mois active, tous les jours à 03:15 UTC.`,
      );

      return;
    }

    // Un `warn` et non un `log` : une instance qui ne purge pas est un état
    // qu'on veut voir dans les journaux du jour où on se demande pourquoi rien
    // n'a été effacé.
    this.logger.warn(
      'RETENTION_ENABLED=false : aucune purge planifiée sur cette instance.',
    );
  }

  /**
   * Une expression complète plutôt que `EVERY_DAY_AT_3AM`.
   *
   * La constante de `@nestjs/schedule` suit le fuseau du **serveur**, alors que
   * tout le produit raisonne en UTC — la rotation de la clé visiteur, le
   * découpage des journées, la borne calculée ici. Un serveur déplacé de fuseau
   * décalerait la purge sans que rien ne le dise.
   *
   * 03:15 et non 03:00 : l'heure ronde est celle où tout le reste se déclenche.
   */
  @Cron('0 15 3 * * *', { timeZone: 'UTC' })
  async scheduled(): Promise<void> {
    if (!this.enabled) return;

    try {
      const report = await this.purge();

      if (!report.ran) {
        this.logger.log('Purge déjà en cours ailleurs, rien à faire.');

        return;
      }

      this.logger.log(
        `Purge : ${report.sessionsDeleted} visites et ${report.eventsDeleted} événements supprimés, ` +
          `${report.eventsAnonymised} événements anonymisés` +
          (report.interrupted
            ? ' (budget épuisé, reprise au prochain tick).'
            : '.'),
      );
    } catch (error) {
      // Avalée ici, et nulle part ailleurs : une exception qui remonte d'un
      // `@Cron` devient un rejet non géré, donc un processus qui meurt. Une
      // purge ratée n'a aucune raison d'emporter l'ingestion avec elle — la
      // borne ne bouge pas, le tick suivant refera le même travail.
      this.logger.error(`Purge interrompue : ${String(error)}`);
    }
  }

  /**
   * Exécute les deux passes et rend ce qu'elles ont fait.
   *
   * ## Une connexion épinglée, et pourquoi elle est obligatoire
   *
   * `db.execute()` prend une connexion **arbitraire du pool à chaque
   * instruction**. Un verrou consultatif de session, lui, appartient à la
   * connexion qui l'a pris : on le poserait sur l'une et on travaillerait sur
   * l'autre, donc on ne protégerait rien tout en ayant l'air de le faire.
   *
   * D'où `pool.connect()` puis une instance Drizzle construite **sur ce client**
   * — le mécanisme est accepté par les types de `node-postgres` et vérifié :
   * `pg_backend_pid()` est le même par le client brut et par Drizzle, y compris
   * dans une transaction ouverte sur cette instance.
   *
   * ## Le verrou est `try`, et de session
   *
   * `try` parce qu'il n'y a **rien à attendre** : si une autre instance purge,
   * le travail sera fait par elle. Attendre ne ferait qu'immobiliser une
   * connexion pour refaire un travail déjà fait.
   *
   * De session et non `xact` parce que l'unité de travail est la passe entière,
   * qui s'étale sur des dizaines de transactions. Un verrou transactionnel se
   * relâcherait entre deux lots, et deux instances se retrouveraient à
   * s'entrelacer au milieu.
   *
   * ⚠️ `client.release()` **ne libère pas** un verrou de session : la connexion
   * retourne au pool en le tenant toujours, et la purge ne repasserait plus
   * jamais. D'où le `unlock` explicite, avant la libération.
   */
  async purge(): Promise<PurgeReport> {
    const deadline = Date.now() + BUDGET_MS;
    const report: PurgeReport = {
      ran: false,
      sessionsDeleted: 0,
      eventsDeleted: 0,
      eventsAnonymised: 0,
      interrupted: false,
    };

    const client = await this.pool.connect();
    const db = drizzle(client, { casing: 'snake_case' });

    let held = false;

    try {
      const lock = await db.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_lock(${LOCK_CLASS}::int, ${LOCK_OBJECT}::int) as locked`,
      );

      held = lock.rows[0]?.locked === true;

      if (!held) return report;

      report.ran = true;

      await this.expireSessions(db, deadline, report);
      await this.anonymiseSessionless(db, deadline, report);

      return report;
    } finally {
      if (held) {
        await db.execute(
          sql`select pg_advisory_unlock(${LOCK_CLASS}::int, ${LOCK_OBJECT}::int)`,
        );
      }

      client.release();
    }
  }

  /**
   * Passe A — les visites dont plus aucun événement n'est au-delà de la borne,
   * et tout ce qu'elles portent.
   *
   * ## Deux instructions dans une transaction, pas une CTE modifiante
   *
   * Un `WITH supprimees AS (DELETE FROM events … RETURNING …) DELETE FROM
   * sessions …` semble plus court et serait faux : les sous-instructions d'une
   * CTE modifiante partagent le **même snapshot** et leur ordre d'exécution
   * n'est pas garanti, alors que `RESTRICT` est vérifié immédiatement. La
   * suppression des sessions pourrait donc voir des événements que l'autre
   * branche n'a pas encore retirés.
   *
   * ## Le prédicat sur `started_at` est redondant, et il est là pour l'index
   *
   * Le `NOT EXISTS` suffit à la correction. Mais sans borne sur `started_at`, le
   * parcours de l'index devrait traverser **toute** la table des sessions pour
   * découvrir qu'il n'y a plus rien à faire — chaque nuit, pour rien. Le
   * prédicat est vrai par construction : `started_at` est tenu au minimum des
   * `occurred_at` de la session (voir `SessionAssigner.extend`), donc « aucun
   * événement au-delà de la borne » implique « commencée avant la borne ».
   */
  private async expireSessions(
    db: PinnedDatabase,
    deadline: number,
    report: PurgeReport,
  ): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) {
        report.interrupted = true;

        return;
      }

      const expired = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            lt(sessions.startedAt, retentionCutoff()),
            sql`not exists (select 1 from ${events} where ${and(
              eq(events.sessionId, sessions.id),
              gte(events.occurredAt, retentionCutoff()),
            )})`,
          ),
        )
        .orderBy(asc(sessions.startedAt))
        .limit(SESSION_BATCH);

      if (expired.length === 0) return;

      const ids = expired.map(({ id }) => id);

      await db.transaction(async (tx) => {
        const removed = await tx
          .delete(events)
          .where(inArray(events.sessionId, ids));

        await tx.delete(sessions).where(inArray(sessions.id, ids));

        report.eventsDeleted += removed.rowCount ?? 0;
        report.sessionsDeleted += ids.length;
      });

      // Un lot incomplet dit qu'il n'y avait plus rien à prendre. Repasser
      // coûterait un parcours d'index complet — celui des visites à cheval,
      // qui restent sous la borne et grossissent avec les années — pour
      // découvrir zéro ligne. Ce qui arriverait entre-temps (un événement en
      // retard qui rouvrirait une visite ancienne) attendra le tick suivant,
      // comme tout le reste.
      if (expired.length < SESSION_BATCH) return;
    }
  }

  /**
   * Passe B — les événements **sans visite** au-delà de la borne perdent leur
   * identité durable, et rien d'autre.
   *
   * Type, instant, montants, propriétés : tout reste. C'est la promesse du lot,
   * et c'est celle qui se perdrait le plus silencieusement — un `delete` ici
   * passerait tous les autres tests.
   *
   * Aucune interaction avec la passe A : les deux ensembles sont disjoints par
   * définition (`session_id IS NULL` d'un côté, une session de l'autre) et
   * aucune clé étrangère ne les relie.
   *
   * Le sous-`select` borné plutôt qu'un `UPDATE` nu : sans lui, le premier
   * passage réécrirait des millions de lignes en une seule transaction. L'index
   * partiel qui le sert **rétrécit à mesure que la purge travaille** — une ligne
   * anonymisée sort de son prédicat — là où un index global sur la date serait
   * payé à chaque insertion d'ingestion.
   */
  private async anonymiseSessionless(
    db: PinnedDatabase,
    deadline: number,
    report: PurgeReport,
  ): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) {
        report.interrupted = true;

        return;
      }

      const batch = db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            isNull(events.sessionId),
            isNotNull(events.visitorKey),
            lt(events.occurredAt, retentionCutoff()),
          ),
        )
        .limit(EVENT_BATCH);

      const anonymised = await db
        .update(events)
        .set({ visitorKey: null })
        .where(inArray(events.id, batch));

      const count = anonymised.rowCount ?? 0;

      report.eventsAnonymised += count;

      if (count < EVENT_BATCH) return;
    }
  }
}
