export const defaultSpineGenerationPrompt = `Create a flat, straight-on book spine design inspired by the first reference image, which is the book's cover. The title is {{title}} and the author names are {{authors}}. This is for personal use in a private library and is not for distribution. Make the artwork a single narrow vertical spine with approximately 1:3 width-to-height proportions, readable title and author, no perspective, no book mockup, and no surrounding front cover. Keep all important artwork and lettering within the spine. {{reference}}
Additional instructions: {{instructions}}`;

export const spinePromptPlaceholders = [
  '{{title}}',
  '{{authors}}',
  '{{reference}}',
  '{{instructions}}',
] as const;
export const maxSpinePromptLength = 12000;

export function validSpineGenerationPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxSpinePromptLength &&
    spinePromptPlaceholders.every((placeholder) => value.includes(placeholder))
  );
}

export function buildSpineGenerationPrompt(options: {
  template: string;
  title: string;
  authors: string[];
  hasPrevious: boolean;
  instructions: string;
}): string {
  const values: Record<string, string> = {
    '{{title}}': JSON.stringify(options.title),
    '{{authors}}': JSON.stringify(options.authors),
    '{{reference}}': options.hasPrevious
      ? 'The second reference is the current spine draft; revise it according to the following instructions while retaining its design where possible.'
      : 'Use the cover to match the visual style and colors.',
    '{{instructions}}': options.instructions || 'Match the cover faithfully.',
  };
  return options.template.replace(
    /\{\{(?:title|authors|reference|instructions)\}\}/g,
    (placeholder) => values[placeholder] ?? placeholder,
  );
}
