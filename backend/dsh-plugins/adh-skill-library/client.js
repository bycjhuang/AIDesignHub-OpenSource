window.__ModuleLoader__.load({
  id: '@aidesign/dsh-client-ui-skill-library',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const PANEL_ID = 'adh-skills';
    let pluginContext;
    const icon = () => h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 5.5C7 4 9.5 4.5 12 6c2.5-1.5 5-2 8-.5v14c-3-1.5-5.5-1-8 .5-2.5-1.5-5-2-8-.5zM12 6v14' }));
    const currentSession = () => {
      try { return Object.values(pluginContext.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy?.mainView || 0) > 0)?.id || ''; }
      catch { return ''; }
    };
    async function read(endpoint, sessionId, signal, name, origin) {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      if (name) params.set(endpoint === 'team-body' ? 'id' : 'name', name);
      if (origin) params.set('origin', origin);
      const response = await fetch(`/api/adh-skill-library/${endpoint}?${params}`, { credentials: 'same-origin', signal });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || '技能清单暂不可读取。');
      return payload;
    }
    const LAYERS = [
      { key: 'design', label: '设计', color: '#5065ef' },
      { key: 'modeling', label: '建模', color: '#863beb' },
      { key: 'office', label: '办公', color: '#6366f1' },
      { key: 'video', label: '视频', color: '#a855f7' },
      { key: 'writing', label: '写作', color: '#7c3aed' },
      { key: 'general', label: '通用', color: '#64748b' },
    ];
    const TIERS = [
      { key: 'builtin', label: '系统内置', color: '#94a3b8' },
      { key: 'user', label: '用户技能', color: '#0ea5e9' },
      { key: 'workspace', label: '工作区', color: '#14b8a6' },
      { key: 'plugin', label: '插件赠赋', color: '#f59e0b' },
      { key: 'other', label: '其他', color: '#94a3b8' },
    ];

    const cardIcon = (path, color) => h('svg', {
      viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: color,
      strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, ...path.map((d) => h('path', { key: d, d })));
    const ICON_PATHS = {
      video: ['M4 6h10v12H4z', 'M14 10l6-3v10l-6-3'],
      office: ['M6 3h9l4 4v14H6z', 'M9 12h7', 'M9 16h7'],
      modeling: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
      design: ['M4 5h16v14H4z', 'M4 15l5-5 4 4 3-3 4 4'],
      writing: ['M4 20l4-1 11-11-3-3L5 16z', 'M14 6l3 3'],
      general: ['M5 5h14v14H5z', 'M9 9h6', 'M9 13h6'],
    };
    const iconFor = (skill, color) => {
      const text = `${skill.id} ${skill.displayName}`.toLowerCase();
      const key = /video|cover|editing|film/.test(text) ? 'video'
        : /office|docx|xlsx|pptx|word|excel/.test(text) ? 'office'
        : /model|cad|dwg|dxf|3d/.test(text) ? 'modeling'
        : /design|image|photo|mockup/.test(text) ? 'design'
        : /writ|calligraphy|copy/.test(text) ? 'writing' : 'general';
      return cardIcon(ICON_PATHS[key], color);
    };

    const CSS = `
      .adh-sl { --sl-ink:#20243b; --sl-muted:#68708b; --sl-line:#e5e7f1; --sl-paper:#fff; --sl-floor:#f7f8fc; --sl-accent:#5167e9;
        height:100%;overflow:auto;box-sizing:border-box;padding:28px clamp(18px,4vw,48px) 40px;color:var(--sl-ink);background:var(--sl-floor);font-family:inherit; }
      [data-ds-dark-theme] .adh-sl { --sl-ink:#ececf8;--sl-muted:#a3abc5;--sl-line:#36394e;--sl-paper:#242738;--sl-floor:#1c1f2e;--sl-accent:#a5b0ff; }
      .adh-sl * { box-sizing:border-box; }
      .adh-sl button,.adh-sl input { font:inherit; }
      .adh-sl button { cursor:pointer; }
      .adh-sl button:focus-visible,.adh-sl input:focus-visible { outline:2px solid var(--sl-accent);outline-offset:3px; }
      .adh-sl-head { display:flex;align-items:flex-start;justify-content:space-between;gap:18px;max-width:1050px;margin:auto; }
      .adh-sl h1 { font-size:24px;line-height:1.25;letter-spacing:-.4px;margin:0;font-weight:720; }
      .adh-sl-intro { color:var(--sl-muted);font-size:13px;line-height:1.65;margin:8px 0 0; }
      .adh-sl-refresh,.adh-sl-close { color:var(--sl-accent);border:1px solid var(--sl-line);border-radius:8px;padding:7px 12px;background:var(--sl-paper); }
      .adh-sl-refresh:disabled { opacity:.55;cursor:wait; }
      .adh-sl-search { max-width:1050px;margin:22px auto 12px;display:flex;align-items:center;gap:12px; }
      .adh-sl-search input { width:min(520px,100%);height:40px;padding:0 13px;border:1px solid var(--sl-line);border-radius:8px;background:var(--sl-paper);color:var(--sl-ink);font-size:13px; }
      .adh-sl-count { white-space:nowrap;font-size:12px;color:var(--sl-muted); }
      .adh-sl-list { list-style:none;padding:0;max-width:1050px;margin:0 auto;border-top:1px solid var(--sl-line); }
      .adh-sl-list li { border-bottom:1px solid var(--sl-line); }
      .adh-sl-row { width:100%;display:grid;grid-template-columns:minmax(0,1fr) 110px 120px;align-items:center;gap:20px;text-align:left;border:0;padding:16px 12px;background:transparent;color:inherit;border-radius:6px; }
      .adh-sl-row:hover { background:color-mix(in srgb,var(--sl-accent) 6%,transparent); }
      .adh-sl-name { display:block;font-size:14px;font-weight:650;line-height:1.45; }
      .adh-sl-id { margin-left:9px;font-size:11px;font-weight:400;color:var(--sl-muted); }
      .adh-sl-desc { display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:5px;font-size:12px;line-height:1.6;color:var(--sl-muted);max-width:72ch; }
      .adh-sl-source { font-size:12px;color:var(--sl-muted); }
      .adh-sl-status { font-size:11px;line-height:1.6;color:var(--sl-accent); }
      .adh-sl-status.off { color:var(--sl-muted); }
      .adh-sl-state { max-width:1050px;margin:30px auto;color:var(--sl-muted);font-size:13px;line-height:1.7; }
      .adh-sl-state[role=alert] { color:#bf4d65; }
      .adh-sl-note { max-width:1050px;margin:18px auto 0;color:var(--sl-muted);font-size:11px;line-height:1.7; }
      .adh-sl-dialog { width:min(760px,calc(100vw - 40px));max-height:calc(100vh - 56px);border:1px solid var(--sl-line);border-radius:14px;padding:0;background:var(--sl-paper);color:var(--sl-ink);box-shadow:0 24px 90px #11152b38; }
      .adh-sl-dialog::backdrop { background:#11152b55; }
      .adh-sl-dialog-head { display:flex;align-items:flex-start;gap:18px;padding:20px 24px;border-bottom:1px solid var(--sl-line); }
      .adh-sl-dialog-head h2 { margin:0;font-size:18px;line-height:1.5; }
      .adh-sl-dialog-head p { margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--sl-muted); }
      .adh-sl-dialog-content { padding:20px 24px;overflow:auto;max-height:calc(100vh - 190px); }
      .adh-sl-dialog-content pre { white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:13px;line-height:1.8;margin:18px 0 0; }
      .adh-sl-meta { font-size:12px;line-height:1.8;color:var(--sl-muted); }
      @media(max-width:680px) { .adh-sl { padding:20px 16px 28px; }.adh-sl-row { grid-template-columns:minmax(0,1fr) 95px;gap:8px;padding:15px 4px; }.adh-sl-source { grid-column:1;grid-row:2; }.adh-sl-status { grid-column:2;grid-row:1 / 3; }.adh-sl-id { display:block;margin:3px 0 0; }.adh-sl-search { gap:8px; }.adh-sl-dialog-head,.adh-sl-dialog-content { padding:18px; } }
    `;
    const CARD_CSS = `
      .bycj-sl-page { position: relative; width: 100%; height: 100%; overflow-y: auto; background: #f8fafc;
        padding: 28px 32px 48px; box-sizing: border-box; }
      .bycj-sl-back { border: 0; background: transparent; color: #5065ef; font-size: 13px; cursor: pointer;
        padding: 4px 8px; border-radius: 8px; margin-bottom: 10px; }
      .bycj-sl-back:hover { background: #e9e7f8; color: #4939a7; }
      .bycj-sl-head h1 { margin: 0; font-size: 22px; font-weight: 800; color: #0f172a; }
      .bycj-sl-head p { margin: 6px 0 0; font-size: 12px; color: #64748b; }
      .bycj-sl-search { margin: 16px 0 8px; max-width: 520px; display: flex; align-items: center; gap: 8px;
        background: #fff; border: 1px solid rgba(76, 88, 140, 0.16); border-radius: 12px; padding: 8px 12px; }
      .bycj-sl-search input { border: 0; outline: none; width: 100%; font-size: 13px; color: #0f172a; background: transparent; }
      .bycj-sl-section { margin-top: 22px; }
      .bycj-sl-section-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: #334155; }
      .bycj-sl-section-title .dot { width: 8px; height: 8px; border-radius: 50%; }
      .bycj-sl-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
      .bycj-sl-card { position: relative; overflow: hidden; background: #fff; border: 1px solid rgba(76, 88, 140, 0.12);
        border-radius: 16px; padding: 16px 16px 14px 19px; cursor: pointer;
        box-shadow: 0 16px 40px rgba(76, 88, 140, 0.1); transition: transform .15s ease, box-shadow .15s ease; }
      .bycj-sl-card:hover { transform: translateY(-2px); box-shadow: 0 20px 48px rgba(76, 88, 140, 0.16); }
      .bycj-sl-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--layer-color); }
      .bycj-sl-card-icon { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--layer-color) 13%, #fff); }
      .bycj-sl-card-name { margin-top: 10px; font-size: 15px; font-weight: 650; color: #0f172a; }
      .bycj-sl-card-id { margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #94a3b8; }
      .bycj-sl-card-desc { margin-top: 8px; font-size: 12px; line-height: 1.55; color: #64748b;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .bycj-sl-card-foot { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
      .bycj-sl-badge { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(76, 88, 140, 0.18); color: #475569; background: #f8fafc; }
      .bycj-sl-badge.on { color: #4338ca; border-color: rgba(80, 101, 239, 0.35); background: #eef0ff; }
      .bycj-sl-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 92vw); background: #fff; z-index: 80;
        box-shadow: -24px 0 60px rgba(15, 23, 42, 0.18); display: flex; flex-direction: column; }
      .bycj-sl-drawer-head { padding: 18px 20px; border-bottom: 1px solid rgba(76, 88, 140, 0.12); display: flex; gap: 10px; align-items: flex-start; }
      .bycj-sl-drawer-body { padding: 18px 20px; overflow-y: auto; font-size: 13px; line-height: 1.7; color: #334155; }
      .bycj-sl-drawer-body pre { background: #f1f5f9; border-radius: 10px; padding: 10px 12px; overflow-x: auto; font-size: 12px; }
      .bycj-sl-drawer-body h1, .bycj-sl-drawer-body h2, .bycj-sl-drawer-body h3 { color: #0f172a; margin: 14px 0 6px; }
      .bycj-sl-empty { padding: 40px 0; text-align: center; color: #94a3b8; font-size: 13px; }
    
 .adh-sl .bycj-sl-card { text-align:left; color:inherit;font:inherit; }
 .adh-sl .bycj-sl-grid { list-style:none;padding:0; }
 .adh-sl .bycj-sl-head,.adh-sl .adh-sl-head,.adh-sl .adh-sl-search {max-width:none;}
 .adh-sl-dialog {position:fixed;inset:0 0 0 auto;margin:0;width:min(560px,92vw);height:100vh;max-height:100vh;border-radius:0;}
 .adh-sl-dialog-content {max-height:calc(100vh - 130px);}
 [data-ds-dark-theme] .adh-sl .bycj-sl-card {background:var(--sl-paper);}
 [data-ds-dark-theme] .adh-sl .bycj-sl-card-name {color:var(--sl-ink);}
 [data-ds-dark-theme] .adh-sl .bycj-sl-card-desc {color:var(--sl-muted);}
 @media(prefers-reduced-motion:reduce){.adh-sl .bycj-sl-card{transition:none;}}
 `;
    async function write(endpoint, payload = {}) {
      const response = await fetch(`/api/adh-skill-library/${endpoint}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '操作未完成，请重试。');
      return result;
    }
    const TEAM_CSS = `
      .adh-sl-tabs {display:flex;gap:24px;margin-top:22px;border-bottom:1px solid var(--sl-line);}
      .adh-sl-tab {display:flex;gap:8px;align-items:center;padding:11px 2px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--sl-muted);font-weight:600;}
      .adh-sl-tab[aria-selected=true] {color:var(--sl-accent);border-bottom-color:var(--sl-accent);}
      .adh-sl-tab span {font-size:11px;font-weight:400;border:1px solid var(--sl-line);border-radius:20px;padding:1px 7px;}
      .adh-sl .bycj-sl-card {cursor:default;height:100%;display:flex;flex-direction:column;box-shadow:0 4px 16px #4c588c0a;}
      .adh-sl .bycj-sl-card:hover {transform:none;box-shadow:0 4px 16px #4c588c14;}
      .adh-sl-open {display:block;text-align:left;flex:1;width:100%;padding:0;border:0;background:transparent;color:inherit;}
      .adh-sl-actions {display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid var(--sl-line);}
      .adh-sl-action {border:1px solid var(--sl-line);border-radius:7px;padding:6px 10px;font-size:12px;color:var(--sl-accent);background:var(--sl-paper);}
      .adh-sl-action.primary {border-color:var(--sl-accent);background:var(--sl-accent);color:#fff;}
      [data-ds-dark-theme] .adh-sl-action.primary {color:#1c1f2e;}
      .adh-sl-action:disabled {opacity:.55;cursor:wait;}
      .adh-sl-owner {margin:10px 0 0;color:var(--sl-muted);font-size:11px;line-height:1.65;}
      .adh-sl-feedback {margin:14px 0 0;font-size:12px;line-height:1.6;color:var(--sl-accent);}
      .adh-sl-feedback[role=alert] {color:#bf4d65;}
      .adh-sl-sharing {margin-top:18px;padding:14px 16px;border:1px solid var(--sl-line);border-radius:9px;background:var(--sl-paper);}
      .adh-sl-sharing summary {font-size:12px;font-weight:600;cursor:pointer;color:var(--sl-ink);}
      .adh-sl-sharing p {font-size:12px;line-height:1.7;color:var(--sl-muted);margin:10px 0;overflow-wrap:anywhere;}
      .adh-sl-sharing form {display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-top:12px;}
      .adh-sl-sharing label {display:grid;gap:6px;font-size:11px;color:var(--sl-muted);flex:1;min-width:180px;}
      .adh-sl-sharing input {min-width:0;width:100%;padding:8px 10px;border:1px solid var(--sl-line);border-radius:7px;background:var(--sl-floor);color:var(--sl-ink);font-size:12px;}
      .adh-sl-address {font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;user-select:text;}
      .adh-sl-network-actions {display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
    `;
    const statusLabel = (skill) => skill.modelInvocable && skill.userInvocable ? '模型 / 手动可用' : skill.modelInvocable ? '模型可用' : skill.userInvocable ? '手动可用' : '未启用';

    const ROLE_LABELS = { designer: '项目设计师', pm: '项目经理', director: '设计总监', reviewer: '校审负责人', finance: '经营 / 财务', leader: '公司负责人' };
    const roleLabel = (role) => ROLE_LABELS[role] || role || '';
    const authorLabel = (skill) => [skill.author?.name || '团队成员', roleLabel(skill.author?.role)].filter(Boolean).join(' · ');
    const sharedDate = (skill) => {
      const date = new Date(skill.updatedAt || skill.sharedAt);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN');
    };
    function Detail({ skill, sessionId, team, onClose }) {
      const dialog = useRef(null);
      const [state, setState] = useState({ loading: true });
      useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        const controller = new AbortController();
        read(team ? 'team-body' : 'body', team ? '' : sessionId, controller.signal, skill.id, team ? skill.origin : undefined)
          .then((payload) => setState({ skill: payload.skill }))
          .catch((error) => { if (!controller.signal.aborted) setState({ error: error.message }); });
        return () => { controller.abort(); element?.close(); };
      }, [skill.id, skill.origin, sessionId, team]);
      const full = state.skill || skill;
      return h('dialog', { ref: dialog, className: 'adh-sl-dialog', 'aria-labelledby': 'adh-sl-detail-title', onClose, onCancel: onClose,
        onClick: (event) => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } } },
        h('div', { className: 'adh-sl-dialog-head' },
          h('div', { style: { flex: 1, minWidth: 0 } }, h('h2', { id: 'adh-sl-detail-title' }, full.displayName), h('p', null, full.description)),
          h('button', { className: 'adh-sl-close', type: 'button', onClick: onClose, 'aria-label': '关闭技能说明' }, '关闭')),
        h('div', { className: 'adh-sl-dialog-content', 'aria-busy': state.loading || undefined },
          h('div', { className: 'adh-sl-meta' }, team ? `分享者：${authorLabel(full)}　${sharedDate(full)}` : `${full.sourceLabel} · ${statusLabel(full)}`,
            h('br'), `技能：${full.skillId || full.id}`,
            team ? h('p', null, '这是团队分享的技能说明快照，可供查阅，不会自动安装或执行。') : null),
          state.loading ? h('p', { role: 'status' }, '正在读取技能说明…') : state.error ? h('p', { role: 'alert' }, state.error) : h('pre', null, full.content)));
    }

    function SkillPage() {
      const [sessionId, setSessionId] = useState(currentSession);
      const [revision, refresh] = useState(0);
      const [query, setQuery] = useState('');
      const [selected, select] = useState(null);
      const [state, setState] = useState({ loading: true, skills: [], teamSkills: [], sharing: {} });
      const [tab, setTab] = useState('local');
      const [busy, setBusy] = useState('');
      const [feedback, setFeedback] = useState(null);
      const [hostUrl, setHostUrl] = useState('');
      const [hostToken, setHostToken] = useState('');
      useEffect(() => pluginContext.sessions.list.subscribe(() => setSessionId(currentSession())), []);
      useEffect(() => { select(null); }, [sessionId, tab]);
      useEffect(() => {
        const controller = new AbortController();
        setState(previous => ({ ...previous, loading: true, error: undefined }));
        read('list', sessionId, controller.signal)
          .then((payload) => setState({ skills: payload.skills || [], teamSkills: payload.teamSkills || [], sharing: payload.sharing || {}, context: payload.context }))
          .catch((error) => { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error.message })); });
        return () => controller.abort();
      }, [sessionId, revision]);
      useEffect(() => {
        if (tab !== 'team' || busy) return;
        const timer = setInterval(() => refresh(value => value + 1), 15000);
        return () => clearInterval(timer);
      }, [tab, busy]);
      async function act(endpoint, payload, message) {
        if (busy) return;
        setBusy(endpoint); setFeedback(null);
        try {
          await write(endpoint, payload);
          setFeedback({ message });
          if (endpoint === 'connect') setHostToken('');
          refresh(value => value + 1);
        } catch (error) { setFeedback({ error: true, message: error.message }); }
        finally { setBusy(''); }
      }
      const team = tab === 'team';
      const sharing = state.sharing || {};
      const server = sharing.server || {};
      const remote = sharing.remote || {};
      const sharingErrors = [...new Set([sharing.error, server.lastError, sharing.remoteError].filter(Boolean))];
      const source = team ? state.teamSkills : state.skills;
      const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return source.filter((skill) => `${skill.displayName} ${skill.id} ${skill.description} ${skill.whenToUse || ''} ${skill.sourceLabel || ''} ${skill.author?.name || ''}`.toLocaleLowerCase().includes(needle));
      }, [query, source]);
      const sections = LAYERS.map(layer => ({ ...layer, skills: filtered.filter(skill => (LAYERS.some(row => row.key === skill.layer) ? skill.layer : 'general') === layer.key) })).filter(section => section.skills.length);
      const actionButton = (label, endpoint, payload, message, primary = false) => h('button', {
        type: 'button', className: `adh-sl-action${primary ? ' primary' : ''}`, disabled: Boolean(busy), onClick: () => act(endpoint, payload, message),
      }, label);
      return h('section', { className: 'adh-sl', 'aria-label': '技能中心' }, h('style', null, CSS + CARD_CSS + TEAM_CSS),
        h('button', { type: 'button', className: 'bycj-sl-back', onClick: () => pluginContext.get('layout')?.selectPanel(null) }, '‹ 返回会话'),
        h('div', { className: 'adh-sl-head bycj-sl-head' }, h('div', null, h('h1', null, '技能中心'),
          h('p', { className: 'adh-sl-intro' }, team ? '把好用的技能分享给团队，连接共享主机即可查阅。' : '这台电脑可用的技能，按用途浏览，也可以分享给团队。')),
          h('button', { type: 'button', className: 'adh-sl-refresh', disabled: state.loading || Boolean(busy), onClick: () => refresh(value => value + 1) }, '刷新')),
        h('div', { className: 'adh-sl-tabs', role: 'tablist', 'aria-label': '技能范围' },
          ...[{ key: 'local', label: '本机技能', count: state.skills.length }, { key: 'team', label: '团队共享', count: state.teamSkills.length }].map(item =>
            h('button', { key: item.key, id: `adh-sl-tab-${item.key}`, type: 'button', role: 'tab', 'aria-selected': tab === item.key, 'aria-controls': 'adh-sl-skills-panel', className: 'adh-sl-tab', onClick: () => { setTab(item.key); setQuery(''); setFeedback(null); } }, item.label, h('span', null, item.count)))),
        team ? h('details', { className: 'adh-sl-sharing' }, h('summary', null, remote.connected ? `已连接共享主机 · ${remote.url}` : server.running ? '本机共享已开启 · 连接设置' : '局域网共享与连接设置'),
          h('p', null, `当前分享身份：${sharing.identity?.name || '当前设计师'}${sharing.identity?.role ? ` · ${roleLabel(sharing.identity.role)}` : ''}`),
          server.running ? h('div', null,
            h('p', null, '团队成员在同一局域网内，使用下面的主机地址和邀请码连接。'),
            ...(server.urls || []).map(url => h('p', { key: url, className: 'adh-sl-address' }, url)),
            h('p', null, '邀请码：', h('code', { className: 'adh-sl-address' }, server.token || '暂不可读取')),
            actionButton('关闭本机共享', 'server-stop', {}, '本机局域网共享已关闭。')) :
            h('div', null, h('p', null, '开启后，连接到这台电脑的成员可以查看已分享的技能。'), actionButton('开启本机共享', 'server-start', {}, '本机共享已开启。', true)),
          remote.connected ? h('div', { className: 'adh-sl-network-actions' }, actionButton('断开共享主机', 'disconnect', {}, '已断开共享主机。')) :
            h('form', { onSubmit: event => { event.preventDefault(); act('connect', { url: hostUrl.trim(), token: hostToken.trim() }, '已连接共享主机。'); } },
              h('label', null, '共享主机地址', h('input', { type: 'url', required: true, value: hostUrl, placeholder: 'http://192.168.1.100:端口', onChange: event => setHostUrl(event.target.value), autoComplete: 'off' })),
              h('label', null, '邀请码', h('input', { type: 'password', required: true, value: hostToken, onChange: event => setHostToken(event.target.value), autoComplete: 'off' })),
              h('button', { type: 'submit', className: 'adh-sl-action', disabled: Boolean(busy) }, '连接共享主机')),
          h('p', null, '共享的是技能说明快照；其他成员可查阅，不会自动安装或执行。')) :
          h('p', { className: 'adh-sl-note' }, state.context?.label || '本机已启用技能'),
        feedback ? h('p', { className: 'adh-sl-feedback', role: feedback.error ? 'alert' : 'status' }, feedback.message) : null,
        team ? sharingErrors.map(message => h('p', { key: message, className: 'adh-sl-feedback', role: 'alert' }, message)) : null,
        h('div', { className: 'adh-sl-search' }, h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: team ? '搜索技能或分享者…' : '搜索技能名或描述…', 'aria-label': '搜索技能' }),
          !state.loading && !state.error ? h('span', { className: 'adh-sl-count', role: 'status' }, `${filtered.length} / ${source.length} 项`) : null),
        h('div', { id: 'adh-sl-skills-panel', role: 'tabpanel', 'aria-labelledby': `adh-sl-tab-${tab}`, 'aria-busy': state.loading || undefined },
          state.error ? h('p', { className: 'adh-sl-state', role: 'alert' }, state.error) : !source.length && state.loading ? h('p', { className: 'adh-sl-state', role: 'status' }, '正在读取技能库…') : filtered.length ? sections.map(section => h('section', { key: section.key, className: 'bycj-sl-section', 'aria-label': section.label },
            h('div', { className: 'bycj-sl-section-title' }, h('span', { className: 'dot', style: { background: section.color } }), `${section.label} · ${section.skills.length}`),
            h('ul', { className: 'bycj-sl-grid' }, ...section.skills.map(skill => h('li', { key: `${skill.origin || 'local'}:${skill.id}` },
              h('article', { className: 'bycj-sl-card', style: { '--layer-color': section.color } },
                h('button', { type: 'button', className: 'adh-sl-open', onClick: () => select(skill), 'aria-label': `查看 ${skill.displayName} 的技能说明` },
                  h('div', { className: 'bycj-sl-card-icon' }, iconFor(skill, section.color)), h('div', { className: 'bycj-sl-card-name' }, skill.displayName),
                  h('div', { className: 'bycj-sl-card-id' }, skill.skillId || skill.id),
                  h('div', { className: 'bycj-sl-card-desc' }, skill.description || skill.whenToUse || '点击查看技能说明。'),
                  team ? h('p', { className: 'adh-sl-owner' }, `分享者：${authorLabel(skill)}`, h('br'), `${skill.origin === 'remote' ? '共享主机' : '这台电脑'} · ${sharedDate(skill)}`) :
                    h('div', { className: 'bycj-sl-card-foot' }, h('span', { className: `bycj-sl-badge${skill.modelInvocable ? ' on' : ''}` }, '模型'),
                      h('span', { className: `bycj-sl-badge${skill.userInvocable ? ' on' : ''}` }, '用户'), h('span', { className: 'bycj-sl-badge' }, skill.sourceLabel),
                      skill.sharedId ? h('span', { className: 'bycj-sl-badge on' }, '已分享') : null)),
                !team ? h('div', { className: 'adh-sl-actions' }, actionButton(skill.sharedId ? '更新分享' : '分享到团队', 'share', { name: skill.id, sessionId }, skill.sharedId ? '团队中的技能说明已更新。' : '已分享到团队共享。')) :
                  skill.canUnshare ? h('div', { className: 'adh-sl-actions' }, actionButton('取消分享', 'unshare', { id: skill.id }, '已取消分享。')) : null)))))) :
            h('p', { className: 'adh-sl-state' }, query ? '没有匹配的技能，试试软件名称、任务用途或分享者。' : team ? '还没有团队共享技能。从“本机技能”选择一个技能，点击“分享到团队”；或连接团队的共享主机。' : '当前没有已启用的技能。选择对话后刷新，或检查技能目录设置。')),
        !state.loading && !state.error && !team ? h('p', { className: 'adh-sl-note' }, '专业软件技能需要相应软件及插件连接就绪。') : null,
        selected ? h(Detail, { key: `${sessionId}:${selected.origin || 'local'}:${selected.id}`, skill: selected, sessionId, team, onClose: () => select(null) }) : null);
    }
    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        pluginContext = ctx;
        function NavIcon() {
          const [active, setActive] = useState(() => ctx.get('layout')?.panelInfo.getSnapshot().activePanelId === PANEL_ID);
          useEffect(() => {
            const face = ctx.get('layout')?.panelInfo;
            return face?.subscribe(() => setActive(face.getSnapshot().activePanelId === PANEL_ID));
          }, []);
          return h('span', { style: { color: active ? '#6678ed' : undefined } }, icon());
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '技能中心' }, NavIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, SkillPage));
      },
    };
  },
});
