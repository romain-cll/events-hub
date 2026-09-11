import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import type { DrizzleTransaction } from '../database/database.module';
import { events, sessions } from '../database/schema';
import type { Location } from '../geoip/geoip.service';
import type { Client } from '../user-agent/user-agent.service';
import type { Campaign } from './campaign';

/**
 * L'inactivité maximale à l'intérieur d'une session.
 *
 * Deux événements successifs d'un même visiteur restent dans la même session
 * tant que l'écart entre leurs `occurredAt` est **inférieur ou égal** à cette
 * valeur. Au-delà — strictement — une nouvelle session commence.
 *
 * Trente minutes est une convention de l'analyse web, pas une propriété du
 * comportement observé. Elle vit ici parce que c'est ici qu'elle est appliquée,
 * et parce que le découpage est persisté : contrairement aux définitions qui
 * vivent dans Analytics, la changer ne suffirait pas — il faudrait reconstruire
 * l'historique. C'est le prix assumé d'une source de vérité unique.
 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** Ce qu'il faut savoir pour rattacher un événement à une session. */
export interface SessionCandidate {
  projectId: string;
  visitorKey: string;
  /**
   * La clé que le même visiteur portait **avant la rotation de minuit UTC**,
   * quand l'événement tombe dans les trente minutes qui la suivent.
   *
   * Sans elle, une session qui traverse minuit est coupée en deux : la clé a
   * changé, donc le voisin d'avant minuit est invisible. C'est
   * `CoreService.previousKey` qui décide de la poser — ici, on se contente de
   * chercher le voisin sous les deux clés.
   *
   * Absente en journée, c'est-à-dire dans l'immense majorité des cas.
   */
  fallbackKey?: string;
  occurredAt: Date;
  /**
   * D'où vient le visiteur, résolu depuis son IP par `GeoIpService`.
   *
   * **Utilisée à l'ouverture seulement.** Une session qui existe déjà garde la
   * position qu'elle avait : c'est celle du visiteur *quand il est arrivé*, et
   * la réécrire à chaque événement la ferait osciller sur un mobile qui change
   * de réseau — pour un gain nul, puisqu'aucune lecture ne demande « où était-il
   * à la troisième page ».
   */
  location?: Location;
  /**
   * Avec quoi il navigue, dérivé de son User-Agent par `UserAgentService`.
   *
   * **Utilisée à l'ouverture seulement**, comme `location` et pour la même
   * raison : c'est un attribut de la visite. La réécrire à chaque événement la
   * ferait osciller au fil d'une mise à jour de navigateur, pour un gain nul —
   * aucune lecture ne demande « avec quoi naviguait-il à la troisième page ».
   *
   * Le cas ne se présente d'ailleurs presque jamais : en mode dérivé, le
   * User-Agent entre dans la clé visiteur, donc deux en-têtes différents
   * ouvrent deux sessions. Seul un visiteur consenti peut changer de navigateur
   * en cours de visite — le premier gagne.
   */
  client?: Client;
  /**
   * D'où vient la visite, quand une campagne l'a amenée.
   *
   * **Utilisée à l'ouverture seulement**, comme `location` et `client`, et c'est
   * ici que ça compte le plus. Par événement, une visite de trois pages dirait
   * trois arrivées de la même campagne : les UTM restent dans l'URL après le
   * premier chargement, et sur une application monopage ils y restent tant que
   * personne n'a réécrit l'historique. L'erreur serait exactement
   * proportionnelle à la profondeur des visites — invisible, et d'autant plus
   * grosse que le site est bon.
   *
   * Ce que ça coûte : un visiteur déjà présent qui clique une publicité dans un
   * second onglet moins de trente minutes plus tard ne change pas la campagne de
   * sa session. C'est le prix exact de « posé à l'ouverture », le même que pour
   * la position géographique.
   */
  campaign?: Campaign | null;
}

/** Un voisin : son instant et la session à laquelle il appartient. */
interface Neighbour {
  sessionId: string;
  occurredAt: Date;
}

/**
 * Attribue une session à chaque événement entrant, et la persiste.
 *
 * ## Le piège que ce service évite
 *
 * L'implémentation naïve compare l'événement entrant au **dernier événement
 * inséré** pour ce visiteur. C'est faux dès qu'un événement arrive en retard, ce
 * qui est le cas normal : le SDK peut émettre en `keepalive` pendant que la page
 * se décharge, et un tel envoi est livré bien après des événements qui lui sont
 * postérieurs.
 *
 *     arrivé en 1er : occurredAt 10:00
 *     arrivé en 2e  : occurredAt 09:20   ← 40 min *avant* le précédent
 *
 * Comparer 09:20 à 10:00 donnerait 40 minutes, donc une session neuve — alors
 * que cet événement appartient à ce qui se passait à 09:20.
 *
 * La bonne question n'est donc pas chronologique au sens de l'arrivée, elle est
 * **spatiale** : quels sont les deux voisins les plus proches de `t` dans le
 * temps de l'événement ? L'ordre d'arrivée HTTP ne joue plus aucun rôle, et
 * l'attribution devient indépendante du réseau.
 *
 * ## Les quatre cas
 *
 * Avec `prev` le voisin le plus proche à `t` ou avant, et `next` le plus proche
 * après :
 *
 * | `t - prev` | `next - t` | décision                       |
 * |------------|------------|--------------------------------|
 * | ≤ 30 min   | > 30 min   | rejoint la session de `prev`   |
 * | > 30 min   | ≤ 30 min   | rejoint la session de `next`   |
 * | > 30 min   | > 30 min   | ouvre une nouvelle session     |
 * | ≤ 30 min   | ≤ 30 min   | **fusionne** les deux sessions |
 *
 * Le dernier cas est le vrai travail. Un événement qui tombe à moins de trente
 * minutes de deux sessions distinctes démontre qu'elles n'auraient jamais dû en
 * faire deux : on les recolle plutôt que de laisser une coupure dont on sait
 * qu'elle est fausse.
 *
 * La fusion ne peut pas cascader. `prev` et `next` sont uniques, donc au plus
 * deux sessions sont pontées ; et recoller ne déplace aucun `occurredAt`, donc
 * une troisième session reste à plus de trente minutes. Le travail est borné par
 * la taille de la session absorbée.
 *
 * ## Où vit l'état
 *
 * Dans la table, et nulle part ailleurs. Aucun cache, aucune mémoire de
 * processus : tout ce qu'il faut savoir se déduit des deux voisins, donc de
 * lignes déjà écrites. C'est ce qui rend le mécanisme correct sur plusieurs
 * instances d'API, à travers un redémarrage, et sans aucune synchronisation
 * applicative.
 *
 * ## La concurrence
 *
 * Deux onglets qui postent en même temps liraient tous les deux « aucun voisin »
 * et créeraient tous les deux une session. Un verrou consultatif Postgres, pris
 * sur `(projet, clé visiteur)`, sérialise l'attribution pour ce visiteur-là et
 * pour lui seul — deux visiteurs différents ne se croisent jamais, le débit
 * global est intact.
 *
 * `pg_advisory_xact_lock` se libère au `COMMIT` **ou au `ROLLBACK`**, y compris
 * si le process meurt : aucun verrou orphelin à nettoyer. Et c'est un verrou
 * dans Postgres, donc il vaut entre instances sans rien à coordonner.
 *
 * `hashtext` réduit à un entier 32 bits : deux visiteurs peuvent entrer en
 * collision et s'attendre inutilement. Ça coûte un peu de latence, jamais une
 * erreur.
 */
@Injectable()
export class SessionAssigner {
  /**
   * Rend la session à laquelle l'événement doit être rattaché, en la créant, en
   * l'étendant ou en fusionnant deux sessions selon le cas.
   *
   * Doit être appelée **dans la transaction qui insère l'événement** : le verrou
   * ne protège que jusqu'au `COMMIT`, et relâcher entre l'attribution et
   * l'insertion rouvrirait exactement la course qu'il empêche.
   */
  async assign(
    tx: DrizzleTransaction,
    {
      projectId,
      visitorKey,
      fallbackKey,
      occurredAt,
      location,
      client,
      campaign,
    }: SessionCandidate,
  ): Promise<string> {
    // Triées, et c'est la seule chose qui compte : deux requêtes du même
    // visiteur à cheval sur minuit portent les deux mêmes clés dans un ordre
    // qui ne dépend pas de laquelle est « celle du jour ». Les prendre dans un
    // ordre stable interdit l'interblocage.
    const keys =
      fallbackKey === undefined
        ? [visitorKey]
        : [visitorKey, fallbackKey].sort();

    for (const key of keys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${projectId} || ${key}))`,
      );
    }

    const [previous, next] = await Promise.all([
      this.neighbour(tx, projectId, keys, occurredAt, 'before'),
      this.neighbour(tx, projectId, keys, occurredAt, 'after'),
    ]);

    const joinsPrevious =
      previous !== null && this.within(previous, occurredAt);
    const joinsNext = next !== null && this.within(next, occurredAt);

    if (joinsPrevious && joinsNext) {
      // Les deux voisins sont assez proches : l'événement fait le pont.
      return previous.sessionId === next.sessionId
        ? this.extend(tx, previous.sessionId, occurredAt)
        : this.merge(tx, previous.sessionId, next.sessionId, occurredAt);
    }

    if (joinsPrevious) return this.extend(tx, previous.sessionId, occurredAt);
    if (joinsNext) return this.extend(tx, next.sessionId, occurredAt);

    return this.open(
      tx,
      projectId,
      visitorKey,
      occurredAt,
      location,
      client,
      campaign,
    );
  }

  /** L'écart entre un voisin et l'événement tient-il dans une session ? */
  private within(neighbour: Neighbour, occurredAt: Date): boolean {
    const gap = Math.abs(occurredAt.getTime() - neighbour.occurredAt.getTime());

    // Inférieur **ou égal** : trente minutes pile restent la même session.
    return gap <= SESSION_GAP_MS;
  }

  /**
   * L'événement le plus proche de `occurredAt`, avant ou après, pour ce
   * visiteur.
   *
   * La clé visiteur vit sur `sessions`, pas sur l'événement : la jointure est
   * le prix de cette séparation, et l'index `(project_id, visitor_key)` la rend
   * directe.
   *
   * Le côté « avant » inclut l'égalité, le côté « après » l'exclut : deux
   * événements au même instant tombent ainsi du même côté, et aucun n'est vu
   * deux fois.
   *
   * ## Pourquoi plusieurs clés, et pas deux appels
   *
   * Autour de minuit, le même visiteur en porte deux (voir
   * `SessionCandidate.fallbackKey`). Un `in` les couvre en une requête, et
   * surtout l'`order by` rend alors **le plus proche des deux** sans qu'on ait
   * à comparer deux résultats à la main — départager après coup demanderait de
   * réécrire ici la règle que la requête applique déjà.
   */
  private async neighbour(
    tx: DrizzleTransaction,
    projectId: string,
    visitorKeys: string[],
    occurredAt: Date,
    side: 'before' | 'after',
  ): Promise<Neighbour | null> {
    const [row] = await tx
      .select({
        // `sessions.id` plutôt qu'`events.session_id` : les deux valent la même
        // chose sous cette jointure, mais celle-ci n'est pas nullable. Depuis
        // qu'un événement peut ne pas avoir de session, lire la colonne portante
        // obligerait à écarter un `null` que la jointure a déjà exclu.
        sessionId: sessions.id,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .innerJoin(sessions, eq(events.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.projectId, projectId),
          inArray(sessions.visitorKey, visitorKeys),
          side === 'before'
            ? lte(events.occurredAt, occurredAt)
            : gt(events.occurredAt, occurredAt),
        ),
      )
      .orderBy(
        side === 'before' ? desc(events.occurredAt) : asc(events.occurredAt),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * Ouvre une session neuve, commençant à cet instant.
   *
   * Le seul endroit où la position est écrite — voir `SessionCandidate.location`
   * pour la raison. `location` absente laisse les trois colonnes à `null`, ce
   * qui est le cas normal quand la base GeoIP n'est pas là.
   */
  private async open(
    tx: DrizzleTransaction,
    projectId: string,
    visitorKey: string,
    occurredAt: Date,
    location?: Location,
    client?: Client,
    campaign?: Campaign | null,
  ): Promise<string> {
    const [session] = await tx
      .insert(sessions)
      .values({
        projectId,
        visitorKey,
        startedAt: occurredAt,
        countryCode: location?.countryCode,
        region: location?.region,
        city: location?.city,
        browser: client?.browser,
        os: client?.os,
        deviceType: client?.deviceType,
        isBot: client?.isBot,
        campaignSource: campaign?.source,
        campaignMedium: campaign?.medium,
        campaignName: campaign?.name,
      })
      .returning({ id: sessions.id });

    return session.id;
  }

  /**
   * Rattache l'événement à une session existante.
   *
   * `startedAt` peut **reculer** : un événement arrivé en retard, antérieur à
   * tout ce qu'on connaissait de la session, en avance la borne de début. Le
   * `least` est fait par Postgres plutôt qu'en JavaScript pour rester dans la
   * transaction et ne pas relire la ligne.
   */
  private async extend(
    tx: DrizzleTransaction,
    sessionId: string,
    occurredAt: Date,
  ): Promise<string> {
    await tx
      .update(sessions)
      .set({ startedAt: sql`least(${sessions.startedAt}, ${occurredAt})` })
      .where(eq(sessions.id, sessionId));

    return sessionId;
  }

  /**
   * Recolle deux sessions qu'un événement vient de révéler n'en être qu'une.
   *
   * La survivante est celle qui a commencé le plus tôt — un choix arbitraire
   * mais déterministe, et le seul qui garde `startedAt` cohérent sans le
   * recalculer.
   *
   * Autour de minuit, les deux sessions pontées peuvent porter **deux clés
   * visiteur différentes** (voir `SessionCandidate.fallbackKey`). La survivante
   * garde la sienne, donc celle de la veille, et les événements d'après minuit
   * la rejoignent : une session ne porte toujours qu'une clé, et le visiteur
   * n'est pas compté deux fois sur la fenêtre qui les contient.
   *
   * L'ordre compte : on déplace les événements **avant** de supprimer la session
   * absorbée, sinon la clé étrangère refuse la suppression. C'est elle qui
   * garantit qu'aucun événement ne se retrouve orphelin, même si ce code se
   * trompe.
   */
  private async merge(
    tx: DrizzleTransaction,
    first: string,
    second: string,
    occurredAt: Date,
  ): Promise<string> {
    const bornes = await tx
      .select({ id: sessions.id, startedAt: sessions.startedAt })
      .from(sessions)
      .where(sql`${sessions.id} in (${first}, ${second})`)
      .orderBy(asc(sessions.startedAt), asc(sessions.id));

    const [survivante, absorbee] = bornes;

    await tx
      .update(events)
      .set({ sessionId: survivante.id })
      .where(eq(events.sessionId, absorbee.id));

    await tx.delete(sessions).where(eq(sessions.id, absorbee.id));

    await tx
      .update(sessions)
      .set({
        startedAt: sql`least(${sessions.startedAt}, ${absorbee.startedAt}, ${occurredAt})`,
      })
      .where(eq(sessions.id, survivante.id));

    return survivante.id;
  }
}
