/* ============================================================
 * app.js — 应用主控：导航 / 视图切换 / 事件分发 / 设置
 * ============================================================ */
window.MA = (() => {
  const VIEWS = {
    dashboard: { title: '工作台', desc: 'XM AI Studio · 思考-创作-剪辑-输出 全流程智能化', render: renderDashboard },
    chat: { title: 'AI 创意助手', desc: '脚本策划 · 分镜拆解 · 提示词优化 · 文案生成', render: (el) => window.ChatView.render(el) },
    image: { title: 'AI 生图', desc: '火山方舟 Seedream 模型 · 文生图 / 图生图', render: (el) => window.ImageView.render(el) },
    video: { title: 'AI 生视频', desc: '火山方舟 Seedance 模型 · 文生视频 / 图生视频', render: (el) => window.VideoView.render(el) },
    storyboard: { title: '故事板 Storyboard', desc: '可视化剧本 · 场景编排 · 批量生成 · 一键成片', render: (el) => window.StoryboardView.render(el) },
    pipeline: { title: '流水线生产', desc: '小龙虾自动化 · 一句话创意到成片全自动', render: (el) => window.PipelineView.render(el) },
    editor: { title: '智能剪辑', desc: '时间线剪辑 · 转场 · 文字卡 · BGM · 导出成片', render: (el) => window.EditorView.render(el) },
    frammer: { title: '包框合成', desc: '改尺寸包框 · 垫底图 · 尾板视频 · 横竖屏互转', render: (el) => window.FrammerView.render(el) },
    resize: { title: '多尺寸适配', desc: '一个视频批量输出多尺寸包框素材：16:9 / 9:16 / 1:1 / 4:5 / 2:3', render: (el) => window.ResizeView.render(el) },
    remake: { title: '仿拍复刻', desc: '上传竞品爆款素材参考图，AI 复用其爆款逻辑，替换成你的主体与玩法，批量生产复刻图与复刻视频', render: (el) => window.RemakeView.render(el) },
    playable: { title: 'AI 试玩（优化中）', desc: '上传视频/图片 → AI 分析帧 → 微动/平面试玩 → UI 拖拽交互 → 按钮跳转物料 → 导出试玩广告 HTML', render: (el) => window.PlayableView.render(el) },
    localize: { title: '文字本地化（优化中）', desc: '视频/图片素材 → AI 识别并消除原文/Logo → 翻译替换 → 按原位置重绘 → 输出同属性媒体', render: (el) => window.LocalizeView.render(el) },
    voice: { title: 'AI 配音', desc: '多语种 AI 配音（ElevenLabs 32+ 语种，支持克隆音色 Voice ID）· 广告本地化配音', render: (el) => window.VoiceView.render(el) },
    gallery: { title: '作品中心', desc: '管理你的全部 AI 创作成果', render: (el) => window.GalleryView.render(el) },
  };

  let current = 'dashboard';

  /* ---------- 导航 ---------- */
  function nav(view) {
    if (!VIEWS[view]) view = 'dashboard';
    current = view;
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.view === view);
    });
    document.querySelector('#viewTitle').textContent = VIEWS[view].title;
    document.querySelector('#viewDesc').textContent = VIEWS[view].desc;
    const content = document.querySelector('#content');
    content.innerHTML = '<div class="view-loading"><div class="spinner"></div></div>';
    setTimeout(() => {
      try {
        VIEWS[view].render(content);
      } catch (e) {
        console.error(e);
        content.innerHTML = `<div class="empty-state"><div class="big-ico">😵</div><p>页面渲染出错：${UI.escapeHtml(e.message)}</p></div>`;
      }
    }, 30);
    // 流水线徽标
    const pl = window.PipelineView;
    const badge = document.querySelector('#navBadgePipeline');
    if (pl) {
      const st = (() => { try { return JSON.parse(localStorage.getItem('materall_pipeline') || '{}'); } catch { return {}; } })();
      const busy = ['split', 'images', 'videos'].includes(st.phase);
      badge.classList.toggle('show', busy);
    }
  }

  /* ---------- 事件分发 ---------- */
  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function dispatch(evt, payload) {
    (listeners[evt] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[dispatch]', evt, e); }
    });
  }
  // 注册跨模块事件
  on('image:fillPrompt', (p) => window.ImageView.onFill(p));
  on('video:fillPrompt', (p) => window.VideoView.fillPrompt(p));
  on('video:setFirstFrame', (url) => window.VideoView.setFirstFrame(url));
  on('storyboard:addShots', (arr) => window.StoryboardView.addShots(arr));
  on('storyboard:addImage', (url, prompt) => window.StoryboardView.addImage(url, prompt));
  on('storyboard:addTextShots', (t) => window.StoryboardView.addTextShots(t));
  on('storyboard:demo', () => window.StoryboardView.demo());
  on('editor:addRemote', (m) => window.EditorView.addRemote(m));
  on('pipeline:fromStoryboard', () => window.PipelineView.fromStoryboard());

  /* ---------- 仪表盘 ---------- */
  async function renderDashboard(el) {
    let stats = { total: 0, image: 0, video: 0, project: 0 };
    try { stats = await Store.stats(); } catch { /* ignore */ }
    el.innerHTML = `
      <div class="dash-hero">
        <h2>让创意 <span class="grad-text">自动化</span> 生产</h2>
        <p>XM AI Studio 以「低门槛 · 高效率 · 强智能」为核心，整合静态图片生成、动态视频生成、智能自动化剪辑与 AI 逻辑思考辅助，覆盖 UA 素材生产、快速验证创意、创意设计辅助全场景。</p>
        <div class="dash-flow">
          <span class="f-node"><span class="f-ico">🧠</span>思考</span><span class="f-arrow">→</span>
          <span class="f-node"><span class="f-ico">🖼️</span>创作</span><span class="f-arrow">→</span>
          <span class="f-node"><span class="f-ico">✂️</span>剪辑</span><span class="f-arrow">→</span>
          <span class="f-node"><span class="f-ico">🚀</span>输出</span>
        </div>
      </div>
      <div class="dash-stats">
        <div class="stat-card" data-go="image"><div class="stat-num">${stats.image}</div><div class="stat-label">🖼️ AI 图片作品</div></div>
        <div class="stat-card" data-go="video"><div class="stat-num">${stats.video}</div><div class="stat-label">🎬 AI 视频作品</div></div>
        <div class="stat-card" data-go="gallery"><div class="stat-num">${stats.project}</div><div class="stat-label">🎞️ 剪辑成片</div></div>
        <div class="stat-card" data-go="gallery"><div class="stat-num">${stats.total}</div><div class="stat-label">🗂️ 作品总数</div></div>
      </div>
      <div class="grid grid-4">
        <div class="card" style="cursor:pointer" data-go="chat">
          <div class="card-title"><span class="ico">🧠</span>创意助手</div>
          <p style="font-size:12.5px;color:var(--text-2)">AI 逻辑思考辅助：脚本策划、分镜拆解、提示词优化</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="image">
          <div class="card-title"><span class="ico">🖼️</span>AI 生图</div>
          <p style="font-size:12.5px;color:var(--text-2)">Seedream 高质量文生图 / 图生图，一键流转视频</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="video">
          <div class="card-title"><span class="ico">🎬</span>AI 生视频</div>
          <p style="font-size:12.5px;color:var(--text-2)">Seedance 文生视频 / 图生视频，任务实时跟踪</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="storyboard">
          <div class="card-title"><span class="ico">📋</span>故事板</div>
          <p style="font-size:12.5px;color:var(--text-2)">可视化剧本 Storyboard，批量编排自动化生产</p>
        </div>
        <div class="card" style="cursor:pointer;border-color:rgba(34,211,238,.35)" data-go="pipeline">
          <div class="card-title"><span class="ico">🏭</span>流水线生产</div>
          <p style="font-size:12.5px;color:var(--text-2)">小龙虾自动化：一句话创意 → 全自动分镜/生图/生视频/成片</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="editor">
          <div class="card-title"><span class="ico">✂️</span>智能剪辑</div>
          <p style="font-size:12.5px;color:var(--text-2)">时间线剪辑、转场、文字卡、BGM，浏览器内合成 MP4</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="gallery">
          <div class="card-title"><span class="ico">🗂️</span>作品中心</div>
          <p style="font-size:12.5px;color:var(--text-2)">统一管理图片 / 视频 / 成片，随时复用流转</p>
        </div>
        <div class="card" style="cursor:pointer" data-go="settings">
          <div class="card-title"><span class="ico">🔌</span>连接配置</div>
          <p style="font-size:12.5px;color:var(--text-2)">配置火山方舟 API Key，检测服务连通状态</p>
        </div>
      </div>`;
    el.querySelectorAll('[data-go]').forEach((card) => {
      card.addEventListener('click', () => {
        if (card.dataset.go === 'settings') openSettings();
        else nav(card.dataset.go);
      });
    });
  }

  /* ---------- 设置 ---------- */
  const MODE_STORAGE = 'materall_key_mode'; // ark | bili | dual
  const PROV_META = {
    ark: { name: '火山方舟', keyLabel: '火山方舟 API Key', keyPh: 'sk-xxxx 或 32 位 Key', links: ['<a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apikey" target="_blank">获取方舟 API Key →</a>', '<a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通方舟模型 →</a>'] },
    bili: { name: 'Bilibili llmapi', keyLabel: 'Bilibili llmapi API Key', keyPh: '粘贴 llmapi.bilibili.co 的 Key', links: ['<a href="https://llmapi.bilibili.co" target="_blank">llmapi.bilibili.co 网关 →</a>', '<span style="font-size:11px">支持 GPT-5.3 / GPT-5.4 / doubao 等 54 款模型</span>'] },
  };
  function getKeyMode() {
    const s = localStorage.getItem(MODE_STORAGE);
    if (s === 'ark' || s === 'bili' || s === 'dual') return s;
    // 兼容推断：只有方舟 Key 且 provider=ark → ark；否则 dual（bili key 存在）→ bili/dual
    return API.getProvider() === 'ark' && !API.getArkKey() && API.getKey() ? 'ark' : 'dual';
  }
  function setKeyMode(m) { localStorage.setItem(MODE_STORAGE, m === 'dual' ? 'dual' : m === 'bili' ? 'bili' : 'ark'); }
  function applyProvUI() {
    const mode = getKeyMode();
    const p = API.getProvider();
    document.querySelectorAll('#settingsModal [data-mode]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.mode === mode));
    document.querySelectorAll('#settingsModal [data-prov]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.prov === p));
    const provRow = document.getElementById('settingsProvRow');
    const arkWrap = document.getElementById('settingsArkFieldWrap');
    const keyEl = document.getElementById('settingsApiKey');
    const arkEl = document.getElementById('settingsArkKey');
    const meta = PROV_META[p];
    if (mode === 'dual') {
      if (provRow) provRow.style.display = '';
      if (arkWrap) arkWrap.style.display = '';
      document.getElementById('settingsKeyLabel').textContent = (p === 'bili' ? 'Bilibili llmapi API Key（识别/对话）' : '火山方舟 API Key（识别/对话）');
      keyEl.placeholder = meta.keyPh;
    } else if (mode === 'bili') {
      API.setProvider('bili');
      if (provRow) provRow.style.display = 'none';
      if (arkWrap) arkWrap.style.display = 'none';
      document.getElementById('settingsKeyLabel').textContent = 'Bilibili llmapi API Key';
      keyEl.placeholder = '粘贴 llmapi.bilibili.co 的 Key';
    } else {
      API.setProvider('ark');
      if (provRow) provRow.style.display = 'none';
      if (arkWrap) arkWrap.style.display = 'none';
      document.getElementById('settingsKeyLabel').textContent = '火山方舟 API Key';
      keyEl.placeholder = 'sk-xxxx 或 32 位 Key';
    }
    keyEl.value = API.getKey();
    if (arkEl) arkEl.value = API.getArkKey();
    document.getElementById('settingsLinks').innerHTML = PROV_META[API.getProvider()].links.join('');
    refreshDualHint();
  }
  // 能力提示：按模式 + 已填 Key 给出说明
  function refreshDualHint() {
    const el = document.getElementById('settingsDualHint');
    if (!el) return;
    const mode = getKeyMode();
    const key1 = (document.getElementById('settingsApiKey')?.value || '').trim();
    const ark = mode === 'dual' ? (document.getElementById('settingsArkKey')?.value || '').trim() : (mode === 'ark' ? key1 : '');
    let html = '';
    if (mode === 'ark') html = key1 ? '🟢 <b>已配火山方舟</b>：识别/对话 + AI 生图/生视频/✨AI 抹除 全部可用（豆包系列）。' : '⚪ 填上方「火山方舟 API Key」即可全部功能可用。';
    else if (mode === 'bili') html = key1 ? '🟢 <b>已配 Bilibili</b>：识别/翻译/对话/AI 分析可用（GPT-5.x 等 54 款）。<br><span style="color:var(--text-3)">提示：若你其实也有方舟 Key，选「🔀 两个都有」可解锁 AI 生图/生视频/✨AI 抹除</span>' : '⚪ 填上方「Bilibili llmapi API Key」即可识别/对话。';
    else {
      const biliKey = API.getProvider() === 'bili' ? key1 : '';
      const arkKey = ark;
      const pName = API.getProvider() === 'bili' ? 'Bilibili' : '方舟';
      if (arkKey && (key1 || biliKey)) html = '🟢 <b>全功能可用</b>：' + pName + ' 管识别/对话，方舟管 AI 生图/生视频/✨AI 抹除去字。';
      else if (!arkKey && key1) html = '🟡 <b>已填 ' + pName + ' Key</b>（识别可用）；<br>AI 生图/✨AI 抹除需在下方「火山方舟 Key」填入方舟 Key。';
      else if (arkKey && !key1) html = '🟡 <b>已填方舟 Key</b>（生图/抹除可用）；<br>上方还需选识别服务商并填对应 Key。';
      else html = '⚪ 两把 Key 位置如下：<b>识别服务商 Key</b>（上）+ <b>火山方舟 Key</b>（下，生图/抹除用）。';
    }
    el.innerHTML = html;
  }
  function openSettings() {
    document.getElementById('settingsMask').classList.remove('hidden');
    document.getElementById('settingsModal').classList.remove('hidden');
    applyProvUI();
    document.getElementById('settingsResult').classList.add('hidden');
  }
  function closeSettings() {
    document.getElementById('settingsMask').classList.add('hidden');
    document.getElementById('settingsModal').classList.add('hidden');
  }
  function initSettings() {
    document.getElementById('btnOpenSettings').addEventListener('click', openSettings);
    document.getElementById('settingsClose').addEventListener('click', closeSettings);
    document.getElementById('settingsMask').addEventListener('click', closeSettings);
    document.querySelectorAll('#settingsModal [data-mode]').forEach((b) => b.addEventListener('click', () => {
      setKeyMode(b.dataset.mode);
      if (b.dataset.mode === 'ark') API.setProvider('ark');
      if (b.dataset.mode === 'bili') API.setProvider('bili');
      applyProvUI();
      document.getElementById('settingsResult').classList.add('hidden');
    }));
    document.querySelectorAll('#settingsModal [data-prov]').forEach((b) => b.addEventListener('click', () => {
      if (getKeyMode() !== 'dual') return;
      API.setProvider(b.dataset.prov);
      applyProvUI();
      document.getElementById('settingsResult').classList.add('hidden');
    }));
    // Key 输入即更新能力提示
    ['settingsApiKey', 'settingsArkKey'].forEach((id) => {
      const inp = document.getElementById(id);
      if (inp) inp.addEventListener('input', () => { try { refreshDualHint(); } catch { /* ignore */ } });
    });
    // 校验 ② 方舟 Key（轻量：读模型列表），结果追加到 resultEl；无 Key 跳过
    async function verifyArk(resultEl) {
      const mode = getKeyMode();
      const arkV = mode === 'dual' ? (document.getElementById('settingsArkKey')?.value || '').trim()
        : mode === 'ark' ? (document.getElementById('settingsApiKey')?.value || '').trim() : '';
      if (!arkV) return;
      try {
        const r = await fetch('/api/models?provider=ark', { headers: { 'X-ARK-Key': arkV } });
        const j = await r.json().catch(() => ({}));
        const ids = Array.isArray(j.ids) ? j.ids : [];
        resultEl.innerHTML += r.ok && ids.length
          ? `<br>火山方舟 Key 有效：读到 ${ids.length} 个模型 ✅（AI 生图/✨AI 抹除可用）`
          : `<br>火山方舟 Key 校验失败：${UI.escapeHtml(String((j.error && j.error.message) || ('HTTP ' + r.status)).slice(0, 120))}`;
      } catch (e) {
        resultEl.innerHTML += `<br>方舟 Key 校验异常：${UI.escapeHtml(String(e.message || e).slice(0, 100))}`;
      }
    }
    document.getElementById('settingsSave').addEventListener('click', async () => {
      const mode = getKeyMode();
      const p = API.getProvider();
      const key = document.getElementById('settingsApiKey').value.trim();
      const result = document.getElementById('settingsResult');
      const btn = document.getElementById('settingsSave');
      btn.disabled = true;
      btn.textContent = '检测中…';
      result.classList.remove('hidden');
      result.className = 'settings-result';
      if (!key) {
        result.textContent = '⚠️ 请输入 API Key';
        result.classList.add('err');
        btn.disabled = false;
        btn.textContent = '保存并检测连接';
        return;
      }
      API.setKey(key);
      // Key 落位按模式：ark=单方舟(存 KEY_ARK)；bili=单 Bili(清方舟)；dual=两把分别存
      const arkInp = document.getElementById('settingsArkKey');
      if (mode === 'ark') API.setArkKey(key);
      else if (mode === 'bili') API.setArkKey('');
      else if (arkInp) API.setArkKey(arkInp.value.trim());
      refreshDualHint();
      if (p === 'bili') {
        // Bilibili llmapi：读取 /v1/models 验证 + 展示 54 款模型供选择主模型
        try {
          const r = await API.listModels();
          const ids = (r.ids || []).filter((id) => !/embedding|rerank|whisper|tts|dall-e|flux|sdxl/i.test(id));
          const cur = API.getChatModel() || '';
          if (!ids.length) throw new Error('网关未返回模型列表');
          const opts = ids.map((m) => `<option value="${UI.escapeHtml(m)}" ${m === cur ? 'selected' : ''}>${UI.escapeHtml(m)}</option>`).join('');
          result.innerHTML = `✅ Bilibili llmapi 连接成功，读到 <b>${ids.length}</b> 款模型（GPT-5.x 等）。<br>
            识别/对话主模型：<select id="setModelPick" style="max-width:100%;padding:4px 6px;border-radius:6px;border:1px solid var(--border-light,#333);background:var(--bg-2,#111);color:var(--text)">${opts}</select>
            <span style="font-size:11px;color:var(--text-3)">（选 gpt-5.3 / gpt-5.4 可做文字识别等视觉任务；识别会自动适配）</span>`;
          result.classList.add('ok');
          result.querySelector('#setModelPick').addEventListener('change', (e) => {
            API.setChatModel(e.target.value);
            UI.toast(`已选主模型：${e.target.value}`, 'ok', 3000);
          });
          refreshApiStatus();
          UI.toast('Bilibili llmapi 连接成功 🎉', 'ok');
        } catch (e) {
          const m = e.message || '';
          let hint = m.slice(0, 140);
          if (/invalid_api_key|密钥不正确|401/i.test(m)) hint = 'API Key 无效：请确认粘贴的是 llmapi.bilibili.co 网关签发的 Key';
          else if (/MISSING_API_KEY/i.test(m)) hint = '未检测到 Key，请在上方填写';
          result.innerHTML = `❌ Bilibili 连接失败：${UI.escapeHtml(hint)}<br><span style="font-size:11px;color:var(--text-3)">${UI.escapeHtml(m.slice(0, 160))}</span>`;
          result.classList.add('err');
          UI.toast('Bilibili llmapi 连接失败', 'err', 6000);
        }
        btn.disabled = false;
        btn.textContent = '保存并检测连接';
        await verifyArk(result);
        return;
      }
      try {
        const health = await API.health();
        if (health.ark && (health.ark.envKeyConfigured || health.ark.keyProvided)) {
          // 真实调用方舟验证 Key 有效性（用最便宜的一次对话请求）
          try {
            const test = await API.chatTest(API.getChatModel());
            if (test.ok) {
              result.innerHTML = `✅ 连接成功，Key 有效！模型「${test.model}」回复：${UI.escapeHtml((test.reply || '').slice(0, 16))}`;
              result.classList.add('ok');
              refreshApiStatus();
              UI.toast('API Key 有效，连接成功 🎉', 'ok');
            } else {
              const m = test.message || '';
              let hint = m.slice(0, 120);
              if (/api key|authentication|401/i.test(m)) hint = 'API Key 无效或格式错误（需 sk- 开头的方舟专用 Key）';
              else if (/does not exist|do not have access/i.test(m)) hint = `Key 有效，但对话模型「${test.model}」不可用，可稍后在创意助手中换模型`;
              result.innerHTML = `⚠️ Key 已保存，但验证未通过：<br>${UI.escapeHtml(hint)}<br><span style="font-size:11px;color:var(--text-3)">${UI.escapeHtml(m.slice(0, 150))}</span>`;
              result.classList.remove('ok');
              result.classList.add('err');
              UI.toast('Key 验证未通过，请检查', 'err', 5000);
            }
          } catch (e2) {
            result.innerHTML = `⚠️ Key 已保存，但调用方舟失败：${UI.escapeHtml(e2.message.slice(0, 100))}`;
            result.classList.add('err');
          }
        } else {
          result.innerHTML = '⚠️ 服务已连接，但未检测到 API Key。<br>请确认 .env 配置或上方输入正确。';
          result.classList.add('err');
        }
      } catch (e) {
        result.innerHTML = `❌ ${UI.escapeHtml(e.message)}`;
        result.classList.add('err');
      }
      btn.disabled = false;
      btn.textContent = '保存并检测连接';
      await verifyArk(result);
    });
  }

  /* ---------- API 状态 ---------- */
  async function refreshApiStatus() {
    const dot = document.querySelector('#apiStatus .dot');
    const text = document.querySelector('.api-status-text');
    try {
      const health = await API.health();
      const ready = !!(API.getKey() || health.ark?.envKeyConfigured);
      dot.className = 'dot ' + (ready ? 'dot-green' : 'dot-red');
      // 文案准确化："已配置"而非"已连接"（是否有效以真实调用为准）
      text.textContent = ready ? '方舟 Key 已配置' : 'API 未配置';
    } catch {
      dot.className = 'dot dot-red';
      text.textContent = '服务未启动';
    }
  }

  /* ---------- 帮助 ---------- */
  function openHelp() {
    UI.modal(`
      <h4 style="margin-bottom:8px">🚀 快速上手（4 步）</h4>
      <ol style="padding-left:20px;font-size:13px;color:var(--text-2);line-height:2">
        <li><b style="color:var(--text)">获取 API Key</b>：在火山引擎控制台「火山方舟 → API Key 管理」创建 Key（开通 Seedream 生图、Seedance 生视频、豆包对话模型）</li>
        <li><b style="color:var(--text)">连接</b>：点击左下角「连接设置」，填入 Key 并保存</li>
        <li><b style="color:var(--text)">创作</b>：用「创意助手」策划 → 「AI 生图」出画面 → 「AI 生视频」动起来</li>
        <li><b style="color:var(--text)">成片</b>：故事板批量编排 → 「流水线生产」全自动 → 「智能剪辑」合成导出 MP4</li>
      </ol>
      <h4 style="margin:12px 0 8px">🔗 关键入口</h4>
      <ul style="padding-left:20px;font-size:13px;color:var(--text-2);line-height:2">
        <li><a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apikey" target="_blank">获取 API Key</a></li>
        <li><a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">开通模型服务</a></li>
      </ul>
      <p style="font-size:11.5px;color:var(--text-3);margin-top:10px">提示：视频生成任务在云端异步执行，需 1-5 分钟；剪辑在本地浏览器完成（首次会加载约 30MB 剪辑引擎）。</p>
    `, { title: '使用指南' });
  }

  /* ---------- 环境检测：引导用户使用完整服务 ---------- */
  async function checkEnvironment() {
    const loc = window.location;
    const banner = document.getElementById('envBanner');
    const text = document.getElementById('envBannerText');
    let msg = '';
    if (loc.protocol === 'file:') {
      msg = '当前通过文件方式直接打开页面，AI 服务不可用。请先在项目目录运行 <b>node server.js</b>，然后访问 <a href="http://localhost:3000" target="_blank">http://localhost:3000</a>';
    } else if (await API.detectStaticMode()) {
      msg = '🌐 当前为<b>在线分享版</b>：素材上传 / <b>包框合成</b> / 智能剪辑 / 作品中心可正常使用（全部在浏览器本地完成）。AI 生图 / 生视频 / 创意助手需要服务端，由部署者的完整版提供';
    } else if (loc.port && loc.port !== '3000' && !/^(localhost|127\.)/.test(loc.hostname)) {
      msg = '当前是静态预览环境，AI 功能（生图/生视频/剪辑）需要本地服务支撑。请访问 <a href="http://localhost:3000" target="_blank">http://localhost:3000</a>（服务已启动时直接可用）';
    }
    if (msg && banner && text) {
      text.innerHTML = msg;
      banner.classList.remove('hidden');
      document.getElementById('envBannerClose').addEventListener('click', () => banner.classList.add('hidden'));
    }
  }

  /* ---------- 启动 ---------- */
  function init() {
    UI.initModal();
    initSettings();
    refreshApiStatus();
    checkEnvironment();

    // 导航
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => nav(item.dataset.view));
    });
    document.querySelector('#btnQuickHelp').addEventListener('click', openHelp);

    // 流水线徽标轮询
    setInterval(() => {
      const pl = document.querySelector('#navBadgePipeline');
      if (pl) {
        const st = (() => { try { return JSON.parse(localStorage.getItem('materall_pipeline') || '{}'); } catch { return {}; } })();
        pl.classList.toggle('show', ['split', 'images', 'videos'].includes(st.phase));
      }
    }, 4000);

    // 初始视图
    nav('dashboard');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { nav, dispatch, on, openSettings, refreshApiStatus };
})();
