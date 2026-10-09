import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { invalidEpub } from './errors.js';

export const OPF_NS = 'http://www.idpf.org/2007/opf';
export const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export function parseXml(data: Uint8Array, label: string): Document {
  const errors: string[] = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  });
  const document = parser.parseFromString(
    new TextDecoder().decode(data),
    'application/xml',
  );
  if (errors.length || !document.documentElement) {
    throw invalidEpub(
      `Could not parse ${label}: ${errors[0] ?? 'missing document element'}`,
    );
  }
  return document;
}

export function serializeXml(document: Document): Uint8Array {
  const serialized = new XMLSerializer().serializeToString(document);
  return new TextEncoder().encode(
    serialized.startsWith('<?xml')
      ? serialized
      : `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`,
  );
}

export function elements(root: Node, localName: string): Element[] {
  const found: Element[] = [];
  const visit = (node: Node) => {
    const children = node.childNodes;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children.item(index);
      if (!child) continue;
      if (child.nodeType === 1) {
        const element = child as Element;
        if (
          element.localName === localName ||
          element.nodeName.split(':').pop() === localName
        )
          found.push(element);
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

export function childElement(
  root: Node,
  localName: string,
): Element | undefined {
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index);
    if (child?.nodeType !== 1) continue;
    const element = child as Element;
    if (
      element.localName === localName ||
      element.nodeName.split(':').pop() === localName
    )
      return element;
  }
  return undefined;
}

export function createOpfElement(document: Document, name: string): Element {
  return document.createElementNS(OPF_NS, name);
}
