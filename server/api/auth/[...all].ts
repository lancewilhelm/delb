import { auth } from "~/utils/auth"; // path to your auth file
import { cloudDb } from "~~/server/utils/db/cloud";
import { users } from "~/utils/db/schema";
import { count } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  if (event.path === "/api/auth/user-count") {
    const userCount = await cloudDb.select({ count: count() }).from(users);
    return userCount[0].count;
  }

  return auth.handler(toWebRequest(event));
});
