/**
 * L'environnement des workers e2e, posé avant que la moindre application démarre.
 *
 * `setupFiles` tourne dans chaque worker **avant le framework de test et avant
 * tout import de l'app** : c'est la seule fenêtre où l'on peut encore décider ce
 * que `ConfigService` lira, puisqu'il ne réécrit jamais un `process.env` déjà
 * posé.
 *
 * Ces réglages vivaient dans le script `test:e2e` de `package.json`. Ils en
 * sortent parce qu'on lance couramment une seule suite à la main
 * (`jest --config test/jest-e2e.json events.list`) : par ce chemin, aucun ne
 * s'appliquait.
 *
 * Partout `??=` et non `=` : une exécution qui veut éprouver le réglage lui-même
 * doit pouvoir l'imposer depuis l'environnement.
 */

/**
 * Le plafond qui compte n'est pas ici : c'est `max_connections` de Postgres —
 * cent, partagé avec les serveurs de dev qui tournent déjà. Le produit à tenir
 * dessous est `maxWorkers × DATABASE_POOL_MAX`, et les deux facteurs sont fixés
 * côte à côte (voir `jest-e2e.json`) : quatre et quatre, soit seize connexions,
 * quel que soit le nombre de suites ou de cœurs de la machine.
 */
process.env.DATABASE_POOL_MAX ??= '4';

/**
 * Le planificateur de la purge, éteint — pas la purge.
 *
 * Le drapeau ne gouverne que `scheduled()` ; `purge()` l'ignore, exprès, pour
 * rester éprouvable. La suite de rétention continue donc de l'appeler
 * directement, et ne change pas de comportement.
 *
 * Sans ça, chaque suite arme son propre `@Cron` à 03:15 UTC — une trentaine par
 * exécution. Un run qui traverse cette minute déclenche une purge **globale** au
 * milieu des autres suites : elle prend le verrou consultatif que la suite de
 * rétention attend, et fait échouer une suite au hasard une fois par jour. C'est
 * le genre de rougeur qu'on relance sans lire, et la sérialisation en deux passes
 * ne l'attrape pas.
 *
 * À noter : la tâche reste **enregistrée** — `@Cron` est posé à la construction,
 * et le drapeau est lu dans le corps de `scheduled()`. Le minuteur se déclenche
 * donc toujours, et retourne immédiatement. C'est ce qu'on veut : ce qui coûte
 * n'est pas le minuteur, c'est ce qu'il ferait à la base.
 *
 * Conséquence assumée : les suites journalisent toutes le `warn` prévu par le
 * service — « aucune purge planifiée ». C'est l'état qu'on veut, et le service a
 * raison de le dire fort.
 */
process.env.RETENTION_ENABLED ??= 'false';
