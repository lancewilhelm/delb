import type { Directive, DirectiveBinding } from "vue";

type TooltipSide = "top" | "right" | "bottom" | "left";

export type TooltipBindingValue =
  | string
  | {
      text: string;
      side?: TooltipSide;
      /**
       * Gap between the target and tooltip (px).
       * Default: 8
       */
      offset?: number;
      /**
       * Distance to keep from viewport edges (px).
       * Default: 8
       */
      viewportPadding?: number;
      /**
       * Show delay in ms.
       * Default: 150
       */
      showDelay?: number;
      /**
       * Hide delay in ms.
       * Default: 0
       */
      hideDelay?: number;
      /**
       * Max width (CSS value). If omitted, falls back to CSS `--tooltip-max-width`.
       */
      maxWidth?: string;
      /**
       * If true, keeps tooltip open when hovering the tooltip itself.
       * Note: tooltip is `pointer-events: none` by default in CSS; enabling this
       * also flips pointer-events to auto for the tooltip element.
       * Default: false
       */
      interactive?: boolean;

      /**
       * Whether the tooltip is allowed to flip to other sides to avoid clipping.
       * Default: true
       */
      autoFlip?: boolean;
    };

type TooltipState = {
  id: string;
  binding?: TooltipBindingValue;

  tooltipEl: HTMLDivElement | null;
  contentEl: HTMLDivElement | null;

  open: boolean;

  showTimer: number | null;
  hideTimer: number | null;

  onEnter: ((ev: Event) => void) | null;
  onLeave: ((ev: Event) => void) | null;
  onFocus: ((ev: Event) => void) | null;
  onBlur: ((ev: Event) => void) | null;
  onPointerDown: ((ev: Event) => void) | null;

  onReposition: (() => void) | null;

  cleanupFns: Array<() => void>;
};

const TOOLTIP_STATE = Symbol("tooltip");

const DEFAULTS = {
  side: "top" as TooltipSide,
  offset: 8,
  viewportPadding: 8,
  showDelay: 500,
  hideDelay: 0,
  autoFlip: true,
  interactive: false,
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function normalizeBinding(value: TooltipBindingValue | undefined | null): {
  text: string;
  side: TooltipSide;
  offset: number;
  viewportPadding: number;
  showDelay: number;
  hideDelay: number;
  maxWidth?: string;
  interactive: boolean;
  autoFlip: boolean;
} {
  if (typeof value === "string") {
    return {
      text: value,
      side: DEFAULTS.side,
      offset: DEFAULTS.offset,
      viewportPadding: DEFAULTS.viewportPadding,
      showDelay: DEFAULTS.showDelay,
      hideDelay: DEFAULTS.hideDelay,
      maxWidth: undefined,
      autoFlip: DEFAULTS.autoFlip,
      interactive: DEFAULTS.interactive,
    };
  }

  const v = value ?? { text: "" };
  return {
    text: v.text ?? "",
    side: v.side ?? DEFAULTS.side,
    offset: v.offset ?? DEFAULTS.offset,
    viewportPadding: v.viewportPadding ?? DEFAULTS.viewportPadding,
    showDelay: v.showDelay ?? DEFAULTS.showDelay,
    hideDelay: v.hideDelay ?? DEFAULTS.hideDelay,
    maxWidth: v.maxWidth ?? undefined,
    autoFlip: v.autoFlip ?? DEFAULTS.autoFlip,
    interactive: v.interactive ?? DEFAULTS.interactive,
  };
}

function nextId(): string {
  if (!isBrowser()) return "tooltip-ssr";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__delbTooltipId = (w.__delbTooltipId ?? 0) + 1;
  return `tooltip-${w.__delbTooltipId}`;
}

function clearTimer(timer: number | null): void {
  if (timer != null) window.clearTimeout(timer);
}

function getScrollParents(el: Element): Array<Element | Window> {
  const parents: Array<Element | Window> = [];
  let cur: Element | null = el.parentElement;

  while (cur) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const overflow = style.overflow;

    const isScrollable = /(auto|scroll|overlay)/.test(
      overflow + overflowX + overflowY,
    );

    if (isScrollable) parents.push(cur);
    cur = cur.parentElement;
  }

  parents.push(window);
  return parents;
}

function chooseBestSide(args: {
  preferred: TooltipSide;
  targetRect: DOMRect;
  tooltipRect: DOMRect;
  viewportPadding: number;
}): TooltipSide {
  const { preferred, targetRect, tooltipRect, viewportPadding } = args;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceTop = targetRect.top - viewportPadding;
  const spaceBottom = vh - targetRect.bottom - viewportPadding;
  const spaceLeft = targetRect.left - viewportPadding;
  const spaceRight = vw - targetRect.right - viewportPadding;

  const needH = tooltipRect.height;
  const needW = tooltipRect.width;

  const fits = (side: TooltipSide) => {
    if (side === "top") return spaceTop >= needH;
    if (side === "bottom") return spaceBottom >= needH;
    if (side === "left") return spaceLeft >= needW;
    return spaceRight >= needW;
  };

  if (fits(preferred)) return preferred;

  const opposite: Record<TooltipSide, TooltipSide> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };

  const candidates: TooltipSide[] = [
    opposite[preferred],
    "top",
    "bottom",
    "left",
    "right",
  ];

  for (const c of candidates) {
    if (fits(c)) return c;
  }

  // Nothing fits fully; choose the side with most space in the relevant axis
  const scores: Record<TooltipSide, number> = {
    top: spaceTop,
    bottom: spaceBottom,
    left: spaceLeft,
    right: spaceRight,
  };

  return (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    preferred) as TooltipSide;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function computePosition(args: {
  side: TooltipSide;
  offset: number;
  viewportPadding: number;
  targetRect: DOMRect;
  tooltipRect: DOMRect;
}): { x: number; y: number } {
  const { side, offset, viewportPadding, targetRect, tooltipRect } = args;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = 0;
  let y = 0;

  if (side === "top") {
    x = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
    y = targetRect.top - tooltipRect.height - offset;
  } else if (side === "bottom") {
    x = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
    y = targetRect.bottom + offset;
  } else if (side === "left") {
    x = targetRect.left - tooltipRect.width - offset;
    y = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
  } else {
    x = targetRect.right + offset;
    y = targetRect.top + targetRect.height / 2 - tooltipRect.height / 2;
  }

  // Clamp to viewport so it doesn't get cut off
  x = clamp(x, viewportPadding, vw - viewportPadding - tooltipRect.width);
  y = clamp(y, viewportPadding, vh - viewportPadding - tooltipRect.height);

  return { x, y };
}

function ensureTooltipEl(state: TooltipState): void {
  if (!isBrowser()) return;
  if (state.tooltipEl) return;

  const el = document.createElement("div");
  el.className = "tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("data-state", "closed");

  el.id = state.id;

  const content = document.createElement("div");
  content.className = "tooltip-content";

  const text = document.createElement("span");
  text.textContent = "";

  content.appendChild(text);
  el.appendChild(content);

  document.body.appendChild(el);

  state.tooltipEl = el;
  state.contentEl = content;
}

function setOpen(state: TooltipState, open: boolean): void {
  if (!state.tooltipEl) return;
  state.open = open;
  state.tooltipEl.setAttribute("data-state", open ? "open" : "closed");
  state.tooltipEl.style.display = open ? "" : "none";
}

function updateTooltipContentAndOptions(
  el: HTMLElement,
  state: TooltipState,
  options: ReturnType<typeof normalizeBinding>,
): void {
  ensureTooltipEl(state);
  if (!state.tooltipEl) return;

  // aria-describedby
  if (options.text.trim().length > 0) {
    el.setAttribute("aria-describedby", state.id);
  } else {
    el.removeAttribute("aria-describedby");
  }

  // content
  const textNode = state.contentEl?.querySelector("span");
  if (textNode) textNode.textContent = options.text;

  // maxWidth
  if (options.maxWidth) {
    state.tooltipEl.style.maxWidth = options.maxWidth;
  } else {
    state.tooltipEl.style.removeProperty("max-width");
  }

  // interactive toggle (pointer-events)
  state.tooltipEl.style.pointerEvents = options.interactive ? "auto" : "none";
}

function reposition(el: HTMLElement, state: TooltipState): void {
  if (!state.tooltipEl) return;
  const options = normalizeBinding(state.binding);

  // If no text, keep it closed and bail
  if (!options.text.trim()) {
    setOpen(state, false);
    return;
  }

  const targetRect = el.getBoundingClientRect();

  // Prepare measurement: show invisibly so we can measure size
  const prevDisplay = state.tooltipEl.style.display;
  const prevOpacity = state.tooltipEl.style.opacity;

  state.tooltipEl.style.display = "";
  state.tooltipEl.style.opacity = "0";
  state.tooltipEl.setAttribute("data-state", "open");

  // Tooltip may wrap based on content/maxWidth; allow layout
  const tooltipRect = state.tooltipEl.getBoundingClientRect();

  let sideToUse: TooltipSide = options.side;
  if (options.autoFlip) {
    sideToUse = chooseBestSide({
      preferred: options.side,
      targetRect,
      tooltipRect,
      viewportPadding: options.viewportPadding,
    });
  }

  // After changing side, size might not change, but position does
  const { x, y } = computePosition({
    side: sideToUse,
    offset: options.offset,
    viewportPadding: options.viewportPadding,
    targetRect,
    tooltipRect,
  });

  state.tooltipEl.style.setProperty("--tooltip-x", `${x}px`);
  state.tooltipEl.style.setProperty("--tooltip-y", `${y}px`);

  // Restore visible state according to current open flag
  state.tooltipEl.style.opacity = prevOpacity;
  state.tooltipEl.style.display = prevDisplay;
  state.tooltipEl.setAttribute("data-state", state.open ? "open" : "closed");
}

function attachRepositionListeners(el: HTMLElement, state: TooltipState): void {
  if (!isBrowser()) return;
  if (state.onReposition) return;

  const cb = () => {
    if (!state.open) return;
    reposition(el, state);
  };

  state.onReposition = cb;

  const parents = getScrollParents(el);
  const onResize = cb;
  const onScroll = cb;

  window.addEventListener("resize", onResize, { passive: true });

  for (const p of parents) {
    if (p === window) {
      window.addEventListener("scroll", onScroll, { passive: true });
    } else {
      (p as Element).addEventListener("scroll", onScroll, { passive: true });
      state.cleanupFns.push(() =>
        (p as Element).removeEventListener("scroll", onScroll),
      );
    }
  }

  state.cleanupFns.push(() => window.removeEventListener("resize", onResize));
  state.cleanupFns.push(() => window.removeEventListener("scroll", onScroll));
}

function detachRepositionListeners(state: TooltipState): void {
  state.onReposition = null;
  // scroll parent listeners are removed via cleanupFns on unmount; for hide/show we just guard by open flag
}

function show(el: HTMLElement, state: TooltipState): void {
  const options = normalizeBinding(state.binding);

  clearTimer(state.hideTimer);
  state.hideTimer = null;

  clearTimer(state.showTimer);
  state.showTimer = window.setTimeout(() => {
    ensureTooltipEl(state);
    updateTooltipContentAndOptions(el, state, options);

    if (!state.tooltipEl) return;

    reposition(el, state);
    setOpen(state, true);
    attachRepositionListeners(el, state);

    // after opening, reposition again next frame to account for fonts/layout
    requestAnimationFrame(() => {
      if (!state.open) return;
      reposition(el, state);
      setOpen(state, true);
    });
  }, options.showDelay);
}

function hide(state: TooltipState): void {
  const options = normalizeBinding(state.binding);

  clearTimer(state.showTimer);
  state.showTimer = null;

  clearTimer(state.hideTimer);
  state.hideTimer = window.setTimeout(() => {
    setOpen(state, false);
    detachRepositionListeners(state);
  }, options.hideDelay);
}

function cleanup(state: TooltipState, el?: HTMLElement): void {
  if (!isBrowser()) return;

  clearTimer(state.showTimer);
  clearTimer(state.hideTimer);
  state.showTimer = null;
  state.hideTimer = null;

  if (el) el.removeAttribute("aria-describedby");

  // remove listeners
  if (state.onEnter && el)
    el.removeEventListener("pointerenter", state.onEnter);
  if (state.onLeave && el)
    el.removeEventListener("pointerleave", state.onLeave);
  if (state.onFocus && el) el.removeEventListener("focus", state.onFocus);
  if (state.onBlur && el) el.removeEventListener("blur", state.onBlur);
  if (state.onPointerDown) {
    document.removeEventListener("pointerdown", state.onPointerDown, true);
  }

  for (const fn of state.cleanupFns) fn();
  state.cleanupFns = [];

  // remove tooltip from DOM
  if (state.tooltipEl?.parentNode) {
    state.tooltipEl.parentNode.removeChild(state.tooltipEl);
  }

  state.tooltipEl = null;
  state.contentEl = null;

  state.onEnter = null;
  state.onLeave = null;
  state.onFocus = null;
  state.onBlur = null;
  state.onPointerDown = null;

  state.open = false;
}

function getOrCreateState(el: HTMLElement): TooltipState {
  const existing = (el as unknown as Record<symbol, TooltipState>)[
    TOOLTIP_STATE
  ];
  if (existing) return existing;

  const state: TooltipState = {
    id: nextId(),
    binding: undefined,

    tooltipEl: null,
    contentEl: null,

    open: false,

    showTimer: null,
    hideTimer: null,

    onEnter: null,
    onLeave: null,
    onFocus: null,
    onBlur: null,
    onPointerDown: null,

    onReposition: null,

    cleanupFns: [],
  };

  (el as unknown as Record<symbol, TooltipState>)[TOOLTIP_STATE] = state;
  return state;
}

function bindEvents(el: HTMLElement, state: TooltipState): void {
  if (state.onEnter) return;

  state.onEnter = () => show(el, state);
  state.onLeave = () => hide(state);
  state.onFocus = () => show(el, state);
  state.onBlur = () => hide(state);

  // Close if you click/tap elsewhere
  state.onPointerDown = (ev: Event) => {
    if (!state.open) return;

    const t = ev.target as Node | null;
    if (!t) return;

    // If interactive tooltip is enabled, allow clicks within tooltip without closing
    const opts = normalizeBinding(state.binding);
    if (opts.interactive && state.tooltipEl && state.tooltipEl.contains(t)) {
      return;
    }

    // If click is on the target, keep it open (you might want click tooltips later)
    if (el.contains(t)) return;

    hide(state);
  };

  el.addEventListener("pointerenter", state.onEnter);
  el.addEventListener("pointerleave", state.onLeave);

  // Support keyboard users
  el.addEventListener("focus", state.onFocus);
  el.addEventListener("blur", state.onBlur);

  document.addEventListener("pointerdown", state.onPointerDown, true);

  state.cleanupFns.push(() => {
    if (state.onPointerDown) {
      document.removeEventListener("pointerdown", state.onPointerDown, true);
    }
  });
}

function updateFromBinding(
  el: HTMLElement,
  state: TooltipState,
  binding: DirectiveBinding<TooltipBindingValue>,
): void {
  state.binding = binding.value;

  const options = normalizeBinding(binding.value);
  updateTooltipContentAndOptions(el, state, options);

  // If binding changed while open, reposition
  if (state.open) {
    reposition(el, state);
    setOpen(state, true);
  }
}

/**
 * Usage:
 * - v-tooltip="'Hello'"
 * - v-tooltip="{ text: 'Hello', side: 'right' }"
 */
const tooltipDirective: Directive<HTMLElement, TooltipBindingValue> = {
  mounted(el, binding) {
    if (!isBrowser()) return;

    const state = getOrCreateState(el);

    // Make sure element can receive focus for accessibility if it's not naturally focusable
    if (
      !el.hasAttribute("tabindex") &&
      !(el instanceof HTMLButtonElement) &&
      !(el instanceof HTMLAnchorElement) &&
      el.getAttribute("role") !== "button" &&
      el.getAttribute("role") !== "link"
    ) {
      // Only add tabindex if tooltip text exists; keep it minimal
      const options = normalizeBinding(binding.value);
      if (options.text.trim()) el.setAttribute("tabindex", "0");
    }

    bindEvents(el, state);
    updateFromBinding(el, state, binding);
  },

  updated(el, binding) {
    if (!isBrowser()) return;

    const state = getOrCreateState(el);

    // Reuse existing tooltip; just update content/options
    updateFromBinding(el, state, binding);

    // If text becomes empty, ensure closed + cleanup tooltip DOM
    const options = normalizeBinding(binding.value);
    if (!options.text.trim() && state.open) {
      hide(state);
    }
  },

  beforeUnmount(el) {
    if (!isBrowser()) return;

    const state = (el as unknown as Record<symbol, TooltipState>)[
      TOOLTIP_STATE
    ];
    if (!state) return;

    cleanup(state, el);
    // Avoid deleting dynamically computed keys due to lint rules; just clear it.
    (el as unknown as Record<symbol, TooltipState>)[TOOLTIP_STATE] =
      undefined as unknown as TooltipState;
  },
};

export default tooltipDirective;
