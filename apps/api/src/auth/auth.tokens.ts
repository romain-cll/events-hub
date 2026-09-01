/**
 * Jeton d'injection de l'instance Better Auth.
 *
 * Il vit dans son propre fichier — et non à côté de la factory — pour que le
 * guard et `app.setup.ts` puissent le réclamer sans importer la configuration
 * complète de l'auth, qui tire toute la bibliothèque avec elle.
 */
export const AUTH = Symbol('AUTH');
