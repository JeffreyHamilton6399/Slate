/**
 * Avatar — a circular profile image, or the person's initial on an accent
 * disc when they have no photo. Shared by the Home header button, the Profile
 * screen, and the friends list so avatars look the same everywhere.
 */

import { cn } from '../utils/cn';

interface AvatarProps {
  /** Data URL / image URL, or null/empty for the initial fallback. */
  url?: string | null;
  /** Name or email — first character is the fallback initial. */
  name?: string;
  /** Pixel diameter. */
  size?: number;
  className?: string;
}

export function Avatar({ url, name, size = 36, className }: AvatarProps) {
  const initial = (name?.trim()?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 font-semibold text-accent',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        initial
      )}
    </span>
  );
}
