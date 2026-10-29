'use strict';

// MANUAL LIVE ACCEPTANCE ONLY. This file does nothing without an explicit opt-in.
// It uses the existing DeepSeek Harness ACP profile/login and may consume model
// and native-search quota. Only supply a PUBLIC building/project name, optionally
// with its city. This is not an OS sandbox and does not change Harness permissions.
// Harness may keep its own normal session history; this script does not edit its
// configuration, read a real Hub workspace, or mount/create any Hub credentials.
// No automatic invocation from package scripts, startup, tests, or CI is intended.
//
// node scripts/probe-case-name.cjs --allow-live-model \
//   --node "D:\\tools\\node.exe" --entry "D:\\tools\\dsh\\lib\\bin.js" \
//   --query "公开建筑项目名称 城市" [--timeout-ms 180000|240000]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ACTIVE = new Set(['queued', 'running', 'waiting_agent', 'cancel_requested']);
const TERMINAL_CASE = new Set(['awaiting_review', 'failed', 'needs_clarification']);
const FIELDS = ['name', 'area', 'typeLabel', 'location', 'openingDate', 'designer'];
const SAFE_CODES = new Set(['TIMEOUT', 'ABORTED', 'SPAWN_FAILED', 'ACP_ERROR', 'AGENT_EXITED', 'UNSUPPORTED_PROTOCOL', 'PROTOCOL_ERROR', 'EMPTY_RESULT', 'OUTPUT_LIMIT', 'BUSY', 'NON_JSON_RESULT', 'INVALID_RESULT', 'UNEXPECTED_TOOL', 'HUB_GRANT_FORBIDDEN', 'PROBE_DEADLINE']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(new Error(code), { code });
const log = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function usage() {
  process.stdout.write('Manual live-model probe; may consume existing Harness login/model/search quota.\n' +
    'Usage: node scripts/probe-case-name.cjs --allow-live-model --node <absolute node.exe> --entry <absolute dsh/lib/bin.js> --query "PUBLIC project name [city]" [--timeout-ms 180000|240000]\n' +
    'No real Hub data is read. No Hub grant is created. Existing Harness permissions are unchanged; the temporary working directory is NOT an OS sandbox. A public-only receipt is retained in a new system-temp folder.\n');
}

function options(argv) {
  if (argv.includes('--help')) return { help: true };
  if (!argv.includes('--allow-live-model')) return { optedIn: false };
  const allowed = new Set(['--node', '--entry', '--query', '--timeout-ms']);
  const values = new Map();let optIns = 0;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--allow-live-model') { optIns++;continue; }
    if (!allowed.has(flag) || values.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw fail('INVALID_ARGUMENTS');
    values.set(flag, argv[++i]);
  }
  if (optIns !== 1) throw fail('INVALID_ARGUMENTS');
  const command = values.get('--node'), entry = values.get('--entry'), query = values.get('--query')?.trim();
  const timeoutMs = Number(values.get('--timeout-ms') || 180000);
  if (![180000, 240000].includes(timeoutMs)) throw fail('INVALID_TIMEOUT');
  if (!query || query.length < 2 || query.length > 300 || /[\u0000-\u001f\u007f]|https?:\/\/|(?:[a-z]:[\\/])|\\\\|\b(?:Bearer\s+|sk-[a-z\d_-]{12,}|api[_-]?key\s*[:=]|password\s*[:=])/i.test(query)) throw fail('PUBLIC_NAME_REQUIRED');
  for (const file of [command, entry]) if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw fail('LOCAL_RUNTIME_PATH_REQUIRED');
  if (process.platform !== 'win32' || !/^[a-z]:[\\/]/i.test(command) || !/^[a-z]:[\\/]/i.test(entry) || path.basename(command).toLowerCase() !== 'node.exe') throw fail('WINDOWS_NODE_REQUIRED');
  const runtimeRoot = path.dirname(path.dirname(entry)), manifestFile = path.join(runtimeRoot, 'package.json');
  if (fs.statSync(manifestFile, { throwIfNoEntry: false })?.size > 256 * 1024) throw fail('RUNTIME_MANIFEST_INVALID');
  let manifest;try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { throw fail('RUNTIME_MANIFEST_INVALID'); }
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (manifest.name !== '@deepseek-ai/dsh' || declared?.replace(/\\/g, '/').replace(/^\.\//, '') !== 'lib/bin.js' || path.resolve(entry) !== path.resolve(runtimeRoot, 'lib/bin.js')) throw fail('RUNTIME_MANIFEST_INVALID');
  // Read only a non-secret home PATH and check for an already-created profile.
  // This prevents the launcher from auto-initializing a new external profile.
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  if (!path.isAbsolute(dshHome) || !fs.statSync(path.join(dshHome, 'profiles', 'acp', 'package.json'), { throwIfNoEntry: false })?.isFile()) throw fail('EXISTING_ACP_PROFILE_REQUIRED');
  return { optedIn: true, command: path.resolve(command), entry: path.resolve(entry), query, timeoutMs, version: String(manifest.version || '').slice(0, 80) };
}

// Only schema-selected public information crosses into the audit receipt. Never
// serialize process.env, raw ACP frames, raw stderr, chat chunks, or error stacks.
function publicText(value, max = 5000) {
  if (typeof value !== 'string') return null;
  return value.slice(0, max)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z\d_-]{12,}/gi, '[REDACTED]')
    .replace(/\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|密钥|密码)\s*[:=]\s*)["']?[^\s"'<>;,}]+/gi, '$1[REDACTED]');
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const { validatePublicUrl } = require('../backend/public-page.cjs');
    const url = validatePublicUrl(value);
    if ([...url.searchParams.keys()].some(key => /token|secret|password|credential|api[-_]?key|signature|^sig$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

function publicResult(raw) {
  if (typeof raw !== 'string' || raw.length > 500000) throw fail('INVALID_RESULT');
  const { parseResearchResult } = require('../backend/research-result.cjs');
  let value;try { value = parseResearchResult(raw); } catch { throw fail('NON_JSON_RESULT'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['matched', 'ambiguous', 'not_found'].includes(value.matchStatus) || !Array.isArray(value.evidence)) throw fail('INVALID_RESULT');
  return {
    matchStatus: value.matchStatus, primarySourceUrl: publicUrl(value.primarySourceUrl),
    ...Object.fromEntries(FIELDS.map(field => [field, publicText(value[field], field === 'name' ? 300 : 1500)])),
    summary: publicText(value.summary), failureReason: publicText(value.failureReason, 100),
    evidence: value.evidence.slice(0, 48).filter(item => item && FIELDS.includes(item.field)).map(item => ({ field: item.field, ...(item.value === undefined ? {} : { value: publicText(item.value, 1500) }), sourceUrl: publicUrl(item.sourceUrl), quote: publicText(item.quote, 1500) })),
    candidates: (Array.isArray(value.candidates) ? value.candidates : []).slice(0, 12).filter(item => item && typeof item === 'object').map(item => ({ name: publicText(item.name, 300), url: publicUrl(item.url), description: publicText(item.description, 1500) })),
  };
}

function publicCase(item) {
  if (!item) return null;
  const r = item.research || {};
  return {
    id: item.id, projectId: item.projectId, name: publicText(item.name, 300), sourceUrl: publicUrl(item.sourceUrl), notes: publicText(item.notes),
    fields: Object.fromEntries(FIELDS.map(field => { const v = r.fields?.[field] || {};return [field, { value: publicText(v.value, 1500), quote: publicText(v.quote, 1500), sourceUrl: publicUrl(v.sourceUrl), status: publicText(v.status, 80) }]; })),
    research: { mode: r.mode, query: publicText(r.query, 300), status: r.status, matchStatus: r.matchStatus, revision: r.revision, jobId: r.jobId, runId: r.runId,
      error: publicText(r.error, 1000), failureReason: publicText(r.failureReason, 100), sourceValidation: r.sourceValidation || null, sourceSnapshot: r.sourceSnapshot || null,
      sources: (r.sources || []).map(source => ({ url: publicUrl(source.url), finalUrl: publicUrl(source.finalUrl), title: publicText(source.title, 500), status: source.status, retrievedAt: source.retrievedAt })),
      candidates: (r.candidates || []).map(candidate => ({ name: publicText(candidate.name, 300), url: publicUrl(candidate.url), description: publicText(candidate.description, 1500) })),
    },
  };
}

async function probe(config) {
  const { LocalBackend } = require('../backend/local-backend.cjs');
  const { AgentHub } = require('../backend/agent-hub.cjs');
  const { CaseResearchService } = require('../backend/case-research.cjs');
  const { executeAgent } = require('../backend/agent-executors.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-case-name-probe-'));
  const receiptPath = path.join(root, 'receipt.json'), startedAt = Date.now();
  const projectId = 'project_public_research_probe', memberId = 'member_public_research_probe';
  const stop = new AbortController(), executions = new Set(), toolCalls = new Map(), toolEvents = [], statusEvents = [];
  let backend, hub, caseService, caseId, result = null, hasProjectGrant = false, executionCount = 0, failureCode = null, deadlineHit = false, signalName = null, finalCase = null, finalRun = null;
  let previewEvidence = { attempted: false, status: 'not-requested', imageCount: 0, warningCount: 0 };
  let formatDiagnostics = null;
  const safeErrorCode = error => SAFE_CODES.has(error?.code) ? error.code : 'PROBE_FAILED';
  const signal = name => { signalName = name;stop.abort(); };
  const sigint = () => signal('SIGINT'), sigterm = () => signal('SIGTERM');
  process.on('SIGINT', sigint);process.on('SIGTERM', sigterm);
  const timer = setTimeout(() => { deadlineHit = true;stop.abort(); }, config.timeoutMs);
  log({ status: 'starting-public-name-probe', receiptPath, publicName: config.query, totalBudgetMs: config.timeoutMs, hasProjectGrant: false });
  const runningTask = async (connection, input) => {
    hasProjectGrant ||= Boolean(input.env?.AIDESIGNHUB_TOKEN || connection.mcpServers?.length || hub?.access.grants.length);
    if (hasProjectGrant) throw fail('HUB_GRANT_FORBIDDEN');
    executionCount++;
    if (executionCount !== 1) throw fail('INVALID_RESULT');
    const work = (async () => {
      try {
        const answer = await executeAgent(connection, { ...input, signal: AbortSignal.any([input.signal, stop.signal]), onEvent: event => {
          if (event?.type === 'permission') { input.onEvent?.({ message: 'Probe: ACP permission request denied by the unchanged adapter.' });return; }
          if (event?.type !== 'tool') return; // Never forward assistant text/chunks.
          const callId = typeof event.id === 'string' ? crypto.createHash('sha256').update(event.id).digest('hex').slice(0, 20) : null;
          const name = typeof event.name === 'string' && /^[a-z\d_.:-]{1,100}$/i.test(event.name) ? event.name : toolCalls.get(callId) || 'unknown_tool';
          if (callId && event.name) toolCalls.set(callId, name);
          const status = ['pending', 'in_progress', 'running', 'completed', 'failed'].includes(event.status) ? event.status : 'reported';
          const evidence = { elapsedMs: Date.now() - startedAt, callIdHash: callId, name, status };
          toolEvents.push(evidence);
          log({ status: 'tool-event', tool: name, toolStatus: status, count: toolEvents.length });
          input.onEvent?.({ message: `Probe tool: ${name} (${status}).` });
          // Detection is not a sandbox or a pre-execution permission gate. Stop
          // promptly if the agent attempts non-web work; it may already have begun.
          if (!['web_search', 'web_fetch'].includes(name)) { failureCode = 'UNEXPECTED_TOOL';stop.abort(); }
        } });
        const rawText = typeof answer.text === 'string' ? answer.text : '';
        formatDiagnostics = { rawTextLength: rawText.length, hasJsonFence: /```json\b/i.test(rawText), startsWithObject: rawText.trimStart().startsWith('{'), endsWithObject: rawText.trimEnd().endsWith('}') };
        result = publicResult(answer.text);
        return { text: JSON.stringify(result), metadata: { transport: 'acp', stopReason: 'end_turn', permissions: 'deny-by-default' } };
      } catch (error) {
        const code = failureCode || safeErrorCode(error);
        failureCode ||= code;
        throw fail(code); // Do not let raw provider stderr/errors enter Hub storage.
      }
    })();
    executions.add(work);
    try { return await work; } finally { executions.delete(work); }
  };
  try {
    backend = new LocalBackend({ dataDir: path.join(root, 'isolated-data') });
    backend.mutate(store => {
      for (const key of Object.keys(store)) if (Array.isArray(store[key])) store[key] = [];
      store.settings = { currentProjectId: projectId, currentMemberId: memberId, currentRole: 'designer', createdAt: Date.now() };
      store.projects = [{ id: projectId, name: 'Synthetic public research acceptance', code: 'PUBLIC-RESEARCH-PROBE', city: 'Synthetic', type: 'Public architecture research only', stage: 'concept', stageRound: 1, progress: 0, folderPath: null, createdAt: Date.now(), updatedAt: Date.now() }];
      store.members = [{ id: memberId, projectId, name: 'Synthetic acceptance operator', title: 'Synthetic designer', role: 'designer', skills: [], load: 0, active: true }];
      store.agentHub = { version: 1, connections: [], conversations: [], jobs: [], runs: [], events: [] };
      return true;
    });
    hub = new AgentHub({ backend, execute: runningTask });
    hub.createGrant = () => { hasProjectGrant = true;throw fail('HUB_GRANT_FORBIDDEN'); };
    hub.saveConnection({ id: 'public-name-probe', provider: 'deepseek', label: 'Manual isolated public-name acceptance', mode: 'acp', command: config.command, args: [config.entry, '--profile', 'acp'], cwd: '', timeoutMs: config.timeoutMs - 60000 });
    caseService = new CaseResearchService({ backend, hub });
    caseService.on('changed', id => {
      const item = caseService.find(id);if (!item || (caseId && id !== caseId)) return;
      const state = item.research?.status;
      if (statusEvents.at(-1)?.status === state) return;
      statusEvents.push({ elapsedMs: Date.now() - startedAt, status: state });
      log({ status: 'case-state', caseStatus: state });
    });
    caseId = caseService.collect({ projectId, query: config.query, connectionId: 'public-name-probe' }).id;
    while (!stop.signal.aborted) {
      const item = caseService.find(caseId);
      if (TERMINAL_CASE.has(item?.research?.status)) break;
      await sleep(100);
    }
    if (deadlineHit) failureCode = 'PROBE_DEADLINE';
    else if (signalName) failureCode = 'ABORTED';
    finalCase = publicCase(caseService.find(caseId));
    const run = hub.state.runs.find(item => item.id === finalCase?.research.runId);
    finalRun = run ? { id: run.id, status: run.status, allowProjectTools: run.input.allowProjectTools === true } : null;
    if (finalCase?.research.status === 'awaiting_review' && !stop.signal.aborted) {
      previewEvidence = { attempted: true, status: 'requested', imageCount: 0, warningCount: 0 };
      // One normal preview loads no more than the first four images. Image failure
      // does not invalidate already verified facts; it is reported separately.
      const stopPreview = () => caseService.previews.dispose();
      stop.signal.addEventListener('abort', stopPreview, { once: true });
      try {
        const preview = await caseService.preview(caseId);
        previewEvidence = { attempted: true, status: publicText(preview.status, 80), imageCount: preview.images?.length || 0, warningCount: preview.warnings?.length || 0, hasMoreImages: preview.hasMoreImages === true, completedWithinBudget: !stop.signal.aborted };
      } catch { previewEvidence.status = stop.signal.aborted ? 'budget-or-cancelled' : 'unavailable'; }
      finally { stop.signal.removeEventListener('abort', stopPreview); }
      if (signalName) failureCode = 'ABORTED';
    }
  } catch (error) {
    failureCode ||= safeErrorCode(error);
  } finally {
    clearTimeout(timer);stop.abort();
    // Abort only this isolated invocation. executeAgent resolves only after its
    // owned child process has closed, including its bounded forced-stop path.
    if (hub) for (const run of hub.state.runs) if (ACTIVE.has(run.status)) { try { hub.cancelRun(run.id); } catch { failureCode ||= 'CLEANUP_FAILED'; } }
    try { caseService?.dispose(); } catch { failureCode ||= 'CLEANUP_FAILED'; }
    try { hub?.dispose(); } catch { failureCode ||= 'CLEANUP_FAILED'; }
    await Promise.allSettled([...executions]);
    if (caseService) await caseService.idle().catch(() => { failureCode ||= 'CLEANUP_FAILED'; });
    // Allow AgentHub.executeRun's final controller cleanup to settle as well.
    for (let i = 0; hub?.controllers.size && i < 50; i++) await sleep(20);
    process.removeListener('SIGINT', sigint);process.removeListener('SIGTERM', sigterm);
  }

  finalCase ||= publicCase(caseService?.find(caseId));
  const completedTools = [...new Set(toolEvents.filter(event => event.status === 'completed').map(event => event.name))];
  const observedTools = [...new Set(toolEvents.map(event => event.name))];
  const cleanupComplete = executions.size === 0 && !hub?.controllers.size && !caseService?.pending.size && !caseService?.verifications.size;
  hasProjectGrant ||= Boolean(hub?.access.grants.length || finalRun?.allowProjectTools);
  const ok = !failureCode && cleanupComplete && executionCount === 1 && !hasProjectGrant && finalCase?.research.status === 'awaiting_review' && finalCase.research.sourceValidation?.primaryIdentityVerified === true && ['web_search', 'web_fetch'].every(name => completedTools.includes(name));
  const snapshotName = finalCase?.research.sourceSnapshot?.file;
  const snapshotFile = typeof snapshotName === 'string' && snapshotName === path.basename(snapshotName) && snapshotName.endsWith('.json') ? path.join(root, 'isolated-data', 'case-pages', snapshotName) : null;
  let publicSourcePages = [];
  if (snapshotFile && fs.existsSync(snapshotFile)) {
    try { const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));publicSourcePages = (snapshot.pages || []).map(page => ({ url: publicUrl(page.url), finalUrl: publicUrl(page.finalUrl), title: publicText(page.title, 500), text: publicText(page.text, 100000), retrievedAt: page.retrievedAt })); } catch { failureCode ||= 'RECEIPT_SOURCE_READ_FAILED'; }
  }
  const receipt = {
    version: 1, probe: 'manual-public-case-name-live-acceptance', startedAt, finishedAt: Date.now(), ok: ok && !failureCode, failureCode,
    publicName: config.query, runtimeVersion: publicText(config.version, 80), budgetMs: config.timeoutMs, executionCount,
    safety: { realModelMayConsumeQuota: true, realHubDataRead: false, externalConfigChanged: false, hubGatewayStarted: false, hasProjectGrant, permissionsChanged: false, isOsSandbox: false, cleanupComplete, ownTempDataRetained: true, credentialsOrEnvironmentStored: false, rawChatOrStderrStored: false },
    execution: finalRun, case: finalCase, publicResearchResult: result, formatDiagnostics, publicSourcePages, preview: previewEvidence, statusEvents, toolEvents,
    evidence: { observedTools, completedTools, webSearchCompleted: completedTools.includes('web_search'), webFetchCompleted: completedTools.includes('web_fetch'), independentSourceReadCount: finalCase?.research.sourceValidation?.readCount || 0, remainsPendingHumanReview: finalCase?.research.status === 'awaiting_review' },
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  log({ status: receipt.ok ? 'passed-pending-human-review' : 'not-accepted', code: failureCode, receiptPath, publicName: finalCase?.name || config.query, caseStatus: finalCase?.research.status || 'not-created', sourceUrls: (finalCase?.research.sources || []).map(source => source.url).filter(Boolean), fieldStatuses: Object.fromEntries(Object.entries(finalCase?.fields || {}).map(([key, field]) => [key, field.status])), sourceIdentityVerified: finalCase?.research.sourceValidation?.primaryIdentityVerified === true, previewStatus: previewEvidence.status, imageCount: previewEvidence.imageCount, executionCount, toolEventCount: toolEvents.length, hasProjectGrant, cleanupComplete });
  if (!receipt.ok) process.exitCode = 1;
}

async function main() {
  let config;
  try { config = options(process.argv.slice(2)); } catch (error) { log({ status: 'not-started', code: /^[A-Z_]+$/.test(error?.code || '') ? error.code : 'INVALID_ARGUMENTS' });process.exitCode = 2;return; }
  if (config.help) { usage();return; }
  if (!config.optedIn) { usage();log({ status: 'not-started', code: 'EXPLICIT_LIVE_MODEL_OPT_IN_REQUIRED' });process.exitCode = 2;return; }
  await probe(config);
}

if (require.main === module) main().catch(() => { log({ status: 'probe-error', code: 'SAFE_PROBE_FAILURE', note: 'Raw error details suppressed. Inspect the previously printed isolated receipt directory.' });process.exitCode = 1; });
