/**
 * Shared, viewport-scoped "where is the user looking" snapshot.
 *
 * The R3F `CameraTracking` component publishes the orbit target and the world
 * height currently spanning the viewport every frame; non-canvas callers (the
 * model importer, which runs from a dialog or an OS drop and has no access to
 * the live camera) read the latest value to place + size a fresh import at the
 * spot the user is actually looking at, rather than dumping it at the world
 * origin at a fixed size.
 */

export interface CameraFocus {
  /** Orbit target in world space — the point the camera is looking at. */
  center: { x: number; y: number; z: number };
  /** World-space height spanning the full viewport at the target distance.
   *  Used to size an import to a consistent fraction of the screen. */
  viewSize: number;
  /** performance.now() timestamp of this sample (staleness guard). */
  ts: number;
}

let latest: CameraFocus | null = null;

export function setCameraFocus(focus: CameraFocus): void {
  latest = focus;
}

/** Latest focus, or null if none was published in the last `maxAgeMs` (e.g. the
 *  3D viewport isn't mounted, so we can't know where the user is looking). */
export function getCameraFocus(maxAgeMs = 2000): CameraFocus | null {
  if (!latest) return null;
  if (performance.now() - latest.ts > maxAgeMs) return null;
  return latest;
}
