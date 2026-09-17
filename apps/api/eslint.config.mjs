import node from '@events-hub/eslint-config/node';

export default [
  // Les fichiers de configuration ne font pas partie du programme TypeScript :
  // le parser typé ne les trouve pas dans `tsconfig.json`, et les y ajouter
  // pour les linter ferait entrer de la configuration dans le build.
  { ignores: ['eslint.config.mjs', 'test/jest-e2e.*.js', 'scripts', 'dist'] },
  ...node,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
