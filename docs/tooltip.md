# Tooltip Directive

Delb includes a simple, reusable tooltip directive (`v-tooltip`) that you can attach to **any** element. The tooltip is rendered into `document.body` (so it won’t be clipped by scroll/overflow containers), and it will **auto-flip / clamp** to stay within the viewport.

## Usage

### 1) Basic (string)

```/dev/null/example.vue#L1-7
<template>
  <button v-tooltip="'Save changes'">
    Save
  </button>
</template>
```

### 2) With options (object)

```/dev/null/example.vue#L1-18
<template>
  <button
    v-tooltip="{
      text: 'Saves your changes',
      side: 'right',
      offset: 10,
      viewportPadding: 12,
      showDelay: 200,
      hideDelay: 0
    }"
  >
    Save
  </button>
</template>
```

## Options

You can pass either:

- a `string` (tooltip text), or
- an object with the following fields:

### `text` (required for object form)

- Type: `string`
- The tooltip content.

### `side`

- Type: `"top" | "right" | "bottom" | "left"`
- Default: `"top"`
- Preferred placement side. If `autoFlip` is enabled, the tooltip may render on a different side to avoid clipping.

### `offset`

- Type: `number`
- Default: `8`
- Gap (in pixels) between the target element and the tooltip.

### `viewportPadding`

- Type: `number`
- Default: `8`
- Minimum distance (in pixels) to keep from the viewport edges.

### `showDelay`

- Type: `number`
- Default: `150`
- Delay (ms) before showing the tooltip on hover/focus.

### `hideDelay`

- Type: `number`
- Default: `0`
- Delay (ms) before hiding the tooltip on leave/blur.

### `maxWidth`

- Type: `string` (CSS value, e.g. `"240px"`, `"20rem"`)
- Optional
- Sets a per-tooltip max width; otherwise defaults to the global CSS variable `--tooltip-max-width`.

### `autoFlip`

- Type: `boolean`
- Default: `true`
- When enabled, the tooltip will choose a side that best fits within the viewport.

### `interactive`

- Type: `boolean`
- Default: `false`
- When enabled, the tooltip allows pointer interaction (sets `pointer-events: auto` on the tooltip).  
  Note: the tooltip is non-interactive by default (`pointer-events: none`) to avoid interfering with hovering/clicking the target.

## Behavior notes

- **Teleported to body:** Tooltip DOM is appended to `document.body`, which avoids clipping by containers with `overflow: hidden/auto/scroll`.
- **Viewport safety:** Tooltip coordinates are clamped to the viewport with `viewportPadding`, and it can `autoFlip` when there isn’t enough room on the preferred side.
- **Keyboard accessibility:** The directive shows tooltips on `focus` and hides them on `blur`.
  - For non-focusable elements, the directive may add `tabindex="0"` so keyboard users can reveal the tooltip.
  - The directive should **not** add `tabindex` to elements that are `aria-hidden="true"` (common for decorative icon spans), because a focused `aria-hidden` element triggers browser accessibility warnings and hides focus from assistive technology users.
- **ARIA wiring:**
  - When the target is accessible, the directive uses `aria-describedby` to associate the tooltip content.
  - If the target is `aria-hidden="true"` (or otherwise should not be described), the directive should avoid `aria-describedby` and instead rely on an accessible wrapper element (e.g. a `<button aria-label="...">...</button>`) for the name/description.
- **Dismiss on outside click/tap:** If a tooltip is open, pointer down outside the target (and outside the tooltip when `interactive: true`) hides it.

## Styling

Tooltips use global CSS under the `.tooltip` class, with CSS variables for customization (defined in the main stylesheet). The directive sets positioning via:

- `--tooltip-x`
- `--tooltip-y`

You can adjust visuals by overriding variables such as:

- `--tooltip-bg`
- `--tooltip-fg`
- `--tooltip-shadow`
- `--tooltip-radius`
- `--tooltip-max-width`
- `--tooltip-z`
- `--tooltip-arrow-size`
