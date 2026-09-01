import { z } from 'zod';

/**
 * Une origine, au sens strict du terme : schéma, hôte, port — et rien d'autre.
 *
 * La validation passe par `URL` plutôt que par une expression régulière, et
 * compare le résultat à l'entrée : `new URL('https://acme.com/tracking').origin`
 * rend `https://acme.com`, donc une valeur qui porterait un chemin, une query
 * ou un fragment est rejetée au lieu d'être silencieusement tronquée.
 *
 * C'est ce qui garantit que la comparaison faite à l'ingestion — une égalité de
 * chaînes contre l'en-tête `Origin`, qui a exactement cette forme — ne peut pas
 * échouer pour une raison de format.
 */
const originSchema = z.string().superRefine((value, context) => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: `« ${value} » n'est pas une URL valide.`,
    });

    return;
  }

  if (parsed.origin !== value) {
    context.addIssue({
      code: 'custom',
      message: `« ${value} » doit être une origine seule, sans chemin — par exemple « ${parsed.origin} ».`,
    });
  }
});

/**
 * `allowedOrigins` est **non vide sur une clé publique**, et vide sur une clé
 * serveur. Les deux moitiés de la règle comptent.
 *
 * Une clé publique sans origine déclarée accepterait tout, ce qui viderait la
 * fonctionnalité de son sens pour tous ceux qui ne la configurent pas — c'est-à-
 * dire la majorité, et précisément ceux qu'on cherche à protéger du snippet
 * copié ailleurs par mégarde.
 *
 * Une clé serveur, elle, n'a pas d'origine : `Origin` est un en-tête que pose le
 * navigateur, et son appelant n'en est pas un. En accepter une laisserait croire
 * qu'elle est vérifiée quelque part, alors que `resolve` ne la regarde jamais
 * pour ce type de clé. Le refus est donc explicite plutôt que silencieux.
 */
export const createProjectKeySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(64).optional(),
    allowedOrigins: z.array(originSchema).max(20).default([]),
    /**
     * Coché, la clé est un secret serveur (`eh_sk_`) : hachée, montrée une seule
     * fois, capable d'écrire des événements sans visiteur.
     *
     * Le défaut est `false`, et le sens de ce défaut est le sujet : une clé est
     * publique sauf demande explicite, donc un oubli produit la clé **la moins**
     * puissante. L'inverse ferait d'une distraction une porte ouverte.
     */
    isSecret: z.boolean().default(false),
  })
  .superRefine(({ isSecret, allowedOrigins }, context) => {
    if (isSecret && allowedOrigins.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedOrigins'],
        message:
          "Une clé serveur n'a pas d'origine : l'en-tête Origin est posé par le navigateur, et cet appelant n'en est pas un.",
      });
    }

    if (!isSecret && allowedOrigins.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedOrigins'],
        message:
          'Une clé publique doit déclarer au moins une origine autorisée.',
      });
    }
  });

export const updateProjectKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(64).optional(),
  allowedOrigins: z.array(originSchema).min(1).max(20).optional(),
});

export type CreateProjectKeyDto = z.output<typeof createProjectKeySchema>;
export type UpdateProjectKeyDto = z.output<typeof updateProjectKeySchema>;
