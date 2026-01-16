declare module 'epubjs' {
  export type EpubLocation = {
    start?: { cfi?: string };
    end?: { cfi?: string };
  };

  export type EpubLocations = {
    generate: (chars?: number) => Promise<void>;
    percentageFromCfi: (cfi: string) => number;
    length: () => number;
  };

  export type EpubThemes = {
    register: (
      name: string,
      theme: Record<string, Record<string, string>>,
    ) => void;
    select: (name: string) => void;
    override: (property: string, value: string) => void;
  };

  export type EpubRendition = {
    display: (target?: string) => Promise<void>;
    prev: () => void;
    next: () => void;
    destroy: () => void;
    on: (event: 'relocated', handler: (loc: EpubLocation) => void) => void;
    themes: EpubThemes;
  };

  export type EpubBook = {
    ready: Promise<void>;
    renderTo: (
      element: HTMLElement,
      options?: {
        width?: string | number;
        height?: string | number;
        spread?: 'none' | 'auto' | 'always';
        allowScriptedContent?: boolean;
      },
    ) => EpubRendition;
    locations: EpubLocations;
    destroy: () => void;
  };

  export type EpubFn = (data: ArrayBuffer | Blob | string) => EpubBook;

  const ePub: EpubFn;
  export default ePub;
}
