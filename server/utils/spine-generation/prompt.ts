import { and, eq } from 'drizzle-orm';
import { systemState } from '~~/server/utils/db/schema';
import { cloudDb } from '~~/server/utils/db/cloud';
import { defaultSpineGenerationPrompt } from '~~/shared/spine-generation-prompt';

const key = 'spine-generation-prompt';

export async function readSpineGenerationPrompt() {
  const [row] = await cloudDb
    .select({ value: systemState.value })
    .from(systemState)
    .where(eq(systemState.key, key));
  return {
    prompt: row?.value ?? defaultSpineGenerationPrompt,
    savedPrompt: row?.value ?? null,
    defaultPrompt: defaultSpineGenerationPrompt,
  };
}

export async function saveSpineGenerationPrompt(
  prompt: string,
  previous: string | null,
) {
  if (previous === null) {
    const inserted = await cloudDb
      .insert(systemState)
      .values({ key, value: prompt })
      .onConflictDoNothing()
      .returning({ key: systemState.key });
    return inserted.length > 0;
  }
  const updated = await cloudDb
    .update(systemState)
    .set({ value: prompt })
    .where(and(eq(systemState.key, key), eq(systemState.value, previous)))
    .returning({ key: systemState.key });
  return updated.length > 0;
}
