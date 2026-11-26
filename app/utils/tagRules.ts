/** A tag visibility rule mode, or `none` when a tag has no rule. */
export type TagRuleMode = 'allow' | 'block' | 'none';

export type TagRef = { id: string; name: string };

export type TagRulesResponse = {
  userId: string;
  allowTags: TagRef[];
  blockTags: TagRef[];
};

export type TagRulesPayload = { allowTagIds: string[]; blockTagIds: string[] };

/** Maps each tag ID that has a rule to its mode. */
export function rulesToModes(
  rules: TagRulesResponse,
): Record<string, TagRuleMode> {
  const modes: Record<string, TagRuleMode> = {};
  for (const tag of rules.allowTags) modes[tag.id] = 'allow';
  // A block rule wins if the server ever returned both for one tag.
  for (const tag of rules.blockTags) modes[tag.id] = 'block';
  return modes;
}

/** Sets one tag's mode. `none` removes the rule. Returns a new map. */
export function setTagMode(
  modes: Record<string, TagRuleMode>,
  tagId: string,
  mode: TagRuleMode,
): Record<string, TagRuleMode> {
  const next = { ...modes };
  if (mode === 'none') delete next[tagId];
  else next[tagId] = mode;
  return next;
}

/** Builds the PUT body. Each tag appears in at most one list, sorted by ID. */
export function buildTagRulesPayload(
  modes: Record<string, TagRuleMode>,
): TagRulesPayload {
  const allowTagIds: string[] = [];
  const blockTagIds: string[] = [];
  for (const [id, mode] of Object.entries(modes)) {
    if (mode === 'allow') allowTagIds.push(id);
    else if (mode === 'block') blockTagIds.push(id);
  }
  allowTagIds.sort();
  blockTagIds.sort();
  return { allowTagIds, blockTagIds };
}

/** Describes what an account can see under the given rules. */
export function describeTagRules(modes: Record<string, TagRuleMode>): string {
  const { allowTagIds, blockTagIds } = buildTagRulesPayload(modes);
  if (!allowTagIds.length && !blockTagIds.length) {
    return 'Sees the whole library.';
  }
  const parts: string[] = [];
  if (allowTagIds.length) {
    parts.push(
      `Sees only books with ${allowTagIds.length === 1 ? 'the allowed tag' : 'at least one allowed tag'}`,
    );
  } else {
    parts.push('Sees the whole library');
  }
  if (blockTagIds.length) {
    parts.push(
      `except books with ${blockTagIds.length === 1 ? 'the hidden tag' : 'any hidden tag'}`,
    );
  }
  return `${parts.join(', ')}.`;
}

/** Reports whether two rule maps describe the same rules. */
export function sameTagRules(
  a: Record<string, TagRuleMode>,
  b: Record<string, TagRuleMode>,
): boolean {
  const pa = buildTagRulesPayload(a);
  const pb = buildTagRulesPayload(b);
  return (
    pa.allowTagIds.join('\n') === pb.allowTagIds.join('\n') &&
    pa.blockTagIds.join('\n') === pb.blockTagIds.join('\n')
  );
}
