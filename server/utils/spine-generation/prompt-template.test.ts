import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildSpineGenerationPrompt,
  defaultSpineGenerationPrompt,
  validSpineGenerationPrompt,
} from '../../../shared/spine-generation-prompt';

test('the default template includes book details and the correct reference instruction', () => {
  const first = buildSpineGenerationPrompt({
    template: defaultSpineGenerationPrompt,
    title: 'A title with {{authors}}',
    authors: ['An author'],
    hasPrevious: false,
    instructions: '',
  });
  assert.match(first, /A title with \{\{authors\}\}/);
  assert.match(first, /\["An author"\]/);
  assert.match(first, /Use the cover to match the visual style and colors/);
  assert.match(first, /Additional instructions: Match the cover faithfully/);
  const update = buildSpineGenerationPrompt({
    template: defaultSpineGenerationPrompt,
    title: 'A title',
    authors: [],
    hasPrevious: true,
    instructions: 'Larger letters',
  });
  assert.match(update, /second reference is the current spine draft/);
  assert.match(update, /Additional instructions: Larger letters/);
});

test('a prompt must contain every placeholder and fit the size limit', () => {
  assert.equal(validSpineGenerationPrompt(defaultSpineGenerationPrompt), true);
  assert.equal(
    validSpineGenerationPrompt(
      defaultSpineGenerationPrompt.replace('{{reference}}', ''),
    ),
    false,
  );
  assert.equal(
    validSpineGenerationPrompt(
      defaultSpineGenerationPrompt + 'x'.repeat(12001),
    ),
    false,
  );
  assert.equal(validSpineGenerationPrompt(null), false);
});
