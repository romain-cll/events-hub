import { z } from 'zod';

/**
 * Contrat d'entrée de `POST /v1/projects`.
 *
 * `organizationId` est fourni par l'appelant et **vérifié côté service** : rien
 * ici ne dit qu'il en est membre, un schéma ne peut pas le savoir. Le déduire
 * d'une « organisation active » portée par la session serait plus court, mais
 * rendrait la cible d'écriture implicite — et donc invisible dans la requête
 * comme dans les logs.
 *
 * `strictObject`, comme le DTO d'ingestion : une clé inconnue fait échouer la
 * requête plutôt que d'être ignorée en silence.
 */
export const createProjectSchema = z.strictObject({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(128),
});

export type CreateProjectDto = z.output<typeof createProjectSchema>;
