import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

const databaseUrl = process.env.DATABASE_URL || 'file:./data/delb.db';
const client = createClient({ url: databaseUrl });

export const cloudDb = drizzle(client);
