import {
  getCurrentInstance,
  onScopeDispose,
  unref,
  watchEffect,
  type MaybeRefOrGetter,
} from 'vue';

export interface HeadStyleEntry {
  id?: string;
  innerHTML?: string;
  textContent?: string;
}

export interface HeadLinkEntry {
  id?: string;
  rel: string;
  type?: string;
  href: string;
  sizes?: string;
  color?: string;
}

export interface HeadInput {
  title?: MaybeRefOrGetter<string | undefined>;
  titleTemplate?: (title: string | undefined) => string;
  htmlAttrs?: {
    lang?: string;
    style?: string | Record<string, string>;
  };
  style?: HeadStyleEntry[];
  link?: HeadLinkEntry[];
}

let activeTitleTemplate: ((title: string | undefined) => string) | null = null;
let lastRawTitle: string | undefined;

function applyTitle(rawTitle: string | undefined) {
  if (typeof document === 'undefined') return;
  lastRawTitle = rawTitle;
  document.title = activeTitleTemplate
    ? activeTitleTemplate(rawTitle)
    : rawTitle || 'Delb';
}

function applyHtmlStyle(style: string | Record<string, string>) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (typeof style === 'string') {
    el.setAttribute('style', style);
    return;
  }
  for (const [key, value] of Object.entries(style)) {
    el.style.setProperty(key, value);
  }
}

function applyHeadObject(input: HeadInput) {
  if (typeof document === 'undefined') return;

  if (input.titleTemplate) {
    activeTitleTemplate = input.titleTemplate;
    applyTitle(lastRawTitle);
  }

  if ('title' in input && input.title !== undefined) {
    const resolved =
      typeof input.title === 'function' ? input.title() : unref(input.title);
    applyTitle(resolved);
  }

  if (input.htmlAttrs) {
    if (input.htmlAttrs.lang) {
      document.documentElement.lang = input.htmlAttrs.lang;
    }
    if (input.htmlAttrs.style !== undefined) {
      applyHtmlStyle(input.htmlAttrs.style);
    }
  }

  if (input.style) {
    for (const entry of input.style) {
      const css = entry.textContent ?? entry.innerHTML ?? '';
      let el = entry.id
        ? document.head.querySelector<HTMLStyleElement>(
            `style#${CSS.escape(entry.id)}`,
          )
        : null;
      if (!el) {
        el = document.createElement('style');
        if (entry.id) el.id = entry.id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    }
  }

  if (input.link) {
    for (const entry of input.link) {
      let el = entry.id
        ? document.head.querySelector<HTMLLinkElement>(
            `link#${CSS.escape(entry.id)}`,
          )
        : null;
      if (!el) {
        el = document.createElement('link');
        if (entry.id) el.id = entry.id;
        document.head.appendChild(el);
      }
      el.rel = entry.rel;
      if (entry.type) el.type = entry.type;
      el.href = entry.href;
      if (entry.sizes) el.setAttribute('sizes', entry.sizes);
      if (entry.color) el.setAttribute('color', entry.color);
    }
  }
}

export function useHead(input: HeadInput | (() => HeadInput)) {
  if (typeof document === 'undefined') return;

  if (typeof input === 'function') {
    const stop = watchEffect(() => {
      applyHeadObject(input());
    });
    if (getCurrentInstance()) {
      onScopeDispose(stop);
    }
    return;
  }

  if (
    input.title !== undefined &&
    (typeof input.title === 'function' ||
      (typeof input.title === 'object' && input.title !== null && 'value' in input.title))
  ) {
    const stop = watchEffect(() => {
      applyHeadObject(input);
    });
    if (getCurrentInstance()) {
      onScopeDispose(stop);
    }
    return;
  }

  applyHeadObject(input);
}
