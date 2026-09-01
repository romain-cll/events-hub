import globals from 'globals';

import { base } from './base.js';

/** Variante Node / NestJS. */
export const node = [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
    },
  },
];

export default node;
