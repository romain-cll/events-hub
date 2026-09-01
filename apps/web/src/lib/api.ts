import { z } from 'zod';

import { forwardedCookies } from './forwarded-cookies';

/**
 * Base de l'API — ingestion, lecture analytique et authentification.
 *
 * Une seule définition pour toute l'application : `auth-client.ts` en dérive
 * son `baseURL`, `apiFetch` l'utilise pour tout le reste. Les avoir en double
 * laisserait un jour l'un des deux pointer ailleurs que l'autre.
 */
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3003';

/**
 * Un appel à l'API, authentifié.
 *
 * ## Ce que ça referme
 *
 * Toutes les routes de lecture sont derrière le guard global de l'API depuis
 * qu'elle a une authentification. Un `fetch` nu n'emporte pas le cookie de
 * session en cross-origin — il faut `credentials: 'include'` — et le dashboard
 * recevait donc des 401 sur ses propres données.
 *
 * L'oubli est silencieux et se répète : chaque nouvelle famille de requêtes
 * (projets, clés, plus tard webhooks) referait la même erreur. D'où un point
 * de passage unique, qui n'a pas d'option pour s'en dispenser.
 *
 * ## Les deux côtés du rendu
 *
 * `credentials` couvre le navigateur ; `forwardedCookies()` couvre le serveur
 * Start, qui doit recopier l'en-tête entrant. La fonction est donc utilisable
 * indifféremment dans un composant, un `loader` ou un `beforeLoad`.
 *
 * ## Ce que ça ne fait pas
 *
 * Ni parsing, ni validation, ni interprétation du statut : la réponse brute
 * est rendue telle quelle. Chaque appelant sait ce qu'il attend — `read()`
 * dans `analytics.ts` valide contre un schéma Zod, la session traite le 401
 * comme une absence de session et non comme une panne.
 */
export function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(new URL(path, API_URL), {
    ...init,
    credentials: 'include',
    headers: { ...forwardedCookies(), ...init.headers },
  });
}

/**
 * La route d'ingestion, en absolu — celle qui part dans le snippet d'install.
 *
 * Elle est dérivée d'`API_URL` plutôt qu'écrite en dur dans l'écran qui
 * l'affiche : le snippet est du code que quelqu'un va coller chez lui, et une
 * URL qui ne suit pas la configuration donnerait une intégration muette, sans
 * message d'erreur, que personne ne saurait relier à cette ligne.
 */
export const INGESTION_ENDPOINT = new URL('/v1/events', API_URL).toString();

/**
 * Le script d'installation, servi par le hub — l'URL qui va dans le snippet.
 *
 * Servi **à côté** de la route d'ingestion, et ce voisinage est le mécanisme :
 * une fois chargé, le script résout `events` relativement à son propre `src` et
 * trouve `/v1/events` sans qu'on ait à le lui dire. C'est ce qui réduit le
 * snippet à une clé, là où deux valeurs à recopier feraient deux occasions de
 * se tromper — dont une, l'adresse, qui échoue sans le moindre message.
 */
export const SDK_SCRIPT_URL = new URL('/v1/eh.js', API_URL).toString();

/**
 * Une lecture de l'API, validée avant d'être rendue.
 *
 * Le schéma n'est pas facultatif, et c'est tout l'intérêt : il n'existe pas de
 * chemin qui rende du JSON non validé. Le contrat a déjà dérivé quatre fois
 * sans que rien ne l'attrape (voir `@events-hub/api-contract`) ; laisser une
 * porte « juste pour cette route-là » suffirait à rouvrir le sujet.
 *
 * ## Trois échecs, une seule sortie
 *
 * Statut d'erreur, JSON illisible, forme inattendue : tout lève. TanStack Query
 * les range au même endroit, chaque écran a déjà son `error`, et le message part
 * tel quel à l'affichage — le corps d'un 404 ou d'un 400 porte le détail, et le
 * jeter afficherait « erreur » sans dire laquelle.
 *
 * Le 401 est le cas qui ne devrait jamais s'afficher : `_authed` a déjà renvoyé
 * sur `/auth/login` avant qu'un écran ne se monte. S'il apparaît quand même,
 * c'est qu'une session a expiré entre le chargement et la lecture, et le message
 * brut est alors ce qu'il y a de plus utile à voir.
 *
 * Ce que la fonction ne fait pas : les écritures. `POST` et compagnie ont chacun
 * leur forme d'erreur métier — un nom refusé, une origine mal formée — et les
 * faire passer par ici les réduirait tous au même message.
 */
export async function apiJson<Output>(
  path: string,
  schema: z.ZodType<Output>,
  init?: RequestInit,
): Promise<Output> {
  const response = await apiFetch(path, init);

  if (!response.ok) {
    throw new Error(`${response.status} — ${await response.text()}`);
  }

  const parsed = schema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error(
      `${path}: unexpected response.\n${z.prettifyError(parsed.error)}`,
    );
  }

  return parsed.data;
}

/**
 * Ce que l'API répond quand elle refuse une écriture, ramené à une phrase.
 *
 * Trois formes cohabitent et il faut les trois : une `HttpException` de Nest
 * porte `message`, `ZodValidationPipe` répond un 400 dont le vrai contenu est
 * dans `issues` — `message` n'y vaut que « Request body validation failed »,
 * qui ne dit ni quel champ ni pourquoi — et Better Auth, sur `/v1/auth/*`, rend
 * `{ message, code }`, que la première branche couvre déjà.
 *
 * ⚠️ Les messages remontés sont ceux de l'API, donc en français, alors que
 * l'interface est en anglais. C'est une dette connue : la traduction doit se
 * faire côté serveur pour valoir aussi pour les autres clients, pas ici où elle
 * ne couvrirait que le dashboard.
 */
async function refusalOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (typeof body === 'object' && body !== null) {
      const { issues, message } = body as {
        issues?: { path?: string; message?: string }[];
        message?: unknown;
      };

      if (issues?.length) {
        return issues
          .map(({ path, message: issue }) =>
            path ? `${path}: ${issue ?? ''}` : (issue ?? ''),
          )
          .join('\n');
      }

      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join('\n');
    }
  } catch {
    // Corps vide ou non-JSON : le statut est tout ce qu'on a.
  }

  return `Request refused (${String(response.status)}).`;
}

/**
 * Une écriture, avec le message de refus de l'API préservé.
 *
 * Elle ne passe pas par `apiJson`, et c'est délibéré : une lecture qui échoue
 * n'a qu'une façon d'échouer, alors qu'une écriture est refusée pour une raison
 * **métier** — un nom trop long, une origine mal formée, une organisation qui
 * n'est pas la vôtre. Réduire tout ça à `404 — {"message":…}` mettrait du JSON
 * brut sous un champ de formulaire.
 *
 * ## Elle a quitté `projects.ts` en gagnant un second appelant
 *
 * Elle y était privée tant que les projets étaient seuls à écrire. Membres,
 * invitations et organisations écrivent aussi, et vers `/v1/auth/*` — des routes
 * que nous n'écrivons pas, dont les refus arrivent dans une troisième forme.
 * La recopier là-bas aurait fait deux chemins d'écriture capables de traiter
 * une erreur différemment ; c'est exactement ce que `apiFetch` referme déjà
 * pour le cookie de session, une ligne plus haut.
 *
 * La réponse reste validée contre le contrat : ce que rend un `POST` est de la
 * donnée qu'on va afficher, elle n'a pas moins besoin d'être vérifiée qu'une
 * lecture.
 */
export async function write<Output>(
  path: string,
  schema: { parse: (value: unknown) => Output },
  body?: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<Output> {
  const response = await apiFetch(path, {
    method,
    // Pas d'en-tête ni de corps quand il n'y a rien à envoyer : une révocation
    // désigne sa cible par l'URL. Un `content-type: application/json` sur un
    // corps absent est une invitation à ce qu'un parseur strict s'en étrangle.
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });

  if (!response.ok) throw new Error(await refusalOf(response));

  return schema.parse(await response.json());
}
