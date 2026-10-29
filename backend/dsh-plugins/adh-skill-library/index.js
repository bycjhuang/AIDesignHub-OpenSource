// The catalog and instruction bodies come from the same registry the Agent uses.
// In particular, this plugin never walks personal skill folders or accepts paths.
const MAX_BODY_BYTES = 512 * 1024;
const FRIENDLY_NAMES = Object.freeze({
  'office-docx': 'Word 文档', 'office-pptx': 'PPT 演示', 'office-xlsx': 'Excel 表格',
  'blender-modeling': 'Blender 建模', '3dsmax-modeling': '3ds Max 建模',
  'rhino-modeling': 'Rhino 建模', 'sketchup-modeling': 'SketchUp 建模',
  'revit-bim': 'Revit BIM 联动', 'autocad-drafting': 'AutoCAD 制图',
  'c4d-modeling': 'Cinema 4D 建模', 'archicad-automation': 'ArchiCAD 联动',
  'photoshop-automation': 'Photoshop 图像处理', 'illustrator-automation': 'Illustrator 矢量设计',
  'indesign-automation': 'InDesign 排版', 'premiere-editing': 'Premiere 剪辑',
  'aftereffects-automation': 'After Effects 动效', 'lightroom-catalog': 'Lightroom 照片',
});
const SOURCE_NAMES = Object.freeze({
  bundled: 'Hub 内置', runtime: '插件提供', custom: '自定义目录',
  'project-dsh': '当前工作区', 'project-agents': '当前工作区',
  'user-dsh': '用户技能', 'user-agents': '用户技能',
});
const text = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const json = (status, payload) => Response.json(payload, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });
const failure = (status, message) => json(status, { ok: false, error: message });
class CatalogError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const name = 'adh-skill-library';
export const inject = ['connection', 'skills'];

function selectors(url, body) {
  const allowed = new Set(body ? ['sessionId', 'name'] : ['sessionId']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new CatalogError(400, '技能查询参数无效。');
  }
  const sessionId = url.searchParams.get('sessionId') || undefined;
  if (sessionId && !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) throw new CatalogError(400, '会话标识无效。');
  const skillName = url.searchParams.get('name');
  if (body && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(skillName || '')) throw new CatalogError(400, '技能名称无效。');
  return { sessionId, skillName };
}

/** Resolve only a Host-owned Session, following the official skill-catalog scope. */
async function withCatalog(ctx, sessionId, signal, visit) {
  if (!sessionId) return visit(ctx.skills, { signal }, { kind: 'global', label: '全局已启用技能' });
  const query = ctx.get('sessionQuery');
  if (!query) throw new CatalogError(503, '会话服务尚未就绪，请稍后刷新。');
  let observation;
  try { observation = await query.observeSession(sessionId, { signal }); }
  catch { throw new CatalogError(404, '当前会话不可读取，请返回对话后重试。'); }
  let cwd, preset;
  try {
    cwd = observation.projections?.values?.workingDirectory ?? observation.header?.cwd;
    preset = observation.projections?.values?.agentPreset ?? observation.header?.agentPreset;
  } finally { observation[Symbol.dispose]?.(); }
  if (!cwd) throw new CatalogError(409, '当前会话尚未选择工作区。');
  const live = ctx.get('agents')?.get(sessionId);
  const presets = ctx.get('agentPresets');
  const registry = (live && presets?.serviceFor(live, 'skills')) || ctx.skills;
  let lease;
  try {
    if (!live && presets) lease = await presets.acquireScope(preset);
    return await visit(registry, { cwd, scope: live ?? lease?.key, signal }, {
      kind: 'session', label: '当前对话可用技能', sessionId, cwd,
    });
  } finally {
    if (lease?.[Symbol.asyncDispose]) await lease[Symbol.asyncDispose]();
    else lease?.[Symbol.dispose]?.();
  }
}

function summaryOf(skill) {
  const invocation = skill.invocation || {};
  const modelInvocable = invocation.modelInvocable === true;
  const userInvocable = invocation.userInvocable === true;
  const source = text(skill.source, 100);
  return {
    layer: FRIENDLY_NAMES[skill.name] && !skill.name.startsWith('office-') ? 'modeling'
      : /office|docx|xlsx|pptx|word|excel|presentation|spreadsheet/.test(skill.name) ? 'office'
      : /video|animation|animate|hyperframes|film|reel|motion|media-use|opus/.test(skill.name) ? 'video'
      : /model|cad|threejs|3d/.test(skill.name) ? 'modeling'
      : /design|image|photo|svg/.test(skill.name) ? 'design'
      : /writ|copy|text/.test(skill.name) ? 'writing' : 'general',
    id: text(skill.name, 128), displayName: FRIENDLY_NAMES[skill.name] || text(skill.name, 128),
    description: text(skill.description), whenToUse: text(skill.whenToUse),
    source, sourceLabel: SOURCE_NAMES[source] || '注册技能', provider: text(skill.provider, 120),
    modelInvocable, userInvocable, status: modelInvocable || userInvocable ? 'available' : 'disabled',
  };
}

// This credential stays in the Host process. Browser routes remain admitted by
// the authenticated native connection and cannot supply a desktop endpoint.
export function createDesktopBridge(environment = process.env, fetchImpl = fetch) {
  return async (operation, args = {}, signal) => {
    let endpoint;
    try { endpoint = new URL(environment.ADH_WORKBENCH_ENDPOINT || ''); } catch { throw new CatalogError(503, '本机技能共享服务尚未就绪，请重新打开 AI Hub。'); }
    const token = environment.ADH_WORKBENCH_TOKEN;
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/adh-workbench' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new CatalogError(503, '本机技能共享连接无效，请重启 Hub。');
    let response;
    try { response = await fetchImpl(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: `skill_library_${operation}`, caller: 'skill-library-ui', arguments: args }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }); }
    catch { throw new CatalogError(503, '技能共享服务暂不可连接，请稍后刷新。'); }
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new CatalogError(400, text(payload.error?.message, 800) || '技能共享操作未完成，请稍后重试。');
    return payload;
  };
}

export function registerSkillLibrary(ctx, desktop) {
  function handler(body) {
    return async (request) => {
      try {
        const { sessionId, skillName } = selectors(new URL(request.url), body);
        return await withCatalog(ctx, sessionId, request.signal, async (registry, options, context) => {
          const catalog = await registry.list(options);
          if (!body) {
            let shared;
            try { shared = await desktop('catalog', {}, request.signal); }
            catch (error) { shared = { teamSkills: [], sharing: { error: error instanceof CatalogError ? error.message : '技能共享服务暂不可读取。' } }; }
            const identity = shared.sharing?.identity;
            const skills = catalog.map(item => {
              const summary = summaryOf(item);
              const own = shared.teamSkills?.find(row => row.origin === 'local' && row.skillId === summary.id && row.author?.id === identity?.id);
              return own ? { ...summary, sharedId: own.id } : summary;
            }).sort((a, b) => a.id.localeCompare(b.id));
            return json(200, { ok: true, context, skills, teamSkills: shared.teamSkills, sharing: shared.sharing });
          }
          // Resolve the name against a fresh winning catalog; no caller-controlled
          // path, filesystem read, or stale provider locator crosses this boundary.
          const listed = catalog.find((item) => item.name === skillName);
          if (!listed) return failure(404, '此技能已不在当前可用清单中。');
          const skill = await registry.get(skillName, options);
          if (!skill) return failure(404, '技能说明暂不可读取，请刷新后重试。');
          if (typeof skill.content !== 'string' || Buffer.byteLength(skill.content, 'utf8') > MAX_BODY_BYTES) return failure(413, '技能说明过长，暂不支持在此预览。');
          const metadata = skill.metadata || {};
          return json(200, { ok: true, skill: { ...summaryOf(listed),
            displayName: text(metadata.displayName, 128) || summaryOf(listed).displayName,
            content: skill.content,
          } });
        });
      } catch (error) {
        return failure(error instanceof CatalogError ? error.status : 503,
          error instanceof CatalogError ? error.message : '技能清单暂不可读取，请稍后刷新。');
      }
    };
  }
  // Connection-owned exact routes enforce the same cookie/Host/Origin admission
  // as ordinary Agent APIs. A loopback socket alone is not authentication.
  ctx.connection.fetch.register({ path: '/api/adh-skill-library/list', methods: ['GET'], requestBody: 'buffered', fetch: handler(false) });
  ctx.connection.fetch.register({ path: '/api/adh-skill-library/body', methods: ['GET'], requestBody: 'buffered', fetch: handler(true) });
  const operations = {
    share: ['name', 'sessionId'], unshare: ['id'], 'server-start': [], 'server-stop': [], connect: ['url', 'token'], disconnect: [],
  };
  const guard = work => async request => {
    try { return json(200, { ok: true, ...await work(request) }); }
    catch (error) { return failure(error instanceof CatalogError ? error.status : 503, error instanceof CatalogError ? error.message : '技能共享操作未完成，请稍后重试。'); }
  };
  ctx.connection.fetch.register({ path: '/api/adh-skill-library/team-body', methods: ['GET'], requestBody: 'buffered', fetch: guard(async request => {
    const url = new URL(request.url), keys = [...url.searchParams.keys()];
    if (keys.some(key => !['id', 'origin'].includes(key) || url.searchParams.getAll(key).length !== 1) || !/^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('id') || '') || !['local', 'remote'].includes(url.searchParams.get('origin'))) throw new CatalogError(400, '团队技能标识无效。');
    return desktop('body', { id: url.searchParams.get('id'), origin: url.searchParams.get('origin') }, request.signal);
  }) });
  for (const [operation, allowed] of Object.entries(operations)) {
    ctx.connection.fetch.register({ path: `/api/adh-skill-library/${operation}`, methods: ['POST'], requestBody: 'buffered', fetch: guard(async request => {
      if (new URL(request.url).search) throw new CatalogError(400, '技能操作参数无效。');
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > 8192) throw new CatalogError(413, '技能操作参数过长。');
      let args; try { args = JSON.parse(raw); } catch { throw new CatalogError(400, '技能操作参数无效。'); }
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new CatalogError(400, '技能操作参数无效。');
      if (operation === 'share') {
        const query = new URL('http://127.0.0.1/');
        for (const [key, value] of Object.entries(args)) { if (typeof value !== 'string') throw new CatalogError(400, '技能标识无效。'); query.searchParams.set(key, value); }
        const { sessionId, skillName } = selectors(query, true);
        return withCatalog(ctx, sessionId, request.signal, async (registry, options) => {
          const listed = (await registry.list(options)).find(item => item.name === skillName);
          if (!listed) throw new CatalogError(404, '此技能已不在当前可用清单中。');
          const skill = await registry.get(skillName, options);
          if (!skill || typeof skill.content !== 'string') throw new CatalogError(404, '技能说明暂不可读取。');
          if (Buffer.byteLength(skill.content, 'utf8') > MAX_BODY_BYTES) throw new CatalogError(413, '技能说明过长，暂不能分享。');
          return desktop('share', { skill: { ...summaryOf(listed), content: skill.content } }, request.signal);
        });
      }
      if (operation === 'unshare' && !/^[A-Za-z0-9_-]{1,200}$/.test(args.id || '')) throw new CatalogError(400, '团队技能标识无效。');
      if (operation === 'connect' && (typeof args.url !== 'string' || args.url.length > 2048 || typeof args.token !== 'string' || args.token.length > 256)) throw new CatalogError(400, '请填写团队主机地址和邀请码。');
      return desktop(operation, args, request.signal);
    }) });
  }
}

export function apply(ctx) { registerSkillLibrary(ctx, createDesktopBridge()); }
