import {
  BadRequestException,
  HttpStatus,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { z, type ZodType } from 'zod';

/**
 * Fait passer une valeur entrante à travers un schéma Zod, ou rejette en 400.
 *
 * S'utilise par paramètre plutôt qu'en pipe global : le schéma dépend de la
 * route, et c'est justement le fait de l'écrire à côté du handler qui rend le
 * contrat lisible — `@Body(new ZodValidationPipe(createEventSchema)) body`.
 * Il vaut pour n'importe quelle source (`@Body`, `@Query`, `@Param`) ; le
 * message d'erreur nomme celle qui a échoué, sans quoi un client cherchant une
 * faute dans son corps de requête passerait à côté d'un `?from=` invalide.
 *
 * La valeur retournée est la sortie du schéma, pas l'entrée : les `transform`
 * (ex. chaîne ISO -> `Date`) et les `default` sont déjà appliqués quand le
 * handler reçoit l'objet.
 */
@Injectable()
export class ZodValidationPipe<
  TSchema extends ZodType,
> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<TSchema> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // On remonte *toutes* les erreurs d'un coup, chemin compris : un client
      // qui poste un payload malformé corrige en une passe au lieu de dix.
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: `Request ${metadata.type} validation failed`,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
