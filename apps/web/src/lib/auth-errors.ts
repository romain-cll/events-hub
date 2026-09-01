/**
 * Ce que l'API répond quand elle refuse, traduit pour un humain.
 *
 * Better Auth rend un `code` stable à côté de son message anglais. On traduit
 * ici, à un seul endroit, plutôt que dans chaque formulaire : les deux écrans
 * partagent la moitié des cas, et un message écrit deux fois finit par ne plus
 * dire la même chose des deux côtés.
 *
 * ## Le cas par défaut rend le message du serveur
 *
 * Et surtout pas « une erreur est survenue ». Un code non prévu — il en
 * apparaîtra, Better Auth en ajoute à chaque version — doit rester lisible à
 * l'écran, sinon la seule façon de savoir ce qui s'est passé est d'ouvrir les
 * outils réseau. Un message anglais imparfait vaut mieux qu'un message français
 * qui ne dit rien.
 */

/**
 * La longueur minimale d'un mot de passe.
 *
 * C'est **la valeur par défaut de Better Auth**, pas une décision du front :
 * `minPasswordLength` n'est pas configuré dans `apps/api/src/auth/auth.ts`. La
 * réécrire ici est une duplication assumée — elle évite un aller-retour dont on
 * connaît l'issue — mais elle n'a pas autorité. Si l'API durcissait la règle
 * sans qu'on touche à cette ligne, le serveur refuserait et le message
 * `PASSWORD_TOO_SHORT` ci-dessous prendrait le relais.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** La forme minimale d'une erreur better-fetch. */
export interface AuthError {
  code?: string;
  message?: string;
}

const MESSAGES: Record<string, string> = {
  // Un seul code pour « adresse inconnue » et « mauvais mot de passe », et
  // c'est voulu côté serveur : distinguer les deux dirait à un inconnu quelles
  // adresses ont un compte. Le message reste donc vague lui aussi — le
  // préciser ici rétablirait la fuite que l'API vient d'éviter.
  INVALID_EMAIL_OR_PASSWORD: 'Adresse ou mot de passe incorrect.',
  INVALID_EMAIL: 'Cette adresse email n’est pas valide.',

  // À l'inverse, ici on nomme le problème. Voir le commentaire de `signup.tsx` :
  // l'API renvoie déjà ce code distinct, le taire ne masquerait rien et
  // laisserait quelqu'un bloqué devant un formulaire qui refuse sans dire quoi.
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'Un compte existe déjà avec cette adresse.',

  PASSWORD_TOO_SHORT: `Le mot de passe doit faire au moins ${String(MIN_PASSWORD_LENGTH)} caractères.`,
  PASSWORD_TOO_LONG: 'Le mot de passe est trop long.',

  FAILED_TO_CREATE_USER: 'La création du compte a échoué. Réessayez.',
  FAILED_TO_CREATE_SESSION: 'La connexion a échoué. Réessayez.',
};

export function messageFor(error: AuthError | null | undefined): string {
  if (!error) return '';

  return (
    (error.code ? MESSAGES[error.code] : undefined) ??
    error.message ??
    'Requête refusée, sans motif.'
  );
}

/**
 * L'autre famille d'échec : la requête n'a pas abouti du tout.
 *
 * À ne pas confondre avec un refus. « Adresse ou mot de passe incorrect »
 * envoie chercher ses identifiants ; une API éteinte demande d'attendre. Les
 * confondre fait douter de son mot de passe quelqu'un dont le wifi a coupé.
 */
export const UNREACHABLE =
  'Le serveur est injoignable. Vérifiez votre connexion et réessayez.';
