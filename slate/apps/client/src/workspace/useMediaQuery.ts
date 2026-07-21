import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

export function useIsMobile(): boolean {
  // Mobile = narrow screen in portrait. Landscape phones (812×375) get the
  // full desktop layout with docks — the editor needs horizontal space and
  // the dock panels are usable when the device is sideways.
  return useMediaQuery('(max-width: 768px) and (orientation: portrait)');
}
