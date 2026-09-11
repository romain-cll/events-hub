/**
 * `@events-hub/api-contract` — ce que `/v1` promet sur le fil.
 *
 * Une seule définition de chaque forme, lue par les deux côtés : l'API type ses
 * retours contre elle, le dashboard valide ses lectures avec elle. C'est ce
 * paquet qui est la vérité — pas les interfaces du service, pas les schémas du
 * front.
 *
 * ## Pourquoi il existe
 *
 * Le contrat a dérivé **quatre fois** sans que rien ne l'attrape. Deux sont
 * documentées dans l'historique d'`analytics` ; deux ont été découvertes en
 * branchant le dashboard, dont une où **trois requêtes sur trois** visaient des
 * routes ou des formes qui n'existaient plus — un 400, un 404, et une réponse
 * de nature différente de celle attendue.
 *
 * La cause n'était pas la négligence : la sortie était décrite **deux fois,
 * dans deux langages, sans rien qui les relie**. Une interface TypeScript côté
 * API, un schéma Zod côté front. Rien ne pouvait comparer les deux, donc rien
 * ne le faisait.
 *
 * ## Ce qu'il décrit, et ce qu'il ne décrit pas
 *
 * **Le fil, pas le domaine.** Là où l'API manipule des `Date`, ce paquet porte
 * `z.iso.datetime()` : c'est ce que `JSON.stringify` produit et ce que le
 * client reçoit. La conversion n'est pas une imprécision qu'on tolère, c'est le
 * sujet même du contrat.
 *
 * **Les réponses seulement.** Les requêtes restent validées par les DTO de
 * l'API. Les faire passer par ici obligerait l'API à importer des *valeurs*, ce
 * qui imposerait une étape de compilation — voir `architecture.spec.ts`, qui
 * interdit précisément ça.
 *
 * **`/v1/auth/*` seulement s'il est rattaché.** Ces formes sont inférées de la
 * configuration de Better Auth : les recopier ici en ferait une deuxième source
 * de vérité, exactement le problème qu'on ferme. La règle était donc de ne pas
 * les décrire du tout.
 *
 * `members.ts` est l'exception, et elle précise la règle plutôt qu'elle ne la
 * casse : ces schémas sont **comparés aux types que le plugin infère**, dans
 * `contract.spec.ts`, par le même mécanisme qui compare nos services au reste
 * du contrat. Ce qui est interdit n'est pas de décrire `/v1/auth/*`, c'est de
 * le décrire *sans lien* — une description que rien ne confronte a l'air
 * vérifiée et ne l'est pas, ce qui est pire que pas de description du tout.
 *
 * Le corollaire tient en une phrase : **rien n'entre ici sans son assertion**.
 */
export * from './organizations';
export * from './members';
export * from './projects';
export * from './analytics';
export * from './events';
export * from './event-types';
export * from './integrations';
export * from './revenue';
