import clsx, { type ClassValue } from 'clsx';

/** Tailwind-aware class-name joiner. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}
