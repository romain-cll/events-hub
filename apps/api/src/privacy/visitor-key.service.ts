import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Métadonnées réseau d'une requête d'ingestion. Elles ne viennent jamais du
 * payload : le SDK ne les envoie pas, le serveur les lit sur la connexion HTTP.
 * Un site ne peut donc pas se déclarer visiteur de quelqu'un d'autre.
 */
export interface VisitorIdentity {
  projectId: string;
  ip: string;
  userAgent: string;
}

/**
 * Sépare les composants avant hachage. Un simple `+` rendrait
 * `("abc", "12")` et `("ab", "c12")` indistinguables ; le saut de ligne lève
 * l'ambiguïté et ne peut apparaître dans aucun des trois champs (un en-tête
 * HTTP ne contient pas de saut de ligne, une IP ni un UUID non plus).
 */
const SEPARATOR = '\n';

/**
 * Dérive un identifiant de visiteur éphémère à partir de données qu'on ne
 * conserve pas.
 *
 * ## Le mécanisme
 *
 * `visitor_key = HMAC(secret_du_jour, project_id + ip + user_agent)`, avec
 * `secret_du_jour = HMAC(secret_maître, 'AAAA-MM-JJ')`.
 *
 * Trois propriétés en découlent, et ce sont exactement celles qu'on veut :
 * un même visiteur produit la même clé toute la journée (donc on sait compter
 * des visiteurs uniques) ; le lendemain la clé change (donc on ne peut pas
 * suivre quelqu'un dans le temps) ; et la clé est cloisonnée par projet (donc
 * deux sites clients ne peuvent pas recouper leurs audiences).
 *
 * ## Le recouvrement de trente minutes
 *
 * Ce service ne rend qu'**une** clé, celle du jour de l'instant qu'on lui
 * passe. Mais l'ingestion en demande deux autour de minuit : la clé du moment
 * et celle d'il y a trente minutes (`CoreService.previousKey`), pour qu'une
 * session en cours ne soit pas coupée par la rotation.
 *
 * La rotation n'est donc pas une frontière étanche côté découpage : pendant
 * trente minutes, deux clés du même visiteur coexistent et une session peut
 * traverser minuit — elle garde alors celle de la veille. C'est un arbitrage
 * assumé et borné, pas un effet de bord : sans lui, tout visiteur actif à
 * minuit compterait double.
 *
 * ## Ce que ça protège, et ce que ça ne protège pas
 *
 * Le HMAC est à sens unique : la clé stockée ne redonne pas l'IP. Mais l'espace
 * des IPv4 est petit — qui détient le secret du jour peut tester les quatre
 * milliards d'adresses et retrouver la correspondance. La garantie ne tient
 * donc pas au hachage seul, elle tient au fait que **le secret ne vit pas à
 * côté de la donnée** : la base ne contient aucun secret.
 *
 * Limite assumée à ce stade : le secret du jour étant dérivé d'un secret
 * maître, il reste recalculable pour n'importe quel jour passé tant que ce
 * secret maître existe. Une vraie rotation (secret aléatoire par jour, détruit
 * au bout de 48 h) rendrait les clés d'hier définitivement irréversibles. C'est
 * l'étape d'après, pas celle-ci.
 */
@Injectable()
export class VisitorKeyService {
  private readonly masterSecret: string;

  constructor(config: ConfigService) {
    // `getOrThrow` : sans secret, on ne dégrade pas silencieusement vers une
    // valeur par défaut — toutes les clés deviendraient calculables par
    // n'importe qui ayant lu le code. L'API refuse de démarrer.
    this.masterSecret = config.getOrThrow<string>('VISITOR_KEY_SECRET');
  }

  /**
   * `now` est l'heure d'arrivée de la requête, pas l'`occurredAt` du payload :
   * celui-ci est fourni par le client, qui pourrait l'antidater pour forcer le
   * secret d'un jour donné. Paramétrable pour que les tests puissent traverser
   * un changement de jour sans toucher à l'horloge système.
   */
  compute(identity: VisitorIdentity, now: Date = new Date()): string {
    const payload = [identity.projectId, identity.ip, identity.userAgent].join(
      SEPARATOR,
    );

    return createHmac('sha256', this.dailySecret(now))
      .update(payload)
      .digest('hex');
  }

  /**
   * Le jour est découpé en UTC, pas dans le fuseau du serveur : la frontière de
   * rotation doit être la même partout, sinon deux instances déployées dans
   * deux régions produiraient des clés différentes pour le même visiteur.
   */
  private dailySecret(now: Date): Buffer {
    const day = now.toISOString().slice(0, 10);

    return createHmac('sha256', this.masterSecret).update(day).digest();
  }
}
