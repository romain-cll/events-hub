import { z } from 'zod';

/**
 * Contrat d'entrée de `PATCH /v1/projects/:projectId`.
 *
 * Le nom seul. Ni `organizationId` — déplacer un projet d'une organisation à
 * l'autre est une autre opération, avec ses propres questions (qui garde
 * l'accès, qu'advient-il des clés) qu'un champ facultatif ne poserait à
 * personne — ni la moindre clé technique.
 *
 * `strictObject` comme les autres DTO : envoyer `{ name, organizationId }` en
 * espérant un déménagement doit échouer bruyamment, pas renommer en silence.
 */
export const updateProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
});

export type UpdateProjectDto = z.output<typeof updateProjectSchema>;
