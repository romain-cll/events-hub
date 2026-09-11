/**
 * Le pool `pg` de chaque worker, borné avant que la moindre application démarre.
 *
 * Le plafond qui compte est `max_connections` de Postgres — cent ici, partagé
 * avec les serveurs de dev qui tournent déjà. Le produit à tenir dessous est
 * `maxWorkers × DATABASE_POOL_MAX`, et les deux facteurs sont fixés côte à côte
 * (voir `jest-e2e.json`) : quatre et quatre, soit seize connexions, quel que
 * soit le nombre de suites ou de cœurs de la machine.
 *
 * La valeur vivait dans le script `test:e2e` de `package.json`. Elle en sort
 * parce qu'on lance couramment une seule suite à la main
 * (`jest --config test/jest-e2e.json events.list`) : par ce chemin le pool
 * repartait à dix, et le facteur n'était plus borné du tout.
 *
 * `??=` et non `=` : une exécution qui veut éprouver la saturation du pool doit
 * pouvoir l'imposer depuis l'environnement.
 */
process.env.DATABASE_POOL_MAX ??= '4';
