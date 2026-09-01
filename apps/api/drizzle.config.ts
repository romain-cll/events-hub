import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    'DATABASE_URL absent : copie apps/api/.env.example vers apps/api/.env.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
