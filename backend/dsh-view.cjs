'use strict';

const { WebContentsView, shell } = require('electron');
const { configureVoicePermissions } = require('./dsh-voice.cjs');

/**
 * Hosts the DSH web UI as a first-party child view of the main window so its
 * loopback auth cookie behaves like a normal site cookie (no iframe third-party
 * partitioning) while the React shell keeps drawing everything around it.
 */
class DshViewManager {
  /**
   * @param {() => import('electron').BrowserWindow | null} hostWindow
   * @param {() => string | null} resolveUrl
   * @param {() => void} [onLoaded] fired once the child view finishes painting
   */
  constructor(hostWindow, resolveUrl, onLoaded) {
    this.hostWindow = hostWindow;
    this.resolveUrl = resolveUrl;
    this.onLoaded = onLoaded;
    this.view = null;
    this.bounds = null;
    this.leftInset = 0;
    this.rightInset = 0;
    this.topInset = 0;
    this.hidden = false;
    this.loadedAuthUrl = null;
  }

  get isAttached() {
    return this.view !== null;
  }

  attach() {
    const window = this.hostWindow();
    const url = this.resolveUrl();
    console.info(`[desktop/dsh] view.attach hasView=${Boolean(this.view)} hasUrl=${Boolean(url)}`);
    if (this.view || !window || window.isDestroyed() || !url) return false;
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
        partition: 'persist:adh-agent' },
    });
    this.view = view;
    configureVoicePermissions(view.webContents.session, view.webContents, this.resolveUrl);
    window.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https:\/\//i.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    // The native view paints over the renderer only after its document loads;
    // gate the boot overlay on this so the shell never reveals a half-drawn frame.
    view.webContents.on('did-finish-load', () => { this.onLoaded?.(); });
    this.applyBounds();
    this.loadAuthenticatedUrl(url);
    return true;
  }

  /** After a host restart the port and token change; re-point the attached view. */
  reloadResolvedUrl() {
    if (!this.view) return false;
    const url = this.resolveUrl();
    if (!url || this.loadedAuthUrl === url) return false;
    this.loadAuthenticatedUrl(url);
    return true;
  }

  loadAuthenticatedUrl(url) {
    this.loadedAuthUrl = url;
    void this.view.webContents.loadURL(url).catch(() => {
      if (this.loadedAuthUrl === url) this.loadedAuthUrl = null;
      console.warn('[desktop/dsh] view navigation failed');
    });
  }

  detach() {
    const window = this.hostWindow();
    console.info(`[desktop/dsh] view.detach hasView=${Boolean(this.view)} hasWindow=${Boolean(window && !window.isDestroyed())}`);
    if (this.view && window && !window.isDestroyed()) window.contentView.removeChildView(this.view);
    this.view?.webContents.close();
    this.view = null;
    this.loadedAuthUrl = null;
  }

  setBounds(bounds) {
    this.bounds = bounds;
    this.applyBounds();
  }

  setLeftInset(px) {
    this.leftInset = Math.max(0, Math.round(px));
    this.applyBounds();
  }

  setRightInset(px) {
    this.rightInset = Math.max(0, Math.round(px));
    this.applyBounds();
  }

  setTopInset(px) {
    this.topInset = Math.max(0, Math.round(px));
    this.applyBounds();
  }

  /** Shell modals lock renderer input, so the native child must yield its surface. */
  setHidden(hidden) {
    this.hidden = hidden === true;
    this.applyBounds();
  }

  applyBounds() {
    if (!this.view) return;
    this.view.setVisible(!this.hidden);
    if (!this.bounds) return;
    const { x, y, width, height } = this.bounds;
    const li = Math.min(this.leftInset, width);
    const ri = Math.min(this.rightInset, Math.max(0, width - li));
    const ti = Math.min(this.topInset, height);
    this.view.setBounds({ x: x + li, y: y + ti, width: Math.max(0, width - li - ri), height: Math.max(0, height - ti) });
  }
}

module.exports = { DshViewManager };
