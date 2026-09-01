import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Socle commun à toutes les apps du monorepo.
 *
 * Le lint est type-aware (`recommendedTypeChecked`) : chaque app doit fournir
 * `tsconfigRootDir` dans son propre eslint.config.mjs pour que le service
 * TypeScript pointe sur son tsconfig.
 *
 * `prettier` est en dernier et se contente de désactiver les règles ESLint qui
 * entrent en conflit avec le formatage — il ne reformate rien.
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  prettier,
);

export default base;
