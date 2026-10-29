(() => {
  'use strict';
  const api = window.bycjWorkbench;
  const entry = document.getElementById('hubGlobalModelSettings');
  const status = document.getElementById('hubGlobalModelStatus');
  if (!entry || !api?.projectModelStatus) return;
  const providerNames = { deepseek: 'DeepSeek', bailian: '阿里云百炼', 'openai-compatible': '兼容接口' };
  const dismissedKey = 'aidesignhub.setup-intro.dismissed.v1';
  let model = null, request = 0, intro = null, requestedCategory = 'text';
  const modelDialogs = new WeakMap();
  const categories = [{ id: 'text', label: '对话与推理' }, { id: 'image', label: '图片生成' }, { id: 'video', label: '视频生成' }];
  const categoryOf = value => value === 'image' || value === 'video' ? value : 'text';
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function dismissIntro() {
    try { localStorage.setItem(dismissedKey, '1'); } catch {}
    intro?.remove(); intro = null;
  }
  function openModelSettings(category = 'text') {
    requestedCategory = categoryOf(typeof category === 'string' ? category : 'text');
    const existing = document.querySelector('dialog[data-hub-model-settings]');
    if (existing?.open && modelDialogs.has(existing)) { modelDialogs.get(existing).select(requestedCategory); requestedCategory = 'text'; return; }
    document.getElementById('projectModelSettings')?.click();
  }
  function mediaError(error) {
    const text = String(error?.message || error || '');
    if (/time.?out|timed out/i.test(text)) return '保存连接超时，请稍后重试。';
    if (/network|failed to fetch|fetch failed|ECONN/i.test(text)) return '暂时无法连接本机配置服务，请稍后重试。';
    return /[\u3400-\u9fff]/.test(text) ? text : '媒体模型设置暂未完成，请检查输入后重试。';
  }
  function enhanceModelDialog(dialog) {
    if (!dialog?.querySelector?.('#hubModelForm') || modelDialogs.has(dialog)) return;
    dialog.dataset.hubModelSettings = ''; dialog.classList.add('setup-model-dialog');
    const title = dialog.querySelector('h2'), closeButton = dialog.querySelector('[data-dialog-close]'), footer = closeButton?.closest('.hub-actions');
    if (title) title.textContent = '模型设置';
    const textPanel = node('section', 'setup-model-panel'); textPanel.id = 'hubModelTextPanel'; textPanel.setAttribute('role', 'tabpanel');
    for (const child of [...dialog.children]) if (child !== title && child !== footer) textPanel.append(child);
    const textForm = textPanel.querySelector('#hubModelForm'), textSave = textForm.querySelector('[type=submit]');
    const scopeNote = textPanel.querySelector(':scope > .hub-muted');
    if (scopeNote) { scopeNote.className = 'setup-media-boundary'; scopeNote.textContent = '所有项目共用本机配置。密钥在本机加密保存，不写入项目资料。'; }
    textForm.classList.add('setup-media-form', 'setup-text-form');
    const fields = ['provider', 'model', 'baseUrl', 'apiKey'].map(name => textForm.elements[name].closest('label'));
    const localOption = textForm.elements.allowLocalHttp.closest('label'), pairingOption = textForm.elements.autoPair.closest('label');
    const providerNote = localOption.nextElementSibling, pairingNote = pairingOption.nextElementSibling;
    for (const label of [localOption, pairingOption]) {
      const input = label.querySelector('input'), copy = node('span', 'setup-text-option-copy');
      for (const child of [...label.childNodes]) if (child !== input) copy.append(child);
      label.append(copy); label.classList.add('setup-text-option');
    }
    const pairingCopy = pairingOption.querySelector('.setup-text-option-copy');
    pairingCopy.firstChild.textContent = '保存后自动检测并配对本机 Agent';
    pairingCopy.append(node('small', '', '会调用本页模型，可能消耗少量 API 额度。'));
    const advanced = node('details', 'setup-text-advanced'); advanced.append(node('summary', '', '高级连接与自动配置说明'), localOption, providerNote, pairingNote);
    const options = node('div', 'setup-text-options'); options.append(pairingOption, advanced);
    const saveNotice = textForm.querySelector('#modelSaveNotice'); saveNotice.classList.add('setup-text-save-notice');
    textForm.prepend(node('h3', '', '当前模型配置'));
    textForm.append(...fields, options, saveNotice);
    if (footer) { footer.classList.add('setup-model-footer'); textSave.classList.add('setup-text-submit'); textSave.setAttribute('form', textForm.id); footer.append(textSave); }
    const tabs = node('div', 'setup-model-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '模型类别');
    const panels = { text: textPanel }, buttons = {}, editors = {}, lists = {}, confirmations = {};
    let snapshot = null, reading = null, busy = false, closed = false, active = 'text';
    const notice = node('p', 'setup-media-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
    function announce(message, failed = false) { if (closed) return; notice.textContent = message; notice.hidden = active === 'text' || !message; notice.classList.toggle('is-error', failed); }
    function accept(value) {
      const next = value?.result || value;
      if (!Array.isArray(next?.profiles) || !next.defaults || typeof next.defaults !== 'object') throw new Error('媒体配置返回格式无效，请重新打开模型设置。');
      snapshot = next; renderLists(); return next;
    }
    function setBusy(value) {
      busy = value;
      for (const button of Object.values(buttons)) button.disabled = value;
      for (const panel of Object.values(panels)) for (const field of panel?.querySelectorAll('button,input,select,textarea') || []) field.disabled = value || field.dataset.keepDisabled === 'true';
      textSave.disabled = value;
    }
    async function loadMedia() {
      if (snapshot || reading) return reading;
      if (typeof api.mediaModelSettings !== 'function') { announce('当前版本尚未加载媒体模型设置，请更新并重启工作台。', true); return null; }
      reading = (async () => { try { return accept(await api.mediaModelSettings()); } catch (error) { announce(mediaError(error), true); return null; } finally { reading = null; } })();
      return reading;
    }
    async function mutate(method, payload, category, complete) {
      if (busy) return;
      if (typeof api[method] !== 'function') { announce('媒体模型配置服务尚未就绪，请重启工作台。', true); return; }
      setBusy(true); announce('正在保存本机配置…');
      try {
        const result = await api[method](payload);
        window.dispatchEvent(new CustomEvent('adh-model-settings-changed', { detail: { category } }));
        if (closed) return;
        accept(result); complete?.(); announce(method === 'mediaModelRemove' ? '配置已删除。' : '配置已保存。');
      } catch (error) { announce(mediaError(error), true); }
      finally { if (!closed) setBusy(false); }
    }
    function defaultPayload(profile) { return { id: profile.id, category: profile.category, name: profile.name, apiType: profile.apiType || 'openai-compatible', baseUrl: profile.baseUrl, model: profile.model, isDefault: true }; }
    function renderLists() {
      if (closed || !snapshot) return;
      for (const category of ['image', 'video']) {
        const profiles = snapshot.profiles.filter(profile => profile.category === category), target = lists[category];
        target.replaceChildren();
        if (!profiles.length) { target.append(node('p', 'setup-media-empty', category === 'image' ? '还没有图片模型配置。' : '还没有视频模型配置。')); continue; }
        for (const profile of profiles) {
          const row = node('article', 'setup-media-profile'); row.dataset.mediaProfileId = profile.id;
          const choice = node('input'); choice.type = 'radio'; choice.name = `mediaDefault-${category}`; choice.checked = snapshot.defaults[category] === profile.id; choice.setAttribute('aria-label', `将 ${profile.name} 设为默认${category === 'image' ? '图片' : '视频'}模型`); choice.disabled = busy || profile.enabled === false;
          if (profile.enabled === false) choice.dataset.keepDisabled = 'true';
          choice.onchange = () => mutate('mediaModelSave', defaultPayload(profile), category);
          const copy = node('div', 'setup-media-profile-copy'); copy.append(node('strong', '', profile.name), node('small', '', `${profile.model || '未填模型 ID'} · ${profile.enabled === false ? '已停用' : profile.hasApiKey ? '密钥已保存' : '尚未保存密钥'}${snapshot.defaults[category] === profile.id ? ' · 默认' : ''}`));
          const actions = node('div', 'setup-media-profile-actions'), edit = node('button', 'text-button', '编辑'), remove = node('button', 'text-button', '删除'); edit.type = remove.type = 'button'; edit.disabled = remove.disabled = busy;
          edit.onclick = () => renderEditor(category, profile);
          remove.onclick = () => {
            const confirmation = confirmations[category]; confirmation.replaceChildren(node('p', '', `删除“${profile.name}”的本机配置？`)); confirmation.hidden = false;
            const cancel = node('button', 'secondary-button', '保留'), confirm = node('button', 'secondary-button', '删除配置'); cancel.type = confirm.type = 'button';
            cancel.onclick = () => { confirmation.hidden = true; confirmation.replaceChildren(); };
            confirm.onclick = () => mutate('mediaModelRemove', { id: profile.id }, category, () => { confirmation.hidden = true; confirmation.replaceChildren(); if (editors[category].dataset.profileId === profile.id) editors[category].replaceChildren(); });
            confirmation.append(cancel, confirm);
          };
          actions.append(edit, remove); row.append(choice, copy, actions); target.append(row);
        }
      }
    }
    function renderEditor(category, profile = null) {
      const host = editors[category]; host.replaceChildren(); host.dataset.profileId = profile?.id || '';
      const form = node('form', 'setup-media-form'); form.id = `mediaModelForm-${category}`;
      const heading = node('h3', '', `${profile ? '编辑' : '新增'}${category === 'image' ? '图片' : '视频'}模型`); form.append(heading);
      const field = (label, name, value = '', options = {}) => {
        const wrapper = node('label', '', label), input = node('input'); input.name = name; input.value = value; input.autocomplete = 'off';
        for (const [key, next] of Object.entries(options)) input[key] = next;
        wrapper.append(input); form.append(wrapper); return input;
      };
      field('配置名称', 'name', profile?.name || '', { required: true, maxLength: 100, placeholder: category === 'video' ? '例如 常用视频模型' : '例如 常用图片模型' });
      const type = node('label', '', '接口类型'), select = node('select'); select.name = 'apiType';
      for (const [value, label] of [['openai-compatible', 'OpenAI 兼容接口'], ['apimart', 'APIMart 任务接口']]) { const option = node('option', '', label); option.value = value; select.append(option); }
      select.value = profile?.apiType === 'apimart' ? 'apimart' : 'openai-compatible'; type.append(select); form.append(type);
      field('Base URL', 'baseUrl', profile?.baseUrl || '', { required: true, type: 'url', spellcheck: false, placeholder: 'https://供应商地址/v1' });
      field('模型 ID', 'model', profile?.model || '', { required: true, spellcheck: false, placeholder: '填写供应商提供的模型 ID' });
      const key = field(profile?.hasApiKey ? 'API Key · 留空保留已保存密钥' : 'API Key · 可稍后补充', 'apiKey', '', { type: 'password', spellcheck: false });
      const defaultLabel = node('label', 'setup-media-default'), check = node('input'); check.type = 'checkbox'; check.name = 'isDefault'; check.checked = snapshot?.defaults[category] === profile?.id || !snapshot?.defaults[category];
      if (profile?.id && snapshot.defaults[category] === profile.id) { check.disabled = true; check.dataset.keepDisabled = 'true'; }
      defaultLabel.append(check, document.createTextNode('保存后设为此类别默认')); form.append(defaultLabel);
      const actions = node('div', 'setup-media-form-actions'), save = node('button', 'primary-button', '保存配置'), cancel = node('button', 'secondary-button', '取消'); save.type = 'submit'; cancel.type = 'button'; cancel.onclick = () => { key.value = ''; host.replaceChildren(); }; actions.append(save, cancel); form.append(actions);
      form.onsubmit = async event => {
        event.preventDefault(); const fields = form.elements;
        const payload = { ...(profile?.id ? { id: profile.id } : {}), category, name: fields.name.value.trim(), apiType: fields.apiType.value === 'apimart' ? 'apimart' : 'openai-compatible', baseUrl: fields.baseUrl.value.trim(), model: fields.model.value.trim(), isDefault: fields.isDefault.checked };
        if (key.value.trim()) payload.apiKey = key.value.trim();
        await mutate('mediaModelSave', payload, category, () => { key.value = ''; host.replaceChildren(); });
      };
      host.append(form); form.elements.name.focus();
    }
    const APIMART_BASE = 'https://api.apimart.ai/v1';
    const APIMART_MODELS = {
      text: [['gpt-6.1-sol', 'GPT 6.1 Sol · 对话与工具调用'], ['gpt-6-astra', 'GPT 6 Astra · 对话与工具调用']],
      image: [['gpt-image-2', 'GPT-Image-2 · 综合旗舰'], ['gpt-image-1.5', 'GPT-Image-1.5 · 高性价比'], ['gemini-nano-banana-2.1', 'Nano Banana 2 · 快速写实'], ['gemini-3-pro-image-preview', 'Nano Banana Pro · 旗舰质感'], ['gemini-2.5-flash-image-preview', 'Nano Banana · 轻量快速'], ['flux-kontext-max', 'FLUX Kontext Max · 参考图编辑'], ['seedream-5-0-pro', 'Seedream 5.0 Pro · 美感海报'], ['qwen-image-3.0-pro', 'Qwen-Image 3.0 Pro · 中文文字'], ['midjourney', 'Midjourney · 设计感']],
      video: [['kling-v3-omni', 'Kling v3 Omni · 通用视频'], ['veo3.1-fast', 'Veo 3.1 Fast · 快速视频']],
    };
    const apimartName = (category, model) => `APIMart · ${APIMART_MODELS[category].find(item => item[0] === model)[1].split(' · ')[0]}`;
    async function openApimartBatch() {
      if (busy) return;
      await loadMedia();
      if (!snapshot || closed) return;
      if (dialog.querySelector('[data-apimart-batch]')) return;
      const textStatus = await api.projectModelStatus();
      if (closed || dialog.querySelector('[data-apimart-batch]')) return;
      const panel = node('section', 'setup-apimart-panel'); panel.dataset.apimartBatch = '';
      const back = node('button', 'text-button', '返回模型列表'); back.type = 'button';
      panel.append(back, node('h3', '', 'APIMart 接入与密钥'), node('p', 'setup-apimart-hint', '一把密钥供文本、图片和视频模型共用。已保存的模型显示状态；只勾选需要新增的模型。'));
      const keyWrap = node('label', 'setup-apimart-field', 'API Key'), keyInput = node('input'); keyInput.type = 'password'; keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.placeholder = '更换密钥时在这里填写；留空沿用已保存密钥'; keyWrap.append(keyInput); panel.append(keyWrap);
      const advanced = node('details', 'setup-apimart-advanced'); advanced.append(node('summary', '', '接口地址'));
      const urlWrap = node('label', 'setup-apimart-field', 'Base URL'), urlInput = node('input'); urlInput.type = 'url'; urlInput.value = APIMART_BASE; urlInput.spellcheck = false; urlWrap.append(urlInput); advanced.append(urlWrap); panel.append(advanced);
      const filters = node('div', 'setup-apimart-filters'), modelList = node('div', 'setup-apimart-models'); panel.append(filters, modelList);
      const message = node('p', 'setup-apimart-hint', '已保存只表示本机有配置，不代表已完成生图验证。'); message.setAttribute('role', 'status'); panel.append(message);
      const actions = node('div', 'setup-media-form-actions'), save = node('button', 'primary-button'), cancel = node('button', 'secondary-button', '返回模型列表');
      save.type = cancel.type = 'button'; actions.append(save, cancel); panel.append(actions);
      let selectedCategory = active;
      const chosen = new Set(), filterButtons = {};
      const baseUrl = () => (urlInput.value.trim() || APIMART_BASE).replace(/\/+$/, '');
      const ownedProfiles = () => [...(textStatus.profiles || []).map(p => ({ ...p, category: 'text' })), ...snapshot.profiles].filter(p => p.baseUrl === baseUrl() && p.hasApiKey);
      const updateAction = () => { const updating = !!keyInput.value.trim() && ownedProfiles().length > 0; save.disabled = busy || !updating && chosen.size === 0; save.textContent = updating ? `更新密钥${chosen.size ? `并添加 ${chosen.size} 个模型` : `（${ownedProfiles().length} 个已保存配置）`}` : `添加所选模型${chosen.size ? `（${chosen.size}）` : ''}`; };
      function renderModels() {
        modelList.replaceChildren();
        for (const [category, button] of Object.entries(filterButtons)) button.setAttribute('aria-pressed', String(category === selectedCategory));
        for (const [model, label] of APIMART_MODELS[selectedCategory]) {
          const owned = ownedProfiles().some(p => p.category === selectedCategory && p.model === model), value = `${selectedCategory}:${model}`;
          const row = node(owned ? 'div' : 'label', 'setup-apimart-row');
          if (owned) row.append(node('span', 'setup-apimart-saved-mark', '✓'));
          else { const box = node('input'); box.type = 'checkbox'; box.value = value; box.checked = chosen.has(value); box.onchange = () => { box.checked ? chosen.add(value) : chosen.delete(value); updateAction(); }; row.append(box); }
          const copy = node('span', 'setup-apimart-model-copy'); copy.append(node('strong', '', label.split(' · ')[0]), node('small', '', model));
          row.append(copy, node('span', owned ? 'setup-apimart-state is-saved' : 'setup-apimart-state', owned ? '已保存' : '可添加')); modelList.append(row);
        }
        updateAction();
      }
      for (const category of categories) { const button = node('button', '', category.label); button.type = 'button'; button.onclick = () => { selectedCategory = category.id; renderModels(); }; filterButtons[category.id] = button; filters.append(button); }
      const leave = () => { if (busy) return; keyInput.value = ''; panel.remove(); tabs.hidden = false; if (title) title.textContent = '模型设置'; selectCategory(active); };
      back.onclick = cancel.onclick = leave;
      keyInput.oninput = updateAction; urlInput.onchange = () => { chosen.clear(); renderModels(); };
      dialog.addEventListener('close', () => { keyInput.value = ''; }, { once: true });
      save.onclick = async () => {
        const key = keyInput.value.trim(), selected = [...chosen];
        if (!key && !selected.length) return;
        setBusy(true); for (const field of panel.querySelectorAll('button,input')) field.disabled = true; message.textContent = '正在加密保存本机配置…';
        try {
          let result = null;
          if (key) for (const profile of ownedProfiles()) {
            if (profile.category === 'text') await api.projectModelSave({ provider: 'openai-compatible', baseUrl: baseUrl(), model: profile.model, name: profile.name || profile.model, apiKey: key, isDefault: textStatus.defaultProfileId === profile.id });
            else result = await api.mediaModelSave({ id: profile.id, category: profile.category, apiKey: key });
          }
          for (const value of selected) {
            const [category, model] = value.split(':');
            if (category === 'text') await api.projectModelSave({ provider: 'openai-compatible', name: apimartName(category, model), baseUrl: baseUrl(), model, isDefault: false, keyFromKeyring: !key, ...(key ? { apiKey: key } : {}) });
            else result = await api.mediaModelSave({ category, name: apimartName(category, model), apiType: 'apimart', baseUrl: baseUrl(), model, ...(key ? { apiKey: key } : {}) });
          }
          if (closed) return;
          if (result) accept(result); await renderTextSwitcher(); window.dispatchEvent(new CustomEvent('adh-model-settings-changed', { detail: { category: active } }));
          setBusy(false); leave(); announce(key ? 'APIMart 密钥已更新，已保存配置共用新密钥。' : `已添加 ${selected.length} 个模型。`);
        } catch (error) { message.textContent = mediaError(error); message.classList.add('is-error'); }
        finally { if (!closed) { setBusy(false); for (const field of panel.querySelectorAll('button,input')) field.disabled = false; updateAction(); } }
      };
      for (const item of Object.values(panels)) item.hidden = true; tabs.hidden = true; notice.hidden = true; textSave.hidden = true;
      if (title) title.textContent = 'APIMart 接入'; if (footer) dialog.insertBefore(panel, footer); else dialog.append(panel); renderModels(); dialog.scrollTop = 0;
    }
    const TEXT_PRESETS = [
      { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { provider: 'openai-compatible', baseUrl: 'https://api.apimart.ai/v1', model: 'gpt-6.1-sol', label: 'GPT 6.1 Sol · APIMart' },
      { provider: 'openai-compatible', baseUrl: 'https://api.apimart.ai/v1', model: 'gpt-6-astra', label: 'GPT 6 Astra · APIMart' },
    ];
    async function renderTextSwitcher(note, failed) {
      const form = dialog.querySelector('#hubModelForm');
      if (!form?.parentElement) return;
      let host = form.parentElement.querySelector('[data-text-switcher]');
      if (!host) { host = node('div', 'setup-text-switcher'); host.dataset.textSwitcher = ''; form.parentElement.insertBefore(host, form); }
      let st = {};
      try { st = await api.projectModelStatus(); } catch { return; }
      if (closed) return;
      const top = node('div', 'setup-media-heading'), summary = node('div');
      summary.append(node('h3', '', '对话与推理'), node('p', '', '单选设置默认模型；AI Hub 与 AI Design 对话中仍可分别切换。'));
      const actions = node('div', 'setup-media-actions'), batch = node('button', 'secondary-button', 'APIMart 接入 / 更新密钥');
      batch.type = 'button'; batch.onclick = openApimartBatch; actions.append(batch); top.append(summary, actions);
      const list = node('div', 'setup-media-list setup-text-list');
      host.replaceChildren(top); if (scopeNote) host.append(scopeNote); host.append(list);
      const choices = [...(st.profiles || []).map(p => ({ ...p, label: p.name || p.model })), ...TEXT_PRESETS.filter(p => !(st.profiles || []).some(saved => saved.provider === p.provider && saved.baseUrl === p.baseUrl && saved.model === p.model))];
      for (const preset of choices) {
        const active = st.provider === preset.provider && st.baseUrl === preset.baseUrl && st.model === preset.model;
        const stored = (st.keyring || []).includes(`${preset.provider}|${preset.baseUrl}`);
        const row = node('label', 'setup-media-profile setup-text-profile'), choice = node('input');
        choice.type = 'radio'; choice.name = 'textDefault'; choice.value = preset.id || `${preset.provider}|${preset.baseUrl}|${preset.model}`;
        choice.checked = active; choice.disabled = busy || !stored; choice.setAttribute('aria-label', `将 ${preset.label} 设为默认对话模型`);
        if (!stored) { choice.dataset.keepDisabled = 'true'; row.title = '先在下方表单保存该服务的密钥，或通过 APIMart 接入。'; }
        const copy = node('span', 'setup-media-profile-copy');
        copy.append(node('strong', '', preset.label), node('small', '', `${preset.model} · ${preset.hasApiKey || stored ? '密钥已保存' : '尚未接入'}`));
        row.append(choice, copy, node('span', `setup-text-state${active ? ' is-default' : ''}`, active ? '默认' : stored ? '可切换' : '待配置'));
        choice.onchange = async () => {
          if (busy) return;
          setBusy(true);
          try {
            await api.projectModelSave({ provider: preset.provider, baseUrl: preset.baseUrl, model: preset.model, name: preset.label, allowLocalHttp: preset.allowLocalHttp === true, keyFromKeyring: true });
            window.dispatchEvent(new Event('hub-model-changed'));
            window.dispatchEvent(new CustomEvent('adh-model-settings-changed', { detail: { category: 'text' } }));
            await renderTextSwitcher(`已切换到 ${preset.label}，立即生效。`);
          } catch (error) {
            await renderTextSwitcher(mediaError(error), true).catch(() => {});
          } finally { if (!closed) setBusy(false); }
        };
        list.append(row);
      }
      for (const field of ['provider', 'baseUrl', 'model']) if (st[field] && form.elements[field]) form.elements[field].value = st[field];
      if (note) { const status = node('p', `setup-text-switcher-note${failed ? ' is-error' : ''}`, note); status.setAttribute('role', 'status'); host.append(status); }
    }
    for (const category of categories) {
      const button = node('button', '', category.label); button.type = 'button'; button.id = `hubModelTab-${category.id}`; button.dataset.modelCategory = category.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', category.id === 'text' ? textPanel.id : `hubModelPanel-${category.id}`); button.onclick = () => selectCategory(category.id); buttons[category.id] = button; tabs.append(button);
      if (category.id === 'text') continue;
      const panel = node('section', 'setup-model-panel setup-media-panel'); panel.id = `hubModelPanel-${category.id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      const top = node('div', 'setup-media-heading'), summary = node('div'); summary.append(node('h3', '', category.label), node('p', '', category.id === 'video' ? '选择默认视频模型；保存配置不会发起生成。' : '单选设置默认模型；画布中仍可切换其他已保存模型。'));
      const add = node('button', 'secondary-button', '+ 新增配置'); add.type = 'button'; add.onclick = async () => { await loadMedia(); if (snapshot && !closed) renderEditor(category.id); };
      const batch = node('button', 'secondary-button', 'APIMart 接入 / 更新密钥'); batch.type = 'button'; batch.onclick = openApimartBatch;
      const headActions = node('div', 'setup-media-actions'); headActions.append(batch, add); top.append(summary, headActions);
      lists[category.id] = node('div', 'setup-media-list'); editors[category.id] = node('div', 'setup-media-editor'); confirmations[category.id] = node('div', 'setup-media-delete'); confirmations[category.id].hidden = true;
      panel.append(top, node('p', 'setup-media-boundary', '保存配置不会发起生成。'), lists[category.id], confirmations[category.id], editors[category.id]); panels[category.id] = panel;
    }
    textPanel.setAttribute('aria-labelledby', buttons.text.id);
    function selectCategory(value) {
      if (busy) return;
      const batch = dialog.querySelector('[data-apimart-batch]');
      if (batch) { for (const key of batch.querySelectorAll('input[type=password]')) key.value = ''; batch.remove(); tabs.hidden = false; if (title) title.textContent = '模型设置'; }
      active = categoryOf(value);
      textSave.hidden = active !== 'text';
      if (active === 'text') renderTextSwitcher();
      for (const category of categories) { panels[category.id].hidden = category.id !== active; buttons[category.id].setAttribute('aria-selected', String(category.id === active)); buttons[category.id].tabIndex = category.id === active ? 0 : -1; }
      notice.hidden = active === 'text' || !notice.textContent;
      if (active !== 'text') void loadMedia();
    }
    tabs.onkeydown = event => {
      const index = categories.findIndex(item => item.id === active), next = event.key === 'ArrowRight' ? (index + 1) % categories.length : event.key === 'ArrowLeft' ? (index + categories.length - 1) % categories.length : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); selectCategory(categories[next].id); buttons[categories[next].id].focus(); }
    };
    if (footer) dialog.insertBefore(tabs, footer); else dialog.append(tabs);
    for (const panel of Object.values(panels)) { if (footer) dialog.insertBefore(panel, footer); else dialog.append(panel); }
    if (footer) dialog.insertBefore(notice, footer); else dialog.append(notice);
    dialog.addEventListener('close', () => { closed = true; for (const input of dialog.querySelectorAll('input[type="password"]')) input.value = ''; });
    modelDialogs.set(dialog, { select: selectCategory }); selectCategory(requestedCategory); requestedCategory = 'text';
  }
  async function refresh() {
    const current = ++request;
    try {
      const next = await api.projectModelStatus();
      if (current !== request) return;
      model = next;
      if (model.configured) { intro?.remove(); intro = null; }
      entry.dataset.configured = String(Boolean(model.configured));
      status.textContent = model.configured ? `${providerNames[model.provider] || '模型服务'} · ${model.model || '已配置'}` : '未配置 · 点击设置内置助手';
      entry.title = model.configured ? `本机模型已配置：${model.model || model.provider}。配置存在不代表账号额度已验证。` : '先配置 DesignHub 内置模型；外部执行器单独连接。';
    } catch {
      if (current !== request) return;
      status.textContent = '配置暂不可读取 · 点击重试';
      entry.dataset.configured = 'unknown';
    }
    return model;
  }
  function showIntro() {
    if (model?.configured || intro?.isConnected) return;
    try { if (localStorage.getItem(dismissedKey) === '1') return; } catch {}
    intro = node('aside', 'setup-welcome-panel');
    intro.id = 'hubSetupWelcome';
    intro.setAttribute('aria-labelledby', 'hubSetupWelcomeTitle');
    const close = node('button', 'icon-button setup-welcome-close', '×');
    close.type = 'button'; close.setAttribute('aria-label', '暂时跳过设置'); close.onclick = dismissIntro;
    const title = node('h2', '', '先为 DesignHub 配置一个模型'); title.id = 'hubSetupWelcomeTitle';
    intro.append(close, node('span', 'setup-welcome-mark', '✦'), title,
      node('p', '', '内置助手负责整理沟通、保留项目上下文和准备审批事项。执行设计任务的外部 Agent 可以随后单独连接。'));
    const steps = node('div', 'setup-welcome-steps');
    for (const [number, heading, description] of [
      ['01', '设置内置助手', '使用自己的 DeepSeek、阿里云百炼 API 或 OpenAI 兼容服务。'],
      ['02', '连接外部 Agent', '内置助手规划配对，外部 Agent 只检查协议，不派发项目任务。'],
    ]) {
      const step = node('div'); const body = node('div');
      body.append(node('strong', '', heading), node('small', '', description));
      step.append(node('b', '', number), body); steps.append(step);
    }
    const controls = node('div', 'setup-welcome-actions');
    const skip = node('button', 'secondary-button', '稍后设置，先体验工作台'); skip.type = 'button'; skip.onclick = dismissIntro;
    const configure = node('button', 'primary-button', '配置 DesignHub 模型'); configure.type = 'button'; configure.onclick = openModelSettings;
    controls.append(skip, configure);
    intro.append(steps, node('p', 'setup-welcome-note', 'API 密钥只保存在这台电脑。跳过后，左下角的「DesignHub 模型设置」始终可用。'), controls);
    document.querySelector('.view-stack')?.prepend(intro);
  }
  entry.addEventListener('click', openModelSettings);
  window.addEventListener('adh-model-settings-ready', event => enhanceModelDialog(event.detail?.dialog));
  window.addEventListener('adh-open-model-settings', event => openModelSettings(event.detail?.category));
  // Refresh status after the existing model-settings dialog saves or closes.
  document.addEventListener('close', event => {
    if (event.target?.querySelector?.('#hubModelForm')) refresh();
  }, true);
  window.addEventListener('hub-model-changed', refresh);
  window.addEventListener('project-hub-changed', refresh);
  window.addEventListener('hub-project-changed', refresh);
  const unsubscribe = api.projectModelOnChanged?.(refresh);
  window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); });
  window.aidesignSetupUI = { refresh, openModelSettings };
  refresh().then(() => { if (model && !model.configured) showIntro(); });
})();
