/**
 * La seconde passe : la rétention, seule.
 *
 * Ce que la suite éprouve est global par construction — `purge()` balaie la
 * plateforme, son rapport compte des lignes sans notion de projet, et son verrou
 * consultatif est pris au niveau du cluster. Aucune de ses assertions ne survit
 * à une suite qui écrirait en même temps. Voir l'en-tête de la suite : c'est le
 * refus de cloisonner la purge qui coûte cette sérialisation, et c'est assumé.
 *
 * `maxWorkers: 1` plutôt que `--runInBand` sur la ligne de commande : le flag
 * n'y faisait rien, jest passant déjà en bande dès qu'un seul fichier
 * correspond. Il énonçait une intention qu'il ne mettait pas en œuvre ; ici elle
 * est écrite là où elle vaut, à côté de la raison.
 */
module.exports = {
  ...require('./jest-e2e.json'),
  testRegex: 'retention\\.e2e-spec\\.ts$',
  maxWorkers: 1,
};
