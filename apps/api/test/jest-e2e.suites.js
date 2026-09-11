/**
 * La première passe : toutes les suites sauf la rétention.
 *
 * ## Pourquoi un fichier plutôt qu'un argument
 *
 * L'exclusion vivait sur la ligne de commande, en
 * `--testPathIgnorePatterns /node_modules/ retention.e2e-spec`. Ça marchait, et
 * ça se lisait à l'envers : `testPathIgnorePatterns` est un flag `type: 'array'`
 * côté jest, donc il avale le jeton nu qui le suit. `retention.e2e-spec` n'était
 * pas le filtre qu'il semblait être, c'était le second élément de l'exclusion —
 * et la forme `--flag=valeur` ne referme pas le tableau non plus. Ajouter un
 * filtre à cette commande l'aurait fait basculer en silence du côté des
 * exclusions, et la passe se serait vidée sans rien dire.
 *
 * ## Et pourquoi l'exclusion n'est pas dans `jest-e2e.json`
 *
 * Parce que `jest-e2e.json` est la config qu'on utilise **à la main** pour
 * lancer une suite seule, rétention comprise. Or l'exclusion l'emporte sur le
 * filtre positionnel : y poser `retention.e2e-spec` rendrait
 * `jest --config test/jest-e2e.json retention` définitivement vide.
 */
module.exports = {
  ...require('./jest-e2e.json'),
  testPathIgnorePatterns: ['/node_modules/', 'retention\\.e2e-spec'],
};
