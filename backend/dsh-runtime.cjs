'use strict';

const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { DSH_RUNTIME_PINS, ensureDshRuntime, linkBundleIntoProfile } = require('./dsh-provisioner.cjs');
const { buildLlmPatch, themePreference } = require('./dsh-llm-bridge.cjs');
const { readPatch, mergeDshProfilePatch } = require('./dsh-profile-patch.cjs');
const { ensureProfessionalMcp, buildProfessionalMcpEntries } = require('./dsh-professional-mcp.cjs');
const { applyVoiceInputDefault } = require('./dsh-voice.cjs');
const { buildHubSkillPolicyEntries, ensureHubSkillPolicyRuntime } = require('./dsh-skill-policy.cjs');
const { stageProfessionalSkills } = require('./dsh-professional-skills.cjs');
const { PROJECT_WORKBENCH_BUNDLE, buildProjectWorkbenchEntries, projectWorkbenchHostEnvironment } = require('./dsh-project-workbench.cjs');

const DSH_PROFILE_NAME = 'adh-desktop';
const DSH_BUNDLES = [
  { scope: '@aidesign', name: 'dsh-client-ui-brand', dir: 'adh-brand' },
  { scope: '@aidesign', name: 'dsh-tool-discovery', dir: 'adh-tool-discovery' },
  { scope: '@aidesign', name: 'dsh-skill-policy', dir: 'adh-skill-policy' },
  { scope: '@aidesign', name: 'dsh-client-ui-skill-library', dir: 'adh-skill-library' },
  PROJECT_WORKBENCH_BUNDLE,
];

const TOKEN_URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/;
const RESTART_BACKOFF_MS = [1500, 4000, 10_000];

/**
 * @typedef {Object} DshRuntimeOptions
 * @property {string} userDataDir
 * @property {string} cacheRoot
 * @property {string} pluginsSourceDir
 * @property {() => { configured: boolean, provider: string, baseUrl: string, model: string } | null} getModelStatus
 * @property {(state: object) => void} emit
 * @property {() => boolean} [isQuitting]
 */

class DshRuntimeManager {
  /** @param {DshRuntimeOptions} options */
  constructor(options) {
    this.options = options;
    this.state = { status: 'missing', version: DSH_RUNTIME_PINS.dshVersion };
    this.child = null;
    this.authUrl = null;
    this.llmToken = null;
    this.theme = options.getTheme?.() || 'light';
    this.stopping = false;
    this.restarts = 0;
    this.starting = null;
    this.patchWrite = Promise.resolve();
    this.professionalMcp = null;
    this.professionalEntries = [];
  }

  getState() {
    return { ...this.state };
  }

  getAuthUrl() {
    return this.authUrl;
  }

  setState(next) {
    this.state = { version: DSH_RUNTIME_PINS.dshVersion,
      professionalMcp: { ready: !!this.professionalMcp?.ready, registered: this.professionalEntries.length }, ...next };
    this.options.emit(this.getState());
  }

  setLlmToken(token) {
    if (token === this.llmToken) return false;
    this.llmToken = token;
    return true;
  }

  dshHome() {
    return path.join(this.options.userDataDir, 'dsh');
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.runStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  hostsFile() {
    return path.join(this.dshHome(), 'adh-hosts.pids');
  }

  readHostPids() {
    try {
      return readFileSync(this.hostsFile(), 'utf8')
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  writeHostPids(pids) {
    void writeFile(this.hostsFile(), pids.join('\n')).catch(() => undefined);
  }

  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hosts left behind by crashed or force-killed app runs would double-book the
   * same DSH_HOME session log and knock live sessions out. Reap every recorded
   * host before spawning a new one.
   */
  async reapOrphanHosts() {
    const pids = this.readHostPids();
    if (!pids.length) return;
    this.writeHostPids([]);
    const alive = pids.filter((pid) => this.isAlive(pid));
    for (const pid of alive) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* already gone */ }
    }
    if (!alive.length) return;
    await Promise.race([
      Promise.all(alive.map((pid) => new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!this.isAlive(pid)) {
            clearInterval(timer);
            resolve(undefined);
          }
        }, 200);
      }))),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    for (const pid of alive) {
      if (this.isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* already gone */ }
      }
    }
  }

  async runStart() {
    this.stopping = false;
    try {
      await mkdir(this.dshHome(), { recursive: true });
      await this.reapOrphanHosts();
      this.setState({ status: 'downloading', progress: 0 });
      const { paths } = await ensureDshRuntime({
        cacheRoot: this.options.cacheRoot,
        onProgress: (stage, received, total) => {
          if (stage !== 'node' || !total) return;
          this.setState({ status: 'downloading', progress: Math.round((received / total) * 100) });
        },
      });
      await this.ensureProfile(paths);
      this.setState({ status: 'starting' });
      await this.spawnHost(paths);
    } catch (error) {
      this.setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  runCli(paths, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(paths.nodeExe, [paths.dshCli, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DSH_HOME: this.dshHome() },
        cwd: this.dshHome(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let tail = '';
      const capture = (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-2000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`DSH_CLI_FAILED(${code ?? 'signal'}): ${tail}`)));
    });
  }

  async ensureProfile(paths) {
    await mkdir(this.dshHome(), { recursive: true });
    this.runtimeRoot = paths.root || path.join(this.options.cacheRoot, 'dsh-runtime', DSH_RUNTIME_PINS.dshVersion);
    await (this.options.ensureSkillPolicyRuntime || ensureHubSkillPolicyRuntime)({ runtimeRoot: this.runtimeRoot });
    await stageProfessionalSkills(this.dshHome());
    this.professionalMcp = await ensureProfessionalMcp({
      cacheRoot: this.options.professionalMcpCacheRoot || path.resolve(this.options.pluginsSourceDir, '..', '..', '.runtime'),
    });
    this.professionalEntries = buildProfessionalMcpEntries({
      payloadRoot: this.professionalMcp.ready ? this.professionalMcp.payloadRoot : undefined,
      nodeExe: paths.nodeExe,
    });
    const profileDir = path.join(this.dshHome(), 'profiles', DSH_PROFILE_NAME);
    const packageFile = path.join(profileDir, 'package.json');
    if (!existsSync(packageFile)) {
      // Materialize the profile from the official web template; an empty hand-written
      // bundles list would boot an empty composition tree and silently do nothing.
      await this.runCli(paths, ['--profile', DSH_PROFILE_NAME, '--from-default-profile', 'web', '--dump-config']);
    }
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    if (existsSync(patchFile)) readPatch(await readFile(patchFile, 'utf8'));
    const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
    const profile = (packageJson.dsh ??= {}).profile ??= {};
    const bundles = (profile.bundles ??= []);
    if (!Array.isArray(bundles)) throw new Error('DSH_PROFILE_BUNDLES_INVALID');
    for (const bundle of DSH_BUNDLES) {
      const id = `${bundle.scope}/${bundle.name}`;
      if (!bundles.includes(id)) bundles.push(id);
    }
    applyVoiceInputDefault(packageJson);
    profile.patchReload = 'live';
    await this.backupProfileFile(packageFile);
    const stagedPackage = `${packageFile}.next`;
    await writeFile(stagedPackage, JSON.stringify(packageJson, null, 2));
    await rename(stagedPackage, packageFile);

    for (const bundle of DSH_BUNDLES) {
      const source = path.join(this.options.pluginsSourceDir, bundle.dir);
      if (!existsSync(source)) throw new Error(`DSH_BUNDLE_MISSING: ${bundle.dir}`);
      await linkBundleIntoProfile(profileDir, source, bundle.scope, bundle.name);
    }
    await this.writeLlmPatch(profileDir);
  }

  profileDir() {
    return path.join(this.dshHome(), 'profiles', DSH_PROFILE_NAME);
  }

  /**
   * Merge host-managed settings into cordis.patch.yml, preserving user settings. The
   * profile uses patchReload:'live', so the running host picks this up without a
   * respawn (unlike the env-injected API key, which only applies at spawn time).
   */
  writeLlmPatch(profileDir = this.profileDir()) {
    const write = this.patchWrite.catch(() => undefined).then(() => this.writeProfilePatch(profileDir));
    this.patchWrite = write;
    return write;
  }

  async backupProfileFile(file) {
    const backup = `${file}.before-${DSH_RUNTIME_PINS.dshVersion}`;
    if (existsSync(backup) || !existsSync(file)) return;
    await writeFile(backup, await readFile(file), { flag: 'wx' });
  }

  async writeProfilePatch(profileDir) {
    if (!existsSync(profileDir)) return false;
    const modelStatus = this.options.getModelStatus?.();
    const patch = buildLlmPatch(modelStatus, this.llmToken, this.theme) || [
      '# AIDesignHub desktop profile patch: no model configured.',
      '- id: ui-theme',
      '  config:',
      `    preference: ${themePreference(this.theme)}`,
      '- id: ui-settings-general',
      '  config:',
      "    welcomeNoticeVersion: '2026-09-28.1'",
      '- id: skill-filesystem',
      '  disabled: false',
      '- id: llm-deepseek-account',
      '  disabled: true',
      '',
    ].join('\n');
    const file = path.join(profileDir, 'cordis.patch.yml');
    const previous = existsSync(file) ? await readFile(file, 'utf8') : '';
    const extras = this.professionalEntries.length ? [{ insert: this.professionalEntries }] : [];
    extras.push(...buildHubSkillPolicyEntries({ existingEntries: readPatch(previous),
      runtimeRoot: this.runtimeRoot || path.join(this.options.cacheRoot, 'dsh-runtime', DSH_RUNTIME_PINS.dshVersion) }));
    extras.push(...buildProjectWorkbenchEntries(!!this.options.getWorkbenchConnection?.()));
    const merged = mergeDshProfilePatch(previous, patch, extras);
    if (merged === previous) return false;
    await this.backupProfileFile(file);
    const staged = `${file}.next`;
    await writeFile(staged, merged);
    await rename(staged, file);
    return true;
  }

  /** Live theme change: rewrite the patch so the DSH host reloads its ui-theme. */
  applyTheme(theme) {
    const name = ['light', 'dark', 'minimal'].includes(theme) ? theme : 'light';
    if (name === this.theme) return false;
    this.theme = name;
    void this.writeLlmPatch().catch(() => undefined);
    return true;
  }

  async spawnHost(paths) {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      DSH_HOME: this.dshHome(),
      ADH_PROFESSIONAL_MCP: this.professionalMcp?.payloadRoot || '',
      ADH_DESKTOP_LLM_KEY: this.llmToken ?? '',
      ...projectWorkbenchHostEnvironment(this.options.getWorkbenchConnection?.()),
      // Plugin-manager pnpm/npm children inherit these: the embedded runtime keeps
      // its own cache/store so the user's personal DSH desktop stays untouched.
      npm_config_cache: path.join(paths.root, 'npm-cache'),
      npm_config_store_dir: path.join(paths.root, 'pnpm-store'),
      PATH: [path.dirname(paths.nodeExe), path.join(paths.root, 'package', 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter),
    };
    const child = spawn(paths.nodeExe, [paths.dshCli, '--profile', DSH_PROFILE_NAME, '--port', '0', '--no-open'], {
      env, cwd: this.dshHome(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const urlReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH_HOST_START_TIMEOUT')), 90_000);
      let buffer = '';
      const onChunk = (chunk) => {
        buffer += chunk.toString('utf8');
        const match = TOKEN_URL_PATTERN.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('DSH_HOST_EXITED_EARLY')); });
    });
    try {
      this.authUrl = await urlReady;
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    try {
      await this.probeReady();
    } catch (error) {
      this.authUrl = null;
      child.kill('SIGKILL');
      this.child = null;
      throw error;
    }
    this.restarts = 0;
    this.writeHostPids([...this.readHostPids(), child.pid]);
    this.setState({ status: 'ready' });
    child.once('exit', (code) => {
      this.child = null;
      this.writeHostPids(this.readHostPids().filter((pid) => pid !== child.pid));
      if (this.stopping || this.options.isQuitting?.()) {
        this.setState({ status: 'stopped' });
        return;
      }
      void this.restartAfterCrash(code);
    });
  }

  async probeReady(attempts = 60) {
    const base = this.authUrl.split('/?token=')[0];
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const auth = await fetch(this.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        const cookies = auth.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
        await auth.body?.cancel();
        if (![302, 303].includes(auth.status) || !cookies) throw new Error('DSH_HOST_AUTH_NOT_READY');
        const headers = { Cookie: cookies };
        const page = await fetch(`${base}/`, { headers, redirect: 'manual', signal: AbortSignal.timeout(2000) });
        const pageReady = page.status === 200 && /text\/html/.test(page.headers.get('content-type') || '');
        await page.body?.cancel();
        const logo = await fetch(`${base}/api/adh-brand/logo.png`, { headers, redirect: 'manual', signal: AbortSignal.timeout(2000) });
        const pluginReady = logo.status === 200 && /image\/png/.test(logo.headers.get('content-type') || '');
        await logo.body?.cancel();
        if (pageReady && pluginReady) return;
      } catch { /* host still binding */ }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('DSH_HOST_PROBE_TIMEOUT');
  }

  async restartAfterCrash(code) {
    if (this.stopping || this.restarts >= RESTART_BACKOFF_MS.length) {
      this.setState({ status: 'error', message: `DSH_HOST_EXITED(${code ?? 'signal'})` });
      return;
    }
    const delay = RESTART_BACKOFF_MS[this.restarts++];
    this.setState({ status: 'starting', message: `运行时退出(${code ?? 'signal'})，${Math.round(delay / 1000)}s 后重试` });
    await new Promise(resolve => setTimeout(resolve, delay));
    if (this.stopping) return;
    try {
      const { paths } = await ensureDshRuntime({ cacheRoot: this.options.cacheRoot });
      await this.spawnHost(paths);
    } catch (error) {
      this.setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  async restart() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    this.stopping = false;
    this.restarts = 0;
    await this.start();
    return this.getState();
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    // Graceful first: DSH flushes its session event log on SIGTERM; SIGKILL after
    // the grace period so a wedged host can never block app quit.
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    }, 2000);
    child.once('exit', () => clearTimeout(force));
  }
}

module.exports = { DshRuntimeManager, DSH_PROFILE_NAME, DSH_BUNDLES };
