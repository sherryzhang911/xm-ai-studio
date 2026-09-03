/* ============================================================
 * playable.js — AI 试玩（Playable Ad）
 * 上传视频/图片 → AI 分析帧 → 微动/平面试玩 → UI 拖拽交互
 * → 按钮跳转不同物料 → 商店链接 + 渠道打点 → 导出单文件 HTML
 * ============================================================ */
window.PlayableView = (() => {
  const LS_KEY = 'materall_playable';
  // 试玩画布：竖屏 720x1280（≈9:16）/ 横屏 1280x720（≈16:9）；导出 HTML 全响应式，任意设备横竖屏自适应
  const CANVAS = { portrait: { w: 720, h: 1280 }, landscape: { w: 1280, h: 720 } };
  const getCv = () => CANVAS[st.orientation] || CANVAS.portrait;
  const CHANNELS = ['Applovin', 'Google', 'Moloco', 'Unity'];
  const MAX_FRAMES = 20;
  const MAX_UI = 10;

  // 玩法模板（对齐三谋韩国真实投放素材的玩法类型）
  const TEMPLATES = {
    tap:    { label: '单帧点击', ico: '👆', desc: '1 个画面 + 点击引导 + CTA', minFrames: 1 },
    story:  { label: '视频剧情点击', ico: '🎬', desc: '多画面/视频，点击推进剧情', minFrames: 2 },
    motion: { label: '微动展示', ico: '✨', desc: 'Ken Burns 动态循环 + CTA（无需点击）', minFrames: 1 },
  };

  let st = {
    frames: [],        // 画面 [{ id, name, source(dataURL竖版), sourceLandscape(dataURL横版,可选), w, h, motion }]
    activeFrame: null, // 当前预览画面 id
    type: 'tap',       // motion(微动) | tap(平面试玩)
    template: 'tap',   // 玩法模板
    showCta: true,     // 是否显示 CTA 下载按钮（用户可选）
    orientation: 'portrait', // portrait(720x1280) | landscape(1280x720) —— 预览方向；导出自动横竖屏自适应
    audio: null,       // 配音 { name, source(dataURL base64), fromVideo }
    useOriginalAudio: false, // 上传视频时提取原音轨作为配音
    uiAssets: [],      // UI 素材 [{ id, name, source(dataURL), w, h }]
    buttons: [],       // 互动按钮 [{ id, uiId, target('__cta__'|frameId), x,y,w,h(0~1归一化), label }]
    ctaLabel: 'Download Now',
    playUrl: '',       // Google Play
    iosUrl: '',        // App Store
    channel: 'Applovin',
    name: '',          // 命名
    aiNotes: '',       // AI 分析帧结果
    // 运行态
    dragging: null,
  };
  let mode = 'config';
  let resultHtml = null;   // 导出的 HTML 字符串
  let resultName = '';
  let exporting = false;

  function uid(p = 'f') { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- Ken Burns 微动样式（浏览器原生 CSS 动画，零生成等待/零体积，参考素材式微动） ---------- */
  (function injectKbStyle() {
    if (document.getElementById('plKbStyle')) return;
    const s = document.createElement('style');
    s.id = 'plKbStyle';
    s.textContent = '.kb{animation:plKB 9s ease-in-out infinite alternate;transform-origin:50% 50%;will-change:transform}.kb2{animation:plKB2 11s ease-in-out infinite alternate;transform-origin:50% 50%}@keyframes plKB{from{transform:scale(1) translate(0,0)}to{transform:scale(1.16) translate(-1.5%,1%)}}@keyframes plKB2{from{transform:scale(1.14) translate(1.5%,-1%)}to{transform:scale(1) translate(0,0)}}';
    document.head.appendChild(s);
  })();

  /* ---------- 持久化（轻量：配置 + 压缩画面/UI dataURL） ---------- */
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        type: st.type, template: st.template, showCta: st.showCta, ctaLabel: st.ctaLabel, playUrl: st.playUrl, iosUrl: st.iosUrl,
        channel: st.channel, name: st.name, aiNotes: st.aiNotes, activeFrame: st.activeFrame,
        orientation: st.orientation, audio: st.audio, useOriginalAudio: st.useOriginalAudio,
        frames: st.frames.map((f) => ({ id: f.id, name: f.name, source: f.source, sourceLandscape: f.sourceLandscape || '', w: f.w, h: f.h, fromVideo: !!f.fromVideo, dur: f.dur || 0, seq: (f.seq && f.seq.length > 1) ? f.seq : null })), // seq 尽量持久化，超配额静默丢（导出用内存值）
        uiAssets: st.uiAssets.map((u) => ({ id: u.id, name: u.name, source: u.source, w: u.w, h: u.h })),
        buttons: st.buttons,
      }));
    } catch (e) { /* 超配额静默 */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (s.frames && Array.isArray(s.frames)) st.frames = s.frames;
      if (s.uiAssets && Array.isArray(s.uiAssets)) st.uiAssets = s.uiAssets;
      if (s.buttons && Array.isArray(s.buttons)) st.buttons = s.buttons;
      if (s.type) st.type = s.type;
      if (s.template) st.template = s.template;
      if (s.showCta !== undefined) st.showCta = s.showCta;
      if (s.ctaLabel) st.ctaLabel = s.ctaLabel;
      if (s.playUrl) st.playUrl = s.playUrl;
      if (s.iosUrl) st.iosUrl = s.iosUrl;
      if (s.channel) st.channel = s.channel;
      if (s.name) st.name = s.name;
      if (s.aiNotes) st.aiNotes = s.aiNotes;
      if (s.orientation) st.orientation = s.orientation;
      if (s.audio) st.audio = s.audio;
      if (s.useOriginalAudio !== undefined) st.useOriginalAudio = s.useOriginalAudio;
      st.activeFrame = s.activeFrame || (st.frames[0] && st.frames[0].id) || null;
    } catch { /* ignore */ }
  }

  /* ---------- 工具 ---------- */
  function readImgMeta(src) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = src;
    });
  }
  function compressToDataURL(blob, maxSide = 720, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const W = Math.max(8, Math.round(img.naturalWidth * s));
        const H = Math.max(8, Math.round(img.naturalHeight * s));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }
  async function rm(ffmpeg, name) { try { await ffmpeg.deleteFile(name); } catch { /* ignore */ } }
  function uint8ToB64(u8) {
    let bin = ''; const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    return btoa(bin);
  }

  /** 原生 video+canvas 等间隔抽帧（无需 ffmpeg；count 帧均匀采样，可选小尺寸用于序列轮播） */
  async function extractFramesNative(file, { count = 8, maxSide = 480, quality = 0.72 } = {}) {
    const src = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.playsInline = true;
    const ok = await new Promise((res) => { v.onloadedmetadata = () => res(true); v.onerror = () => res(false); v.src = src; });
    if (!ok || !v.duration || !v.videoWidth) { URL.revokeObjectURL(src); throw new Error('浏览器无法解析该视频'); }
    const dur = v.duration;
    const n = Math.min(count, Math.max(1, Math.round(dur / 0.25)));
    const canvas = document.createElement('canvas');
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(Math.max(0.05, (dur / n) * (i + 0.5)), Math.max(dur - 0.05, 0.05));
      v.currentTime = t;
      await new Promise((res) => { v.onseeked = () => res(); v.onerror = () => res(); setTimeout(res, 3000); });
      const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
      const sc = Math.min(1, maxSide / Math.max(vw, vh));
      canvas.width = Math.max(8, Math.round(vw * sc)); canvas.height = Math.max(8, Math.round(vh * sc));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/jpeg', quality));
    }
    URL.revokeObjectURL(src);
    return { frames: out, duration: dur };
  }

  async function addFiles(files) {
    for (const f of files) {
      if (st.frames.length >= MAX_FRAMES) { UI.toast(`场景最多 ${MAX_FRAMES} 个`, 'warn'); break; }
      if (f.type.startsWith('video/')) {
        try {
          // 视频 = 1 个场景：密集抽帧成序列（seq），导出后自动轮播 → 画面像视频一样真实在动
          const n = Math.min(14, Math.max(6, Math.round(Math.min(f.duration || 6, 6) / 0.4)));
          UI.toast(`正在从「${f.name}」提取画面序列（${n} 帧）…`, 'info', 5000);
          const r = await extractFramesNative(f, { count: n, maxSide: 480, quality: 0.72 });
          if (!r.frames.length) { UI.toast(`「${f.name}」未提取到画面`, 'warn'); continue; }
          st.frames.push({ id: uid(), name: f.name, source: r.frames[0], seq: r.frames, w: 0, h: 0, dur: r.duration, fromVideo: true });
          UI.toast(`✅ 「${f.name}」已作为动态场景（${r.frames.length} 帧轮播）`, 'ok', 4000);
          // 勾选"用原视频配音"时提取音轨
          if (st.useOriginalAudio && !st.audio) {
            try {
              UI.toast('提取原视频音轨…', 'info', 4000);
              const audioSrc = await extractAudioFromVideo(f);
              st.audio = { name: `${f.name} · 原音轨`, source: audioSrc, fromVideo: true };
              UI.toast('已提取原视频音轨作为配音 ✅', 'ok', 3000);
            } catch (e) { UI.toast('原音轨提取失败：' + (e.message || '').slice(0, 50), 'warn', 5000); }
          }
        } catch (e) { UI.toast(`视频「${f.name}」处理失败：${e.message || ''}`, 'err', 5000); }
        continue;
      }
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 15 * 1024 * 1024) { UI.toast(`「${f.name}」超过 15MB`, 'warn'); continue; }
      const dataURL = await compressToDataURL(f, 720, 0.82);
      const m = await readImgMeta(dataURL);
      st.frames.push({ id: uid(), name: f.name, source: dataURL, seq: null, w: m.w, h: m.h });
    }
    if (!st.activeFrame && st.frames.length) st.activeFrame = st.frames[0].id;
    save(); render(document.querySelector('#content'));
  }

  /* ---------- 配音：提取视频音轨 / 上传音频 ---------- */
  async function extractAudioFromVideo(file) {
    const ffmpeg = await window.EditorView.ensureFFmpegPublic();
    if (!ffmpeg) throw new Error('剪辑引擎加载失败');
    const inName = 'pl_audio_in' + (/\.webm$/i.test(file.name) ? '.webm' : '.mp4');
    const outName = 'pl_audio_out.m4a';
    await rm(ffmpeg, inName); await rm(ffmpeg, outName);
    await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const code = await ffmpeg.exec(['-i', inName, '-vn', '-c:a', 'aac', '-b:a', '96k', '-y', outName]);
    if (code !== 0) { await rm(ffmpeg, inName); throw new Error('音轨提取失败(code ' + code + ')'); }
    const data = await ffmpeg.readFile(outName);
    await rm(ffmpeg, inName); await rm(ffmpeg, outName);
    return 'data:audio/mp4;base64,' + uint8ToB64(data);
  }
  async function pickAudio(e, el) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { UI.toast('音频超过 8MB，请压缩', 'err', 5000); return; }
    const dataURL = await UI.fileToDataUrl(f);
    st.audio = { name: f.name, source: dataURL, fromVideo: false };
    save(); render(el);
    UI.toast('配音已上传 ✅', 'ok', 3000);
  }
  async function setFrameLandscape(e, el) {
    const f = e.target.files?.[0];
    if (!f || !st.activeFrame) return;
    if (!f.type.startsWith('image/')) return;
    const dataURL = await compressToDataURL(f, 1280, 0.82);
    const fr = st.frames.find((x) => x.id === st.activeFrame);
    fr.sourceLandscape = dataURL;
    save(); render(el);
    UI.toast('已为当前画面设置横版素材（横屏设备将使用它）✅', 'ok', 4000);
  }

  async function addUiFiles(files) {
    for (const f of files) {
      if (st.uiAssets.length >= MAX_UI) { UI.toast(`UI 素材最多 ${MAX_UI} 个`, 'warn'); break; }
      if (!f.type.startsWith('image/')) continue;
      const dataURL = await compressToDataURL(f, 400, 0.9);
      const m = await readImgMeta(dataURL);
      st.uiAssets.push({ id: uid('ui'), name: f.name, source: dataURL, w: m.w, h: m.h });
    }
    save(); render(document.querySelector('#content'));
  }

  /* ---------- 玩法模板：一键生成交互（对齐真实素材玩法） ---------- */
  function applyTemplate(tplKey) {
    const tpl = TEMPLATES[tplKey];
    if (!tpl) return;
    const n = st.frames.length;
    if (n < tpl.minFrames) { UI.toast(`「${tpl.label}」需要至少 ${tpl.minFrames} 张画面，请先上传素材`, 'warn', 5000); return; }
    st.template = tplKey;
    const ui0 = st.uiAssets[0]?.id || null;
    const f0 = st.frames[0].id, f1 = st.frames[1]?.id || f0, fLast = st.frames[n - 1].id;
    const B = (x, y, w, h, target, uiId) => ({ id: uid('b'), uiId, target, x, y, w, h, label: tpl.label });

    if (tplKey === 'tap') {
      // 单帧点击：大点击引导（中央偏下大按钮）
      st.buttons = [ B(0.25, 0.62, 0.5, 0.3, f1, ui0) ];
    } else if (tplKey === 'story') {
      // 剧情点击：每帧下方居中大按钮，顺序推进
      st.buttons = st.frames.slice(0, n - 1).map((f, i) => B(0.3, 0.68, 0.4, 0.24, st.frames[i + 1].id, ui0));
    } else if (tplKey === 'motion') {
      // 微动展示：无交互按钮，仅自动播放 + CTA
      st.type = 'motion';
      st.buttons = [];
    }
    // 微动模式自动为所有帧生成微动视频（延后到导出时）
    if (tplKey === 'motion') st.type = 'motion'; else st.type = 'tap';
    save(); render(document.querySelector('#content'));
    UI.toast(`已套用「${tpl.label}」模板，可在预览中拖拽微调按钮位置`, 'ok', 4000);
  }

  /* ---------- AI 分析帧 ---------- */
  async function analyzeFrame() {
    const fr = st.frames.find((x) => x.id === st.activeFrame);
    if (!fr) return UI.toast('请先上传素材', 'warn');
    UI.toast('AI 分析帧中…', 'info', 3000);
    try {
      const txt = `你是一名试玩广告策划。请分析这张画面，用中文输出 3 条试玩交互建议（每行一条，简短）：1) 核心玩法卖点；2) 建议的点击/交互热点位置（如"画面右下角放抽卡按钮"）；3) 建议的引导文案。只输出建议本身。`;
      const r = await API.chatVision(txt, fr.source, { temperature: 0.5, max_tokens: 300 });
      st.aiNotes = r.content || '';
      UI.toast('AI 分析完成 ✅', 'ok', 3000);
    } catch (e) {
      const m = e.message || '';
      let hint = '';
      if (/分享版|无本地服务|静态/i.test(m)) hint = '当前是分享版（无后端），AI 分析需在本机 node server.js 环境使用';
      else if (/api key|authentication|unauthorized/i.test(m)) hint = '请在「连接设置」填写有效的方舟 API Key';
      else if (/not (found|enabled|supported)|does not exist/i.test(m)) hint = '视觉模型未开通，请在方舟控制台开通 doubao-seed-1-6-vision 或多模态模型';
      else hint = m.slice(0, 60);
      st.aiNotes = st.aiNotes || '';
      UI.toast('AI 分析不可用：' + hint, 'warn', 6000);
    }
    save(); render(document.querySelector('#content'));
  }

  /* ---------- 渲染 ---------- */
  function render(el) {
    load();
    if (mode === 'done') return renderDone(el);
    renderConfig(el);
  }

  function renderConfig(el) {
    const fr = st.frames.find((x) => x.id === st.activeFrame);
    const date = new Date();
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const defaultName = st.name || `SM-P01-KR-sherry-${dateStr}-${st.channel}`;
    el.innerHTML = `
      <div class="rsz-layout">
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="card">
            <div class="card-title"><span class="ico">🎬</span>① 素材上传（视频自动抽帧 / 图片）</div>
            <input type="file" id="plFile" accept="video/*,image/*" multiple style="display:none">
            <div class="rsz-drop" id="plDrop"><div style="font-size:24px">🖼️</div><p style="margin:6px 0 2px;font-weight:600">点击或拖拽视频/图片到这里</p><p style="font-size:11px;color:var(--text-3)">视频自动抽帧成多个画面 · 最多 ${MAX_FRAMES} 张</p></div>
            ${st.frames.length ? `
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
              ${st.frames.map((f, i) => `
                <div style="position:relative;border:2px solid ${f.id === st.activeFrame ? 'var(--primary-2)' : 'var(--border-light)'};border-radius:8px;padding:4px;background:var(--bg-soft,#0e1119);cursor:pointer" data-act="${f.id}">
                  <img src="${f.source}" style="height:56px;border-radius:5px;display:block;object-fit:cover">
                  <p style="font-size:10px;color:var(--text-3);margin:3px 0 0;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}.${UI.escapeHtml(f.name)}${f.seq && f.seq.length > 1 ? '<span style="color:#22c55e">▶ 动态</span>' : ''}</p>
                  <button class="btn-icon pl-f-del" data-id="${f.id}" title="删除" style="position:absolute;top:1px;right:1px;font-size:10px;background:rgba(0,0,0,.65)">✕</button>
                </div>`).join('')}
            </div>` : ''}
            <div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;font-size:13px;align-items:center">
              <label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="plUseOrigAudio" ${st.useOriginalAudio ? 'checked' : ''} style="accent-color:var(--primary-2)"> 用原视频配音（抽帧时自动提取音轨）</label>
              ${fr ? `<button class="btn btn-sm" id="plSetLandscape">🖼️ 为当前画面设置横版素材（可选）</button>
                <input type="file" id="plLandscapeFile" accept="image/*" style="display:none">
                ${fr.sourceLandscape ? '<span style="font-size:11px;color:var(--ok)">✅ 已设横版素材</span>' : '<span style="font-size:11px;color:var(--text-3)">未设横版（横屏时自动 cover 适配）</span>'}` : ''}
            </div>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">🎮</span>② 玩法模板（一键套用交互）</div>
            <p style="font-size:12px;color:var(--text-3);margin-bottom:8px">选择一种玩法，自动生成按钮与跳转逻辑（对齐真实投放素材的玩法类型）</p>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
              ${Object.entries(TEMPLATES).map(([k, t]) => `
                <div data-tpl="${k}" style="border:2px solid ${st.template === k ? 'var(--primary-2)' : 'var(--border-light)'};border-radius:10px;padding:8px;cursor:pointer;text-align:center;transition:.15s;background:${st.template === k ? 'var(--grad-soft)' : 'transparent'}">
                  <div style="font-size:20px">${t.ico}</div>
                  <div style="font-size:12px;font-weight:600;margin:2px 0">${t.label}</div>
                  <div style="font-size:10px;color:var(--text-3);line-height:1.4">${t.desc}</div>
                </div>`).join('')}
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm" id="plAnalyze">🧠 AI 分析当前帧</button>
              ${st.template === 'motion' ? '<span style="font-size:11px;color:var(--text-3)">✨ 微动为浏览器原生 Ken Burns 动画（导出即动，无需等待）</span>' : ''}
              <label style="display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer;margin-left:auto"><input type="checkbox" id="plShowCta" ${st.showCta ? 'checked' : ''} style="accent-color:var(--primary-2)"> 显示 CTA 下载按钮（可关闭）</label>
            </div>
            <textarea id="plAiNotes" class="input" rows="3" style="width:100%;margin-top:8px;resize:vertical" placeholder="AI 分析建议会显示在这里（也可手动填写交互思路备注）">${UI.escapeHtml(st.aiNotes)}</textarea>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">🧩</span>③ UI 素材（按钮图等，可在预览中拖拽定位）</div>
            <input type="file" id="plUiFile" accept="image/*" multiple style="display:none">
            <button class="btn btn-sm" id="plUiPick">📁 上传 UI 素材（最多 ${MAX_UI} 个）</button>
            ${st.uiAssets.length ? `
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
              ${st.uiAssets.map((u) => `
                <div style="position:relative;border:1px solid var(--border-light);border-radius:8px;padding:4px;background:var(--bg-soft,#0e1119)">
                  <img src="${u.source}" style="height:40px;border-radius:4px;display:block;background:#fff">
                  <button class="btn-icon pl-u-del" data-id="${u.id}" title="删除" style="position:absolute;top:1px;right:1px;font-size:10px;background:rgba(0,0,0,.65)">✕</button>
                </div>`).join('')}
            </div>` : '<p style="font-size:12px;color:var(--text-3);margin-top:6px">未上传</p>'}
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">🎵</span>配音（可选）</div>
            <input type="file" id="plAudioFile" accept="audio/*" style="display:none">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm" id="plAudioPick">📁 上传配音 / BGM</button>
              ${st.audio ? `<span style="font-size:12px;color:var(--ok)">✅ ${UI.escapeHtml(st.audio.name)}${st.audio.fromVideo ? '（原视频音轨）' : ''}</span>
                <button class="btn-icon" id="plAudioRemove" title="移除">✕</button>
                ${st.audio.source && !st.audio.fromVideo ? `<audio src="${st.audio.source}" controls style="height:28px;width:180px"></audio>` : ''}` : '<span style="font-size:12px;color:var(--text-3)">未配音（可在①勾选"用原视频配音"或上传音频）</span>'}
            </div>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">🔘</span>④ 互动按钮（点击后跳转不同物料）</div>
            <p style="font-size:12px;color:var(--text-3);margin-bottom:8px">每个按钮绑定一个 UI 素材 + 位置（预览中拖拽）+ 跳转目标画面</p>
            ${st.buttons.map((b, i) => {
              const u = st.uiAssets.find((x) => x.id === b.uiId);
              const t = b.target === '__cta__' ? 'CTA 下载' : (st.frames.find((x) => x.id === b.target)?.name || '未绑定');
              return `
              <div style="display:flex;align-items:center;gap:8px;border:1px solid var(--border-light);border-radius:8px;padding:6px 8px;margin-bottom:6px">
                ${u ? `<img src="${u.source}" style="height:26px;background:#fff;border-radius:3px">` : '<span style="font-size:11px;color:var(--text-3)">无图</span>'}
                <select class="input pl-b-ui" data-i="${i}" style="width:auto;flex:1;padding:5px 8px">${st.uiAssets.map((x) => `<option value="${x.id}" ${x.id === b.uiId ? 'selected' : ''}>${UI.escapeHtml(x.name)}</option>`).join('')}</select>
                <select class="input pl-b-target" data-i="${i}" style="width:auto;flex:1;padding:5px 8px">
                  <option value="__cta__" ${b.target === '__cta__' ? 'selected' : ''}>🎯 CTA 下载按钮</option>
                  ${st.frames.map((x) => `<option value="${x.id}" ${x.id === b.target ? 'selected' : ''}>→ ${UI.escapeHtml(x.name)}</option>`).join('')}
                </select>
                <span style="font-size:11px;color:var(--text-3);white-space:nowrap">→ ${UI.escapeHtml(t)}</span>
                <button class="btn-icon pl-b-del" data-i="${i}" title="删除">✕</button>
              </div>`;
            }).join('')}
            <button class="btn btn-sm" id="plAddBtn">➕ 添加按钮</button>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">📦</span>⑤ 商店链接与打包规则</div>
            <label class="field"><span class="field-label">Google Play 链接</span>
              <input class="input" id="plPlay" placeholder="https://play.google.com/store/apps/details?id=..." value="${UI.escapeHtml(st.playUrl)}"></label>
            <label class="field"><span class="field-label">App Store 链接（iOS）</span>
              <input class="input" id="plIos" placeholder="https://apps.apple.com/app/id..." value="${UI.escapeHtml(st.iosUrl)}"></label>
            <label class="field"><span class="field-label">试玩渠道</span>
              <select class="input" id="plChannel">${CHANNELS.map((c) => `<option ${c === st.channel ? 'selected' : ''}>${c}</option>`).join('')}</select>
              <span class="field-hint">打点规则：仅 Applovin 渠道埋点（ALPlayableAnalytics），其他渠道直接跳转商店</span></label>
            <label class="field"><span class="field-label">输出命名</span>
              <input class="input" id="plName" placeholder="SM-P01-KR-sherry-20260615-XXXX" value="${UI.escapeHtml(defaultName)}">
              <span class="field-hint">规则：{项目}-{编号}{优先级}-{地区}-{制作人}-{日期}-{渠道}，可自由填写</span></label>
            <label class="field"><span class="field-label">CTA 按钮文案</span>
              <input class="input" id="plCta" value="${UI.escapeHtml(st.ctaLabel)}"></label>
          </div>

          <button class="btn btn-primary btn-block" id="plExport" ${st.frames.length ? '' : 'disabled'}>🚀 导出试玩 HTML</button>
        </div>

        <div class="card" style="position:sticky;top:0">
          <div class="card-title"><span class="ico">👁️</span>实时预览（${getCv().w}×${getCv().h}${fr ? ' · 当前：' + UI.escapeHtml(fr.name) : ''}）</div>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <button class="btn btn-sm ${st.orientation === 'portrait' ? 'btn-primary' : ''}" id="plOriPortrait">📱 竖屏 720×1280</button>
            <button class="btn btn-sm ${st.orientation === 'landscape' ? 'btn-primary' : ''}" id="plOriLandscape">🖥️ 横屏 1280×720</button>
          </div>
          <div style="display:flex;justify-content:center;background:var(--bg-2,#111);border-radius:10px;padding:14px;overflow:auto">
            <div id="plPreview" style="position:relative;width:360px;height:${st.orientation === 'landscape' ? 202 : 640}px;background:#000;border-radius:6px;overflow:hidden;flex-shrink:0"></div>
          </div>
          <p style="font-size:11.5px;color:var(--text-3);margin-top:8px">💡 导出的试玩 HTML 横竖屏自适应（任意设备 cover 铺满，横屏 letterbox）。点击画面内按钮可拖拽定位；可另设「横版素材」让横屏设备用专用图。</p>
        </div>
      </div>`;
    bindConfigEvents(el);
    renderPreview(el);
  }

  // 预览轮播（动态场景帧序列），切帧/重绘时重启
  let seqTimer = null;
  function stopSeq() { if (seqTimer) { clearInterval(seqTimer); seqTimer = null; } }

  function renderPreview(el) {
    const box = el.querySelector('#plPreview');
    if (!box) return;
    const fr = st.frames.find((x) => x.id === st.activeFrame);
    const isLand = st.orientation === 'landscape';
    const cw = isLand ? 360 : 360, ch = isLand ? 202 : 640;
    const src = fr ? (isLand && fr.sourceLandscape ? fr.sourceLandscape : fr.source) : '';
    stopSeq();
    box.innerHTML = `
      ${fr ? `<img id="plFrameImg" src="${src}" class="${st.type === 'motion' && !(fr.seq && fr.seq.length > 1) ? 'kb' : ''}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain">`
        : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:13px">上传素材后显示</div>`}
      ${st.buttons.map((b) => {
        const u = st.uiAssets.find((x) => x.id === b.uiId);
        const bw = Math.round(cw * b.w), bh = Math.round(ch * b.h);
        return `<div class="pl-hotspot" data-i="${st.buttons.indexOf(b)}" style="position:absolute;left:${Math.round(cw * b.x)}px;top:${Math.round(ch * b.y)}px;width:${bw}px;height:${bh}px;${u ? '' : 'border:2px dashed #4f7cff;'}cursor:grab;z-index:5">${u ? `<img src="${u.source}" style="width:100%;height:100%;object-fit:contain;pointer-events:none">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#4f7cff;font-size:10px">${UI.escapeHtml(b.label || '按钮')}</div>`}</div>`;
      }).join('')}
      ${st.showCta ? `<div style="position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:10px 26px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-weight:700;border-radius:22px;font-size:15px;z-index:4;box-shadow:0 4px 16px rgba(0,0,0,.4)">${UI.escapeHtml(st.ctaLabel)}</div>` : ''}`;
    // 动态场景（视频帧序列）：预览轮播 = 迷你视频
    const pimg = box.querySelector('#plFrameImg');
    if (pimg && fr && fr.seq && fr.seq.length > 1) {
      let i = 0;
      const ms = Math.min(500, Math.max(90, Math.round(((fr.dur || 3) / fr.seq.length) * 1000)));
      seqTimer = setInterval(() => { i = (i + 1) % fr.seq.length; pimg.src = fr.seq[i]; }, ms);
    }

    // 按钮拖拽（归一化坐标）
    box.querySelectorAll('.pl-hotspot').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        const i = Number(item.dataset.i);
        const b = st.buttons[i];
        st.dragging = { i, item, cw, ch, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y };
        item.style.cursor = 'grabbing'; e.preventDefault(); e.stopPropagation();
      });
    });
  }

  // 拖拽全局单例
  document.addEventListener('mousemove', (e) => {
    const d = st.dragging;
    if (!d) return;
    const b = st.buttons[d.i];
    b.x = Math.min(Math.max(d.ox + (e.clientX - d.sx) / d.cw, 0), 1 - b.w);
    b.y = Math.min(Math.max(d.oy + (e.clientY - d.sy) / d.ch, 0), 1 - b.h);
    d.item.style.left = Math.round(b.x * d.cw) + 'px';
    d.item.style.top = Math.round(b.y * d.ch) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!st.dragging) return;
    st.dragging = null;
    save();
  });

  function bindConfigEvents(el) {
    const file = el.querySelector('#plFile');
    const drop = el.querySelector('#plDrop');
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); addFiles(Array.from(e.dataTransfer.files || [])); });
    file.addEventListener('change', () => { addFiles(Array.from(file.files || [])); file.value = ''; });

    el.querySelector('#plUiPick').addEventListener('click', () => el.querySelector('#plUiFile').click());
    el.querySelector('#plUiFile').addEventListener('change', (e) => { addUiFiles(Array.from(e.target.files || [])); e.target.value = ''; });

    el.querySelectorAll('[data-act]').forEach((c) => c.addEventListener('click', () => { st.activeFrame = c.dataset.act; save(); render(el); }));
    el.querySelectorAll('.pl-f-del').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      st.frames = st.frames.filter((x) => x.id !== id);
      st.buttons = st.buttons.filter((x) => x.target !== id); // 清掉指向该帧的按钮
      if (st.activeFrame === id) st.activeFrame = st.frames[0]?.id || null;
      save(); render(el);
    }));
    el.querySelectorAll('.pl-u-del').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id;
      st.uiAssets = st.uiAssets.filter((x) => x.id !== id);
      st.buttons = st.buttons.filter((x) => x.uiId !== id);
      save(); render(el);
    }));

    el.querySelectorAll('[data-tpl]').forEach((c) => c.addEventListener('click', () => applyTemplate(c.dataset.tpl)));
    el.querySelector('#plAnalyze').addEventListener('click', () => analyzeFrame());
    el.querySelector('#plShowCta').addEventListener('change', (e) => { st.showCta = e.target.checked; save(); render(el); });
    el.querySelector('#plAiNotes')?.addEventListener('input', (e) => { st.aiNotes = e.target.value; save(); });
    // 方向切换
    el.querySelector('#plOriPortrait').addEventListener('click', () => { st.orientation = 'portrait'; save(); render(el); });
    el.querySelector('#plOriLandscape').addEventListener('click', () => { st.orientation = 'landscape'; save(); render(el); });
    // 配音
    el.querySelector('#plAudioPick').addEventListener('click', () => el.querySelector('#plAudioFile').click());
    el.querySelector('#plAudioFile').addEventListener('change', (e) => { pickAudio(e, el); e.target.value = ''; });
    el.querySelector('#plAudioRemove')?.addEventListener('click', () => { st.audio = null; save(); render(el); });
    el.querySelector('#plUseOrigAudio').addEventListener('change', (e) => { st.useOriginalAudio = e.target.checked; save(); });
    // 横版素材
    el.querySelector('#plSetLandscape')?.addEventListener('click', () => el.querySelector('#plLandscapeFile').click());
    el.querySelector('#plLandscapeFile')?.addEventListener('change', (e) => { setFrameLandscape(e, el); e.target.value = ''; });

    el.querySelector('#plAddBtn').addEventListener('click', () => {
      if (!st.frames.length) return UI.toast('请先上传素材', 'warn');
      const ui = st.uiAssets[0];
      st.buttons.push({ id: uid('b'), uiId: ui?.id || null, target: st.frames[0].id, x: 0.3, y: 0.66, w: ui ? 0.4 : 0.44, h: ui ? 0.24 : 0.16, label: '点击继续' });
      save(); render(el);
    });
    el.querySelectorAll('.pl-b-del').forEach((b) => b.addEventListener('click', () => { st.buttons.splice(Number(b.dataset.i), 1); save(); render(el); }));
    el.querySelectorAll('.pl-b-ui').forEach((s) => s.addEventListener('change', (e) => { st.buttons[Number(s.dataset.i)].uiId = e.target.value; save(); renderPreview(el); }));
    el.querySelectorAll('.pl-b-target').forEach((s) => s.addEventListener('change', (e) => { st.buttons[Number(s.dataset.i)].target = e.target.value; save(); render(el); }));

    el.querySelector('#plPlay').addEventListener('input', (e) => { st.playUrl = e.target.value; save(); });
    el.querySelector('#plIos').addEventListener('input', (e) => { st.iosUrl = e.target.value; save(); });
    el.querySelector('#plChannel').addEventListener('change', (e) => { st.channel = e.target.value; save(); });
    el.querySelector('#plName').addEventListener('input', (e) => { st.name = e.target.value; save(); });
    el.querySelector('#plCta').addEventListener('input', (e) => { st.ctaLabel = e.target.value; save(); });

    el.querySelector('#plExport').addEventListener('click', () => exportPlayable());
  }

  /* ---------- 导出 HTML ---------- */
  function exportPlayable() {
    if (exporting) return;
    if (st.showCta && !st.playUrl && !st.iosUrl) { UI.toast('显示 CTA 需要至少填写一个商店链接（或在②关闭「显示 CTA」）', 'warn', 6000); return; }
    if (!st.frames.length) { UI.toast('请先上传素材', 'warn'); return; }

    exporting = true;
    const name = (st.name || 'playable').trim() || 'playable';
    resultName = name.replace(/[\\/:*?"<>|]/g, '_');
    resultHtml = buildPlayableHtml();
    exporting = false;
    mode = 'done';
    render(document.querySelector('#content'));
  }

  function buildPlayableHtml() {
    const motion = st.type === 'motion'; // 微动 = CSS Ken Burns（导出即动，零等待零体积）
    const showCta = st.showCta;
    const isApplovin = st.channel === 'Applovin';
    const lastFrameId = st.frames[st.frames.length - 1].id;
    const audioSrc = st.audio ? st.audio.source : '';
    // 舞台设计尺寸：竖版 720×1280 / 横版 1280×720（素材按舞台 contain 完整显示，比例不变形）
    const W = 720, H = 1280, WL = 1280, HL = 720;

    // 帧定义（视频场景带 seq 帧序列 → 自动轮播=迷你视频；图片场景静态图）
    const framesJs = st.frames.map((f) => {
      const seq = (f.seq && f.seq.length > 1) ? f.seq : null;
      const dur = f.dur || 3;
      return `{id:"${f.id}",seq:${seq ? JSON.stringify(seq) : 'null'},dur:${dur},src:${JSON.stringify(f.source)},land:${JSON.stringify(f.sourceLandscape || '')}}`;
    }).join(',');
    // 按钮定义
    const btnsJs = st.buttons.map((b) => {
      const u = st.uiAssets.find((x) => x.id === b.uiId);
      const src = u ? u.source : '';
      const ratio = (u && u.w && u.h) ? u.h / u.w : 0.4;
      return `{x:${b.x.toFixed(4)},y:${b.y.toFixed(4)},w:${b.w.toFixed(4)},h:${b.h.toFixed(4)},ratio:${ratio.toFixed(3)},src:${JSON.stringify(src)},target:${JSON.stringify(b.target)},label:${JSON.stringify(b.label || '点击继续')}}`;
    }).join(',');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>${UI.escapeHtml(resultName)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{width:100%;height:100%;background:#000;overflow:hidden;touch-action:manipulation;user-select:none;-webkit-user-select:none}
/* 固定设计尺寸舞台 + transform scale 等比缩放（参考 KR_V1947 fit 方案） */
#stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1);
  width:${W}px;height:${H}px;transform-origin:center center;overflow:hidden;background:#000}
#stage.landscape{width:${WL}px;height:${HL}px}
/* 帧切换：淡入淡出（参考 KR_V1947 .sc 过渡） */
.frame{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .28s ease;pointer-events:none}
.frame.on{opacity:1}
/* 微动：静态图缓慢放大呼吸（Ken Burns 近似，纯 CSS 零体积） */
.frame.on.kb{animation:kb 7s ease-in-out infinite alternate}
@keyframes kb{from{transform:scale(1)}to{transform:scale(1.07)}}
/* 互动按钮（大按钮 + 弹跳 + 脉冲光晕，参考 KR_V1947 .opt/hot） */
.hotspot{position:absolute;cursor:pointer;z-index:5;background:transparent;display:flex;align-items:center;justify-content:center;transition:transform .12s,box-shadow .18s}
.hotspot img{width:100%;height:100%;object-fit:contain;pointer-events:none;filter:drop-shadow(0 4px 14px rgba(0,0,0,.55))}
.hotspot.hot{animation:bob 1.15s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(7px)}}
.hotspot:active{transform:scale(.965)}
/* 无图热区兜底样式（虚线框大按钮） */
.hotspot.bare{border:3px dashed rgba(79,124,255,.85);border-radius:14px;background:rgba(20,30,60,.45);color:#dbe6ff;font-weight:700;display:flex;align-items:center;justify-content:center;text-align:center}
/* CTA 下载按钮 */
#cta{position:absolute;left:50%;bottom:4%;transform:translateX(-50%);padding:16px 42px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-weight:800;border-radius:30px;font-size:18px;z-index:9;box-shadow:0 6px 22px rgba(0,0,0,.5),0 0 0 0 rgba(34,197,94,.55);letter-spacing:.5px;white-space:nowrap;animation:ctaPulse 1.6s ease-out infinite}
#cta:active{transform:translateX(-50%) scale(.96)}
/* Ken Burns 微动（浏览器原生，零等待零体积） */
.kb{animation:plKB 9s ease-in-out infinite alternate;transform-origin:50% 50%;will-change:transform}
.kb2{animation:plKB2 11s ease-in-out infinite alternate;transform-origin:50% 50%}
@keyframes plKB{from{transform:scale(1) translate(0,0)}to{transform:scale(1.16) translate(-1.5%,1%)}}
@keyframes plKB2{from{transform:scale(1.14) translate(1.5%,-1%)}to{transform:scale(1) translate(0,0)}}
@keyframes ctaPulse{0%{box-shadow:0 6px 22px rgba(0,0,0,.5),0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 6px 22px rgba(0,0,0,.5),0 0 0 18px rgba(34,197,94,0)}100%{box-shadow:0 6px 22px rgba(0,0,0,.5),0 0 0 0 rgba(34,197,94,0)}}
/* 进度点（参考 KR_V1947 prog） */
#prog{position:absolute;top:3.2%;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:7}
.pd{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.28);border:1px solid rgba(0,0,0,.3)}
.pd.act{background:#fff;box-shadow:0 0 6px rgba(255,255,255,.8)}
.pd.done{background:rgba(34,197,94,.85)}
/* 引导手指（SVG + 点击动画 + 脉冲圈） */
#hand{position:absolute;width:64px;height:78px;z-index:8;pointer-events:none;display:none}
#hand.on,#hand[class~=on]{display:block;animation:tap 1.15s ease-in-out infinite}
@keyframes tap{0%,100%{transform:translate(0,0) scale(1)}46%{transform:translate(-7px,-11px) scale(.9)}}
</style>
</head>
<body>
<div id="stage">
  <div id="prog"></div>
  <svg id="hand" viewBox="0 0 64 78" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="hs" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.45"/></filter></defs>
    <g filter="url(#hs)">
      <path d="M28 8c0-4.4 3.6-8 8-8s8 3.6 8 8v26l6.5-4.8c5.9-4.3 14.3-2.2 16.8 4.3 1.2 3.2.7 6.8-1.4 9.6L48.9 64.6C45 69.6 39.1 72.5 32.8 72.5h-4.3C17.9 72.5 9 63.6 9 53V33c0-3.9 3.2-7 7-7s7 3.1 7 7v3" fill="#ffffff" stroke="#d8dde8" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="52" cy="52" r="10" fill="rgba(34,197,94,.30)"><animate attributeName="r" values="8;16;8" dur="1.15s" repeatCount="indefinite"/><animate attributeName="opacity" values=".55;.05;.55" dur="1.15s" repeatCount="indefinite"/></circle>
    </g>
  </svg>
</div>
<script>
window.__PLATFORM = ${JSON.stringify(st.channel)};
var STORE = { ios: ${JSON.stringify(st.iosUrl)}, android: ${JSON.stringify(st.playUrl)} };
var FRAMES = [${framesJs}];
var BUTTONS = [${btnsJs}];
var CTA_LABEL = ${JSON.stringify(st.ctaLabel)};
var SHOW_CTA = ${showCta ? 'true' : 'false'};
var LAST_FRAME = ${JSON.stringify(lastFrameId)};
var AUDIO = ${JSON.stringify(audioSrc)};
var KB = ${motion ? 'true' : 'false'}; // 微动模式：帧应用 Ken Burns 动画
var STAGE_P = { w: ${W}, h: ${H} };   // 竖版舞台
var STAGE_L = { w: ${WL}, h: ${HL} }; // 横版舞台

function isLandscape(){ return (window.innerWidth > window.innerHeight); }
function frameSrc(f){ return (isLandscape() && f.land) ? f.land : f.src; }

/* ===== 自适应缩放（参考 KR_V1947 fit）：舞台等比缩放居中，比例永不变形 ===== */
var stageEl = document.getElementById('stage');
function fit(){
  var st = isLandscape() && hasLandscapeFrame() ? STAGE_L : STAGE_P;
  stageEl.classList.toggle('landscape', st === STAGE_L);
  var s = Math.min(window.innerWidth / st.w, window.innerHeight / st.h);
  stageEl.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  layoutHotspots(st);
  showHandOnFirst();
}
function hasLandscapeFrame(){
  for(var i=0;i<FRAMES.length;i++){ if(FRAMES[i].land){ return true; } }
  return false;
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', function(){ setTimeout(fit, 80); });

function track(evt){
  try{
    if(window.ALPlayableAnalytics && ALPlayableAnalytics.trackEvent){ ALPlayableAnalytics.trackEvent(evt); }
    if(window.PlayableSDK && PlayableSDK.trackEvent){ PlayableSDK.trackEvent(evt); }
  }catch(e){}
}
/* 当前帧索引 */
function frameIndex(id){ for(var i=0;i<FRAMES.length;i++){ if(FRAMES[i].id===id) return i; } return 0; }
function drawProg(curIdx){
  var prog = document.getElementById('prog');
  if(!prog || FRAMES.length < 2) return;
  var html = '';
  for(var i=0;i<FRAMES.length;i++){
    html += '<div class="pd' + (i<curIdx?' done':(i===curIdx?' act':'')) + '"></div>';
  }
  prog.innerHTML = html;
}
function switchFrame(id){
  var els = document.querySelectorAll('.frame');
  for(var i=0;i<els.length;i++){ els[i].classList.toggle('on', els[i].dataset.id===id); }
  drawProg(frameIndex(id));
  playSeqFor(id);
  if(id === LAST_FRAME){ track('ENDCARD_SHOWN'); }
  showHandOnFirst();
}
/* ===== 动态场景：帧序列轮播（视频抽帧 → 迷你视频），当前画面真实在动 ===== */
var _seqT = null, _seqImg = null, _seqArr = null, _seqI = 0;
function stopSeqPlay(){ if(_seqT){ clearInterval(_seqT); _seqT = null; } _seqImg = null; _seqArr = null; }
function playSeqFor(id){
  stopSeqPlay();
  var f = null; for(var i=0;i<FRAMES.length;i++){ if(FRAMES[i].id===id){ f = FRAMES[i]; break; } }
  if(!f || !f.seq || f.seq.length < 2) return;
  if(f.land && isLandscape()) return; // 横屏有横版素材时用静态横版
  var im = document.querySelector('.frame.on');
  if(!im) return;
  _seqArr = f.seq; _seqI = 0; _seqImg = im;
  im.src = _seqArr[0];
  var ms = Math.min(500, Math.max(80, Math.round(((f.dur || 3) / f.seq.length) * 1000)));
  _seqT = setInterval(function(){
    if(!_seqImg || !_seqArr) return;
    _seqI = (_seqI + 1) % _seqArr.length;
    _seqImg.src = _seqArr[_seqI];
  }, ms);
}
var started = false;
function onInteract(){
  if(!started){ started = true; track('CHALLENGE_STARTED'); }
}
function download(){
  track('CTA_CLICKED');
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua);
  var url = isIOS ? STORE.ios : STORE.android;
  if(!url) url = STORE.android || STORE.ios;
  try{
    if(window.FbPlayableAd && FbPlayableAd.onCTAClick){ FbPlayableAd.onCTAClick(); return; }
  }catch(e){}
  if(url){ window.open(url, '_top'); }
  try{ if(window.gameEnd) gameEnd(); }catch(e){}
}

/* 热区按当前舞台尺寸布局（归一化坐标 → 画布像素），保证手指可点中 */
function layoutHotspots(st){
  var hotspots = document.querySelectorAll('.hotspot');
  for(var i=0;i<hotspots.length;i++){
    var b = BUTTONS[i]; if(!b) break;
    var w = Math.round(st.w * b.w);
    var h = Math.round(w * b.ratio);
    hotspots[i].style.left = Math.round(st.w * b.x) + 'px';
    hotspots[i].style.top = Math.round(st.h * b.y) + 'px';
    hotspots[i].style.width = w + 'px';
    hotspots[i].style.height = h + 'px';
  }
  var cta = document.getElementById('cta');
  if(cta){ cta.style.bottom = Math.round(st.h * 0.04) + 'px'; }
}

/* 引导手指：指向当前可见帧的第一个可点热区（点击后隐藏）。SVG className 需用 setAttribute */
function showHandOnFirst(){
  var hand = document.getElementById('hand');
  var onFrame = document.querySelector('.frame.on');
  if(!hand || !onFrame || !BUTTONS.length){ hand.setAttribute('class',''); clearHot(); return; }
  var curId = onFrame.dataset.id;
  var idx = -1;
  for(var i=0;i<BUTTONS.length;i++){
    var t = BUTTONS[i].target;
    if(t !== curId){ idx = i; break; }
  }
  var hotspots = document.querySelectorAll('.hotspot');
  // 清掉旧的 hot 高亮
  for(var k=0;k<hotspots.length;k++){ hotspots[k].classList.remove('hot'); }
  var el = idx >= 0 ? hotspots[idx] : null;
  if(!el){ hand.setAttribute('class',''); return; }
  // 当前帧可点按钮：弹跳高亮 + 手指指向
  el.classList.add('hot');
  var w = el.offsetWidth || 80, h = el.offsetHeight || 60;
  hand.style.left = (el.offsetLeft + w * 0.62) + 'px';
  hand.style.top = (el.offsetTop + h * 0.42) + 'px';
  hand.setAttribute('class','on');
}
function clearHot(){
  var hotspots = document.querySelectorAll('.hotspot');
  for(var k=0;k<hotspots.length;k++){ hotspots[k].classList.remove('hot'); }
}
function hideHand(){ var hand = document.getElementById('hand'); if(hand) hand.setAttribute('class',''); clearHot(); }

function build(){
  for(var i=0;i<FRAMES.length;i++){
    var f = FRAMES[i];
    var el = document.createElement('img');
    el.src = frameSrc(f);
    // 动态场景（seq）轮播本身就在动；静态帧且启用微动 → Ken Burns
    el.className = 'frame' + ((KB && !f.seq) ? (i % 2 ? ' kb2' : ' kb') : '');
    el.dataset.id = f.id;
    stageEl.appendChild(el);
  }
  if(AUDIO){
    var a = document.createElement('audio');
    a.src = AUDIO; a.loop = true; a.autoplay = true; a.setAttribute('playsinline','');
    document.body.appendChild(a);
    var tryPlay = function(){ a.play && a.play().catch(function(){}); };
    tryPlay();
    document.addEventListener('touchstart', tryPlay, { once: true });
  }
  for(var j=0;j<BUTTONS.length;j++){
    var b = BUTTONS[j];
    var hs = document.createElement('div');
    hs.className = 'hotspot' + (b.src ? '' : ' bare');
    if(b.src){ var im = document.createElement('img'); im.src = b.src; hs.appendChild(im); }
    else { hs.textContent = b.label || '点击继续'; }
    (function(tgt){
      var fire = function(ev){ if(ev && ev.cancelable) ev.preventDefault(); onInteract(); hideHand(); if(tgt==='__cta__'){ download(); } else { switchFrame(tgt); } };
      hs.addEventListener('click', fire);           // 桌面
      hs.addEventListener('touchend', fire);        // 移动端手指
    })(b.target);
    stageEl.appendChild(hs);
  }
  if(SHOW_CTA){
    var cta = document.createElement('div');
    cta.id = 'cta'; cta.textContent = CTA_LABEL;
    var ctaFire = function(ev){ if(ev && ev.cancelable) ev.preventDefault(); hideHand(); download(); };
    cta.addEventListener('click', ctaFire);
    cta.addEventListener('touchend', ctaFire);
    stageEl.appendChild(cta);
  }
  switchFrame(FRAMES[0].id);
  fit();
  // 横竖屏切换时刷新素材源 + 重新布局（动态 seq 帧仅在横屏且有 land 时切换静态横版）
  window.addEventListener('resize', function(){
    var onEl = document.querySelector('.frame.on');
    var onId = onEl ? onEl.dataset.id : null;
    stopSeqPlay();
    var els = document.querySelectorAll('.frame');
    for(var k=0;k<els.length;k++){
      var fid = els[k].dataset.id;
      var fr = null; for(var m=0;m<FRAMES.length;m++){ if(FRAMES[m].id===fid){ fr=FRAMES[m]; break; } }
      if(fr && fr.land){ els[k].src = frameSrc(fr); }
    }
    if(onId) playSeqFor(onId);
    fit();
  });
}

try{ track('LOADING'); }catch(e){}
try{ track('DISPLAYED'); }catch(e){}
if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', build); } else { build(); }
</script>
</body>
</html>`;
  }

  function renderDone(el) {
    const size = resultHtml ? Math.round(resultHtml.length / 1024) : 0;
    el.innerHTML = `
      <div class="card" style="max-width:760px;margin:0 auto">
        <div class="card-title"><span class="ico">🎉</span>试玩广告已生成</div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:8px">📄 文件：<b>${UI.escapeHtml(resultName)}.html</b> · ${size} KB（单文件，含全部素材内嵌）</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="btn btn-primary" id="plDownload">⬇ 下载 HTML</button>
          <button class="btn" id="plPreviewOpen">👁️ 预览试玩</button>
          <button class="btn btn-ghost" id="plBack">← 返回编辑</button>
        </div>
        <div style="border:1px solid var(--border-light);border-radius:10px;padding:10px;font-size:12px;color:var(--text-3);line-height:1.8">
          <b style="color:var(--text-1)">打包规则核对：</b><br>
          • 玩法模板：${UI.escapeHtml(TEMPLATES[st.template]?.label || st.template)}<br>
          • 试玩渠道：${UI.escapeHtml(st.channel)}${st.channel === 'Google' ? '（Google 建议提交 .zip 打包，下载后请自行压缩为 zip）' : ''}<br>
          • 打点：${st.channel === 'Applovin' ? '✅ AppLovin 渠道已埋点（LOADING/DISPLAYED/CHALLENGE_STARTED/ENDCARD_SHOWN/CTA_CLICKED）' : 'ℹ️ 非 AppLovin 渠道，CTA 直接跳转商店（无埋点）'}<br>
          • CTA：${st.showCta ? '显示（点击跳转商店）' : '已关闭（纯体验/展示，不跳转）'}<br>
          • 商店：Google Play ${st.playUrl ? '✅' : '⚠️ 未填'} / App Store ${st.iosUrl ? '✅' : '⚠️ 未填'}<br>
          • 画面：${st.frames.length} 张 · 按钮：${st.buttons.length} 个 · 类型：${st.type === 'motion' ? '微动（CSS Ken Burns，导出即动）' : '平面试玩'}<br>
          • 命名：${UI.escapeHtml(resultName)}.html
        </div>
        <p style="font-size:11px;color:var(--text-3);margin-top:10px;line-height:1.7">💡 说明：试玩为固定舞台等比缩放（参考 KR_V1947 方案），素材比例不变形；带引导手指动画，按钮同时响应点击与触摸。素材库中的 <b>3D 玩法试玩</b>（如「张飞战吕布」）基于 Cocos Creator 3D 引擎，需由研发用引擎制作，本工具暂不支持自动生成——如已有现成 3D 试玩 HTML，可直接复用。</p>
      </div>`;
    el.querySelector('#plDownload').addEventListener('click', () => {
      const blob = new Blob([resultHtml], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = resultName + '.html';
      a.click();
      try { Store.add({ type: 'project', kind: 'playable', title: `试玩 ${resultName}`, url: a.href, duration: 0 }); } catch { /* ignore */ }
      UI.toast('已开始下载', 'ok');
    });
    el.querySelector('#plPreviewOpen').addEventListener('click', () => {
      const blob = new Blob([resultHtml], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    });
    el.querySelector('#plBack').addEventListener('click', () => { mode = 'config'; render(el); });
  }

  return { render };
})();
