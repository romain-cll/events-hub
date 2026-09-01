import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';

/**
 * Le fichier servi par `GET /v1/eh.js`, tenu à jour sans redémarrage.
 *
 * ## Pourquoi c'est le hub qui le sert
 *
 * Parce que c'est ce qui rend le snippet à une ligne possible. Le script, une
 * fois chargé, sait d'où il vient ; comme il vient de l'API, il en déduit
 * l'adresse d'ingestion sans qu'on la lui écrive. Le servir depuis un CDN ou
 * depuis le dashboard obligerait à recopier cette adresse dans un second
 * attribut — un attribut de plus à copier de travers, pour une intégration qui
 * échoue en silence.
 *
 * ## Le bundle est résolu, pas construit
 *
 * `require.resolve` demande à Node où se trouve `@events-hub/sdk/eh.js`, donc
 * l'emplacement suit le paquet et non une arborescence devinée. C'est une
 * résolution de **chemin**, pas un import : rien du paquet n'entre dans le
 * programme émis, et la contrainte de build qui pèse sur `api-contract`
 * (voir `architecture.spec.ts`) ne s'applique pas.
 *
 * Le corollaire est que le paquet doit avoir été construit. `pnpm build` s'en
 * charge — turbo enchaîne `^build` avant l'API, et avant `dev`. En attendant,
 * l'absence du fichier rend un 503 qui dit quoi lancer, plutôt qu'un 500 qui
 * parlerait d'`ENOENT`.
 *
 * ## Relu quand il change
 *
 * La date de modification est vérifiée à chaque requête, le contenu n'est relu
 * que si elle a bougé. Un `stat` par appel est négligeable devant le réseau, et
 * ça évite le piège de développement : reconstruire le SDK sans que l'API,
 * qui ne surveille pas ce dossier, ne serve jamais autre chose que la version
 * qu'elle a lue au démarrage.
 */
@Injectable()
export class SdkService {
  private readonly logger = new Logger(SdkService.name);

  private cached: { modifiedAt: number; code: Buffer } | null = null;

  async bundle(): Promise<Buffer> {
    let path: string;

    try {
      path = require.resolve('@events-hub/sdk/eh.js');
    } catch {
      this.logger.error(
        "Le bundle navigateur du SDK est introuvable. Lancez « pnpm --filter @events-hub/sdk build » — ou « pnpm build », qui l'enchaîne.",
      );

      throw new ServiceUnavailableException(
        "Le script d'installation n'est pas disponible.",
      );
    }

    const { mtimeMs } = await stat(path);

    if (this.cached?.modifiedAt !== mtimeMs) {
      this.cached = { modifiedAt: mtimeMs, code: await readFile(path) };
    }

    return this.cached.code;
  }
}
