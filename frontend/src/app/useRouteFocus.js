import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * Single-page navigation is silent for screen-reader users. On every route change this
 * names the browser tab after the page heading and, after the first load, moves focus to
 * that heading so the new page is announced and Tab continues from the top of it.
 * Query-string changes (tabs, filters) are not page changes and keep focus where it is.
 */
export function useRouteFocus(mainRef) {
  const { pathname } = useLocation();
  const firstLoad = useRef(true);

  useEffect(() => {
    let tries = 0;
    let timer;
    const apply = () => {
      const main = mainRef.current;
      if (!main) return;
      // Pages show a skeleton first; wait briefly for the real heading.
      const heading = main.querySelector('h1');
      if (!heading && tries < 20) {
        tries += 1;
        timer = setTimeout(apply, 100);
        return;
      }
      const name = heading?.textContent?.trim();
      document.title = name ? `${name} · HealthBridge` : 'HealthBridge';
      if (firstLoad.current) {
        firstLoad.current = false;
        return;
      }
      // Never pull focus away from someone already working inside the page.
      if (main.contains(document.activeElement) && document.activeElement !== main) return;
      const target = heading ?? main;
      target.setAttribute('tabindex', '-1');
      target.setAttribute('data-route-focus', '');
      target.focus({ preventScroll: true });
    };
    apply();
    return () => clearTimeout(timer);
  }, [pathname, mainRef]);
}
