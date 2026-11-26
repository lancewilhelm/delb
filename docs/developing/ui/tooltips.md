# Tooltip directive

Delb includes a reusable tooltip directive (`v-tooltip`) in [`app/directives/tooltip.ts`](../../../app/directives/tooltip.ts). The directive renders tooltips into `document.body` so scroll or overflow containers do not clip them, and it flips and clamps placement to stay inside the viewport.

## Usage

### Basic string form

```vue
<template>
  <button v-tooltip="'Save changes'">Save</button>
</template>
```

### Options object form

```vue
<template>
  <button
    v-tooltip="{
      text: 'Saves your changes',
      side: 'right',
      offset: 10,
      viewportPadding: 12,
      showDelay: 200,
      hideDelay: 0,
    }"
  >
    Save
  </button>
</template>
```

## Options

Pass either a `string` (tooltip text) or an object with the fields below:

- **`text`** (`string`, required in object form): The tooltip content.
- **`side`** (`"top" | "right" | "bottom" | "left"`, default `"top"`): Preferred placement side. When `autoFlip` is enabled, the tooltip can render on another side to avoid clipping.
- **`offset`** (`number`, default `8`): Gap in pixels between the target element and the tooltip.
- **`viewportPadding`** (`number`, default `8`): Minimum distance in pixels from the viewport edges.
- **`showDelay`** (`number`, default `500`): Delay in milliseconds before showing the tooltip on hover or focus.
- **`hideDelay`** (`number`, default `0`): Delay in milliseconds before hiding the tooltip on leave or blur.
- **`maxWidth`** (`string`, optional): Per-tooltip CSS `max-width` value such as `"240px"` or `"20rem"`. Defaults to `--tooltip-max-width`.
- **`autoFlip`** (`boolean`, default `true`): Allows the tooltip to choose the side that best fits within the viewport.
- **`interactive`** (`boolean`, default `false`): Sets `pointer-events: auto` on the tooltip so pointer interaction is possible. Tooltips default to `pointer-events: none` so they do not interfere with hovering or clicking the target.

## Behavior notes

- **Teleported to `document.body`.** Appending the tooltip node to `document.body` prevents clipping by ancestors with `overflow: hidden`, `auto`, or `scroll`.
- **Viewport clamping.** Coordinates clamp to the viewport using `viewportPadding`, and `autoFlip` switches sides when the preferred side lacks space.
- **Keyboard accessibility.** The directive shows tooltips on `focus` and hides them on `blur`. For non-focusable elements, it can add `tabindex="0"`, but it skips elements with `aria-hidden="true"` so decorative icons never receive focus.
- **ARIA wiring.** Accessible targets receive `aria-describedby` pointing to the tooltip. Elements with `aria-hidden="true"` rely on an accessible wrapper (such as a `<button aria-label="...">`) instead.
- **Outside dismissal.** A pointer-down event outside the target (and outside the tooltip when `interactive: true`) hides an open tooltip.

## Styling

Tooltips use global styles under `.tooltip` in [`app/assets/css/main.css`](../../../app/assets/css/main.css). The directive sets `--tooltip-x` and `--tooltip-y` for positioning. Available CSS variables include:

- `--tooltip-bg`
- `--tooltip-fg`
- `--tooltip-shadow`
- `--tooltip-radius`
- `--tooltip-max-width`
- `--tooltip-z`
- `--tooltip-arrow-size`
