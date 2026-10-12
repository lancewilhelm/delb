/** Keep basic description formatting without executable markup or inline styles. */
export function sanitizeDescriptionHtml(input: string): string {
  if (typeof window === 'undefined') return '';

  try {
    const doc = document.implementation.createHTMLDocument('');
    const container = doc.createElement('div');
    container.innerHTML = input ?? '';

    const allowedTags = new Set([
      'DIV',
      'P',
      'BR',
      'EM',
      'I',
      'STRONG',
      'B',
      'UL',
      'OL',
      'LI',
      'BLOCKQUOTE',
      'A',
      'SPAN',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HR',
    ]);
    const removedTags = new Set([
      'SCRIPT',
      'STYLE',
      'IFRAME',
      'OBJECT',
      'EMBED',
      'TEMPLATE',
      'SVG',
      'MATH',
    ]);

    const walk = (node: Node): void => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (removedTags.has(el.tagName)) {
          el.remove();
          return;
        }

        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (name === 'title') continue;
          if (name === 'href' && el.tagName === 'A') {
            // Browsers ignore embedded ASCII whitespace/control characters in
            // URL schemes. Check the same normalized value before preserving it.
            // URL scheme checks must account for browser-ignored controls.
            // eslint-disable-next-line no-control-regex
            const value = attr.value.replace(/[\u0000-\u0020\u007f]/g, '');
            const scheme = /^([a-z][a-z0-9+.-]*):/i
              .exec(value)?.[1]
              ?.toLowerCase();
            if (!scheme || ['https', 'http', 'mailto'].includes(scheme))
              continue;
          }
          el.removeAttribute(attr.name);
        }

        // Sanitize descendants before moving them out of an unsupported wrapper.
        for (const child of Array.from(el.childNodes)) walk(child);
        if (!allowedTags.has(el.tagName)) {
          const parent = el.parentNode;
          if (parent) {
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
          }
        }
        return;
      }

      if (node.nodeType !== Node.TEXT_NODE) node.parentNode?.removeChild(node);
    };

    // The container is a root, not input content.
    for (const child of Array.from(container.childNodes)) walk(child);
    return container.innerHTML;
  } catch {
    return '';
  }
}
