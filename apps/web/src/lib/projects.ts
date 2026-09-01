import {
  projectIngestionSchema,
  projectKeySchema,
  projectKeysSchema,
  projectSchema,
  projectsSchema,
  type Project,
  type ProjectIngestion,
  type ProjectKey,
} from '@events-hub/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { apiJson, write } from './api';

export type { Project, ProjectIngestion, ProjectKey };

/**
 * Les projets du visiteur.
 *
 * `GET /v1/projects` ne prend pas d'identifiant : l'API le lit sur la session
 * et ne rend que les projets des organisations dont on est membre. Il n'y a
 * donc rien à filtrer ici, et surtout rien à passer qu'on pourrait falsifier.
 *
 * ## Le schéma n'est plus écrit ici
 *
 * Il vient de `@events-hub/api-contract`, et c'est le fond du sujet. Cette
 * forme était décrite deux fois — une interface TypeScript côté API, un schéma
 * Zod ici — sans que rien ne puisse comparer les deux. C'est comme ça que le
 * contrat a dérivé quatre fois, dont trois requêtes analytiques devenues
 * caduques sans que la compilation ne bronche.
 *
 * Désormais l'API type ses retours contre cette même définition
 * (`apps/api/src/contract.spec.ts`) : la retirer ou renommer un de ses champs
 * casse les deux côtés en même temps.
 *
 * La validation à la lecture reste faite, alors même que l'API est typée contre
 * le même schéma — les types couvrent la forme, pas ce qui arrive vraiment sur
 * le fil : une version d'API plus ancienne en production, un proxy qui réécrit,
 * une réponse d'erreur en HTML. Le contrat partagé empêche la dérive ; la
 * validation attrape ce qui n'est pas de la dérive. Elle est appliquée par
 * `apiJson`, qui n'a pas d'option pour s'en passer.
 */
export function projectsQuery() {
  return queryOptions({
    queryKey: ['projects'],
    queryFn: () => apiJson('/v1/projects', projectsSchema),
  });
}

/**
 * Les clés d'ingestion d'un projet.
 *
 * Elles sont **publiques par nature** — le SDK les publie dans le bundle de
 * chaque page du site instrumenté — donc les afficher en clair ne révèle rien
 * qu'un `view-source` ne montrerait. L'API les rend d'ailleurs telles quelles à
 * tout membre du projet.
 *
 * La liste arrive triée par date de création croissante, révoquées comprises :
 * c'est un historique, pas un jeu de clés actives. À l'appelant de choisir
 * laquelle il montre — voir `activeKey`.
 */
export function projectKeysQuery(projectId: string) {
  return queryOptions({
    queryKey: ['projects', projectId, 'keys'],
    queryFn: () => apiJson(`/v1/projects/${projectId}/keys`, projectKeysSchema),
  });
}

/** Une clé publique : celle dont la valeur est lisible et collable. */
export type PublicProjectKey = ProjectKey & { value: string };

/**
 * La clé à montrer dans l'écran d'installation : la plus récente encore active,
 * **et publique**.
 *
 * Le parcours part de la **fin** : la liste est croissante par date de création,
 * et après une rotation c'est la dernière créée qu'on veut faire coller, pas la
 * première de l'historique. Rend `undefined` si tout est révoqué — un état
 * légitime, qu'un projet en rotation traverse.
 *
 * Les clés serveur sont écartées, et pas seulement parce que leur `value` est
 * `null` en lecture : cet écran installe le **SDK navigateur**, et proposer d'y
 * coller un secret serveur reviendrait à le publier dans le bundle de chaque
 * page. Le test sur `value` est le garde-fou de typage ; celui sur `isSecret`
 * est la règle.
 *
 * Une boucle plutôt que `findLast`, qui demanderait `lib: es2023` : changer la
 * cible du projet pour une ligne serait un réglage global décidé par un détail.
 */
export function activeKey(keys: ProjectKey[]): PublicProjectKey | undefined {
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];

    if (key.revokedAt || key.isSecret || key.value === null) continue;

    return { ...key, value: key.value };
  }

  return undefined;
}

/**
 * La clé **serveur** à nommer dans l'écran d'installation : la plus récente
 * encore active.
 *
 * Pendant exact d'`activeKey`, et les deux existent pour la même raison : un
 * écran qui prendrait « la dernière clé » sans regarder sa nature proposerait
 * un jour de coller un secret serveur dans une balise `<script>`.
 *
 * Sa `value` est `null` — la base n'en garde qu'un hash — donc il n'y a rien à
 * afficher d'elle sinon son **nom**. C'est justement tout ce dont l'écran a
 * besoin : dire laquelle des clés doit se retrouver dans la variable
 * d'environnement du CI.
 */
export function activeServerKey(keys: ProjectKey[]): ProjectKey | undefined {
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];

    if (key.isSecret && !key.revokedAt) return key;
  }

  return undefined;
}

/**
 * « Est-ce que ça arrive ? » — la seule question de l'écran d'attente.
 *
 * `staleTime: 0` parce que c'est exactement l'inverse de la session : une
 * réponse d'il y a trois secondes ne vaut rien ici, puisque la seule chose
 * qu'on attend est qu'elle change. Le rythme d'interrogation, lui, n'est pas
 * décidé ici : il appartient à l'écran, qui sait s'il est en train de regarder
 * ou pas (voir `waiting.tsx`).
 */
export function ingestionQuery(projectId: string) {
  return queryOptions({
    queryKey: ['projects', projectId, 'ingestion'],
    staleTime: 0,
    queryFn: () =>
      apiJson(`/v1/projects/${projectId}/ingestion`, projectIngestionSchema),
  });
}

/**
 * Crée un projet dans une organisation.
 *
 * `organizationId` est explicite jusque dans la requête. L'API pourrait le
 * déduire d'une « organisation active » portée par la session — elle ne le fait
 * pas, exprès : la cible d'écriture serait alors invisible dans la requête comme
 * dans les logs. Elle vérifie en revanche l'appartenance, donc une organisation
 * qui n'est pas la vôtre est un 404, pas un projet créé ailleurs.
 */
export function createProject(payload: {
  organizationId: string;
  name: string;
}): Promise<Project> {
  return write('/v1/projects', projectSchema, payload);
}

/**
 * Crée une clé d'ingestion pour un projet.
 *
 * ## Les origines dépendent de la nature de la clé
 *
 * Sur une clé **publique**, `allowedOrigins` ne peut pas être vide, côté API
 * comme ici : une clé qui accepterait tout ne protégerait personne de ce qu'elle
 * est censée arrêter — un snippet copié sur un autre site, un staging, un
 * template forké, qui déversent leurs vrais visiteurs dans le projet. C'est pour
 * ça que le parcours de création demande l'URL du site en même temps que le nom.
 *
 * Sur une clé **serveur**, elles doivent être vides, et l'API refuse
 * explicitement le contraire : `Origin` est un en-tête posé par le navigateur, et
 * l'appelant n'en est pas un. En accepter une laisserait croire qu'elle est
 * vérifiée quelque part.
 *
 * ## La valeur rendue ici est la seule occasion de la lire
 *
 * Pour une clé serveur, la base ne garde qu'un hash : `value` porte le secret en
 * clair dans **cette réponse et nulle part ailleurs**. Toute lecture ultérieure
 * rend `null`. L'appelant qui ne l'affiche pas la perd — et personne, nous
 * compris, ne peut la retrouver.
 */
export function createProjectKey(
  projectId: string,
  payload: { name?: string; allowedOrigins: string[]; isSecret?: boolean },
): Promise<ProjectKey> {
  return write(`/v1/projects/${projectId}/keys`, projectKeySchema, payload);
}

/**
 * Révoque une clé — sans la supprimer.
 *
 * La ligne reste, datée : savoir qu'une clé a existé et quand elle a été coupée
 * vaut mieux qu'un trou dans l'historique du projet. Rien n'étant mis en cache à
 * l'ingestion, la coupure est immédiate.
 *
 * Elle est aussi **silencieuse** pour celui qui émet encore : un site qui expédie
 * une clé révoquée cesse d'être mesuré sans erreur visible de son côté. D'où
 * l'ordre à respecter, que l'écran doit dire — créer le remplaçant, puis révoquer.
 */
export function revokeProjectKey(
  projectId: string,
  keyId: string,
): Promise<ProjectKey> {
  return write(
    `/v1/projects/${projectId}/keys/${keyId}`,
    projectKeySchema,
    undefined,
    'DELETE',
  );
}

/**
 * Renomme un projet.
 *
 * Réservé à `owner` et `admin` (`@ProjectRoles`) : le nom est ce que tout le
 * monde lit dans son sélecteur. Un `member` n'a pas ce bouton, et l'API répond
 * 403 s'il l'appelle quand même.
 */
export function renameProject(
  projectId: string,
  payload: { name: string },
): Promise<Project> {
  return write(`/v1/projects/${projectId}`, projectSchema, payload, 'PATCH');
}

/**
 * Supprime un projet — et, avec lui, ses événements.
 *
 * Ce n'est pas une révocation : les clés se révoquent parce que leur historique
 * se lit, un projet supprimé n'a pas d'historique à lire. Le serveur détruit
 * dans l'ordre (`events`, `sessions`, puis le projet, qui emporte ses clés et
 * ses types d'événements), en une transaction.
 *
 * Le projet est rendu tel qu'il était juste avant : c'est la dernière occasion
 * de le nommer, puisqu'il n'y a plus rien à relire ensuite.
 */
export function deleteProject(projectId: string): Promise<Project> {
  return write(`/v1/projects/${projectId}`, projectSchema, undefined, 'DELETE');
}
