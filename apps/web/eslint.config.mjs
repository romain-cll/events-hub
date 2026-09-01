import react from '@events-hub/eslint-config/react';

export default [
  {
    ignores: [
      'eslint.config.mjs',
      '.output',
      '.nitro',
      // Généré par TanStack Router, réécrit à chaque build.
      'src/routeTree.gen.ts',
      // Déposé par `shadcn add`, et remplacé à chaque mise à jour de la CLI :
      // le corriger à la main ferait perdre les correctifs amont, et le lint
      // type-aware n'a pas prise sur le typage lâche de Recharts.
      'src/components/ui',
      // Outillage hors application : tourné à la main sous Node, jamais
      // compilé ni servi. Le lint type-aware travaille sur le `tsconfig` de
      // l'app, qui ne le couvre pas — et l'y ajouter ferait entrer `d3-geo`
      // dans le graphe de types du front pour un fichier qui n'y va pas.
      'scripts',
    ],
  },
  ...react,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
