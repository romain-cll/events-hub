import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

import { DRIZZLE, type DrizzleDatabase } from '../database/database.module';
import {
  projectKeys,
  type EventSource,
  type ProjectKey,
} from '../database/schema';
import type {
  CreateProjectKeyDto,
  UpdateProjectKeyDto,
} from './dto/project-key.dto';

/** Préfixe de la clé publique — celle qui vit dans le bundle du navigateur. */
const PUBLIC_PREFIX = 'eh_pk_';

/** Préfixe de la clé serveur — un vrai secret, détenu par un backend. */
const SECRET_PREFIX = 'eh_sk_';

function generateValue(isSecret: boolean): string {
  const prefix = isSecret ? SECRET_PREFIX : PUBLIC_PREFIX;

  return `${prefix}${randomBytes(16).toString('hex')}`;
}

/**
 * Le hash sous lequel une clé serveur est rangée.
 *
 * SHA-256 nu, sans sel et sans étirement — et ce n'est pas un oubli. Une clé
 * secrète doit être retrouvée **par sa valeur** à chaque événement : le hash
 * doit donc être déterministe, ce qui exclut bcrypt/argon2 et rend le sel
 * inutile. La lenteur, elle, protégerait d'une attaque par dictionnaire sur un
 * mot de passe humain ; ici la valeur est tirée sur 128 bits d'aléa, et aucun
 * dictionnaire ne l'atteint.
 *
 * Ce que ça achète, et c'est tout ce qu'on lui demande : une base volée ne rend
 * aucune clé utilisable.
 */
function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Comment une clé est rangée en base, selon sa nature.
 *
 * La clé publique est stockée **en clair** : elle est publiée à chaque
 * chargement de page, la hacher ne protégerait rien. La clé serveur est stockée
 * **hachée** : elle ne sort jamais du backend de son détenteur.
 *
 * Le préfixe suffit à trancher, donc on sait quoi chercher avant d'interroger
 * quoi que ce soit.
 */
function storedValue(apiKey: string): string {
  return apiKey.startsWith(SECRET_PREFIX) ? hashValue(apiKey) : apiKey;
}

/**
 * Ce que la résolution d'une clé peut donner.
 *
 * `null` ne veut pas dire « erreur » mais **« ignore cet événement sans le
 * dire »** — voir `resolve`. Le type force l'appelant à traiter ce cas au lieu
 * de le confondre avec une réussite.
 */
/**
 * La `source` rendue ici n'est **pas** déclarée par l'appelant : elle est
 * déduite de la nature de la clé qu'il présente. C'est ce qui rend
 * `events.source` digne de confiance, et donc ce sur quoi `event_types.serverOnly`
 * peut s'appuyer.
 */
export type ResolvedProject = { projectId: string; source: EventSource } | null;

/**
 * Une clé telle que le dashboard la reçoit : la ligne, avec `value` nullable.
 *
 * `null` ne veut dire qu'une chose — **c'est une clé serveur, et sa valeur ne
 * se retrouve pas**. À la création, et là seulement, elle porte le secret en
 * clair.
 */
export type ListedProjectKey = Omit<ProjectKey, 'value'> & {
  value: string | null;
};

/**
 * Les clés d'ingestion : leur résolution sur le chemin chaud, et leur gestion
 * depuis le dashboard.
 */
@Injectable()
export class ProjectKeysService {
  private readonly logger = new Logger(ProjectKeysService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Rend le projet auquel une clé donne accès, ou lève.
   *
   * ## Deux natures de refus, deux comportements
   *
   * **Ce qui touche à la clé lève.** Inconnue, révoquée : l'interlocuteur est un
   * développeur en train d'intégrer le SDK, qui doit comprendre pourquoi rien ne
   * remonte. Lui cacher l'état d'une clé qu'il détient déjà ne protège rien et
   * transforme une intégration ratée en énigme.
   *
   * **Ce qui touche à l'origine rend `null`**, et l'appelant répond 204 sans
   * rien écrire. Le refus est silencieux pour deux raisons : il ne donne aucun
   * signal à qui essaierait des origines au hasard, et surtout il n'entraîne pas
   * les SDK clients dans une boucle de retry — un 4xx sur un endpoint de capture
   * fait revenir le client plus souvent, donc amplifie exactement ce qu'on
   * cherche à écarter.
   *
   * Le prix est réel : un développeur qui a simplement oublié de déclarer son
   * domaine ne voit **rien**. C'est pourquoi le refus est journalisé ici avec la
   * clé et l'origine — c'est la seule trace qui rende le cas diagnosticable, et
   * ce qui alimentera un panneau « origines rejetées » côté dashboard.
   *
   * ## Pas de cache, pour l'instant
   *
   * C'est une lecture par événement, mais sur un index unique — moins chère que
   * le verrou consultatif que l'attribution de session prend déjà juste après.
   * Un cache à TTL introduirait un délai de révocation : on mesurera avant de
   * l'accepter.
   */
  async resolve(
    apiKey: string,
    origin: string | undefined,
  ): Promise<ResolvedProject> {
    const [key] = await this.db
      .select({
        projectId: projectKeys.projectId,
        revokedAt: projectKeys.revokedAt,
        allowedOrigins: projectKeys.allowedOrigins,
        isSecret: projectKeys.isSecret,
      })
      .from(projectKeys)
      .where(eq(projectKeys.value, storedValue(apiKey)))
      .limit(1);

    if (!key) {
      throw new UnauthorizedException("Cette clé d'ingestion n'existe pas.");
    }

    if (key.revokedAt) {
      throw new UnauthorizedException(
        "Cette clé d'ingestion a été révoquée. Créez-en une nouvelle depuis le dashboard.",
      );
    }

    // Une clé serveur n'a pas d'origine à présenter, et il ne faut pas lui en
    // demander : `Origin` est posé par le navigateur, et l'appelant n'en est pas
    // un. L'absence de l'en-tête est ici la normale, pas un signal.
    //
    // C'est la conséquence directe de la nature de la clé : celle-là est un vrai
    // secret, donc la détenir *est* l'autorisation. L'allowlist d'origines
    // n'existait que pour compenser le fait que l'autre ne l'est pas.
    if (key.isSecret) return { projectId: key.projectId, source: 'server' };

    // À partir d'ici la clé est publique, donc lisible par quiconque ouvre le
    // bundle. L'origine n'est pas une sécurité — `curl -H 'Origin: …'` la passe
    // — mais elle arrête le cas fréquent et accidentel : un snippet copié sur un
    // autre site, un staging, un template forké.
    if (!origin) {
      this.logger.warn(
        `Événement ignoré : requête sans en-tête Origin (clé ${apiKey.slice(0, 12)}…).`,
      );

      return null;
    }

    // Égalité stricte, jamais de sous-chaîne : `https://acme.com.evil.io`
    // commence par `https://acme.com` et ne doit pas passer pour lui.
    if (!key.allowedOrigins.includes(origin)) {
      this.logger.warn(
        `Événement ignoré : origine ${origin} non déclarée sur la clé ${apiKey.slice(0, 12)}… (autorisées : ${key.allowedOrigins.join(', ')}).`,
      );

      return null;
    }

    return { projectId: key.projectId, source: 'browser' };
  }

  /**
   * Les clés d'un projet — la valeur d'une clé serveur en moins.
   *
   * `value` est `null` pour les clés secrètes. Ce qui est en base est de toute
   * façon un hash, donc le rendre ne servirait à personne ; mais le mettre à
   * `null` dit la bonne chose à l'écran — **cette valeur ne se retrouve pas**,
   * elle ne s'est montrée qu'une fois. Un hash affiché laisserait croire à un
   * secret récupérable, et quelqu'un finirait par le copier dans une variable
   * d'environnement.
   */
  async list(projectId: string): Promise<ListedProjectKey[]> {
    const keys = await this.db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.projectId, projectId))
      .orderBy(asc(projectKeys.createdAt));

    return keys.map((key) => ({
      ...key,
      value: key.isSecret ? null : key.value,
    }));
  }

  /**
   * Crée une clé, et c'est **la seule fois** où une clé serveur est lisible.
   *
   * La valeur en clair est rendue ici et nulle part ailleurs : la base n'en
   * garde que le hash, donc personne — nous compris — ne peut la retrouver
   * ensuite. Perdue, elle se remplace par une nouvelle ; c'est exactement ce que
   * la rotation permet déjà sans coupure.
   */
  async create(
    projectId: string,
    { name, allowedOrigins, isSecret }: CreateProjectKeyDto,
  ): Promise<ListedProjectKey> {
    const value = generateValue(isSecret);

    const [key] = await this.db
      .insert(projectKeys)
      .values({
        projectId,
        name,
        allowedOrigins,
        isSecret,
        value: storedValue(value),
      })
      .returning();

    // La valeur en clair remplace ce qui vient d'être écrit : la ligne rendue
    // porte le secret, la ligne stockée porte son hash.
    return { ...key, value };
  }

  async update(
    projectId: string,
    keyId: string,
    values: UpdateProjectKeyDto,
  ): Promise<ListedProjectKey> {
    const [key] = await this.db
      .update(projectKeys)
      .set(values)
      .where(
        and(eq(projectKeys.id, keyId), eq(projectKeys.projectId, projectId)),
      )
      .returning();

    if (!key) throw new NotFoundException("Cette clé n'existe pas.");

    return { ...key, value: key.isSecret ? null : key.value };
  }

  /**
   * Révoque sans supprimer.
   *
   * La ligne reste pour que l'historique du projet le reste aussi : savoir
   * qu'une clé a existé et quand elle a été coupée vaut mieux qu'un trou. La
   * révocation prend effet immédiatement, puisque rien n'est mis en cache.
   */
  async revoke(projectId: string, keyId: string): Promise<ListedProjectKey> {
    const [key] = await this.db
      .update(projectKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(projectKeys.id, keyId), eq(projectKeys.projectId, projectId)),
      )
      .returning();

    if (!key) throw new NotFoundException("Cette clé n'existe pas.");

    return { ...key, value: key.isSecret ? null : key.value };
  }
}
