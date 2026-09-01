import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { open, type CityResponse, type Reader } from 'maxmind';

/**
 * Ce qu'on retient d'une IP, et rien de plus.
 *
 * Trois libellés grossiers, tous facultatifs — la base ne connaît pas tout, et
 * une résolution partielle vaut mieux qu'un rejet. `countryCode` est un code
 * ISO-3166-1 alpha-2 ; `region` et `city` sont des **noms**, parce que DB-IP
 * City Lite ne porte pas de code de subdivision (vérifié sur le fichier :
 * `subdivisions[0]` n'a qu'un `names`).
 *
 * Ce qui n'y est **pas**, et n'y sera pas : la latitude et la longitude, que la
 * base rend pourtant. Un couple de coordonnées au mètre près sur une ville de
 * trois habitants n'est plus une donnée d'audience, et le planisphère se joint
 * sur le code pays de toute façon.
 */
export interface Location {
  countryCode: string | null;
  region: string | null;
  city: string | null;
}

/** Ce qu'on rend quand on ne sait pas. Gelé : c'est une valeur, pas un état. */
const UNKNOWN: Location = Object.freeze({
  countryCode: null,
  region: null,
  city: null,
});

/**
 * ⚠️ `CityResponse` décrit le schéma **MaxMind**, et notre fichier est de
 * DB-IP.
 *
 * Les trois champs qu'on lit sont communs aux deux — vérifié sur le fichier
 * réel — mais le type promet plus que la base ne tient : DB-IP City Lite n'a
 * par exemple aucun `iso_code` sur ses subdivisions, là où le type le déclare
 * facultatif et laisse croire qu'il pourrait être là. D'où des lectures
 * **toutes en chaînage optionnel** plus bas : ce n'est pas de la prudence
 * décorative, c'est la seule façon honnête de lire une base avec les types
 * d'un autre éditeur.
 */
type CityRecord = CityResponse;

/**
 * Résout une IP en pays / région / ville, à l'ingestion et nulle part ailleurs.
 *
 * ## Pourquoi ce module et pas `privacy/`
 *
 * `PrivacyModule` tient la promesse « ce qui entre ici n'en ressort pas ».
 * Ici, on **dérive** au contraire une donnée destinée à être stockée et
 * affichée. Ce qui rapproche les deux, c'est l'IP : elle entre dans les deux
 * services, et aucun ne la laisse repartir. Les confondre ferait croire que la
 * géolocalisation protège quelque chose — elle ne protège rien, c'est son
 * emplacement dans la chaîne qui protège.
 *
 * ## La base est facultative
 *
 * Elle pèse 124 Mo, elle n'est donc pas dans le dépôt (voir `.gitignore` et
 * `GEOIP_DB_PATH` dans `.env.example`). Un clone frais démarre sans elle : on
 * prévient une fois au démarrage, et toute résolution rend `UNKNOWN`.
 *
 * C'est délibérément un avertissement et pas une erreur. Refuser de démarrer
 * ferait dépendre l'**ingestion** — le chemin critique du produit — d'un
 * fichier de confort ; on perdrait tous les événements pour ne pas perdre une
 * carte. Un `getOrThrow` ici serait le contraire du choix fait dans
 * `VisitorKeyService`, où le secret manquant *doit* arrêter l'API : sans lui,
 * les clés deviendraient calculables par quiconque a lu le code. La géo n'a pas
 * cette propriété.
 *
 * ## Le coût
 *
 * `open()` mappe le fichier une fois au démarrage ; `get()` est ensuite
 * synchrone et en mémoire, de l'ordre de la microseconde. Rien n'est fait par
 * événement : `CoreService` n'appelle ce service que pour la **première** ligne
 * d'une session (voir `SessionAssigner.open`).
 */
@Injectable()
export class GeoIpService implements OnModuleInit {
  private readonly logger = new Logger(GeoIpService.name);

  private readonly path: string | undefined;

  private reader: Reader<CityRecord> | null = null;

  constructor(config: ConfigService) {
    this.path = config.get<string>('GEOIP_DB_PATH');
  }

  async onModuleInit(): Promise<void> {
    if (this.path === undefined || this.path === '') {
      this.logger.warn(
        'GEOIP_DB_PATH absent : la géolocalisation est désactivée, les sessions seront sans pays.',
      );

      return;
    }

    try {
      this.reader = await open<CityRecord>(this.path);
    } catch (error) {
      // La cause complète — chemin compris — va dans les **logs**, où elle est
      // la seule chose qui permette de réparer. Elle ne franchit aucune
      // réponse HTTP : ce service n'est appelé que par l'ingestion, qui ne
      // remonte jamais son échec puisqu'il n'y en a pas.
      //
      // `String(error)` plutôt qu'un `instanceof Error` : l'erreur est créée
      // dans le module `maxmind`, et sous Jest un objet né dans un autre
      // contexte de module échoue au test d'instance — le message devenait
      // « cause inconnue » précisément là où on en avait besoin.
      this.logger.warn(
        `Base GeoIP illisible (${String(error)}) : la géolocalisation est désactivée.`,
      );
    }
  }

  /**
   * La position d'une IP, ou `UNKNOWN`.
   *
   * Ne lève jamais. Une adresse malformée, une base absente ou un
   * enregistrement biscornu rendent tous la même chose : trois `null`. C'est
   * une lecture d'agrément sur le chemin d'ingestion — la faire échouer
   * coûterait un événement, ce qui est hors de proportion avec ce qu'elle
   * apporte.
   */
  locate(ip: string): Location {
    if (this.reader === null) return UNKNOWN;

    let record: CityRecord | null;

    try {
      record = this.reader.get(ip);
    } catch {
      // `maxmind` refuse ce qui n'est pas une adresse — `::1` passe, un
      // en-tête bricolé pas forcément.
      return UNKNOWN;
    }

    if (record === null) return UNKNOWN;

    return {
      countryCode: record.country?.iso_code ?? null,
      // Le premier niveau de subdivision seulement. Les bases en portent
      // parfois deux (région puis département) ; garder les deux ferait deux
      // lignes pour un même endroit selon la précision de l'enregistrement.
      region: record.subdivisions?.[0]?.names?.en ?? null,
      city: record.city?.names?.en ?? null,
    };
  }
}
