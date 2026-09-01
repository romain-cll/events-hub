import node from '@events-hub/eslint-config/node';

export default [
  { ignores: ['eslint.config.mjs', 'dist'] },
  ...node,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
