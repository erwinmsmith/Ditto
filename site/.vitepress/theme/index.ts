import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof document === 'undefined') return;
    // Translated headings have different IDs. Keep the topic, not a stale hash.
    // Capture before the default theme's SPA link handler (desktop and mobile).
    document.addEventListener('click', event => {
      const link = (event.target as Element)?.closest?.('.VPNavBarTranslations a, .VPNavScreenTranslations a');
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href);
      if (!url.hash) return;
      url.hash = '';
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        link.href = url.href;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void router.go(url.href);
    }, true);
  },
} satisfies Theme;
