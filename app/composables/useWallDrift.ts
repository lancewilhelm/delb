import {
  useIntersectionObserver,
  usePreferredReducedMotion,
  useResizeObserver,
} from '@vueuse/core';
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from 'vue';

/**
 * Slowly moves a cover grid upward along its columns, forever.
 *
 * The track is shifted with a transform each frame. Once it has moved one
 * full row, the offset drops back by that row and `rowStart` advances, so the
 * caller renders the grid one row further on. Vue patches the rows in the
 * same frame, so the swap is invisible. Drift stays off with reduced motion,
 * and pauses while the wall is off screen or the tab is hidden.
 */
export function useWallDrift(options: {
  /** Element whose visibility pauses the drift. */
  wall: Ref<HTMLElement | null>;
  /** The grid that moves. Its first `cols` children form the first row. */
  track: Ref<HTMLElement | null>;
  cols: Ref<number>;
  enabled: Ref<boolean>;
  /** Speed along the wall's columns, in CSS pixels per second. */
  pxPerSecond: Ref<number>;
}) {
  const rowStart = ref(0);
  const reducedMotion = usePreferredReducedMotion();
  const active = computed(
    () => options.enabled.value && reducedMotion.value !== 'reduce',
  );
  let offset = 0;
  let pitch = 0;
  let raf = 0;
  let last = 0;
  let onScreen = true;

  function measurePitch() {
    const items = options.track.value?.children;
    const first = items?.[0] as HTMLElement | undefined;
    const below = items?.[options.cols.value] as HTMLElement | undefined;
    return first && below ? below.offsetTop - first.offsetTop : 0;
  }

  function applyOffset() {
    const track = options.track.value;
    if (track) track.style.transform = offset ? `translateY(${-offset}px)` : '';
  }

  function tick(time: number) {
    // Long gaps (a background tab) resume smoothly instead of jumping.
    const dt = Math.min(0.05, (time - last) / 1000);
    last = time;
    pitch ||= measurePitch();
    if (pitch > 0) {
      offset += options.pxPerSecond.value * dt;
      if (offset >= pitch) {
        offset -= pitch;
        rowStart.value += 1;
      }
      applyOffset();
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf || !active.value || !onScreen || !options.track.value) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /** Back to the first row with no offset (drift turned off, new library). */
  function reset() {
    offset = 0;
    pitch = 0;
    rowStart.value = 0;
    applyOffset();
  }

  watch(active, (on) => {
    if (on) start();
    else {
      stop();
      reset();
    }
  });
  // The wall's grid only exists in Wall mode.
  watch(options.track, (el) => {
    if (el) start();
    else stop();
  });
  useIntersectionObserver(options.wall, ([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    if (onScreen) start();
    else stop();
  });
  // Cover sizes change at breakpoints; measure the row height again.
  useResizeObserver(options.track, () => {
    pitch = 0;
  });
  onMounted(start);
  onBeforeUnmount(stop);

  return { rowStart, active, reset };
}
