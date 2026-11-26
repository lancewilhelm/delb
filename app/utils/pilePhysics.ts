import {
  FULL_PILE_REGION,
  type PilePlacement,
  type PileRegion,
} from '~/utils/dashboardArt';

/**
 * Pseudo-3D "books on a table" physics for the Pile card art.
 *
 * Top-down model: x/y slide on the table, `z` is height above it (drawn as
 * scale + shadow), tilt follows drag velocity, and gravity pulls `z` back down.
 * Books overlap like a real pile; they do not collide with each other.
 * The animation loop only runs while something is moving.
 */
type Body = {
  el: HTMLElement;
  w: number;
  h: number;
  x: number;
  y: number;
  a: number;
  z: number;
  vx: number;
  vy: number;
  va: number;
  vz: number;
  tx: number;
  ty: number;
  drag: { ox: number; oy: number; lx: number; ly: number; lt: number } | null;
};

// Height units per second squared. At 32, a released book lands in about a
// fifth of a second, and a full pile finishes dropping in about half a second.
const GRAVITY = 32;
const DRAG_LIFT = 0.75;
const MAX_SPEED = 1600;
const CLICK_SLOP_PX = 4;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function attachPilePhysics(
  tile: HTMLElement,
  items: HTMLElement[],
  placements: PilePlacement[],
  options: { reducedMotion: boolean; region?: PileRegion },
): {
  dispose: () => void;
  consumeDrag: () => boolean;
  positions: () => PilePlacement[];
} {
  const W = tile.clientWidth;
  const H = tile.clientHeight;
  const region = options.region ?? FULL_PILE_REGION;
  // Big piles drop in faster so the last book doesn't lag behind.
  const dropping = items.filter((_, i) => placements[i]?.drop !== false);
  const stagger = Math.min(0.45, 4 / Math.max(1, dropping.length));
  let dropIndex = 0;
  let zTop = 10;
  let raf = 0;
  let last = 0;
  let moved = 0;
  let dragged = false;

  const bodies: Body[] = items.map((el, i) => {
    const p = placements[i] ?? { x: 0.3, y: 0.3, r: 0 };
    const drops = !options.reducedMotion && p.drop !== false;
    return {
      el,
      w: el.offsetWidth,
      h: el.offsetHeight,
      x: p.x * W,
      y: p.y * H,
      a: p.r,
      // Books drop in one after another unless motion is reduced.
      z: drops ? 1.2 + dropIndex++ * stagger : 0,
      vx: 0,
      vy: 0,
      va: 0,
      vz: 0,
      tx: 0,
      ty: 0,
      drag: null,
    };
  });

  const local = (event: PointerEvent) => {
    const rect = tile.getBoundingClientRect();
    // CSS zoom/transforms: convert viewport pixels to the tile's own pixels.
    const scale = rect.width / (tile.clientWidth || rect.width || 1);
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const draw = (b: Body) => {
    const lift = options.reducedMotion ? 0 : b.z;
    b.el.style.transform = `translate(${b.x}px, ${b.y}px) rotate(${b.a}deg) rotateX(${b.tx}deg) rotateY(${b.ty}deg) scale(${1 + lift * 0.16})`;
    b.el.style.boxShadow = `${3 + lift * 10}px ${5 + lift * 18}px ${10 + lift * 24}px rgb(0 0 0 / ${Math.max(0.12, 0.36 - lift * 0.07)})`;
    b.el.style.opacity = String(clamp(3 - b.z, 0, 1));
  };

  const step = (b: Body, dt: number): boolean => {
    if (b.drag) {
      b.z += (DRAG_LIFT - b.z) * Math.min(1, dt * 14);
      if (!options.reducedMotion) {
        b.tx += (clamp(-b.vy * 0.04, -30, 30) - b.tx) * Math.min(1, dt * 12);
        b.ty += (clamp(b.vx * 0.04, -30, 30) - b.ty) * Math.min(1, dt * 12);
        b.a += b.va * dt;
      }
      b.va *= Math.exp(-5 * dt);
      return true;
    }
    b.vz -= GRAVITY * dt;
    b.z += b.vz * dt;
    if (b.z <= 0) {
      b.z = 0;
      if (b.vz < -0.7 && !options.reducedMotion) {
        b.vz = -b.vz * 0.3;
        b.va += (Math.random() - 0.5) * 50;
      } else b.vz = 0;
    }
    const onTable = b.z === 0;
    const friction = Math.exp((onTable ? -5 : -0.5) * dt);
    b.vx *= friction;
    b.vy *= friction;
    b.va *= Math.exp((onTable ? -6 : -0.8) * dt);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.va * dt;
    // Books may hang a little past the region edge; the box clips them.
    const minX = region.x0 * W - b.w * 0.3;
    const maxX = region.x1 * W - b.w * 0.7;
    const minY = region.y0 * H - b.h * 0.2;
    const maxY = region.y1 * H - b.h * 0.65;
    if (b.x < minX) [b.x, b.vx] = [minX, Math.abs(b.vx) * 0.45];
    if (b.x > maxX) [b.x, b.vx] = [maxX, -Math.abs(b.vx) * 0.45];
    if (b.y < minY) [b.y, b.vy] = [minY, Math.abs(b.vy) * 0.45];
    if (b.y > maxY) [b.y, b.vy] = [maxY, -Math.abs(b.vy) * 0.45];
    const settle = Math.exp((onTable ? -10 : -3) * dt);
    b.tx *= settle;
    b.ty *= settle;
    return (
      b.z > 0 ||
      Math.abs(b.vx) + Math.abs(b.vy) > 3 ||
      Math.abs(b.va) > 2 ||
      Math.abs(b.tx) + Math.abs(b.ty) > 0.3
    );
  };

  const tick = (time: number) => {
    const dt = Math.min(0.033, (time - last) / 1000);
    last = time;
    let active = false;
    for (const b of bodies) {
      active = step(b, dt) || active;
      draw(b);
    }
    raf = active ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const b = bodies.find((body) =>
      body.el.contains(event.target as Node | null),
    );
    if (!b) return;
    event.preventDefault();
    const p = local(event);
    b.drag = {
      ox: p.x - b.x,
      oy: p.y - b.y,
      lx: p.x,
      ly: p.y,
      lt: performance.now(),
    };
    b.vx = 0;
    b.vy = 0;
    moved = 0;
    b.el.style.zIndex = String(++zTop);
    b.el.classList.add('is-dragging');
    try {
      tile.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured.
    }
    kick();
  };
  const onMove = (event: PointerEvent) => {
    const b = bodies.find((body) => body.drag);
    if (!b?.drag) return;
    const p = local(event);
    const now = performance.now();
    const dt = Math.max(8, now - b.drag.lt) / 1000;
    const ivx = (p.x - b.drag.lx) / dt;
    const ivy = (p.y - b.drag.ly) / dt;
    moved += Math.abs(p.x - b.drag.lx) + Math.abs(p.y - b.drag.ly);
    b.vx = b.vx * 0.5 + ivx * 0.5;
    b.vy = b.vy * 0.5 + ivy * 0.5;
    // Grabbing off-center makes the book swing around the grab point.
    const rx = b.drag.ox - b.w / 2;
    const ry = b.drag.oy - b.h / 2;
    b.va = clamp(b.va + (rx * ivy - ry * ivx) * 0.0006, -420, 420);
    b.x = p.x - b.drag.ox;
    b.y = p.y - b.drag.oy;
    b.drag.lx = p.x;
    b.drag.ly = p.y;
    b.drag.lt = now;
    kick();
  };
  const onUp = () => {
    const b = bodies.find((body) => body.drag);
    if (!b) return;
    b.drag = null;
    b.el.classList.remove('is-dragging');
    if (moved > CLICK_SLOP_PX) dragged = true;
    b.vx = clamp(b.vx, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(b.vy, -MAX_SPEED, MAX_SPEED);
    b.vz = options.reducedMotion ? 0 : 0.6;
    kick();
  };

  tile.addEventListener('pointerdown', onDown);
  tile.addEventListener('pointermove', onMove);
  tile.addEventListener('pointerup', onUp);
  tile.addEventListener('pointercancel', onUp);
  bodies.forEach(draw);
  kick();

  return {
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      tile.removeEventListener('pointerdown', onDown);
      tile.removeEventListener('pointermove', onMove);
      tile.removeEventListener('pointerup', onUp);
      tile.removeEventListener('pointercancel', onUp);
    },
    /** Where each book lies now, in the order of `items`. */
    positions() {
      return bodies.map((b) => ({ x: b.x / W, y: b.y / H, r: b.a }));
    },
    /** True once after a real drag, so the tile can swallow the trailing click. */
    consumeDrag() {
      const was = dragged;
      dragged = false;
      return was;
    },
  };
}
