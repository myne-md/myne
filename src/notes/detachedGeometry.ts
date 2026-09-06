// Detached-window restore geometry (myne-md/myne#678, epic #173, SYNC-10).
//
// When the workspace restores a popped-out note on the next launch (behind the
// startup_open:"last" preference), a saved window position can be off every
// current display: a second monitor was unplugged. Re-showing it there would
// put the window somewhere the user cannot reach. This is the pure clamp the
// restore path applies before it re-spawns the window. Persistence itself rides
// the device-local MYW1 vault.workspace blob (never synced, no prefs field per
// decision 0136); this module is just the geometry decision, so it is Vitest-
// tested without a live window or a monitor list.

export type WindowGeometry = { x: number; y: number; width: number; height: number };

/** A display's bounds in the same logical coordinate space as the geometry. */
export type Display = { x: number; y: number; width: number; height: number };

function intersects(a: WindowGeometry, b: Display): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Keep a saved window geometry if it still overlaps any current display;
 * otherwise clamp it onto the primary display (size capped to fit, centred), so
 * a disconnected monitor never strands the window off-screen.
 */
export function clampDetachedGeometry(
  saved: WindowGeometry,
  displays: readonly Display[],
  primary: Display,
): WindowGeometry {
  if (displays.some((d) => intersects(saved, d))) return saved;

  const width = Math.min(saved.width, primary.width);
  const height = Math.min(saved.height, primary.height);
  const x = primary.x + Math.max(0, Math.round((primary.width - width) / 2));
  const y = primary.y + Math.max(0, Math.round((primary.height - height) / 2));
  return { x, y, width, height };
}
