window.__ModuleLoader__.load({
  id: '@aidesign/dsh-client-ui-brand',
  factory(require) {
    // Product decision: the DSH sidebar brand row and the hero mark stay hidden
    // (injected CSS owns that); the shell navbar carries the ADH brand. The hero
    // headline becomes a looping lockup: the product name crossfades into the
    // tagline and back.
    const HERO_ANIM_CLASS = 'adh-hero';
    const HERO_NAME = 'AI Design Hub';
    const HERO_TAGLINE = 'Your Design. Every AI. One Hub.';

    // Primary family of the ADH desktop shell.
    // overrideTokens refuses bare strings: every alias needs both palettes.
    const pair = (light, dark) => ({ light, dark });
    const BRAND_TOKENS = {
      '--dsw-alias-brand-primary': pair('#5167e9', '#8b9bff'),
      '--dsw-alias-brand-text': pair('#5167e9', '#c7c0ff'),
      '--dsw-alias-state-business-primary': pair('#5167e9', '#8b9bff'),
      '--dsw-alias-button-primary-fill': pair('#5167e9', '#6d7dff'),
      '--dsw-alias-button-primary-hover': pair('#4353d6', '#8b9bff'),
      '--dsw-alias-button-primary-dimmed': pair('#e9e7f8', '#2a2a3d'),
      '--dsw-alias-label-primary': pair('#5167e9', '#c7c0ff'),
      '--dsw-alias-label-primary-bluish': pair('#5167e9', '#8b9bff'),
      '--dsw-alias-interactive-bg-hover-accent': pair('#e9e7f8', '#2a2a3d'),
    };

    return {
      inject: ['theme'],
      apply(ctx) {
        ctx.effect(() => ctx.theme.overrideTokens('adh-brand', BRAND_TOKENS), 'adh-brand: tokens');
        // Replace the upstream hero headline text node with the looping brand
        // lockup. Re-runs on DOM churn; the presence check keeps it idempotent.
        ctx.effect(() => {
          const buildHero = () => {
            const wrap = document.createElement('span');
            wrap.className = HERO_ANIM_CLASS;
            const nameEl = document.createElement('span');
            nameEl.className = `${HERO_ANIM_CLASS}-name`;
            nameEl.textContent = HERO_NAME;
            const tagEl = document.createElement('span');
            tagEl.className = `${HERO_ANIM_CLASS}-tag`;
            tagEl.textContent = HERO_TAGLINE;
            wrap.append(nameEl, tagEl);
            return wrap;
          };

          const injectHero = () => {
            for (const group of document.querySelectorAll('[class*="titleGroup"]')) {
              const headline = [...group.querySelectorAll('span')].find((span) => (
                !span.className && span.childElementCount === 0
                && (span.textContent || '').trim().length > 1
                && !span.closest('[class*="previewBadge"]')
              ));
              if (!headline || headline.querySelector(`.${HERO_ANIM_CLASS}`)) continue;
              headline.textContent = '';
              headline.appendChild(buildHero());
            }
          };
          injectHero();
          const observer = new MutationObserver(injectHero);
          observer.observe(document.body, { childList: true, subtree: true });
          return () => observer.disconnect();
        }, 'adh-brand: hero animation');
        // The agent-level appearance section is deferred: a global product-wide
        // settings surface will own theming later, so hide the group here.
        ctx.effect(() => {
          const hideAppearance = () => {
            for (const title of document.querySelectorAll('[class*="_title"]')) {
              if ((title.textContent || '').trim() !== '外观') continue;
              const group = title.closest('[class*="_group"]');
              if (group && group.style.display !== 'none') group.style.display = 'none';
            }
          };
          hideAppearance();
          const observer = new MutationObserver(hideAppearance);
          observer.observe(document.body, { childList: true, subtree: true });
          return () => observer.disconnect();
        }, 'adh-brand: hide appearance settings');
        // DSH 0.2.0-rc.2 mounts some popups (model picker, thinking level) in a
        // subtree that never inherits body[data-ds-dark-theme], so they render
        // the light palette — pale text on a white panel — inside a dark shell.
        // Tagging the popup root with the dark attribute applies the scoped
        // dark tokens from the popup down without touching DSH sources.
        ctx.effect(() => {
          const MENU_SELECTOR = '[data-menu-material],[role="menu"],[role="listbox"]';
          const TAG = 'data-adh-dark-fix';
          const isLightBg = (el) => {
            const channels = getComputedStyle(el).backgroundColor.match(/\d+/g);
            return !!channels && (Number(channels[0]) + Number(channels[1]) + Number(channels[2])) / 3 > 200;
          };
          const sync = () => {
            const dark = document.body.hasAttribute('data-ds-dark-theme');
            if (!dark) {
              for (const tagged of document.querySelectorAll(`[${TAG}]`)) {
                tagged.removeAttribute(TAG);
                tagged.removeAttribute('data-ds-dark-theme');
              }
              return;
            }
            for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
              if (menu.hasAttribute(TAG)) continue;
              if (isLightBg(menu) || (menu.firstElementChild && isLightBg(menu.firstElementChild))) {
                menu.setAttribute(TAG, '');
                menu.setAttribute('data-ds-dark-theme', '');
              }
            }
          };
          let queued = false;
          const queueSync = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; sync(); });
          };
          sync();
          const observer = new MutationObserver(queueSync);
          observer.observe(document.body, { childList: true, subtree: true });
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
          return () => observer.disconnect();
        }, 'adh-brand: dark popup parity');
      },
    };
  },
});
