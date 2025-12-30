import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./app/utils/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: "data/opentome.db",
  },
});
