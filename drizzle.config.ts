import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './.drizzle/migrations',
  schema: './app/utils/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'file:./data/delb.db',
  },
});
