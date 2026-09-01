import node from '@events-hub/eslint-config/node';

export default [
  { ignores: ['eslint.config.mjs'] },
  ...node,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
