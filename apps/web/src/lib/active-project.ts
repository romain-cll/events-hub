import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

import type { Project } from './projects';

/**
 * Le nom est préfixé pour ne pas se cogner avec le cookie de session de
 * better-auth ni avec `sidebar_state` posé par shadcn.
 */
const COOKIE = 'eh_active_project';

/** Un an. Le projet qu'on regarde change bien moins souvent qu'une session. */
const MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Le dernier projet consulté, pour que `/projects` sache où envoyer.
 *
 * ## Pourquoi un cookie et pas `localStorage`
 *
 * Parce que la décision se prend **avant** le premier rendu, dans le
 * `beforeLoad` de `/projects`, qui s'exécute aussi sur le serveur. Un
 * `localStorage` n'existe pas là-bas : le serveur redirigerait vers le projet
 * le plus récent, puis le client corrigerait vers le bon — un aller-retour
 * visible à chaque entrée dans l'application.
 *
 * ## Ce cookie n'appelle pas de bandeau de consentement
 *
 * Il ne trace rien et ne sort pas du site. Il retient un choix de navigation
 * que le visiteur vient de faire lui-même, exactement comme le pli ouvert ou
 * fermé de la barre latérale. C'est un cookie strictement nécessaire au
 * fonctionnement du service, dispensé de consentement — la dispense tomberait
 * s'il servait un jour à mesurer quoi que ce soit.
 *
 * ## Pas de `HttpOnly`
 *
 * Le navigateur doit pouvoir l'écrire lui-même quand on change de projet. Ce
 * n'est pas un identifiant : au pire, quelqu'un le falsifie et se voit envoyé
 * vers un projet auquel il n'a pas accès — auquel cas la vérification
 * ci-dessous ne le retient pas, et l'API répondrait 404 de toute façon.
 */
export const readActiveProjectId = createIsomorphicFn()
  .client((): string | undefined => {
    const match = new RegExp(`(?:^|; )${COOKIE}=([^;]*)`).exec(document.cookie);

    return match ? decodeURIComponent(match[1]) : undefined;
  })
  .server((): string | undefined => getCookie(COOKIE));

/**
 * Retient le projet courant. Sans effet hors du navigateur.
 *
 * `SameSite=Lax` suffit : le cookie n'a aucune valeur en requête tierce.
 * `Secure` n'est posé qu'en HTTPS, sinon le navigateur refuserait le cookie
 * en développement sur `localhost` — et le refus est silencieux.
 */
export function rememberActiveProject(projectId: string): void {
  if (typeof document === 'undefined') return;

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';

  document.cookie = `${COOKIE}=${encodeURIComponent(projectId)}; Path=/; Max-Age=${String(MAX_AGE)}; SameSite=Lax${secure}`;
}

/**
 * Le projet vers lequel envoyer quelqu'un qui arrive sur `/projects`.
 *
 * Le cookie ne fait pas autorité : on ne garde son projet que s'il figure
 * *toujours* dans la liste que l'API vient de rendre. Un projet supprimé, ou
 * dont on a perdu l'accès, retomberait sinon sur un écran en 404 — alors que
 * la bonne réponse est simplement le projet suivant.
 *
 * À défaut, le plus récemment créé : pour un compte neuf c'est le seul, et
 * pour un compte ancien c'est celui sur lequel on travaille probablement.
 */
export function pickActiveProject(projects: Project[]): Project | undefined {
  if (projects.length === 0) return undefined;

  const remembered = readActiveProjectId();
  const known = remembered
    ? projects.find(({ id }) => id === remembered)
    : undefined;
  if (known) return known;

  return projects.reduce((newest, project) =>
    project.createdAt > newest.createdAt ? project : newest,
  );
}
