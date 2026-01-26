import { migrate } from 'drizzle-orm/libsql/migrator';
import { cloudDb } from '../server/utils/db/cloud';

await migrate(cloudDb, { migrationsFolder: './.drizzle/migrations' });
