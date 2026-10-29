(function () {
  'use strict';
  const identity = window.AIDesignHubRelease;
  const button = document.getElementById('releaseAbout');
  if (!identity || !button) return;
  button.textContent = `v${identity.version} · 关于`;
  button.addEventListener('click', () => {
    const dialog = document.createElement('dialog'); dialog.className = 'release-about-dialog';
    const heading = document.createElement('h2'); heading.textContent = 'AIDesignHub · 版本与来源';
    const description = document.createElement('p'); description.textContent = '官方发布包可通过发布清单、数字签名与 SHA256 验证。版本标识不包含使用者身份，也不进行联网追踪。';
    const details = document.createElement('dl');
    for (const [label, value] of [['版本', identity.version], ['发布标识', identity.releaseId], ['来源标记', identity.sourceCanary], ['发布公钥 SHA256', identity.publicKeyFingerprint], ['官方仓库', identity.officialRepository]]) {
      const title = document.createElement('dt'); title.textContent = label;
      const content = document.createElement('dd'); content.textContent = value; details.append(title, content);
    }
    const note = document.createElement('p'); note.textContent = '导出成果标注 Powered by AIDesignHub 与版本来源。验证安装包请使用可信仓库中的公钥。当前安装包没有 Windows Authenticode 证书签名。';
    const legal = window.AIDesignHubOpenSource;
    const licensing = document.createElement('section'); licensing.className = 'release-license-section';
    if (legal) {
      const title = document.createElement('h3'); title.textContent = '开源许可与对应源码';
      const terms = document.createElement('p'); terms.textContent = `${legal.copyright}。维护者：${legal.maintainer}。AIDesignHub 自有整合代码采用 ${legal.license}，允许按协议使用、修改与再分发；软件按现状提供，无任何担保。第三方组件保留其原有版权及许可。`;
      const source = document.createElement('a'); source.href = legal.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = `获取 v${legal.version} 对应源码（${legal.sourceArchive}）`;
      const privacy = document.createElement('p'); privacy.textContent = '源码公开不包含使用者的项目资料、知识库、模型密钥或账号配置。用户成果不会仅因使用本软件而自动采用 AGPL。';
      licensing.append(title, terms, source, privacy);
      const notices = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = '第三方组件与原作者声明';
      const text = document.createElement('pre'); text.textContent = legal.notice;
      notices.append(summary, text); licensing.append(notices);
      for (const item of legal.texts) {
        const entry = document.createElement('details');
        const label = document.createElement('summary'); label.textContent = item.title;
        const body = document.createElement('pre'); body.textContent = item.text;
        entry.append(label, body); licensing.append(entry);
      }
    }
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => dialog.close());
    dialog.append(heading, description, details, note, licensing, close); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  });
})();
