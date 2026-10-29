const { app, BrowserWindow, dialog, ipcMain, Menu, shell, safeStorage, screen, session, nativeImage, protocol, clipboard, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalBackend } = require('./backend/local-backend.cjs');
const { TeamSyncServer, TeamSyncClient } = require('./backend/team-sync.cjs');
const { AgentHub, SKILLS } = require('./backend/agent-hub.cjs');
const { ProjectHub } = require('./backend/project-hub.cjs');
const { SkillCenter } = require('./backend/skill-center.cjs');
const { ResourceLibrary } = require('./backend/resource-library.cjs');
const agentConfigWriter = require('./backend/agent-config-writer.cjs');
const { ModelService } = require('./backend/model-service.cjs');
const { resolveDeviceSettings } = require('./backend/device-settings.cjs');
const { AgentPairingService } = require('./backend/agent-pairing.cjs');
const { HubChat } = require('./backend/hub-chat.cjs');
const { TeamDirectory } = require('./backend/team-directory.cjs');
const { AgentGateway } = require('./backend/agent-gateway.cjs');
const { executeAgent } = require('./backend/agent-executors.cjs');
const { acquireServiceLock } = require('./backend/service-lock.cjs');
const { CaseResearchService } = require('./backend/case-research.cjs');
const { registerCaseArticleIpc, SCHEME: CASE_ARTICLE_SCHEME } = require('./backend/case-article-ipc.cjs');
const { ImageCollectionService } = require('./backend/image-collection.cjs');
const { createImageBrowserCapture } = require('./backend/image-browser.cjs');
const { registerImageCollectionIpc, rasterPreview } = require('./backend/image-collection-ipc.cjs');
const { ProjectResearchService } = require('./backend/project-research.cjs');
const { ResearchImageService } = require('./backend/research-images.cjs');
const { registerProjectResearchIpc } = require('./backend/project-research-ipc.cjs');
const { AdhWorkbenchService } = require('./backend/adh-workbench-service.cjs');
const { buildClientConfig } = require('./backend/client-config.cjs');
const { DshRuntimeManager } = require('./backend/dsh-runtime.cjs');
const { startDshModelProxy } = require('./backend/dsh-model-proxy.cjs');
const { DshViewManager } = require('./backend/dsh-view.cjs');
const { registerKnowledgeWorkbenchIpc } = require('./backend/knowledge-workbench-ipc.cjs');
const { resolveKnowledgePayloadRoot } = require('./backend/knowledge-engine/client.cjs');
const { createLoomicLocalService } = require('./backend/loomic-local.cjs');
const { MediaModelService } = require('./backend/media-model-service.cjs');
const { createCanvasAgentProvider } = require('./backend/canvas-agent-provider.cjs');

const APP_DIR = __dirname;
protocol?.registerSchemesAsPrivileged?.([{ scheme: CASE_ARTICLE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const DEMO_COMPANY_ENABLED = process.env.AIDESIGNHUB_DEMO_COMPANY === '1' || (process.argv||[]).includes('--demo-company');
// The current group chat is a frontend demo, not the old LAN mirror. Keep
// legacy connection settings intact, but only activate that protocol in an
// explicitly enabled development session or the historical smoke harness.
const LEGACY_TEAM_SYNC_ENABLED = process.env.AIDESIGNHUB_LEGACY_TEAM_SYNC === '1' || process.env.BYCJ_WORKBENCH_SMOKE === '1';
const LEGACY_TEAM_SYNC_DISABLED = '当前项目群聊为本机界面演示，尚未接入真实团队同步；旧版局域网同步已停用，不需要断开它来新建或切换项目。';
function requireLegacyTeamSync() {
  if(!LEGACY_TEAM_SYNC_ENABLED){const error=new Error(LEGACY_TEAM_SYNC_DISABLED);error.code='LEGACY_TEAM_SYNC_DISABLED';throw error;}
}
function disabledTeamSyncStatus(){return {mode:'off',connected:false,enabled:false,disabled:true,message:LEGACY_TEAM_SYNC_DISABLED};}
const allowedProjectRoots = new Set();
let backend = null;
let teamServer = null;
let teamClient = null;
let agentHub = null;
let agentGateway = null;
let gatewayStatus = {running:false,url:''};
let releaseServiceLock = null;
let caseService = null;
let imageCollection = null;
let projectResearch = null;
let adhWorkbench = null;
let loomicService = null;
let mediaModels = null;
let dshWorkbenchIntent = null;
let imageBrowserCapture = null;
let projectHub = null;
let modelService = null;
let skillCenter = null;
let resourceLibrary = null;
let hubChat = null;
let teamDirectory = null;
let deviceSettings = null;
let agentPairing = null;
let dshRuntime = null;
let dshModelProxy = null;
let dshView = null;
let knowledgeWorkbench = null;
let dshPendingAttach = false;
// The renderer cannot receive mouse events over the native child view, so a
// collapsed sidebar keeps a thin renderer-owned strip at the window's left edge
// (this inset). Expanding the sidebar widens the inset to the full panel width.
const DSH_EDGE_INSET = 12;
let dshHoverWatchdog = null;
function broadcastDsh(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
// Poll the OS cursor while the sidebar is expanded: once it crosses back over
// the native view (or leaves the window) the renderer gets no event, so main
// tells it to collapse. This is the only reliable hover-leave signal.
function startDshHoverWatchdog() {
  if (dshHoverWatchdog) return;
  dshHoverWatchdog = setInterval(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed() || !dshView?.isAttached) return;
    const inset = dshView.leftInset;
    if (inset <= DSH_EDGE_INSET) return; // collapsed; renderer owns the edge strip
    const bounds = win.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const relX = cursor.x - bounds.x;
    const relY = cursor.y - bounds.y;
    const inside = relX >= 0 && relX < bounds.width && relY >= 0 && relY < bounds.height;
    if (!inside || relX >= inset) broadcastDsh('workbench:dsh-hover-leave');
  }, 160);
}
function stopDshHoverWatchdog() {
  if (dshHoverWatchdog) { clearInterval(dshHoverWatchdog); dshHoverWatchdog = null; }
}
const smokeExternalUrls = [];

async function syncFromRemote() {
  if (!teamClient || !backend) return backend?.bootstrap();
  const projectId=backend.bootstrap().project.id;
  const snapshot = await teamClient.bootstrap(projectId);
  for(const message of snapshot.messages||[]) {
    for(let index=0;index<(message.attachments||[]).length;index+=1) {
      const attachment=message.attachments[index];
      const existingPath=String(attachment.storedPath||'');
      const resolvedPath=path.resolve(existingPath||'.');const attachmentRoot=path.resolve(backend.attachmentsDir);
      if(existingPath&&fs.existsSync(existingPath)&&(resolvedPath===attachmentRoot||resolvedPath.startsWith(`${attachmentRoot}${path.sep}`)))continue;
      const downloaded=await teamClient.downloadAttachment(attachment.id);
      message.attachments[index]=backend.storeSyncedAttachment(downloaded,projectId);
    }
  }
  // Team knowledge is not part of bootstrap; pull metadata + files separately so
  // search/reveal work locally. Files already stored on disk are not re-fetched.
  try {
    const teamDocs=await teamClient.getTeamKnowledge(projectId);
    const knowledgeDocs=[];
    for(const doc of teamDocs||[]) {
      const existing=backend.store.knowledgeDocs.find((item)=>item.id===doc.id&&item.scope==='team');
      if(existing&&existing.storedPath&&fs.existsSync(existing.storedPath)) { knowledgeDocs.push(existing); continue; }
      const file=await teamClient.downloadKnowledgeFile(doc.id);
      knowledgeDocs.push(backend.storeSyncedKnowledgeDocument({...doc,projectId},file));
    }
    snapshot.knowledgeDocs=knowledgeDocs;
  } catch {}
  return backend.mergeRemoteSnapshot(snapshot);
}

if (process.env.BYCJ_WORKBENCH_SMOKE === '1') {
  fs.writeFileSync(path.join(APP_DIR, '.smoke-result.json'), JSON.stringify({ ok: false, stage: 'main-started' }, null, 2), 'utf8');
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function classifyFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.3dm', '.pla', '.pln', '.bim', '.rvt', '.skp', '.obj', '.fbx', '.glb', '.gltf'].includes(ext)) return 'model';
  if (['.dwg', '.dxf', '.pdf', '.ai', '.indd', '.idml', '.ppt', '.pptx'].includes(ext)) return 'drawing';
  if (['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.psd', '.svg'].includes(ext)) return 'image';
  if (['.doc', '.docx', '.txt', '.md', '.rtf', '.xls', '.xlsx', '.csv'].includes(ext)) return 'document';
  return 'other';
}

function scanProjectFolder(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  if (!allowedProjectRoots.has(resolvedRoot)) throw new Error('Folder permission is not available.');

  const summary = { model: 0, drawing: 0, image: 0, document: 0, other: 0 };
  const recent = [];
  let folderCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const queue = [{ folder: resolvedRoot, depth: 0 }];
  const maxFiles = 8000;
  const maxDepth = 8;

  while (queue.length && fileCount < maxFiles) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current.folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolutePath = path.join(current.folder, entry.name);
      if (entry.isDirectory()) {
        folderCount += 1;
        if (current.depth < maxDepth) queue.push({ folder: absolutePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = safeStat(absolutePath);
      if (!stat) continue;
      fileCount += 1;
      totalBytes += stat.size;
      const category = classifyFile(entry.name);
      summary[category] += 1;
      recent.push({
        name: entry.name,
        relativePath: path.relative(resolvedRoot, absolutePath),
        category,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
      if (fileCount >= maxFiles) break;
    }
  }

  recent.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return {
    rootPath: resolvedRoot,
    projectName: path.basename(resolvedRoot),
    folderCount,
    fileCount,
    totalBytes,
    summary,
    recent: recent.slice(0, 18),
    truncated: fileCount >= maxFiles,
    scannedAt: Date.now(),
  };
}

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function detectInstalledApps() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const adobeRoots = [path.join(programFiles, 'Adobe'), path.join(programFilesX86, 'Adobe')];
  const findAdobe = (keyword, executable) => {
    for (const root of adobeRoots) {
      if (!fs.existsSync(root)) continue;
      const folders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(keyword));
      for (const folder of folders) {
        const match = firstExisting([
          path.join(root, folder.name, executable),
          path.join(root, folder.name, 'Support Files', 'Contents', 'Windows', executable),
        ]);
        if (match) return match;
      }
    }
    return null;
  };
  const findGraphisoft = () => {
    const root = path.join(programFiles, 'GRAPHISOFT');
    if (!fs.existsSync(root)) return null;
    for (const folder of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const match = firstExisting([path.join(root, folder.name, 'Archicad.exe'), path.join(root, folder.name, 'ARCHICAD.exe')]);
      if (match) return match;
    }
    return null;
  };
  const findRhino = () => {
    const root = path.join(programFiles, 'Rhino 8', 'System', 'Rhino.exe');
    if (fs.existsSync(root)) return root;
    const mcneel = path.join(programFiles, 'Rhino 7', 'System', 'Rhino.exe');
    return fs.existsSync(mcneel) ? mcneel : null;
  };
  const officeCandidates = [
    path.join(programFiles, 'Microsoft Office', 'root', 'Office16', 'POWERPNT.EXE'),
    path.join(programFilesX86, 'Microsoft Office', 'root', 'Office16', 'POWERPNT.EXE'),
  ];

  return [
    { id: 'rhino', name: 'Rhino', path: findRhino() },
    { id: 'archicad', name: 'Archicad', path: findGraphisoft() },
    { id: 'indesign', name: 'Adobe InDesign', path: findAdobe('indesign', 'InDesign.exe') },
    { id: 'illustrator', name: 'Adobe Illustrator', path: findAdobe('illustrator', 'Support Files\\Contents\\Windows\\Illustrator.exe') || findAdobe('illustrator', 'Illustrator.exe') },
    { id: 'powerpoint', name: 'Microsoft PowerPoint', path: firstExisting(officeCandidates) },
    { id: 'obsidian', name: 'Obsidian', path: firstExisting([
      path.join(programFiles, 'Obsidian', 'Obsidian.exe'),
      path.join(localAppData, 'Programs', 'Obsidian', 'Obsidian.exe'),
      path.join(localAppData, 'Obsidian', 'Obsidian.exe'),
    ]) },
  ].map((item) => ({ ...item, installed: Boolean(item.path) }));
}

function buildWeeklyReport(data) {
  const openTasks=data.tasks.filter((item)=>item.status!=='done');
  const openRisks=data.risks.filter((item)=>item.status==='open');
  const recentMessages=data.messages.slice(-8);
  const decisions=data.decisions.slice(0,8);
  return [
    `# ${data.project.name}｜项目周报`,
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 一、本周项目状态',
    '',
    `- 当前阶段：${data.project.currentPhase||'概念设计'}`,
    `- 待完成任务：${openTasks.length} 项`,
    `- 未关闭风险：${openRisks.length} 项`,
    `- 已记录项目决策：${data.decisions.length} 项`,
    '',
    '## 二、待完成任务',
    '',
    ...(openTasks.length?openTasks.map((item)=>`- [ ] ${item.title}｜负责人：${data.members.find((member)=>member.id===item.ownerId)?.name||'待分配'}｜状态：${item.status}`):['- 当前没有待完成任务']),
    '',
    '## 三、风险与管理提醒',
    '',
    ...(openRisks.length?openRisks.map((item)=>`- **${item.title}**：${item.description}`):['- 当前没有未关闭风险']),
    '',
    '## 四、近期项目决策',
    '',
    ...(decisions.length?decisions.map((item)=>`- **${item.title}**（${item.status==='confirmed'?'已确认':'待确认'}）：${item.summary}`):['- 本周暂无项目决策']),
    '',
    '## 五、近期沟通摘要',
    '',
    ...(recentMessages.length?recentMessages.map((item)=>`- ${data.members.find((member)=>member.id===item.senderId)?.name||'项目成员'}：${String(item.body||'').replace(/\s+/g,' ').slice(0,180)}`):['- 本周暂无项目消息']),
    '',
    '> 本周报由本地项目数据库生成，请由项目经理复核后再对外发送。',
    '',
  ].join('\n');
}

function buildScopeChangeReport(data) {
  const item=data.scopeChanges[0];
  return [
    `# ${data.project.name}｜范围变更影响清单`,
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    `## 变更事项`,
    '',
    item?.title||'业主新增高度及产品组合调整',
    '',
    '## 已识别影响',
    '',
    ...(item?.impacts||['总图与指标','Rhino / Archicad 模型','关键效果图','概念成果文本']).map((impact)=>`- ${impact}`),
    '',
    '## 建议留存的证据',
    '',
    '- 业主原始指令、邮件或项目群消息',
    '- 变更前已经确认的模型、图纸和汇报版本',
    '- 受影响成果清单与预计返工人日',
    '- 项目经理对合同范围和追加费用的判断',
    '',
    '## 待确认事项',
    '',
    '- [ ] 业主是否书面确认变更内容',
    '- [ ] 是否影响原定里程碑与付款节点',
    '- [ ] 是否需要发出范围变更确认单',
    '- [ ] 是否需要调整团队资源与交付日期',
    '',
    '> 本清单是项目管理辅助材料，不替代合同或法律意见。',
    '',
  ].join('\n');
}

// 自绘标题条与原生窗口控制按钮 overlay 的配色，跟随三套主题（与 --topbar-bg 合成色一致）。
const TITLEBAR_OVERLAYS = {
  light: { color: '#fbfcfd', symbolColor: '#667085', height: 34 },
  dark: { color: '#141a28', symbolColor: '#e7ebf4', height: 34 },
  minimal: { color: '#fefefe', symbolColor: '#71767f', height: 34 },
};
const titlebarOverlayFor = (theme) => TITLEBAR_OVERLAYS[theme] || TITLEBAR_OVERLAYS.light;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f7fb',
    icon: path.join(APP_DIR, 'assets', 'aidesignhub-appicon.png'),
    title: 'AIDesignHub',
    autoHideMenuBar: true,
    // Windows 的原生标题栏小图标与任务栏图标同源（同一次 setIcon），无法只去掉
    // 标题栏那个；改为隐藏原生标题栏 + 窗口控制按钮 overlay，名字交给 renderer
    // 标题条（.window-titlebar）呈现，任务栏图标不受影响。
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: titlebarOverlayFor(backend?.store?.settings?.theme) }
      : {}),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: process.env.BYCJ_WORKBENCH_SMOKE !== '1',
      offscreen: process.env.BYCJ_WORKBENCH_SMOKE === '1',
    },
  });

  win.once('ready-to-show', () => {if(process.env.BYCJ_WORKBENCH_SMOKE!=='1')win.show();});
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (process.env.BYCJ_WORKBENCH_SMOKE === '1') {
      fs.writeFileSync(path.join(APP_DIR, '.smoke-result.json'), JSON.stringify({ ok: false, stage: 'did-fail-load', errorCode, errorDescription }, null, 2), 'utf8');
      app.quit();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.loadFile(path.join(APP_DIR, 'index.html'));

  if (process.env.BYCJ_WORKBENCH_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
          window.__SMOKE_STEP__='initial bootstrap';
          for (let attempt = 0; attempt < 80 && !document.querySelector('[data-role="pm"]'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
          const apiAvailable = Boolean(window.bycjWorkbench);
          const runtime = apiAvailable ? await window.bycjWorkbench.runtimeInfo() : null;
          const bootstrap = apiAvailable ? await window.bycjWorkbench.bootstrap() : null;
          const knowledge = apiAvailable ? await window.bycjWorkbench.searchKnowledge(bootstrap.project.id, '消防车道净宽度') : null;
          const smokeMessage = apiAvailable ? await window.bycjWorkbench.sendMessage({ projectId: bootstrap.project.id, channelId: bootstrap.channels[0].id, body: '自动测试消息：项目聊天后端可写入。' }) : null;
          window.__SMOKE_STEP__='navigation and role';
          document.querySelector('[data-view="knowledge"]').click();
          const knowledgeOpened = document.querySelector('#view-knowledge').classList.contains('is-active');
          document.querySelector('[data-view="chat"]').click();
          await window.aidesignHubChatUI.open('group');
          const chatOpened = !document.querySelector('#hubChatDock').hidden && document.querySelectorAll('#hubChatDemo .cd-message').length > 0;
          document.querySelector('[data-open-role-menu]').click();
          const roleModalOpened = document.querySelector('#roleModal').classList.contains('is-open');
          document.querySelector('[data-role="pm"]').click();
          for (let attempt = 0; attempt < 40 && !document.querySelector('#briefTitle').textContent.includes('项目经理'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
          const roleChanged = document.querySelector('#briefTitle').textContent.includes('项目经理');
          document.querySelector('#askAiButton').click();
          await window.aidesignHubChatUI.open('assistant');
          const projectAssistantOpened = !document.querySelector('#hubChatDock').hidden;
          if(!projectAssistantOpened)throw new Error('项目助手入口未打开');
          window.aidesignHubChatUI.close();
          document.querySelector('[data-open-role-menu]').click();
          document.querySelector('[data-role="designer"]').click();
          for (let attempt = 0; attempt < 40 && !document.querySelector('#briefTitle').textContent.includes('项目设计师'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
          document.querySelector('#teamSyncButton').click();
          const teamSyncModalOpened = document.querySelector('#teamSyncModal').classList.contains('is-open');
          document.querySelector('#teamSyncModal [data-close-modal]').click();
          const hostSync = apiAvailable ? await window.bycjWorkbench.startTeamServer({ lan:false }) : null;
          const hostSyncWorking = Boolean(hostSync?.running && hostSync?.token && hostSync?.addresses?.length);
          if (apiAvailable) await window.bycjWorkbench.disconnectTeamSync();
          window.__SMOKE_STEP__='agent task';
          document.querySelector('[data-view="agents"]').click();
          for(let attempt=0;attempt<200&&document.querySelector('#view-agents').dataset.agentLoaded!=='true';attempt++)await new Promise(resolve=>setTimeout(resolve,50));
          const agentCards=document.querySelectorAll('[data-agent-provider]').length;
          document.querySelector('#agentOpenHistory').click();
          document.querySelector('#agentManualTaskDetails').open=true;
          document.querySelector('#agentJobTitle').value='自动测试：外部 Agent 协作闭环';
          document.querySelector('#agentJobInstruction').value='输出规范研读记录，保留证据。';
          document.querySelector('#agentJobConnection').value='zcode';
          document.querySelector('#agentJobForm').requestSubmit();
          for(let attempt=0;attempt<200&&!document.querySelector('[data-agent-start]');attempt++)await new Promise(resolve=>setTimeout(resolve,50));
          document.querySelector('[data-agent-start]').click();
          let agentState;
          for(let attempt=0;attempt<200;attempt++){agentState=await window.bycjWorkbench.agentSnapshot();if(agentState.runs.length&&agentState.gateway.running)break;await new Promise(resolve=>setTimeout(resolve,50));}
          const agentUi={cards:agentCards,jobId:agentState.jobs[0]?.id,runId:agentState.runs[0]?.id,status:agentState.runs[0]?.status,gateway:agentState.gateway.running};
          if(agentCards!==6||agentUi.status!=='waiting_agent'||!agentUi.gateway)throw new Error('Agent协作页面和任务创建没有通过验证：'+JSON.stringify(agentUi));
          document.querySelector('[data-view="dashboard"]').click();
          return { title: document.title, agentUi, nav: document.querySelectorAll('[data-view]').length, roleButtons: document.querySelectorAll('[data-role]').length, bodyText: document.body.innerText.includes('项目大脑'), activeView: document.querySelectorAll('.page-view.is-active').length, apiAvailable, runtime, knowledgeOpened, chatOpened, teamSyncModalOpened, hostSyncWorking, backend: bootstrap ? { members: bootstrap.members.length, channels: bootstrap.channels.length, messages: bootstrap.messages.length, decisions: bootstrap.decisions.length, knowledgeDocs: bootstrap.knowledgeDocs.length } : null, knowledgeHits: knowledge?.hits?.length || 0, messagePersisted: Boolean(smokeMessage?.id), roleModalOpened, roleChanged, projectAssistantOpened, errors: window.__BYCJ_WORKBENCH_ERRORS__ || [] };
        })()`);
        result.shellUi=await win.webContents.executeJavaScript(`(async()=>{
          const sleep=ms=>new Promise(r=>setTimeout(r,ms));
          const ask=document.querySelector('#askAiButton');
          const askRect=ask?ask.getBoundingClientRect():null;
          const askVisible=Boolean(ask&&ask.offsetParent!==null&&askRect.width>0&&askRect.height>0);
          const askTopRight=Boolean(askRect&&askRect.right>window.innerWidth*0.6&&askRect.top<140);
          const brand=document.querySelector('.brand-copy span')?.textContent||'';
          const darkBtn=document.querySelector('[data-theme-choice="dark"]');
          darkBtn?.click();await sleep(60);
          const themeApplied=document.documentElement.dataset.theme==='dark'&&darkBtn.classList.contains('is-active');
          document.querySelector('[data-theme-choice="light"]')?.click();await sleep(60);
          const themeRestored=document.documentElement.dataset.theme==='light';
          document.querySelector('[data-view="knowledge"]').click();await sleep(120);
          const knowledgeSections=document.querySelectorAll('#knowledgeDocList .resource-section').length;
          const scopeSelect=Boolean(document.querySelector('#knowledgeImportScope'));
          document.querySelector('[data-view="cases"]').click();await sleep(150);
          const caseTiers=document.querySelectorAll('#caseGrid .case-tier').length;
          const localOption=Boolean(document.querySelector('#caseCollectConnection option[value="__local__"]'));
          const caseScope=Boolean(document.querySelector('#caseCollectScope'));
          document.querySelector('[data-view="dashboard"]').click();await sleep(60);
          const shell=document.querySelector('.app-shell');
          // 聊天按钮必须是 .app-shell 直接子节点（视口定点），不能留在带
          // backdrop-filter 的 topbar 内，否则 Agent 模式会被原生视图空档埋住。
          const askInShell=Boolean(document.querySelector('#askAiButton')&&!document.querySelector('#askAiButton').closest('.topbar')&&document.querySelector('#askAiButton').closest('.app-shell')===shell);
          // 自绘标题条：只有名字、没有图标，顶在窗口最上沿。
          const strip=document.querySelector('.window-titlebar');
          const stripRect=strip?strip.getBoundingClientRect():null;
          const titleStripOk=Boolean(strip&&stripRect&&getComputedStyle(strip).display!=='none'&&stripRect.height>0&&Math.abs(stripRect.top)<1&&strip.textContent.trim()==='AIDesignHub'&&!strip.querySelector('img,svg'));
          shell.classList.add('dsh-agent-mode');await sleep(40);
          // 折叠态不再保留整条右侧栏：只余顶栏右上角的小图标，且顶栏行可见。
          const railGone=!document.querySelector('#agentRightRail');
          const topbar=document.querySelector('.topbar');
          const topbarRect=topbar.getBoundingClientRect();
          const topbarVisible=getComputedStyle(topbar).display!=='none'&&topbarRect.height>0&&Math.abs(topbarRect.top-(stripRect?stripRect.bottom:0))<=1;
          const askSpanHidden=getComputedStyle(document.querySelector('#askAiButton span')).display==='none';
          const askRect2=document.querySelector('#askAiButton').getBoundingClientRect();
          const askCompact=askRect2.width>0&&askRect2.width<=48&&askRect2.height<=48;
          const askInTopbar=askRect2.top>=topbarRect.top-1&&askRect2.bottom<=topbarRect.bottom+1;
          const askSameSpot=Boolean(askRect&&Math.abs(askRect2.top-askRect.top)<=1&&Math.abs(askRect2.right-askRect.right)<=1);
          shell.classList.remove('dsh-agent-mode');await sleep(20);
          const agentChatEntry=askInShell&&railGone&&topbarVisible&&askSpanHidden&&askCompact&&askInTopbar&&askSameSpot;
          return {askVisible,askTopRight,brandSlogan:brand.includes('Your Design'),themeApplied,themeRestored,knowledgeSections,scopeSelect,caseTiers,localOption,caseScope,agentChatEntry,titleStripOk};
        })()`);
        if(!result.shellUi.askVisible||!result.shellUi.askTopRight||!result.shellUi.brandSlogan||!result.shellUi.themeApplied||!result.shellUi.themeRestored||result.shellUi.knowledgeSections!==2||!result.shellUi.scopeSelect||result.shellUi.caseTiers!==2||!result.shellUi.localOption||!result.shellUi.caseScope||!result.shellUi.agentChatEntry||!result.shellUi.titleStripOk)throw new Error('外壳整修断言未通过：'+JSON.stringify(result.shellUi));
        allowedProjectRoots.add(path.resolve(APP_DIR));
        const scanCheck = scanProjectFolder(APP_DIR);
        result.folderScanner = { fileCount: scanCheck.fileCount, categories: scanCheck.summary, recentCount: scanCheck.recent.length };
        result.detectedApps = detectInstalledApps().map(({ id, installed }) => ({ id, installed }));
        const smokeGrant=agentHub.createGrant({label:'isolated-ui-test',projectId:'project_jiangwan',memberId:'member_designer',scopes:['runs:write']});
        const smokeCall=async(name,args)=>{const response=await fetch(`${gatewayStatus.url}/v1/call`,{method:'POST',headers:{Authorization:`Bearer ${smokeGrant.token}`,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});if(!response.ok)throw new Error(`Agent smoke HTTP ${response.status}`);return (await response.json()).result;};
        await smokeCall('hub_run_claim',{runId:result.agentUi.runId});
        await smokeCall('hub_artifact_submit',{runId:result.agentUi.runId,content:'测试成果：出处完整。<img src=x onerror="window.agentXss=true">',requestId:'smoke-artifact'});
        agentHub.revokeGrant(smokeGrant.id);
        await win.webContents.executeJavaScript(`document.querySelector('[data-view="agents"]').click()`);
        result.agentUi.review=await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<150&&!document.querySelector('#agentRunOutput').textContent.includes('测试成果');i++)await new Promise(r=>setTimeout(r,50));const outEl=document.querySelector('#agentRunOutput');const safe=!window.agentXss&&outEl.textContent.includes('<img');const originalConfirm=window.confirm;window.confirm=()=>true;document.querySelector('#agentApproveRun').click();for(let i=0;i<150;i++){if((await window.bycjWorkbench.agentSnapshot()).runs[0].status==='succeeded')break;await new Promise(r=>setTimeout(r,50));}window.confirm=originalConfirm;return {safeText:safe,xss:Boolean(window.agentXss),output:outEl.textContent.slice(0,160),status:(await window.bycjWorkbench.agentSnapshot()).runs[0].status};})()`);
        if(!result.agentUi.review.safeText||result.agentUi.review.status!=='succeeded')throw new Error('Agent成果展示或审核未通过：'+JSON.stringify(result.agentUi.review));
        result.chatUi=await require('./tests/fixtures/chat-ui-smoke.cjs').runChatSmoke(win,agentHub);
        await new Promise(resolve=>setTimeout(resolve,350));
        fs.writeFileSync(path.join(APP_DIR,'.smoke-agent-chat.png'),(await win.webContents.capturePage()).toPNG());
        result.clientConfigUi=await require('./tests/fixtures/client-config-ui-smoke.cjs').runClientConfigSmoke(win,agentHub);
        result.dispatchUi=await require('./tests/fixtures/dispatch-ui-smoke.cjs').runDispatchSmoke(win,agentHub);
        await win.webContents.executeJavaScript(`document.querySelector('[data-view="agents"]').click()`);
        await new Promise(resolve=>setTimeout(resolve,300));
        result.agentUi.activeView=await win.webContents.executeJavaScript(`document.querySelector('.page-view.is-active')?.id`);
        if(result.agentUi.activeView!=='view-agents')throw new Error('Agent页面导航未保持');
        fs.writeFileSync(path.join(APP_DIR,'.smoke-agents.png'),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('#agentNewChat').click()`);
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.writeFileSync(path.join(APP_DIR,'.smoke-agent-welcome.png'),(await win.webContents.capturePage()).toPNG());
        result.caseNameUi=await require('./tests/fixtures/case-name-ui-smoke.cjs').runCaseNameSmoke({win,backend,hub:agentHub,caseService});
        result.projectHubUi=await require('./tests/fixtures/project-hub-ui-smoke.cjs').runProjectHubSmoke(win,projectHub,skillCenter);
        await win.webContents.executeJavaScript(`document.querySelector('#hubDraftDialog').close()`);
        result.globalChatUi=await require('./tests/fixtures/global-chat-ui-smoke.cjs').runGlobalChatSmoke(win,hubChat,teamDirectory);
        result.systemSecretEncryption=safeStorage.isEncryptionAvailable()&&safeStorage.decryptString(safeStorage.encryptString('synthetic-local-encryption-check'))==='synthetic-local-encryption-check';
        if(!result.systemSecretEncryption)throw new Error('系统加密存储回环验证未通过');
        for(const page of ['assistant','skills','workflow']){
          await win.webContents.executeJavaScript(`document.querySelector('[data-view="${page}"]').click();document.querySelector('.main-area').scrollTo(0,0)`);
          await new Promise(resolve=>setTimeout(resolve,150));
          fs.writeFileSync(path.join(APP_DIR,`.smoke-hub-${page}.png`),(await win.webContents.capturePage()).toPNG());
        }
        await win.webContents.executeJavaScript(`document.querySelector('#caseCollectorTitle').scrollIntoView({block:'center'})`);
        await new Promise(resolve=>setTimeout(resolve,350));
        fs.writeFileSync(path.join(APP_DIR,'.smoke-case-name.png'),(await win.webContents.capturePage()).toPNG());
        result.caseUi=await require('./tests/fixtures/case-ui-smoke.cjs').runCaseSmoke({win,backend,hub:agentHub,caseService,gateway:gatewayStatus,appDir:APP_DIR,openedUrls:smokeExternalUrls});
        const activeAfterChatClick = await win.webContents.executeJavaScript(`(async()=>{await window.aidesignHubChatUI.open('group');return !document.querySelector('#hubChatDock').hidden;})()`);
        if (!activeAfterChatClick) throw new Error('Global chat did not open');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const chatPageScreenshot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(APP_DIR, '.smoke-chat.png'), chatPageScreenshot.toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('#teamSyncButton').click()`);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const teamSyncScreenshot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(APP_DIR, '.smoke-team-sync.png'), teamSyncScreenshot.toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('#teamSyncModal [data-close-modal]').click()`);
        await win.webContents.executeJavaScript(`document.querySelector('[data-view="dashboard"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const screenshot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(APP_DIR, '.smoke-dashboard.png'), screenshot.toPNG());
        result.finalRendererErrors=await win.webContents.executeJavaScript(`window.__BYCJ_WORKBENCH_ERRORS__||[]`);
        if(result.finalRendererErrors.length)throw new Error('Renderer errors found after end-to-end smoke');
        fs.writeFileSync(path.join(APP_DIR, '.smoke-result.json'), JSON.stringify({ ok: true, result }, null, 2), 'utf8');
        process.stdout.write(`WORKBENCH_SMOKE=${JSON.stringify(result)}\n`);
      } catch (error) {
        const diagnostics=await win.webContents.executeJavaScript(`({step:window.__SMOKE_STEP__,errors:window.__BYCJ_WORKBENCH_ERRORS__,text:document.body.innerText.slice(-5000)})`).catch(()=>null);
        fs.writeFileSync(path.join(APP_DIR,'.smoke-failure.png'),(await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(APP_DIR, '.smoke-result.json'), JSON.stringify({ ok: false, error: error.message, stack:error.stack,diagnostics }, null, 2), 'utf8');
      } finally {
        app.quit();
      }
    });
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // The demo always gets its own child directory; never initialize over the
  // normal store even when a caller provides a custom data root.
  const backendDataDir = DEMO_COMPANY_ENABLED
    ? path.join(process.env.AIDESIGNHUB_DATA_DIR || (process.env.BYCJ_WORKBENCH_SMOKE === '1' ? path.join(APP_DIR, '.smoke-data') : app.getPath('userData')), 'demo-company-v1')
    : process.env.AIDESIGNHUB_DATA_DIR || (process.env.BYCJ_WORKBENCH_SMOKE === '1'
    ? path.join(APP_DIR, '.smoke-data')
    : path.join(app.getPath('userData'), 'design-workbench-v1'));
  // The workbench smoke asserts against a single freshly created agent run
  // (runs[0]); a persisted scratch store from a previous run would make it read
  // a stale run instead. Clear the built-in smoke dir so re-runs are stable.
  if (process.env.BYCJ_WORKBENCH_SMOKE === '1' && !DEMO_COMPANY_ENABLED && backendDataDir === path.join(APP_DIR, '.smoke-data')) {
    try { fs.rmSync(backendDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  releaseServiceLock = acquireServiceLock(backendDataDir);
  const freshDemoCompany = DEMO_COMPANY_ENABLED && !fs.existsSync(path.join(backendDataDir,'store.json'));
  backend = new LocalBackend({ dataDir:backendDataDir });
  if(DEMO_COMPANY_ENABLED)await require('./backend/demo-company.cjs').ensureDemoCompany(backend,{fresh:freshDemoCompany});
  deviceSettings = resolveDeviceSettings({userDataDir:app.getPath('userData'),backendDataDir,env:process.env,smoke:process.env.BYCJ_WORKBENCH_SMOKE==='1',secretStore:safeStorage});
  modelService = new ModelService({dataDir:deviceSettings.dataDir,secretStore:safeStorage,fetchImpl:(...args)=>net.fetch(...args)});
  try { mediaModels = new MediaModelService({ dataDir: deviceSettings.dataDir, fetchImpl: (...args) => net.fetch(...args), ...(safeStorage.isEncryptionAvailable?.() ? {
    protectSecret: value => safeStorage.encryptString(value).toString('base64'),
    unprotectSecret: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  } : {}) }); } catch {
    const unavailable = () => { throw new Error('图片与视频模型配置暂时不可用，原配置文件已保留，请检查本机配置后重启。'); };
    mediaModels = { snapshot: unavailable, save: unavailable, remove: unavailable,
      getImageProvider: () => ({ status: () => ({ configured: false, canGenerate: false }), generate: unavailable, saveConfig: unavailable }),
      getVideoProvider: () => ({ status: () => ({ configured: false, canGenerate: false }), generate: unavailable }) };
  }
  loomicService = createLoomicLocalService({ dataDir: backend.dataDir,
    staticRoot: path.join(APP_DIR, 'Loomic-main', 'Loomic-main', 'apps', 'web', 'out'),
    getProject: id => id === backend.projectId() ? backend.store.projects.find(item => item.id === id) : null,
    provider: mediaModels.getImageProvider(), videoProvider: mediaModels.getVideoProvider(), chatProvider: createCanvasAgentProvider({ modelService }),
    listMediaModels: () => mediaModels.snapshot() });
  knowledgeWorkbench = registerKnowledgeWorkbenchIpc({ ipcMain, dialog, shell, backend, modelService,
    mainWindow: () => BrowserWindow.getAllWindows()[0] || null, rendererFile: path.join(APP_DIR, 'index.html'),
    payloadRoot: resolveKnowledgePayloadRoot({ appDir: APP_DIR, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }) });
  projectHub = new ProjectHub({backend,model:args=>modelService.draft(args)});
  skillCenter = new SkillCenter({backend,builtins:SKILLS});
  resourceLibrary = new ResourceLibrary({backend});
  hubChat = new HubChat({backend,projectHub,modelService,skillCenter});
  teamDirectory = new TeamDirectory({backend,syncMode:()=>teamClient?'client':teamServer?.status().running?'host':'local'});
  hubChat.on('changed',projectId=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('workbench:hub-chat-changed',projectId);});
  agentHub = new AgentHub({backend,execute:executeAgent,projectContext:pid=>projectHub.context(pid),skillCenter});
  agentPairing = new AgentPairingService({hub:agentHub,dataDir:deviceSettings.dataDir,planner:input=>modelService.planDeviceSetup(input)});
  agentPairing.on('progress',progress=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('workbench:agent-setup-progress',progress);});
  let legacyConnections=[];
  if(!deviceSettings.isolated){
    // Read only the same application's old launch definitions. The pairing
    // service accepts exact matches to newly discovered recipes, never grants,
    // client credentials, project paths, or historical verification records.
    for(const name of ['design-workbench-v1','demo-company-v1']){
      const oldFile=path.join(app.getPath('userData'),name,'store.json');
      try{if(!fs.lstatSync(oldFile).isSymbolicLink()&&fs.statSync(oldFile).size<20*1024*1024){const old=JSON.parse(fs.readFileSync(oldFile,'utf8'));legacyConnections.push(...(Array.isArray(old.agentHub?.connections)?old.agentHub.connections:[]));}}catch{}
    }
  }
  const pairingRestoration=agentPairing.restore(legacyConnections);
  caseService = new CaseResearchService({backend,hub:agentHub,...(process.env.BYCJ_WORKBENCH_SMOKE==='1'?{fetchPage:require('./tests/fixtures/smoke-case.cjs').fetchPage,fetchImage:require('./tests/fixtures/smoke-case.cjs').fetchImage}:{})});
  try {
    imageBrowserCapture = createImageBrowserCapture({ BrowserWindow, session });
    imageCollection = new ImageCollectionService({
      dataDir: backend.dataDir,
      findCase: id => backend.store.cases.find(item => item.id === id),
      findProject: id => backend.store.projects.find(item => item.id === id),
      capturePage: imageBrowserCapture,
      makeThumbnail: dataUrl => rasterPreview(nativeImage, dataUrl, { edge: 420, maxBytes: 48 * 1024 }).dataUrl,
      ...(process.env.BYCJ_WORKBENCH_SMOKE==='1'?{fetchPage:require('./tests/fixtures/smoke-case.cjs').fetchPage,fetchImage:require('./tests/fixtures/smoke-case.cjs').fetchImage}:{}),
    });
  } catch (cause) {
    // A damaged optional image manifest must not prevent access to the existing
    // projects. Preserve it and report the cause inside the image workbench.
    imageBrowserCapture?.dispose();
    const unavailable = () => { throw new Error(`图片素材库暂时不可用：${String(cause.message || cause).slice(0, 400)}`); };
    imageCollection = Object.fromEntries(['start', 'startArticle', 'collectArticle', 'getArticle', 'get', 'cancel', 'retry', 'save', 'list', 'getAsset', 'getCandidate'].map(name => [name, unavailable]));
    imageCollection.dispose = () => {};
  }
  caseService.archiveArticle = (payload, options) => imageCollection.collectArticle(payload, options);
  caseService.getArchivedArticle = payload => imageCollection.getArticle(payload);
  caseService.getArchivedAsset = id => imageCollection.getAsset(id);
  registerCaseArticleIpc({ ipcMain, protocol, service: caseService, images: imageCollection, backend, appDir: APP_DIR });
  projectResearch = new ProjectResearchService({ backend, hub: agentHub, cases: caseService,
    imageResearch: typeof imageCollection.assertScope === 'function' ? new ResearchImageService({ collection: imageCollection }) : null,
    projectContext: projectId => projectHub.context(projectId) });
  projectResearch.on('changed', () => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('workbench:project-research-changed'); });
  caseService.on('changed',()=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('workbench:case-changed');});
  agentHub.on('changed',()=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('workbench:agent-changed');});
  const localOnly = () => {if(teamClient)throw new Error('请在本机独立项目或项目主机配置 Agent；远端团队客户端不能独立改写主机任务。');};
  const projectLocalOnly = () => {if(teamClient)throw new Error('当前连接了远端项目。本版项目整理与技能共建请在项目主机操作；不会在客户端写入随后被同步覆盖的记录。');};
  const currentProjectOnly = payload => {if(payload?.projectId&&payload.projectId!==backend.projectId())throw new Error('项目已切换，请核对当前项目后重试。');};
  const modelSettingsCaller = event => {
    const frame = event?.senderFrame, trusted = require('node:url').pathToFileURL(path.join(APP_DIR, 'index.html')).href;
    if (!frame || frame.parent || frame.url !== trusted) throw new Error('请在 Hub 主界面管理模型和设计画布。');
  };
  let loomicOpening = Promise.resolve();
  ipcMain.handle('workbench:ai-design-open', event => {
    modelSettingsCaller(event); localOnly();
    const projectId = backend.projectId(), project = backend.store.projects.find(item => item.id === projectId);
    const pending = loomicOpening.catch(() => {}).then(async () => {
      currentProjectOnly({ projectId });
      const result = await loomicService.start({ projectId, projectName: project?.name || '当前项目' });
      currentProjectOnly({ projectId });
      return { url: result.url, projectId, mode: result.mode };
    });
    loomicOpening = pending; return pending;
  });
  ipcMain.handle('workbench:media-model-settings', event => { modelSettingsCaller(event); return mediaModels.snapshot(); });
  ipcMain.handle('workbench:media-model-save', (event, payload) => { modelSettingsCaller(event); return mediaModels.save(payload); });
  ipcMain.handle('workbench:media-model-remove', (event, payload) => { modelSettingsCaller(event); return mediaModels.remove(payload); });
  const projectSwitchAllowed = () => {if(teamClient||teamServer?.status().running)throw new Error('请先在聊天的团队同步设置中断开同步，再切换或新建项目。');};
  ipcMain.handle('workbench:team-directory',()=>({...teamDirectory.snapshot(),syncMode:teamClient?'client':teamServer?.status().running?'host':'local'}));
  ipcMain.handle('workbench:team-set-role',(_event,payload)=>{projectLocalOnly();currentProjectOnly(payload);return teamDirectory.setRole(payload);});
  ipcMain.handle('workbench:team-create-project',(_event,payload)=>{projectSwitchAllowed();return teamDirectory.createProject(payload);});
  ipcMain.handle('workbench:team-switch-project',(_event,payload)=>{projectSwitchAllowed();return teamDirectory.switchProject(payload);});
  ipcMain.handle('workbench:hub-chat-snapshot',(_event,payload)=>{currentProjectOnly(payload);return {...hubChat.snapshot({...payload,projectId:backend.projectId()}),syncMode:teamClient?'client':'local'};});
  ipcMain.handle('workbench:hub-chat-send',async(_event,payload)=>{
    currentProjectOnly(payload);
    if(teamClient){
      const snapshot=hubChat.snapshot({...payload,projectId:backend.projectId()});
      if(snapshot.channelId===snapshot.assistantChannelId||/(?:^|[\s，。！？：:（(【\[])@(?:Design\s?Hub|AIDesignHub)(?=$|[\s，。！？：:）)】\]、])/i.test(payload.text||''))throw new Error('团队客户端请由项目主机处理内置 AI；普通群聊仍可同步。');
      const userMessage=await teamClient.sendMessage({projectId:backend.projectId(),channelId:payload.channelId,body:payload.text,senderId:backend.store.settings.currentMemberId});await syncFromRemote();
      return {projectId:userMessage.projectId,channelId:userMessage.channelId,userMessage,status:'sent'};
    }
    return hubChat.send(payload);
  });
  ipcMain.handle('workbench:project-snapshot',()=>({...projectHub.snapshot(backend.projectId()),syncMode:teamClient?'client':'local'}));
  ipcMain.handle('workbench:project-model-status',()=>({...modelService.status(),scope:deviceSettings.scope,isolated:deviceSettings.isolated,migration:deviceSettings.migration}));
  ipcMain.handle('workbench:project-model-save',async (_event,payload)=>{const saved=modelService.save(payload);hubChat.changed(backend.projectId());
    // Live-reload the shared catalog. Upstream keys remain in the host; Harness
    // uses the same authenticated loopback connection across configuration edits.
    try{dshRuntime?.setLlmToken(dshModelProxy?.token);await dshRuntime?.writeLlmPatch?.();}catch(error){console.warn('[desktop/dsh] model list update failed:',error.code||error.name);}
    for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('workbench:model-changed');return saved;});
  ipcMain.handle('workbench:project-prepare',(_event,payload)=>{projectLocalOnly();if(payload?.projectId&&payload.projectId!==backend.projectId())throw new Error('项目已切换，请核对当前项目后重新保存；原文仍保留在输入框。');return projectHub.prepare({...payload,projectId:backend.projectId()});});
  ipcMain.handle('workbench:project-confirm',(_event,payload)=>{projectLocalOnly();return projectHub.confirm(payload);});
  ipcMain.handle('workbench:project-dismiss',(_event,id)=>{projectLocalOnly();return projectHub.dismiss(id);});
  ipcMain.handle('workbench:skill-snapshot',()=>skillCenter.snapshot(backend.projectId()));
  ipcMain.handle('workbench:skill-save',(_event,payload)=>{projectLocalOnly();return skillCenter.save({...payload,projectId:backend.projectId()});});
  ipcMain.handle('workbench:skill-publish',(_event,id)=>{projectLocalOnly();return skillCenter.publish(id);});
  ipcMain.handle('workbench:skill-rate',(_event,payload)=>{projectLocalOnly();return skillCenter.rate({...payload,projectId:backend.projectId()});});
  ipcMain.handle('workbench:resource-snapshot',()=>{const snap=skillCenter.snapshot(backend.projectId());const rl=resourceLibrary.snapshot();return {...snap,...rl};});
  ipcMain.handle('workbench:resource-save-mcp',async(_event,payload)=>{
    if(teamClient&&payload?.scope==='team'){const result=await teamClient.saveTeamMcpServer(payload);await syncFromRemote();return result;}
    projectLocalOnly();return resourceLibrary.saveMcpServer(payload);
  });
  ipcMain.handle('workbench:resource-remove-mcp',async(_event,id,scope)=>{
    if(teamClient&&scope==='team'){const result=await teamClient.removeTeamMcpServer(id);await syncFromRemote();return result;}
    projectLocalOnly();return resourceLibrary.removeMcpServer(id,scope);
  });
  ipcMain.handle('workbench:resource-save-instruction',async(_event,payload)=>{
    if(teamClient&&payload?.scope==='team'){const result=await teamClient.saveTeamInstruction(payload);await syncFromRemote();return result;}
    projectLocalOnly();return resourceLibrary.saveInstruction(payload);
  });
  ipcMain.handle('workbench:resource-remove-instruction',async(_event,id,scope)=>{
    if(teamClient&&scope==='team'){const result=await teamClient.removeTeamInstruction(id);await syncFromRemote();return result;}
    projectLocalOnly();return resourceLibrary.removeInstruction(id,scope);
  });
  ipcMain.handle('workbench:resource-save-rtk',(_event,payload)=>{projectLocalOnly();return resourceLibrary.saveRtk(payload);});
  ipcMain.handle('workbench:resource-remove-rtk',()=>{projectLocalOnly();return resourceLibrary.removeRtk();});
  ipcMain.handle('workbench:agent-config-list',()=>agentConfigWriter.listAgents());
  ipcMain.handle('workbench:agent-config-sync',(_event,agentId)=>{projectLocalOnly();return agentConfigWriter.syncAgent(agentId,resourceLibrary.state);});
  ipcMain.handle('workbench:agent-config-write-mcp',(_event,agentId,servers)=>{projectLocalOnly();return agentConfigWriter.writeMcpServers(agentId,servers);});
  ipcMain.handle('workbench:agent-config-write-instructions',(_event,agentId,instructions)=>{projectLocalOnly();return agentConfigWriter.writeInstructions(agentId,instructions);});
  const startAgentGateway=async()=>{
    localOnly();
    if(agentGateway&&gatewayStatus?.running)return gatewayStatus;
    // Windows 可能把之前保存的端口划进保留区间（Hyper-V/WinNAT），此时绑定会报 EACCES。
    // 这种情况改用系统分配的端口，避免每次链接调研都在网关启动处失败。
    const launch=async port=>{const gateway=new AgentGateway({hub:agentHub,port});const status={running:true,...await gateway.start()};return {gateway,status};};
    let attempt;
    try{attempt=await launch(backend.store.settings.agentPort||0);}
    catch(error){if(!['EACCES','EADDRINUSE'].includes(error?.code))throw error;attempt=await launch(0);}
    agentGateway=attempt.gateway;gatewayStatus=attempt.status;
    agentHub.setGateway({url:gatewayStatus.url,command:process.execPath,mcpScript:path.join(APP_DIR,'scripts','hub-mcp.cjs'),cliScript:path.join(APP_DIR,'scripts','hub-cli.cjs')});
    backend.mutate(store=>{store.settings.agentPort=gatewayStatus.port;return true;});return gatewayStatus;
  };
  const setGatewayEnabled=async enabled=>{
    localOnly();
    if(enabled){const status=await startAgentGateway();backend.mutate(store=>{store.settings.agentGatewayEnabled=true;return true;});return status;}
    if(agentGateway){if(agentHub.controllers.size)throw new Error('请先完成或取消正在执行的任务，再关闭接口。');await agentGateway.stop();agentGateway=null;gatewayStatus={running:false,url:''};agentHub.setGateway(null);}
    backend.mutate(store=>{store.settings.agentGatewayEnabled=false;return true;});return gatewayStatus;
  };
  ipcMain.handle('workbench:case-collect',async(_event,payload)=>{localOnly();if(payload?.connectionId&&!payload.query)await startAgentGateway();return caseService.collect(payload);});
  ipcMain.handle('workbench:case-research-local',async(_event,payload)=>{localOnly();const status=modelService.status();if(!status?.configured)throw new Error('尚未配置内置助手模型，无法使用本机调研。请先在模型设置中填写服务商、接口、模型 ID 与 API Key。');const result=await modelService.researchCase({query:payload?.query});const item=caseService.localCase({projectId:payload?.projectId,query:payload?.query,result,scope:payload?.scope});caseService.emit('changed',item.id);return item;});
  ipcMain.handle('workbench:case-retry',async(_event,id,options)=>{localOnly();if(caseService.find(id)?.research?.mode!=='name')await startAgentGateway();return caseService.retry(id,options);});
  ipcMain.handle('workbench:case-review',(_event,id,decision)=>{localOnly();return caseService.review(id,decision);});
  ipcMain.handle('workbench:case-preview',(_event,id,options)=>caseService.preview(String(id||''),{refresh:options?.refresh===true,moreImages:options?.moreImages===true}));
  registerImageCollectionIpc({ ipcMain, service: imageCollection, backend, dialog, shell, nativeImage, appDir: APP_DIR, localOnly });
  registerProjectResearchIpc({ ipcMain, service: projectResearch, backend, imageCollection, dialog, nativeImage, appDir: APP_DIR, localOnly, beforeStart: startAgentGateway });
  adhWorkbench = new AdhWorkbenchService({ backend, hub: agentHub, projectHub, cases: caseService, research: projectResearch, images: imageCollection, shell, nativeImage, beforeExternalDispatch: startAgentGateway, agentPairing, assertLocalAgentSettings: localOnly, clipboard, gatewayStatus: () => gatewayStatus, setGatewayEnabled,
    skillSecrets: safeStorage.isEncryptionAvailable?.() ? { protectSecret: value => safeStorage.encryptString(value).toString('base64'), unprotectSecret: value => safeStorage.decryptString(Buffer.from(value, 'base64')) } : undefined });
  await adhWorkbench.start();
  const deliverWorkbenchIntent = () => {
    const contents = dshView?.view?.webContents;
    if (!contents || contents.isDestroyed() || !dshWorkbenchIntent) return;
    const intent = dshWorkbenchIntent; dshWorkbenchIntent = null;
    void contents.executeJavaScript(`window.__adhWorkbenchPendingIntent=${JSON.stringify(intent)};window.dispatchEvent(new CustomEvent('adh-workbench-request',{detail:window.__adhWorkbenchPendingIntent}));`).catch(() => { dshWorkbenchIntent = intent; });
  };
  ipcMain.handle('workbench:adh-workbench-open', (event, payload) => {
    localOnly(); currentProjectOnly(payload);
    const frame = event.senderFrame, trusted = require('node:url').pathToFileURL(path.join(APP_DIR, 'index.html')).href;
    if (!frame || frame.parent || frame.url !== trusted) throw new Error('此页面不能向 AI Hub 传递项目资料。');
    if(payload?.panel!==undefined&&!['collaboration','skills'].includes(payload.panel))throw new Error('AI Hub 页面入口无效。');
    if(payload?.panel==='skills') dshWorkbenchIntent={panel:'skills'};
    else if(payload?.panel==='collaboration'){
      if(payload.runId&&!agentHub.state.runs.some(run=>run.id===payload.runId&&run.projectId===backend.projectId()))throw new Error('运行记录不属于当前项目。');
      if(payload.connectionId&&!agentHub.state.connections.some(item=>item.id===payload.connectionId))throw new Error('执行器配置不存在。');
      dshWorkbenchIntent={projectId:backend.projectId(),panel:'collaboration',tab:payload.tab==='tasks'?'tasks':'settings',...(payload.runId?{runId:payload.runId}:{}),...(payload.connectionId?{connectionId:payload.connectionId}:{}),autoPair:payload.autoPair===true};
    }else dshWorkbenchIntent = { projectId: backend.projectId(), action: payload?.action === 'presentation' ? 'presentation' : 'research', caseIds: adhWorkbench.selectCases(payload?.caseIds || [], backend.projectId()), prompt: String(payload?.prompt || '').slice(0, 4000) };
    deliverWorkbenchIntent(); return { prepared: true };
  });
  ipcMain.handle('workbench:open-external-url',async(_event,input)=>{if(typeof input!=='string'||input.length>4096)throw new Error('链接无效。');let url;try{url=new URL(input);}catch{throw new Error('链接无效。');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('仅允许打开无内嵌凭据的网页链接。');if(process.env.BYCJ_WORKBENCH_SMOKE!=='1')await shell.openExternal(url.href);else smokeExternalUrls.push(url.href);return {opened:true,url:url.href,simulated:process.env.BYCJ_WORKBENCH_SMOKE==='1'};});
  ipcMain.handle('workbench:agent-snapshot',()=>({...agentHub.snapshot(),gateway:gatewayStatus,deviceSetup:{progress:agentPairing.progress,restoration:pairingRestoration}}));
  ipcMain.handle('workbench:agent-client-config',(_event,payload)=>{localOnly();if(payload?.token!==undefined&&!agentHub.authorize(payload.token))throw new Error('本次项目授权已失效，请创建新的授权。');return buildClientConfig({transport:payload?.transport,gateway:gatewayStatus,command:process.execPath,mcpScript:path.join(APP_DIR,'scripts','hub-mcp.cjs'),token:payload?.token});});
  ipcMain.handle('workbench:agent-save-connection',(_event,config)=>{localOnly();return agentHub.saveConnection(config);});
  ipcMain.handle('workbench:agent-discover-runtimes',()=>{localOnly();return agentHub.discoverRuntimes();});
  ipcMain.handle('workbench:agent-pair-runtime',(_event,payload)=>{localOnly();return agentPairing.pair(payload);});
  ipcMain.handle('workbench:agent-auto-pair',(_event,payload)=>{localOnly();return agentPairing.autoPair(payload);});
  ipcMain.handle('workbench:agent-probe-connection',(_event,id)=>{localOnly();return agentHub.probeConnection(id);});
  ipcMain.handle('workbench:agent-test-connection',(_event,id)=>{localOnly();return agentHub.testConnection(id);});
  ipcMain.handle('workbench:agent-create-job',(_event,payload)=>{localOnly();return agentHub.createJob(payload);});
  ipcMain.handle('workbench:agent-send-chat',async(_event,payload)=>{localOnly();if(payload?.allowProjectTools===true)await startAgentGateway();return agentHub.sendChat(payload);});
  ipcMain.handle('workbench:agent-start-job',async(_event,id)=>{localOnly();await startAgentGateway();return agentHub.startJob(id);});
  ipcMain.handle('workbench:agent-cancel-run',(_event,id)=>{localOnly();return agentHub.cancelRun(id);});
  ipcMain.handle('workbench:agent-review-run',(_event,id,approved)=>{localOnly();return agentHub.reviewRun(id,approved);});
  ipcMain.handle('workbench:agent-create-grant',(_event,payload)=>{localOnly();return agentHub.createGrant(payload);});
  ipcMain.handle('workbench:agent-revoke-grant',(_event,id)=>agentHub.revokeGrant(id));
  ipcMain.handle('workbench:agent-gateway-toggle',(_event,enabled)=>setGatewayEnabled(enabled));
  ipcMain.handle('workbench:agent-export-run',async(_event,id)=>{
    const packet=agentHub.exportRun(id);const result=await dialog.showSaveDialog({title:'导出 Agent 任务包',defaultPath:`AIDesignHub-${id}.json`,filters:[{name:'JSON',extensions:['json']}]});
    if(result.canceled||!result.filePath)return {canceled:true};fs.writeFileSync(result.filePath,JSON.stringify(packet,null,2),'utf8');return {path:result.filePath,canceled:false};
  });
  ipcMain.handle('workbench:agent-import-result',async(_event,id)=>{
    localOnly();const selected=await dialog.showOpenDialog({title:'导入 Agent 成果 JSON',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
    if(selected.canceled)return {canceled:true};if(fs.statSync(selected.filePaths[0]).size>600000)throw new Error('成果文件过大。');const result=JSON.parse(fs.readFileSync(selected.filePaths[0],'utf8'));if(result.runId!==id)throw new Error('成果 runId 与选定任务不匹配。');
    const run=agentHub.state.runs.find(run=>run.id===id);if(!run)throw new Error('运行不存在。');return agentHub.submitResult(id,result.content,result.requestId,agentHub.localPrincipal(run.projectId));
  });
  teamServer = LEGACY_TEAM_SYNC_ENABLED ? new TeamSyncServer(backend) : null;
  const persistedSync = backend.bootstrap().settings.teamSync;
  if (LEGACY_TEAM_SYNC_ENABLED && persistedSync?.mode === 'host') {
    try {
      await teamServer.start({
        host:persistedSync.lan?'0.0.0.0':'127.0.0.1',
        port:Number(persistedSync.port)||0,
        token:persistedSync.hostToken,
      });
    } catch (error) {
      backend.setTeamSyncConfig({ mode:'off', lastError:error.message });
    }
  } else if (LEGACY_TEAM_SYNC_ENABLED && persistedSync?.mode === 'client' && persistedSync.url && persistedSync.token) {
    teamClient = new TeamSyncClient({ url:persistedSync.url, token:persistedSync.token });
    try { await syncFromRemote(); } catch { teamClient = null; }
  }
  if (process.env.BYCJ_WORKBENCH_SMOKE === '1' && backend.bootstrap().knowledgeDocs.length === 0) {
    const fixture = path.join(APP_DIR, 'tests', 'fixtures', '项目规划条件.txt');
    if (fs.existsSync(fixture)) await backend.importKnowledge([fixture], backend.bootstrap().project.id, 'regulation');
  }

  ipcMain.handle('workbench:runtime-info', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    demoCompany: DEMO_COMPANY_ENABLED,
  }));

  ipcMain.handle('workbench:select-project-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择一个本地设计项目文件夹',
      properties: ['openDirectory'],
      buttonLabel: '绑定为项目文件夹',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const resolved = path.resolve(result.filePaths[0]);
    allowedProjectRoots.add(resolved);
    return scanProjectFolder(resolved);
  });

  ipcMain.handle('workbench:detect-installed-apps', () => detectInstalledApps());
  ipcMain.handle('workbench:bootstrap', async (_event, projectId) => {
    if (teamClient) { try { await syncFromRemote(); } catch {} }
    return backend.bootstrap(projectId);
  });
  ipcMain.handle('workbench:set-role', (_event, role) => backend.setRole(String(role || 'designer')));
  ipcMain.handle('workbench:set-current-member', (_event, memberId) => backend.setCurrentMember(String(memberId || '')));
  ipcMain.handle('workbench:add-task', async (_event, payload) => {
    if (teamClient) { const result=await teamClient.addTask(payload||{});await syncFromRemote();return result; }
    return backend.addTask(payload || {});
  });
  ipcMain.handle('workbench:update-task', async (_event, taskId, patch) => {
    if(teamClient){const result=await teamClient.updateTask(String(taskId),patch||{});await syncFromRemote();return result;}
    return backend.updateTask(String(taskId), patch || {});
  });
  ipcMain.handle('workbench:add-case', async (_event, payload) => {
    if(teamClient&&payload?.scope==='team'){const result=await teamClient.addCase(payload);await syncFromRemote();return result;}
    return backend.addCase(payload || {});
  });
  ipcMain.handle('workbench:remove-case', async (_event, caseId) => {
    const existing=backend.store.cases.find((item)=>item.id===String(caseId));
    if(teamClient&&existing?.scope==='team'){const result=await teamClient.removeCase(String(caseId));await syncFromRemote();return result;}
    return backend.removeCase(String(caseId));
  });
  ipcMain.handle('workbench:add-member', async (_event, payload) => {
    if (teamClient) { const result=await teamClient.addMember(payload||{});await syncFromRemote();return result; }
    return backend.addMember(payload || {});
  });
  ipcMain.handle('workbench:add-channel', async (_event, payload) => {
    if(teamClient){const result=await teamClient.addChannel(payload||{});await syncFromRemote();return result;}
    return backend.addChannel(payload||{});
  });
  ipcMain.handle('workbench:send-message', async (_event, payload) => {
    if (teamClient) {
      const next={...(payload||{})};
      if(Array.isArray(next.attachments)&&next.attachments.length){
        const files=next.attachments.map((file)=>({name:file.name,contentBase64:fs.readFileSync(file.storedPath).toString('base64')}));
        next.attachments=await teamClient.uploadAttachments({projectId:next.projectId,files});
      }
      const result=await teamClient.sendMessage(next);await syncFromRemote();return result;
    }
    return backend.sendMessage(payload || {});
  });
  ipcMain.handle('workbench:search-messages', (_event, projectId, query) => backend.searchMessages(projectId, query));
  ipcMain.handle('workbench:create-decision', async (_event, payload) => {
    if (teamClient) { const result=await teamClient.createDecision(payload||{});await syncFromRemote();return result; }
    return backend.createDecision(payload || {});
  });
  ipcMain.handle('workbench:update-decision', async (_event, decisionId, patch) => {
    if(teamClient){const result=await teamClient.updateDecision(String(decisionId),patch||{});await syncFromRemote();return result;}
    return backend.updateDecision(String(decisionId), patch || {});
  });
  ipcMain.handle('workbench:update-risk', async (_event, riskId, patch) => {
    if(teamClient){const result=await teamClient.updateRisk(String(riskId),patch||{});await syncFromRemote();return result;}
    return backend.updateRisk(String(riskId), patch || {});
  });
  ipcMain.handle('workbench:update-milestone', async (_event, milestoneId, patch) => {
    if(teamClient){const result=await teamClient.updateMilestone(String(milestoneId),patch||{});await syncFromRemote();return result;}
    return backend.updateMilestone(String(milestoneId), patch || {});
  });
  ipcMain.handle('workbench:search-knowledge', (_event, projectId, query) => knowledgeWorkbench.service.searchAll(projectId, query));
  ipcMain.handle('workbench:remove-knowledge', async (_event, documentId) => {
    const doc=backend.store.knowledgeDocs.find((item)=>item.id===String(documentId));
    if(teamClient&&doc?.scope==='team'){const result=await teamClient.removeTeamKnowledge(String(documentId));await syncFromRemote();return result;}
    if (!doc) throw new Error('知识资料不存在。');
    return knowledgeWorkbench.service.removeLegacyDocument(doc.projectId, String(documentId));
  });

  ipcMain.handle('workbench:select-chat-attachments', async (_event, projectId) => {
    const result = await dialog.showOpenDialog({ title:'选择聊天附件', properties:['openFile','multiSelections'], buttonLabel:'添加到消息' });
    if (result.canceled) return [];
    return backend.importChatAttachments(result.filePaths, projectId);
  });

  ipcMain.handle('workbench:select-knowledge-files', async (_event, projectId, sourceType, scope) => {
    const result = await dialog.showOpenDialog({
      title:'导入本地知识资料', properties:['openFile','multiSelections'], buttonLabel:'导入并建立索引',
      filters:[{ name:'知识资料', extensions:['pdf','doc','docx','pptx','xlsx','txt','md','csv','json','html','xml','log'] }],
    });
    if (result.canceled) return [];
    const wantTeam=scope==='team';
    // A team client cannot write host storage directly; upload the raw files so the
    // host parses/indexes them as team knowledge, then pull the merged snapshot back.
    if(teamClient&&wantTeam){
      const files=result.filePaths.slice(0,20).map((filePath)=>({name:path.basename(filePath),contentBase64:fs.readFileSync(filePath).toString('base64')}));
      const uploaded=await teamClient.uploadTeamKnowledge({projectId,sourceType:sourceType||'project',files});
      await syncFromRemote();return uploaded;
    }
    return backend.importKnowledge(result.filePaths, projectId, sourceType || 'project', wantTeam?'team':'local');
  });

  ipcMain.handle('workbench:export-backup', async () => {
    const project = backend.bootstrap().project;
    const result = await dialog.showSaveDialog({ title:'导出项目工作台备份', defaultPath:`${project.name}-工作台备份-${new Date().toISOString().slice(0,10)}.json`, filters:[{ name:'JSON备份', extensions:['json'] }] });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(backend.exportSnapshot(), null, 2), 'utf8');
    return { filePath:result.filePath };
  });

  ipcMain.handle('workbench:export-weekly-report', async () => {
    const data=backend.bootstrap();
    const result=await dialog.showSaveDialog({title:'导出项目周报',defaultPath:`${data.project.name}-项目周报-${new Date().toISOString().slice(0,10)}.md`,filters:[{name:'Markdown 文档',extensions:['md']}]});
    if(result.canceled||!result.filePath)return null;
    fs.writeFileSync(result.filePath,buildWeeklyReport(data),'utf8');
    return {filePath:result.filePath};
  });

  ipcMain.handle('workbench:generate-scope-report', () => {
    const data=backend.bootstrap();const reportsDir=path.join(backend.dataDir,'reports');fs.mkdirSync(reportsDir,{recursive:true});
    const filePath=path.join(reportsDir,`${data.project.name}-范围变更影响清单-${new Date().toISOString().slice(0,10)}.md`);
    fs.writeFileSync(filePath,buildScopeChangeReport(data),'utf8');shell.showItemInFolder(filePath);return {filePath};
  });

  ipcMain.handle('workbench:find-contract-source', () => {
    const docs=backend.bootstrap().knowledgeDocs;
    return docs.find((doc)=>doc.sourceType==='contract'||/合同|协议|委托书/.test(doc.name))||null;
  });

  ipcMain.handle('workbench:launch-installed-app', async (_event, appId) => {
    const item=detectInstalledApps().find((appInfo)=>appInfo.id===String(appId||''));
    if(!item)throw new Error('Unsupported application.');
    if(!item.installed||!item.path)throw new Error(`${item.name} was not detected on this computer.`);
    const error=await shell.openPath(item.path);if(error)throw new Error(error);
    return {launched:true,name:item.name};
  });

  ipcMain.handle('workbench:reveal-file', (_event, filePath) => {
    const resolved=path.resolve(String(filePath||''));
    const dataRoot=path.resolve(backend.dataDir);
    const allowed=[...allowedProjectRoots].some((root)=>resolved===root||resolved.startsWith(`${root}${path.sep}`)) || resolved.startsWith(`${dataRoot}${path.sep}`);
    if(!allowed) throw new Error('This file is outside approved project and workbench folders.');
    shell.showItemInFolder(resolved); return { revealed:true };
  });

  ipcMain.handle('workbench:team-sync-status', () => {
    if(!LEGACY_TEAM_SYNC_ENABLED)return disabledTeamSyncStatus();
    const config=backend.bootstrap().settings.teamSync||{mode:'off'};
    if(teamServer?.status().running)return {mode:'host',...teamServer.status()};
    return {mode:teamClient?'client':config.mode||'off',url:config.url||'',connected:Boolean(teamClient),lastError:config.lastError||null};
  });
  ipcMain.handle('workbench:start-team-server', async (_event, options) => {
    requireLegacyTeamSync();
    if(teamClient)teamClient=null;
    if(teamServer?.status().running)await teamServer.stop();
    const previous=backend.bootstrap().settings.teamSync||{};
    const status=await teamServer.start({host:options?.lan?'0.0.0.0':'127.0.0.1',port:Number(options?.port)||0,token:previous.hostToken});
    backend.setTeamSyncConfig({mode:'host',hostToken:status.token,port:status.port,lan:Boolean(options?.lan),url:'',token:''});
    return {mode:'host',...status};
  });
  ipcMain.handle('workbench:connect-team-server', async (_event, config) => {
    requireLegacyTeamSync();
    if(teamServer?.status().running)await teamServer.stop();
    const client=new TeamSyncClient({url:config?.url,token:config?.token});
    await client.health();
    teamClient=client;
    try { await syncFromRemote();backend.setTeamSyncConfig({mode:'client',url:config.url,token:config.token,lastError:null}); }
    catch(error){teamClient=null;backend.setTeamSyncConfig({mode:'off',lastError:error.message});throw error;}
    return {mode:'client',url:config.url,connected:true};
  });
  ipcMain.handle('workbench:disconnect-team-sync', async () => {
    if(!LEGACY_TEAM_SYNC_ENABLED)return disabledTeamSyncStatus();
    teamClient=null;if(teamServer)await teamServer.stop();backend.setTeamSyncConfig({mode:'off',url:'',token:'',lastError:null});return {mode:'off'};
  });
  ipcMain.handle('workbench:team-sync-now', async () => {
    requireLegacyTeamSync();
    if(teamClient)await syncFromRemote();return {status:teamClient?'client':teamServer?.status().running?'host':'off',data:backend.bootstrap()};
  });
  // Restore the local tool entry only when the user explicitly left it on.
  // Implicit starts (chat tools, job dispatch, case research) never persist this
  // choice, and a failed restore leaves the entry closed with the button usable.
  if(backend.store.settings.agentGatewayEnabled===true){
    try{await startAgentGateway();}
    catch{agentGateway=null;gatewayStatus={running:false,url:''};}
  }

  // DSH (DeepSeek Harness) embedded agent engine initialization.
  // The runtime manager downloads and spawns the DSH sidecar; the view manager
  // hosts the DSH web UI as a native child view of the main window.
  const dshPluginsDir = path.join(APP_DIR, 'backend', 'dsh-plugins');
  // Packaged builds ship the prebuilt DSH runtime and professional-mcp payload
  // under resources/ (see electron-builder extraResources), so the installed app
  // works offline; development falls back to the user cache download path.
  const bundledDshRuntime = app.isPackaged
    && fs.existsSync(path.join(process.resourcesPath, 'dsh-runtime', '0.2.1-rc.2', 'runtime-manifest.json'));
  const dshCacheRoot = bundledDshRuntime ? process.resourcesPath : path.join(app.getPath('userData'), 'cache');
  dshModelProxy = await startDshModelProxy({ modelService, fetchImpl: (...args) => net.fetch(...args) });
  dshRuntime = new DshRuntimeManager({
    userDataDir: app.getPath('userData'),
    cacheRoot: dshCacheRoot,
    professionalMcpCacheRoot: bundledDshRuntime ? process.resourcesPath : undefined,
    pluginsSourceDir: dshPluginsDir,
    getModelStatus: () => ({ ...modelService.status(), baseUrl: dshModelProxy.baseUrl }),
    getTheme: () => backend.store.settings.theme || 'light',
    getWorkbenchConnection: () => adhWorkbench?.connection,
    emit: (state) => {
      console.info(`[desktop/dsh] ${state.status}${state.message ? `: ${state.message}` : ''}`);
      broadcastDsh('workbench:dsh-state-changed', state);
      // The renderer may have requested the view before the host finished
      // booting; attach now that the auth URL exists.
      if (state.status === 'ready') {
        if (dshPendingAttach) {
          dshPendingAttach = false;
          if (dshView?.attach()) startDshHoverWatchdog();
        } else {
          dshView?.reloadResolvedUrl();
        }
      }
    },
    isQuitting: () => false,
  });
  const mainWindowRef = () => BrowserWindow.getAllWindows()[0] || null;
  dshView = new DshViewManager(mainWindowRef, () => dshRuntime?.getAuthUrl(), () => {
    // The native view only paints over the renderer after its document loads;
    // the shell keeps the boot overlay up until this fires to hide the flash.
    broadcastDsh('workbench:dsh-view-loaded');
    deliverWorkbenchIntent();
  });

  // DSH IPC handlers
  ipcMain.handle('workbench:dsh-get-state', () => dshRuntime?.getState() || { status: 'missing', version: '0.0.0' });
  ipcMain.handle('workbench:dsh-start', async () => {
    if (!dshRuntime) throw new Error('DSH runtime not initialized');
    // Pass the API key from the model service to the DSH runtime.
    const modelStatus = modelService?.status();
    if (modelStatus?.configured && modelStatus.hasApiKey) {
      try {
        dshRuntime.setLlmToken(dshModelProxy.token);
      } catch { /* API key retrieval failed; DSH will start without it */ }
    }
    await dshRuntime.start();
    return dshRuntime.getState();
  });
  ipcMain.handle('workbench:dsh-stop', () => {
    dshRuntime?.stop();
    return dshRuntime?.getState() || { status: 'stopped' };
  });
  ipcMain.handle('workbench:dsh-restart', async () => {
    if (!dshRuntime) throw new Error('DSH runtime not initialized');
    return await dshRuntime.restart();
  });
  ipcMain.handle('workbench:dsh-attach-view', () => {
    const status = dshRuntime?.getState().status;
    if (status === 'ready') {
      const attached = dshView?.attach() || false;
      if (attached) startDshHoverWatchdog();
      return attached;
    }
    dshPendingAttach = true;
    // Lazy start: boot the sidecar only once the agent view is actually opened.
    if (status === 'missing' || status === 'stopped' || status === 'error') {
      const modelStatus = modelService?.status();
      if (modelStatus?.configured && modelStatus.hasApiKey) {
        try { dshRuntime.setLlmToken(dshModelProxy.token); } catch { /* proxy unavailable */ }
      }
      void dshRuntime.start().catch(() => undefined);
    }
    return false;
  });
  ipcMain.handle('workbench:dsh-detach-view', () => {
    dshPendingAttach = false;
    stopDshHoverWatchdog();
    dshView?.detach();
    return true;
  });
  ipcMain.handle('workbench:dsh-set-view-bounds', (_event, bounds) => {
    dshView?.setBounds(bounds);
    return true;
  });
  ipcMain.handle('workbench:dsh-set-view-inset-left', (_event, px) => {
    dshView?.setLeftInset(px);
    return true;
  });
  ipcMain.handle('workbench:dsh-set-view-inset-right', (_event, px) => {
    dshView?.setRightInset(px);
    return true;
  });
  ipcMain.handle('workbench:dsh-set-view-inset-top', (_event, px) => {
    dshView?.setTopInset(px);
    return true;
  });
  ipcMain.handle('workbench:get-theme', () => backend.store.settings.theme || 'light');
  ipcMain.handle('workbench:set-theme', async (_event, theme) => {
    const name = ['light', 'dark', 'minimal'].includes(theme) ? theme : 'light';
    backend.mutate(store => { store.settings.theme = name; return true; });
    // DSH reads cordis.patch.yml only at host spawn (0.2.0-rc.2 has no live patch
    // reload), so a running sidecar keeps its previous ui-theme. applyTheme rewrites
    // the patch; respawn the host when the theme truly changed so the embedded agent
    // view reloads with the matching theme on next entry. Theme toggles only happen
    // outside agent mode (the sidebar switcher is collapsed there), so no live session
    // is being watched when this fires.
    try {
      const changed = dshRuntime?.applyTheme?.(name);
      if (changed && dshRuntime?.getState?.().status === 'ready') {
        await dshRuntime.restart();
        if (dshView?.isAttached) dshView.reloadResolvedUrl();
      }
    } catch {}
    const overlayWin = process.platform === 'win32' ? mainWindowRef() : null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setTitleBarOverlay(titlebarOverlayFor(name));
    return name;
  });
  ipcMain.handle('workbench:dsh-set-view-hidden', (_event, hidden) => {
    dshView?.setHidden(hidden);
    return true;
  });
  ipcMain.handle('workbench:dsh-set-llm-token', (_event, token) => {
    const changed = dshRuntime?.setLlmToken(token);
    // If the view is already attached and the runtime restarted, reload the URL.
    if (changed && dshView?.isAttached) {
      dshView.reloadResolvedUrl();
    }
    return { changed: !!changed };
  });

  createWindow();
}).catch(error=>{dialog.showErrorBox('AIDesignHub 启动失败',error.message);app.quit();});

app.on('before-quit',()=>{dshModelProxy?.stop();stopDshHoverWatchdog();void loomicService?.stop();void knowledgeWorkbench?.dispose();dshRuntime?.stop();adhWorkbench?.dispose();agentPairing?.dispose();hubChat?.dispose();projectHub?.dispose();projectResearch?.dispose();caseService?.dispose();imageCollection?.dispose();imageBrowserCapture?.dispose();agentHub?.dispose();agentGateway?.stop().catch(()=>{});releaseServiceLock?.();});
app.on('window-all-closed', () => app.quit());
