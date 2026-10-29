import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGO = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'assets', 'LOGO.png'));

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress ?? '';
  const normalized = address.toLowerCase();
  const loopbackSocket = normalized === '::1' || normalized.startsWith('::ffff:127.') || address.startsWith('127.');
  if (!loopbackSocket) return false;
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export const name = 'adh-brand';
export const inject = ['webServer'];

/** Host half: serve the ADH logo to the client bundle over the loopback web server. */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/api/adh-brand/logo.png',
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          res.statusCode = 403;
          res.end('forbidden: loopback-only');
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(LOGO);
      },
    });
    return () => dispose();
  }, 'adh-brand: logo route');

  // Shell cosmetics that align the embedded host with the ADH desktop shell:
  // blue-violet page floor, indigo scrollbars and focus rings.
  ctx.effect(() => {
    const dispose = ctx.webServer.tapIndex?.((html) => html.replace('</head>', `${ADH_SHELL_CSS}</head>`));
    return typeof dispose === 'function' ? dispose : undefined;
  }, 'adh-brand: shell css');
}

const ADH_SHELL_CSS = `<style id="adh-shell-cosmetics">
  /* Immersive embed: the DSH surface fills the shell content area edge to edge;
     only scrollbars, selection and focus rings are harmonized with the shell. */
  ::selection { background: rgba(81, 103, 233, 0.22); }
  * { scrollbar-width: thin; scrollbar-color: rgba(81, 103, 233, 0.58) transparent; }
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, rgba(81, 103, 233, 0.58), rgba(139, 92, 231, 0.42));
    border-radius: 8px;
  }
  *::-webkit-scrollbar-track { background: transparent; }
  :focus-visible { outline: 2px solid #5167e9; outline-offset: 2px; }
  /* The upstream "preview" badge is noise inside a shipped product surface.
     Class prefix is module-scoped but stable for a pinned DSH version. */
  [class*="previewBadge"] { display: none !important; }
  /* Settings dialogs: the raw grey rectangle clashes with the shell's rounded
     panels (and its geometry reads asymmetric over the inset view), so the dim
     layer stays functional (click-outside close) but paints nothing. */
  .VOzbGW_mask { background: transparent !important; }
  /* Product decision: no logo/wordmark in the DSH sidebar brand row and no mark
     in the empty-state hero; the shell navbar already carries the brand. */
  [data-slot="sidebar.brand.mark"], [data-slot="sidebar.brand.name"],
  [data-slot="conversation.hero.brand.mark"] { display: none !important; }
  /* Hero lockup: the product name and its tagline crossfade in place. Both spans
     occupy the same grid cell, so the block never reflows as text swaps. Each
     fades up, holds, then fades out on a shared 9s loop offset by half a cycle. */
  .adh-hero { display: grid; justify-items: center; align-items: center; }
  .adh-hero > span {
    grid-area: 1 / 1;
    white-space: nowrap;
    font-weight: 800;
    background: linear-gradient(135deg, #5167e9, #8b5ce7);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    opacity: 0;
  }
  .adh-hero-name { animation: adh-hero-name 9s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
  .adh-hero-tag {
    font-size: 0.62em;
    animation: adh-hero-tag 9s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  @keyframes adh-hero-name {
    0%   { opacity: 0; transform: translateY(0.28em); }
    8%   { opacity: 1; transform: translateY(0); }
    42%  { opacity: 1; transform: translateY(0); }
    50%  { opacity: 0; transform: translateY(-0.28em); }
    100% { opacity: 0; transform: translateY(-0.28em); }
  }
  @keyframes adh-hero-tag {
    0%   { opacity: 0; transform: translateY(0.28em); }
    50%  { opacity: 0; transform: translateY(0.28em); }
    58%  { opacity: 1; transform: translateY(0); }
    92%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-0.28em); }
  }
</style>`;
