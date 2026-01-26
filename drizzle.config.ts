import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './.drizzle/migrations',
  schema: './app/utils/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'data/delb.db',
  },
});
