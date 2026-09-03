/* ============================================================
 * editor.js — 智能剪辑（ffmpeg.wasm 0.12 单线程核心，浏览器端合成）
 * 素材池（AI 作品/本地素材/文字卡）→ 时间线 → 统一转码 +
 * 转场 → 拼接 → BGM 混音 → 导出 MP4 成片
 * 说明：0.12 单线程核心无 SharedArrayBuffer 依赖，
 *       静态托管（无 COOP/COEP 头）也能正常加载，异地分享版可用
 * ============================================================ */
window.EditorView = (() => {
  const LS_KEY = 'materall_timeline';
  // 剪辑引擎：优先本地内置（public/vendor/ffmpeg），CDN 兜底
  const FFMPEG_JS = location.origin + '/vendor/ffmpeg/ffmpeg.js';
  const CORE_SETS = [
    { core: location.origin + '/vendor/ffmpeg/ffmpeg-core.js', wasm: location.origin + '/vendor/ffmpeg/ffmpeg-core.wasm' },
    { core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js', wasm: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm' },
    { core: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js', wasm: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm' },
  ];

  let ffmpeg = null;          // FFmpeg 实例
  let ffmpegLoaded = false;
  let assets = [];            // 素材池 {id,name,type,source}
  let timeline = [];          // 时间线片段 {id, assetId, name, type, source, duration, originalDur}
  let selectedId = null;
  let exporting = false;

  /* ---------- 批量加工（批量剪裁/换尾板/抽帧/静音/压缩）状态 ---------- */
  let editorMode = 'timeline';   // timeline | batch
  let bFiles = [];               // [{file,name,dur,vw,vh,url}] url=blob objectURL
  let bEnds = [];                // 尾板库 [{id,name,isImg,url,vw,vh,bucket,dur}]
  let bRunning = false;
  let bCancel = false;
  let bResults = [];             // [{name,url,ok,err,imgs}]

  /* ---------- 持久化 ---------- */
  function saveTL() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(timeline.map((c) => ({
        id: c.id, assetId: c.assetId, name: c.name, type: c.type,
        source: c.source, duration: c.duration, originalDur: c.originalDur,
      }))));
    } catch { /* ignore */ }
  }
  function loadTL() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      if (Array.isArray(raw)) timeline = raw;
    } catch { timeline = []; }
  }

  /* ---------- 渲染 ---------- */
  function render(el) {
    loadTL();
    el.innerHTML = `
      <div class="tabs mode-tabs" style="margin-bottom:14px">
        <button class="tab ${editorMode === 'timeline' ? 'active' : ''}" data-m="timeline">🎞️ 时间线剪辑</button>
        <button class="tab ${editorMode === 'batch' ? 'active' : ''}" data-m="batch">⚡ 批量加工</button>
      </div>
      <div id="edModeBody">${editorMode === 'timeline' ? timelineLayout() : batchLayout()}</div>`;

    el.querySelectorAll('.mode-tabs .tab').forEach((t) => {
      t.addEventListener('click', () => {
        if (editorMode === t.dataset.m) return;
        editorMode = t.dataset.m;
        render(el);
      });
    });

    if (editorMode === 'timeline') {
      bindEvents(el);
      renderAssets(el);
      renderTrack(el);
      updateTotalDur();
    } else {
      bindBatch(el);
    }
  }

  /* 时间线剪辑布局（原编辑器主体） */
  function timelineLayout() {
    return `
      <div class="editor-layout">
        <div class="editor-assets">
          <div class="card">
            <div class="card-title"><span class="ico">📦</span>素材池</div>
            <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px">
              <button class="btn btn-sm" id="edUpload">📁 本地上传</button>
              <button class="btn btn-sm" id="edCard">🔤 新建文字卡</button>
              <button class="btn btn-sm" id="edFromGallery">🗂️ 从作品中心</button>
            </div>
            <input type="file" id="edFile" accept="video/*,image/*" multiple style="display:none">
            <div class="asset-list" id="edAssetList"></div>
          </div>
          <div class="card">
            <div class="card-title"><span class="ico">🎵</span>背景音乐</div>
            <input type="file" id="edBgmFile" accept="audio/*" style="display:none">
            <div style="display:flex;gap:7px;align-items:center">
              <button class="btn btn-sm" id="edBgmPick">📁 选择 BGM</button>
              <span id="edBgmName" style="font-size:11.5px;color:var(--text-3)">未选择</span>
              <button class="btn-icon" id="edBgmClear" title="移除" style="display:none">✕</button>
            </div>
            <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)">
              BGM 音量 <input type="range" id="edBgmVol" min="0" max="100" value="35" style="flex:1;accent-color:var(--primary-2)">
            </div>
          </div>
        </div>

        <div class="editor-main">
          <div class="editor-canvas" id="edCanvas">
            <div class="empty" id="edCanvasEmpty">👆 从素材池拖入或点击添加片段到时间线<br>选择片段后在此预览</div>
            <video id="edPreview" controls style="display:none;width:100%;height:100%;background:#000"></video>
          </div>
          <div class="card timeline">
            <div class="timeline-head">
              <span style="font-weight:700;font-size:13.5px">🎞️ 时间线（${timeline.length} 个片段）</span>
              <div style="display:flex;gap:7px">
                <button class="btn btn-sm" id="edClear">清空</button>
              </div>
            </div>
            <div class="timeline-track" id="edTrack">
              ${timeline.length ? '' : `<div class="empty-state" style="width:100%;padding:20px"><p>点击素材或拖拽到此处添加片段</p></div>`}
            </div>
          </div>
          <div class="editor-ops">
            <label class="field" style="margin:0;display:flex;align-items:center;gap:8px">
              <span class="field-label" style="margin:0">画布</span>
              <select class="input" id="edRatio" style="width:auto;padding:6px 30px 6px 10px">
                <option value="16:9">16:9 横屏</option>
                <option value="9:16">9:16 竖屏</option>
              </select>
            </label>
            <label class="field" style="margin:0;display:flex;align-items:center;gap:8px">
              <span class="field-label" style="margin:0">质量</span>
              <select class="input" id="edQuality" style="width:auto;padding:6px 30px 6px 10px">
                <option value="720">720P（推荐）</option>
                <option value="480">480P（更快）</option>
              </select>
            </label>
            <span style="flex:1"></span>
            <span id="edTotalDur" style="font-size:12px;color:var(--text-3)"></span>
            <button class="btn btn-primary" id="edExport">🚀 导出成片</button>
          </div>
          <div id="edExportStatus" class="editor-export-status"></div>
        </div>
      </div>`;
  }

  function bindEvents(el) {
    const fileInput = el.querySelector('#edFile');
    el.querySelector('#edUpload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const f of Array.from(fileInput.files || [])) {
        const type = f.type.startsWith('video') ? 'video' : 'image';
        const source = await UI.fileToDataUrl(f);
        addAsset({ name: f.name.replace(/\.[^.]+$/, ''), type, source });
      }
      fileInput.value = '';
      renderAssets(el);
      UI.toast('素材已加入素材池，点击添加到时间线', 'ok');
    });

    el.querySelector('#edCard').addEventListener('click', () => cardDialog(el));
    el.querySelector('#edFromGallery').addEventListener('click', () => galleryDialog(el));

    // BGM
    el.querySelector('#edBgmPick').addEventListener('click', () => el.querySelector('#edBgmFile').click());
    el.querySelector('#edBgmFile').addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      window.MA.bgm = { name: f.name, source: await UI.fileToDataUrl(f) };
      el.querySelector('#edBgmName').textContent = f.name;
      el.querySelector('#edBgmClear').style.display = '';
      UI.toast('BGM 已添加', 'ok');
    });
    el.querySelector('#edBgmClear').addEventListener('click', () => {
      window.MA.bgm = null;
      el.querySelector('#edBgmName').textContent = '未选择';
      el.querySelector('#edBgmClear').style.display = 'none';
    });

    el.querySelector('#edClear').addEventListener('click', () => {
      if (timeline.length && confirm('清空时间线？')) {
        timeline = [];
        saveTL();
        renderTrack(el);
        updateTotalDur();
      }
    });

    el.querySelector('#edExport').addEventListener('click', () => exportVideo(el));
  }

  /* ---------- 素材池 ---------- */
  function addAsset({ name, type, source }) {
    const id = UI.uid('as');
    assets = [{ id, name, type, source }, ...assets].slice(0, 60);
    // 首次加载 ffmpeg（需要时）
    ensureFFmpeg();
    return id;
  }

  function renderAssets(el) {
    const list = el.querySelector('#edAssetList');
    const works = []; // 不在此处加载作品，统一通过 dialog
    void works;
    if (assets.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding:14px"><p style="font-size:12px">暂无素材<br>上传文件 / 创建文字卡 / 从作品中心导入</p></div>`;
      return;
    }
    list.innerHTML = assets.map((a) => `
      <div class="asset-item" data-id="${a.id}" title="点击添加到时间线">
        <div class="thumb">
          ${a.type === 'video' ? `<video src="${a.source}" muted preload="metadata"></video>`
            : a.type === 'image' ? `<img src="${a.source}">`
            : `<span class="ct-ico">🔤</span>`}
        </div>
        <div class="meta">
          <div class="t">${UI.escapeHtml(a.name || '素材')}</div>
          <div class="s">${a.type === 'video' ? '视频' : a.type === 'image' ? '图片' : '文字卡'}</div>
        </div>
        <button class="btn-icon" data-del="${a.id}" title="移除">🗑</button>
      </div>`).join('');

    list.querySelectorAll('.asset-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        const a = assets.find((x) => x.id === item.dataset.id);
        if (a) addClip(a);
      });
      item.querySelector('[data-del]').addEventListener('click', () => {
        assets = assets.filter((x) => x.id !== item.dataset.id);
        renderAssets(el);
      });
    });
  }

  /* ---------- 时间线 ---------- */
  async function addClip(asset, opts = {}) {
    let duration = opts.duration;
    if (!duration) {
      duration = await probeDuration(asset);
    }
    const clip = {
      id: UI.uid('cl'),
      assetId: asset.id,
      name: asset.name || '片段',
      type: asset.type,
      source: asset.source,
      duration: Math.round((duration || 5) * 100) / 100,
      originalDur: Math.round((duration || 5) * 100) / 100,
    };
    timeline.push(clip);
    saveTL();
    const el = document.querySelector('#content');
    if (el) {
      renderTrack(el);
      updateTotalDur();
    }
    UI.toast(`已添加「${clip.name}」`, 'ok', 1500);
    return clip;
  }

  /** 探测媒体时长（video 元素） */
  function probeDuration(asset) {
    return new Promise((resolve) => {
      if (asset.type === 'image') return resolve(5);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve(v.duration || 5);
      v.onerror = () => resolve(5);
      v.src = asset.source;
      setTimeout(() => resolve(5), 4000); // 兜底
    });
  }

  function renderTrack(el) {
    const track = el.querySelector('#edTrack');
    if (timeline.length === 0) {
      track.innerHTML = `<div class="empty-state" style="width:100%;padding:20px"><p>点击素材或拖拽到此处添加片段</p></div>`;
      return;
    }
    track.innerHTML = timeline.map((c, i) => `
      <div class="clip-item ${c.id === selectedId ? 'active' : ''}" data-id="${c.id}" draggable="true" title="${UI.escapeHtml(c.name)}">
        <button class="clip-x" data-x="${c.id}">✕</button>
        <div class="clip-thumb">
          ${c.type === 'video' ? `<video src="${c.source}" muted preload="metadata"></video>`
            : c.type === 'image' ? `<img src="${c.source}">`
            : `<span class="ct-ico">🔤</span>`}
        </div>
        <div class="clip-bar">
          <span class="nm">${i + 1}. ${UI.escapeHtml(c.name.slice(0, 8))}</span>
          <span class="dur">${c.duration}s</span>
        </div>
      </div>`).join('');

    track.querySelectorAll('.clip-item').forEach((item) => {
      // 选中 & 预览
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-x]')) return;
        selectedId = item.dataset.id;
        renderTrack(el);
        previewClip(item.dataset.id);
      });
      // 删除
      item.querySelector('[data-x]').addEventListener('click', () => {
        timeline = timeline.filter((c) => c.id !== item.dataset.id);
        if (selectedId === item.dataset.id) { selectedId = null; hidePreview(el); }
        saveTL();
        renderTrack(el);
        updateTotalDur();
      });
      // 双击调时长
      item.addEventListener('dblclick', () => {
        const c = timeline.find((x) => x.id === item.dataset.id);
        if (!c) return;
        const v = prompt(`设置「${c.name}」时长（秒）`, c.duration);
        const n = parseFloat(v);
        if (n > 0 && n <= 60) {
          c.duration = Math.round(n * 100) / 100;
          saveTL();
          renderTrack(el);
          updateTotalDur();
        }
      });
      // 拖拽排序
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', item.dataset.id);
      });
    });

    // track 级拖放事件只绑定一次（避免重复渲染导致重复监听）
    if (!track.dataset.bound) {
      track.dataset.bound = '1';
      track.addEventListener('dragover', (e) => e.preventDefault());
      track.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        const target = e.target.closest('.clip-item');
        if (!id || !target) return;
        const from = timeline.findIndex((c) => c.id === id);
        const to = timeline.findIndex((c) => c.id === target.dataset.id);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = timeline.splice(from, 1);
        timeline.splice(to, 0, moved);
        saveTL();
        renderTrack(el);
        updateTotalDur();
      });
    }
  }

  function updateTotalDur() {
    const el = document.querySelector('#edTotalDur');
    if (el) {
      const total = timeline.reduce((s, c) => s + c.duration, 0);
      el.textContent = `总时长 ${UI.fmtDur(total)}`;
    }
  }

  function previewClip(id) {
    const c = timeline.find((x) => x.id === id);
    const canvas = document.querySelector('#edCanvas');
    const empty = document.querySelector('#edCanvasEmpty');
    const video = document.querySelector('#edPreview');
    if (!canvas || !video) return;
    empty.style.display = 'none';
    video.style.display = 'block';
    video.src = c.source;
    video.currentTime = 0;
    video.play().catch(() => {});
  }
  function hidePreview(el) {
    const empty = el.querySelector('#edCanvasEmpty');
    const video = el.querySelector('#edPreview');
    if (empty) empty.style.display = '';
    if (video) { video.style.display = 'none'; video.pause(); video.removeAttribute('src'); }
  }

  /* ---------- 文字卡 ---------- */
  function cardDialog(el) {
    UI.modal(`
      <label class="field"><span class="field-label">标题（大字）</span><input class="input" id="cardTitle" value="夏日限定"></label>
      <label class="field"><span class="field-label">副标题 / 说明</span><input class="input" id="cardSub" value="冰爽一夏 · 即刻畅饮"></label>
      <div class="grid grid-2" style="gap:10px">
        <label class="field"><span class="field-label">比例</span>
          <select class="input" id="cardRatio"><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option></select></label>
        <label class="field"><span class="field-label">风格</span>
          <select class="input" id="cardStyle">
            <option value="grad">渐变科技风</option>
            <option value="dark">暗黑高级风</option>
            <option value="light">清新亮色风</option>
          </select></label>
      </div>
      <label class="field"><span class="field-label">展示时长（秒）</span><input class="input" id="cardDur" type="number" value="3" min="1" max="15"></label>
      <button class="btn btn-primary btn-block" id="cardCreate">生成文字卡</button>
    `, { title: '创建文字卡（片头 / 转场 / 片尾）' });
    document.getElementById('cardCreate').addEventListener('click', () => {
      const title = document.getElementById('cardTitle').value.trim() || '标题';
      const sub = document.getElementById('cardSub').value.trim();
      const ratio = document.getElementById('cardRatio').value;
      const style = document.getElementById('cardStyle').value;
      const dur = parseFloat(document.getElementById('cardDur').value) || 3;
      const dataUrl = renderCard(title, sub, ratio, style);
      const id = addAsset({ name: `文字卡·${title.slice(0, 6)}`, type: 'image', source: dataUrl });
      const asset = assets.find((a) => a.id === id);
      addClip(asset, { duration: dur });
      UI.closeModal();
      UI.toast('文字卡已生成并加入时间线', 'ok');
    });
  }

  function renderCard(title, sub, ratio, style) {
    const W = 1280, H = ratio === '9:16' ? 1280 : 720;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const palettes = {
      grad: [['#6c5ce7', '#4f7cff'], ['#0b0e15', '#1a1038']],
      dark: [['#111827', '#000000'], ['#1f2937', '#111827']],
      light: [['#f8fafc', '#e2e8f0'], ['#0f172a', '#334155']],
    };
    const [bg, fg] = palettes[style] || palettes.grad;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 光晕
    const glow = ctx.createRadialGradient(W * 0.8, H * 0.15, 0, W * 0.8, H * 0.15, W * 0.55);
    glow.addColorStop(0, 'rgba(108,92,231,.28)');
    glow.addColorStop(1, 'rgba(108,92,231,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // 标题
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.min(W, H) * (sub ? 0.11 : 0.13);
    ctx.font = `800 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = fg[0];
    ctx.fillText(title, W / 2, H / 2 - (sub ? fs * 0.45 : 0));
    if (sub) {
      ctx.shadowBlur = 10;
      ctx.font = `500 ${fs * 0.38}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillStyle = fg[1];
      ctx.fillText(sub, W / 2, H / 2 + fs * 0.55);
    }
    return cv.toDataURL('image/png');
  }

  /* ---------- 作品中心导入 ---------- */
  async function galleryDialog(el) {
    const works = await Store.list();
    const usable = works.filter((w) => w.url || w.thumb);
    UI.modal(`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;max-height:420px;overflow-y:auto">
        ${usable.length ? usable.map((w) => `
          <div style="cursor:pointer;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;overflow:hidden" data-wid="${w.id}">
            <div style="aspect-ratio:16/10;background:#0a0d14;overflow:hidden">
              ${w.type === 'video'
                ? `<video src="${API.proxyUrl(w.url)}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>`
                : `<img src="${API.proxyUrl(w.url || w.thumb)}" style="width:100%;height:100%;object-fit:cover">`}
            </div>
            <div style="padding:6px 8px;font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escapeHtml(w.title || '作品')}</div>
          </div>`).join('')
        : '<div class="empty-state" style="grid-column:1/-1"><p>作品中心暂无素材</p></div>'}
      </div>
    `, { title: '从作品中心导入素材' });
    document.querySelectorAll('[data-wid]').forEach((box) => {
      box.addEventListener('click', async () => {
        const w = usable.find((x) => x.id === box.dataset.wid);
        if (!w) return;
        UI.closeModal();
        const source = w.url || w.thumb;
        let localSource = source;
        // 远程 URL 下载成本地 data URL，供 ffmpeg 使用
        if (/^http/.test(source)) {
          UI.toast('正在下载素材…', 'info', 2000);
          try {
            const blob = await API.fetchBlob(source);
            localSource = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = () => res(r.result);
              r.onerror = rej;
              r.readAsDataURL(blob);
            });
          } catch {
            UI.toast('素材下载失败，将使用网络地址（浏览器预览可用）', 'warn', 5000);
          }
        }
        const id = addAsset({ name: w.title || '作品', type: w.type === 'video' ? 'video' : 'image', source: localSource });
        const asset = assets.find((a) => a.id === id);
        await addClip(asset);
        const el = document.querySelector('#content');
        if (el) renderAssets(el);
      });
    });
  }

  /* ---------- 外部导入 ---------- */
  async function addRemote({ url, name, type }) {
    ensureFFmpeg();
    UI.toast('正在下载素材…', 'info', 2500);
    let source = url;
    try {
      const blob = await API.fetchBlob(url);
      source = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
    } catch {
      UI.toast('素材下载失败', 'err');
      return;
    }
    const id = addAsset({ name: name || '素材', type, source });
    const asset = assets.find((a) => a.id === id);
    await addClip(asset);
    const el = document.querySelector('#content');
    if (el) {
      renderAssets(el);
      renderTrack(el);
      updateTotalDur();
    }
  }

  /* ---------- ffmpeg ---------- */
  function ensureFFmpeg() {
    if (ffmpegLoaded || window.MA._ffmpegLoading) return;
    window.MA._ffmpegLoading = true;
    UI.toast('正在加载剪辑引擎（ffmpeg.wasm）…', 'info', 3000);
    const script = document.createElement('script');
    script.src = FFMPEG_JS;
    script.onload = async () => {
      try {
        const { FFmpeg } = window.FFmpegWASM || {};
        if (!FFmpeg) throw new Error('FFmpegWASM 全局对象未定义');
        for (const set of CORE_SETS) {
          try {
            const inst = new FFmpeg();
            // 全局进度/日志委托：各模块用 window.MA._ffmpegProgress/_ffmpegLog 注册回调，
            // 避免重复 on() 监听累积
            inst.on('progress', ({ progress }) => {
              if (typeof window.MA._ffmpegProgress === 'function') window.MA._ffmpegProgress(progress);
            });
            inst.on('log', ({ type, message }) => {
              if (typeof window.MA._ffmpegLog === 'function') window.MA._ffmpegLog(type, message);
            });
            await inst.load({ coreURL: set.core, wasmURL: set.wasm });
            ffmpeg = inst;
            ffmpegLoaded = true;
            console.log('[ffmpeg] loaded from', set.core);
            break;
          } catch (e) {
            console.warn('[ffmpeg] core load failed:', set.core, e);
          }
        }
      } catch (e) {
        console.error('[ffmpeg] wrapper error:', e);
      }
      if (!ffmpegLoaded) {
        UI.toast('剪辑引擎加载失败，请检查网络后重试', 'err', 6000);
      }
      window.MA._ffmpegLoading = false;
    };
    script.onerror = () => {
      window.MA._ffmpegLoading = false;
      UI.toast('剪辑引擎 CDN 加载失败，请检查网络', 'err', 6000);
    };
    document.head.appendChild(script);
  }

  /** 统一转 Uint8Array（0.12 writeFile 需要） */
  async function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return new Uint8Array(data);
  }
  /** 执行 ffmpeg 并校验退出码（0.12 exec 返回退出码，非 0 抛错） */
  async function execOk(inst, args) {
    const code = await inst.exec(args);
    if (code !== 0) throw new Error(`ffmpeg 执行失败（退出码 ${code}）`);
  }
  /** 删除文件（不存在不报错） */
  async function rm(inst, name) {
    try { await inst.deleteFile(name); } catch { /* ignore */ }
  }

  /** 公共：获取已加载的 ffmpeg 实例（frammer 等模块复用）；未加载时触发加载并返回 null */
  async function ensureFFmpegPublic() {
    if (ffmpegLoaded) return ffmpeg;
    ensureFFmpeg();
    // 等待加载（最多 90s）
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (ffmpegLoaded) return ffmpeg;
      if (!window.MA._ffmpegLoading) break; // 加载失败
    }
    return null;
  }

  /* ---------- 导出 ---------- */
  async function exportVideo(el) {
    if (timeline.length === 0) return UI.toast('时间线为空，请先添加素材', 'warn');
    if (exporting) return;
    if (!ffmpegLoaded) {
      ensureFFmpeg();
      return UI.toast('剪辑引擎加载中，请稍候再点击导出', 'warn');
    }

    exporting = true;
    // 注册引擎进度回调（0.12 通过 on('progress') 委托到这里）
    window.MA._ffmpegProgress = (ratio) => {
      const sEl = el.querySelector('#edExportStatus');
      if (sEl && ratio > 0 && ratio < 1) {
        sEl.innerHTML = `<div class="progress-bar"><div class="fill" style="width:${Math.round(ratio * 100)}%"></div></div><p style="font-size:11.5px;color:var(--text-3);margin-top:6px">剪辑引擎处理中 ${Math.round(ratio * 100)}%</p>`;
      }
    };
    const statusEl = el.querySelector('#edExportStatus');
    const btn = el.querySelector('#edExport');
    btn.disabled = true;
    const ratio = el.querySelector('#edRatio').value;
    const quality = el.querySelector('#edQuality').value;
    const [W, H] = ratio === '9:16' ? [720, 1280] : [1280, 720];
    if (quality === '480') { /* 统一转码到目标尺寸，480 时降低分辨率 */ }
    const outW = W, outH = H;

    const setStatus = (text) => {
      statusEl.innerHTML = `<p style="font-size:12.5px;color:var(--text-2)">${text}</p>`;
    };

    try {
      setStatus('⏳ 准备素材…');

      /* Step 1: 逐片段统一转码（缩放适配 + 25fps + 淡入淡出转场 + 音轨统一） */
      const inputNames = [];
      for (let i = 0; i < timeline.length; i++) {
        const c = timeline[i];
        setStatus(`⏳ 转码片段 ${i + 1}/${timeline.length}：${UI.escapeHtml(c.name)}…`);
        const inName = `in_${i}` + (c.source.includes('image/png') || c.source.startsWith('data:image/png') ? '.png' : c.type === 'image' ? '.png' : '.mp4');
        // 写入输入文件
        const ext = c.source.startsWith('data:video') ? '.mp4' : c.source.startsWith('data:image') ? '.png' : c.type === 'video' ? '.mp4' : '.png';
        const inFile = `in_${i}${ext}`;
        await rm(ffmpeg, inFile);
        await ffmpeg.writeFile(inFile, await toU8(await fetchFileLike(c.source)));

        const dur = Math.min(c.duration || 5, 60);
        const outFile = `seg_${i}.mp4`;
        const vf = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${Math.max(dur - 0.35, 0.01)}:d=0.35`;
        let args;
        if (c.type === 'image') {
          // 图片 → 视频（静音轨）
          args = [
            '-loop', '1', '-i', inFile,
            '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', String(dur),
            '-vf', vf,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '96k',
            '-shortest', '-y', outFile,
          ];
        } else {
          // 视频（保留原声，限制时长）
          args = [
            '-i', inFile,
            '-t', String(dur),
            '-vf', vf,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '96k',
            '-y', outFile,
          ];
        }
        await execOk(ffmpeg, args);
        inputNames.push(outFile);
        await rm(ffmpeg, inFile);
      }

      /* Step 2: concat 拼接 */
      setStatus('⏳ 拼接所有片段…');
      const concatTxt = inputNames.map((n) => `file '${n}'`).join('\n');
      await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatTxt));
      let concatOk = true;
      try {
        await execOk(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-y', 'merged.mp4']);
      } catch (e) {
        concatOk = false;
        console.warn('[ffmpeg] concat demuxer failed, fallback to filter', e);
      }
      if (!concatOk) {
        const inputs = [];
        const filterParts = [];
        inputNames.forEach((n, i) => {
          inputs.push('-i', n);
          filterParts.push(`[${i}:v:0][${i}:a:0]`);
        });
        const filter = `${filterParts.join('')}concat=n=${inputNames.length}:v=1:a=1[outv][outa]`;
        await execOk(ffmpeg, [...inputs, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-y', 'merged.mp4']);
      }

      /* Step 3: BGM 混音 */
      const bgm = window.MA.bgm;
      if (bgm && bgm.source) {
        setStatus('⏳ 混入背景音乐…');
        const vol = (Number(el.querySelector('#edBgmVol').value) || 35) / 100;
        await ffmpeg.writeFile('bgm_in.mp3', await toU8(await fetchFileLike(bgm.source)));
        await execOk(ffmpeg, [
          '-i', 'merged.mp4', '-i', 'bgm_in.mp3',
          '-filter_complex', `[1:a]volume=${vol.toFixed(2)}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3,volume=1.0[aout]`,
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
          '-y', 'final.mp4'
        ]);
      } else {
        await ffmpeg.writeFile('final.mp4', await ffmpeg.readFile('merged.mp4'));
      }

      setStatus('⏳ 正在合成输出文件…');
      const data = await ffmpeg.readFile('final.mp4');
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      // 保存到作品中心
      let savedWork = null;
      try {
        savedWork = await Store.add({
          type: 'project', kind: 'final-cut',
          title: `成片 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}（${timeline.length} 片段）`,
          url, thumb: '', duration: timeline.reduce((s, c) => s + c.duration, 0),
        });
      } catch { /* ignore */ }

      /* Step 4: 清理 */
      for (const n of [...inputNames, 'concat.txt', 'merged.mp4', 'final.mp4', ...(bgm && bgm.source ? ['bgm_in.mp3'] : [])]) {
        await rm(ffmpeg, n);
      }

      // 展示结果
      UI.closeModal();
      UI.modal(`
        <video src="${url}" controls style="width:100%;border-radius:10px;background:#000"></video>
        <p style="font-size:12px;color:var(--text-3);margin:10px 0 14px">
          🎉 成片已生成！总时长 ${UI.fmtDur(timeline.reduce((s, c) => s + c.duration, 0))} · 已自动保存到作品中心
        </p>
        <div style="display:flex;gap:9px">
          <a class="btn btn-primary" style="flex:1" href="${url}" download="materall_成片_${Date.now()}.mp4">⬇ 下载成片</a>
          <button class="btn" style="flex:1" id="dlClose">继续编辑</button>
        </div>
      `, { title: '✅ 成片完成' });
      document.getElementById('dlClose').addEventListener('click', UI.closeModal);
      statusEl.innerHTML = '';
      UI.toast('成片生成成功 🎉', 'ok', 5000);
    } catch (e) {
      console.error('[ffmpeg] export error:', e);
      setStatus(`<span style="color:var(--danger)">❌ 导出失败：${UI.escapeHtml(e.message || '未知错误')}</span>`);
      UI.toast(`导出失败：${e.message}`, 'err', 7000);
    } finally {
      exporting = false;
      btn.disabled = false;
      window.MA._ffmpegProgress = null;
    }
  }

  /** 兼容 fetchFile：支持 data URL / blob / http */
  async function fetchFileLike(source) {
    if (source instanceof Blob) return source;
    if (typeof source === 'string') {
      if (/^data:/i.test(source)) {
        const resp = await fetch(source);
        return resp.blob();
      }
      if (/^https?:/i.test(source) || source.startsWith('blob:')) {
        const resp = await fetch(source);
        return resp.blob();
      }
    }
    return new Blob([source]);
  }

  /* ================================================================
   * ⚡ 批量加工模式
   * 常用批量功能：剪开头+接尾板 / 去头尾 / 抽帧 / 静音 / 压缩
   * 原理：逐条串行喂给 ffmpeg.wasm（同一实例），避免内存峰值
   * ================================================================ */
  /** 常用投放尺寸档位（与 resize 模块对齐）；auto=按自身比例归类，any=通用任意比例 */
  const B_BUCKETS = [
    { key: 'auto', label: '自动（按素材比例归类）' },
    { key: 'any', label: '通用（任意比例）' },
    { key: '9:16', label: '9:16 竖屏' },
    { key: '16:9', label: '16:9 横屏' },
    { key: '1:1', label: '1:1 方形' },
    { key: '4:5', label: '4:5 竖版' },
    { key: '2:3', label: '2:3 竖版' },
  ];
  /** 按宽高判断素材/尾板所属比例档（覆盖投放常见比例） */
  function ratioBucket(vw, vh) {
    const ar = (vw || 16) / (vh || 9);
    if (ar > 1.25) return '16:9';        // 横屏（16:9 / 4:3 / 2.39:1 等）
    if (ar >= 0.95) return '1:1';        // 方图（1:1 / 5:4 等近似）
    if (ar >= 0.75) return '4:5';        // 4:5 / 3:4
    if (ar >= 0.62) return '2:3';        // 2:3
    return '9:16';                       // 竖屏（9:16 / 1:2 等）
  }
  /** 尾板实际归属档（auto → 按自身宽高归类） */
  const endEffBucket = (e) => (e.bucket === 'auto' ? ratioBucket(e.vw, e.vh) : e.bucket);
  /** 按目标档位挑选尾板：精确档 → 通用(any) → 第一张兜底 */
  function pickEndFor(bucket, ends) {
    const list = ends || [];
    return list.find((e) => endEffBucket(e) === bucket)
      || list.find((e) => e.bucket === 'any')
      || list[0] || null;
  }
  /** 素材输出目标档位：手动画幅用所选档，原比例按素材自身 */
  const targetBucketOf = (f, p) => (p.ratio === 'orig' ? ratioBucket(f.vw, f.vh) : p.ratio);

  const B_TASKS = [
    { key: 'trimEnd', ico: '✂️', label: '剪开头 + 接尾板', desc: '去片头 → 多尺寸尾板自动匹配拼接', suffix: '尾板', needOut: true },
    { key: 'trim', ico: '🎬', label: '批量去头尾', desc: '裁掉每段开头/结尾无效部分', suffix: '修剪', needOut: true },
    { key: 'frames', ico: '🖼️', label: '批量抽帧', desc: '按间隔抽帧成图（灵感 / 截图 / 分镜）', suffix: '帧' },
    { key: 'mute', ico: '🔇', label: '批量静音', desc: '去掉原声只留画面（后续另配）', suffix: '静音' },
    { key: 'compress', ico: '🧊', label: '批量压缩', desc: '统一画幅与清晰度，缩小体积', suffix: '压缩', needOut: true },
  ];

  /** 通用输出设置 HTML（裁切/压缩任务显示） */
  function bOutHTML() {
    return `
      <div class="b-sub-box" style="margin-top:12px">
        <div class="grid grid-3" style="gap:10px">
          <label class="field" style="margin:0"><span class="field-label">📐 输出画幅</span>
            <select class="input" id="bpRatio">
              <option value="orig">原比例</option>
              <option value="9:16">9:16 竖屏（抖音）</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方形</option>
              <option value="4:5">4:5 竖版（小红书）</option>
              <option value="2:3">2:3 竖版</option>
            </select></label>
          <label class="field" style="margin:0"><span class="field-label">适配方式</span>
            <select class="input" id="bpFit">
              <option value="crop">裁切填满（无黑边）</option>
              <option value="contain">完整保留（黑边）</option>
            </select></label>
          <label class="field" style="margin:0"><span class="field-label">清晰度</span>
            <select class="input" id="bpQ">
              <option value="720">720P（推荐）</option>
              <option value="480">480P（更小）</option>
              <option value="1080">1080P</option>
            </select></label>
        </div>
      </div>`;
  }

  function bTaskParamsHTML(task) {
    if (task === 'trimEnd' || task === 'trim') {
      const isEnd = task === 'trimEnd';
      return `
        <div class="b-param-box">
          <div class="grid grid-2" style="gap:10px">
            <label class="field" style="margin:0"><span class="field-label">✂️ 从第几秒开始剪</span>
              <input class="input" id="bpStart" value="1" placeholder="秒数，如 2 或 0:03.5">
              <span class="field-hint">可填小数或 分:秒（如 0:05）</span></label>
            <label class="field" style="margin:0"><span class="field-label">⏱️ 保留到</span>
              <select class="input" id="bpEndMode">
                <option value="full">全片（只去片头）</option>
                <option value="len">开始后只留 N 秒</option>
              </select>
              <span class="field-hint" style="display:none" id="bpEndHint">适合把长素材切成投放长度</span></label>
          </div>
          <div id="bpMaxRow" style="display:none">
            <label class="field" style="margin-top:6px"><span class="field-label">保留秒数</span>
              <input class="input" id="bpMaxLen" type="number" value="15" min="1" max="300"></label>
          </div>
          ${isEnd ? `
          <div class="b-sub-box" style="margin-top:12px">
            <span class="field-label" style="margin-bottom:8px">🏷️ 尾板库 <span style="font-weight:400;color:var(--text-3);font-size:11px">多张尾板 · 按素材尺寸自动匹配（多尺寸素材 ↔ 多尺寸尾板）</span></span>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input type="file" id="bpEndFile" accept="video/*,image/*" multiple style="display:none">
              <button class="btn btn-sm btn-primary" id="bpEndPick">📁 添加尾板（可多选：视频/图片）</button>
              <button class="btn btn-sm" id="bpEndClear" style="display:none">🗑 清空</button>
              <span id="bpEndName" style="font-size:12px;color:var(--text-3)">${bEnds.length ? `已 ${bEnds.length} 张` : '未添加'}</span>
            </div>
            <div id="bpEndsList" style="margin-top:10px;display:flex;flex-direction:column;gap:7px"></div>
            <p style="font-size:11px;color:var(--text-3);margin-top:8px">💡 处理时按<b>素材输出画幅</b>自动选板：先精确匹配同档尾板 → 无则用「通用」→ 最后用第一张。竖素材会自动接竖尾板、横素材接横尾板。每张可手动改档位与时长（视频取前 N 秒 / 图片展示 N 秒）。</p>
          </div>` : ''}
          ${bOutHTML()}
        </div>`;
    }
    if (task === 'frames') {
      return `
        <div class="b-param-box">
          <div style="display:flex;align-items:center;gap:8px;font-size:13px">
            <span>🖼️ 每隔</span>
            <select class="input" id="bpFps" style="width:auto">
              <option value="0.5">0.5 秒</option>
              <option value="1" selected>1 秒</option>
              <option value="2">2 秒</option>
              <option value="3">3 秒</option>
              <option value="5">5 秒</option>
            </select>
            <span>抽 1 帧（保持原始分辨率）</span>
          </div>
          <p style="font-size:11px;color:var(--text-3);margin-top:8px">💡 常用于：参考视频拆解、做分镜、截取高光画面。抽出的帧可直接进「AI 生图/仿拍复刻」当参考图。</p>
        </div>`;
    }
    if (task === 'mute') {
      return `
        <div class="b-param-box">
          <p style="font-size:12.5px;color:var(--text-2);margin:0;line-height:1.8">🔇 输出视频<b>画面不变、声音全无</b>（H.264 重编码，保持原分辨率）。<br>适合：去掉版权原声 / 准备后期统一配音 / 静音素材混剪。</p>
        </div>`;
    }
    if (task === 'compress') {
      return `
        <div class="b-param-box">
          <p style="font-size:12.5px;color:var(--text-2);margin:0 0 6px;line-height:1.7">🧊 等比缩放 + H.264 重编码，体积明显减小；「原比例」时不会把低清视频放大。</p>
          ${bOutHTML()}
        </div>`;
    }
    return '';
  }

  /** 批量面板布局 */
  function batchLayout() {
    return `
      <div class="batch-wrap">
        <div class="batch-col">
          <div class="card">
            <div class="card-title"><span class="ico">📦</span>① 批量素材 <span class="b-count" id="bCount">0 个视频</span></div>
            <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px">
              <button class="btn btn-sm btn-primary" id="bAdd">📁 批量添加视频</button>
              <button class="btn btn-sm" id="bFromGal">🗂️ 从作品中心</button>
              <button class="btn btn-sm" id="bClear" style="display:none">清空</button>
            </div>
            <input type="file" id="bFile" accept="video/*" multiple style="display:none">
            <div class="b-list" id="bList"></div>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">⚙️</span>② 处理任务 <span class="b-count" style="font-weight:400">5 种常用批量处理</span></div>
            <div class="b-tasks" id="bTasks">
              ${B_TASKS.map((t, i) => `
                <button class="b-task${i === 0 ? ' active' : ''}" data-task="${t.key}">
                  <span class="b-t-ico">${t.ico}</span>
                  <span class="b-t-name">${t.label}</span>
                  <span class="b-t-desc">${t.desc}</span>
                </button>`).join('')}
            </div>
            <div id="bParams"></div>
          </div>
        </div>

        <div class="batch-col batch-main">
          <div class="card">
            <div class="card-title"><span class="ico">🚀</span>③ 执行与结果</div>
            <div class="b-ops" style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-primary" id="bRun">▶️ 开始批量处理</button>
              <button class="btn btn-danger" id="bStop" style="display:none">⏹ 停止</button>
              <span style="font-size:11.5px;color:var(--text-3)">逐条顺序处理，完成后自动存入作品中心</span>
            </div>
            <div id="bProgress"></div>
          </div>
          <div class="card">
            <div class="card-title"><span class="ico">📥</span>结果列表 <span id="bResCount" style="font-weight:400;font-size:12px;color:var(--text-3)"></span></div>
            <div id="bResults"></div>
          </div>
        </div>
      </div>`;
  }

  /* ---------- 批量：素材 ---------- */
  function probeVideoInfo(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve({ dur: v.duration || 0, vw: v.videoWidth || 1280, vh: v.videoHeight || 720 });
      v.onerror = () => resolve({ dur: 0, vw: 1280, vh: 720 });
      v.src = url;
      setTimeout(() => resolve({ dur: 0, vw: 1280, vh: 720 }), 6000);
    });
  }

  async function addBFiles(fileList, nameHint) {
    for (const f of Array.from(fileList || [])) {
      if (!f.type.startsWith('video') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name)) continue;
      if (bFiles.length >= 30) {
        UI.toast('批量素材最多 30 个，已达上限', 'warn');
        break;
      }
      const url = URL.createObjectURL(f);
      const info = await probeVideoInfo(url);
      bFiles.push({ file: f, name: f.name, url, dur: info.dur, vw: info.vw, vh: info.vh });
    }
    const el = document.querySelector('#content');
    if (el) {
      renderBList(el);
      updateBCount(el);
    }
    UI.toast(`已加入 ${bFiles.length} 个视频，请选择任务开始处理`, 'ok', 2200);
  }

  function renderBList(el) {
    const list = el.querySelector('#bList');
    if (!bFiles.length) {
      list.innerHTML = `<div class="empty-state" style="padding:12px"><p style="font-size:12px">暂无素材，点击「批量添加视频」多选加入</p></div>`;
      const clearBtn = el.querySelector('#bClear');
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }
    list.innerHTML = bFiles.map((f, i) => `
      <div class="asset-item" title="${UI.escapeHtml(f.name)}">
        <div class="thumb"><video src="${f.url}" muted preload="metadata"></video></div>
        <div class="meta">
          <div class="t">${UI.escapeHtml(f.name.slice(0, 22))}</div>
          <div class="s">${f.dur ? UI.fmtDur(f.dur) + ' · ' + f.vw + '×' + f.vh : '读取时长中…'}
            ${f.dur ? `<span class="badge badge-wait" style="margin-left:4px;font-size:9.5px;padding:0 5px">${ratioBucket(f.vw, f.vh)}</span>` : ''}</div>
        </div>
        <button class="btn-icon" data-del="${i}" title="移除">🗑</button>
      </div>`).join('');
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.del);
        try { URL.revokeObjectURL(bFiles[i].url); } catch { /* ignore */ }
        bFiles.splice(i, 1);
        renderBList(el);
        updateBCount(el);
      });
    });
    const clearBtn = el.querySelector('#bClear');
    if (clearBtn) clearBtn.style.display = '';
  }

  function updateBCount(el) {
    const c = el.querySelector('#bCount');
    if (c) c.textContent = `${bFiles.length} 个视频`;
  }

  /* ---------- 批量：任务切换 & 参数 ---------- */
  function bindBatch(el) {
    // 默认选中第一个任务
    const firstTask = B_TASKS[0].key;
    const taskBtns = el.querySelector('#bTasks');
    if (taskBtns) {
      taskBtns.addEventListener('click', (e) => {
        const btn = e.target.closest('.b-task');
        if (!btn || bRunning) return;
        taskBtns.querySelectorAll('.b-task').forEach((x) => x.classList.remove('active'));
        btn.classList.add('active');
        const params = el.querySelector('#bParams');
        if (params) {
          params.innerHTML = bTaskParamsHTML(btn.dataset.task);
          bindTaskParams(el, btn.dataset.task);
        }
      });
    }
    // 文件
    const fileInput = el.querySelector('#bFile');
    el.querySelector('#bAdd').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addBFiles(fileInput.files); fileInput.value = ''; });
    el.querySelector('#bClear')?.addEventListener('click', () => {
      if (!bFiles.length) return;
      if (!confirm(`清空 ${bFiles.length} 个素材？`)) return;
      bFiles.forEach((f) => { try { URL.revokeObjectURL(f.url); } catch { /* ignore */ } });
      bFiles = [];
      renderBList(el);
      updateBCount(el);
    });
    el.querySelector('#bFromGal').addEventListener('click', () => bGalleryDialog(el));
    // 开始/停止
    el.querySelector('#bRun').addEventListener('click', () => runBatch(el));
    el.querySelector('#bStop').addEventListener('click', () => { bCancel = true; UI.toast('正在停止…（当前条完成后退出）', 'warn'); });
    // 默认参数
    const params = el.querySelector('#bParams');
    if (params) {
      params.innerHTML = bTaskParamsHTML(firstTask);
      bindTaskParams(el, firstTask);
    }
    // 页面重进/模式切换回来时恢复素材与尾板列表展示（状态在模块级保留）
    renderBList(el);
    updateBCount(el);
  }

  function bindTaskParams(el, task) {
    const startInput = el.querySelector('#bpStart');
    if (startInput) {
      startInput.addEventListener('blur', () => {
        const t = parseTime(startInput.value);
        if (!Number.isFinite(t) || t < 0) { UI.toast('时间格式不对，示例：5 或 0:03.5', 'warn'); startInput.value = '1'; }
      });
    }
    const endMode = el.querySelector('#bpEndMode');
    const maxRow = el.querySelector('#bpMaxRow');
    const endHint = el.querySelector('#bpEndHint');
    if (endMode && maxRow) {
      const sync = () => {
        maxRow.style.display = endMode.value === 'len' ? '' : 'none';
        if (endHint) endHint.style.display = endMode.value === 'len' ? '' : 'none';
      };
      endMode.addEventListener('change', sync);
      sync();
    }
    // 尾板库（trimEnd）：多张尾板，按尺寸档位匹配
    const endFile = el.querySelector('#bpEndFile');
    const endPick = el.querySelector('#bpEndPick');
    const endClear = el.querySelector('#bpEndClear');
    if (endPick && endFile) {
      endPick.addEventListener('click', () => endFile.click());
      endFile.addEventListener('change', async () => {
        await addBEnds(endFile.files);
        endFile.value = '';
        renderBEnds(el);
      });
    }
    if (endClear) {
      endClear.addEventListener('click', () => {
        if (!bEnds.length) return;
        if (!confirm(`清空 ${bEnds.length} 张尾板？`)) return;
        bEnds.forEach((e) => { try { URL.revokeObjectURL(e.url); } catch { /* ignore */ } });
        bEnds = [];
        renderBEnds(el);
      });
    }
    renderBEnds(el);
    void task;
  }

  /** 添加尾板（多张）：探测时长与尺寸，默认 auto 档位 */
  async function addBEnds(fileList) {
    for (const f of Array.from(fileList || [])) {
      if (bEnds.length >= 10) {
        UI.toast('尾板最多 10 张', 'warn');
        break;
      }
      const isImg = f.type.startsWith('image');
      if (!isImg && !f.type.startsWith('video')) continue;
      const url = URL.createObjectURL(f);
      const info = isImg ? { dur: 0, vw: 0, vh: 0 } : await probeVideoInfo(url);
      if (isImg) {
        // 图片探测尺寸（画布读取，供比例归类）
        try {
          const bmp = await createImageBitmap(f);
          info.vw = bmp.width; info.vh = bmp.height;
          bmp.close();
        } catch { /* ignore */ }
      }
      bEnds.push({
        id: UI.uid('be'), name: f.name, isImg, url,
        vw: info.vw || (isImg ? 9 : 16), vh: info.vh || (isImg ? 16 : 9),
        bucket: 'auto', dur: 4,
      });
    }
    const nm = document.querySelector('#bpEndName');
    if (nm) nm.textContent = `已 ${bEnds.length} 张`;
    const cl = document.querySelector('#bpEndClear');
    if (cl) cl.style.display = bEnds.length ? '' : 'none';
    if (bEnds.length) UI.toast(`尾板库现有 ${bEnds.length} 张，处理时按尺寸自动匹配`, 'ok', 2000);
  }

  /** 渲染尾板库列表（每张：缩略 + 名称 + 档位 + 时长 + 删除） */
  function renderBEnds(el) {
    const list = el.querySelector('#bpEndsList');
    const nm = el.querySelector('#bpEndName');
    const cl = el.querySelector('#bpEndClear');
    if (nm) nm.textContent = bEnds.length ? `已 ${bEnds.length} 张` : '未添加';
    if (cl) cl.style.display = bEnds.length ? '' : 'none';
    if (!list) return;
    if (!bEnds.length) {
      list.innerHTML = `<div style="font-size:11.5px;color:var(--text-3);background:var(--bg-soft);border:1px dashed var(--border);border-radius:8px;padding:8px 10px">尾板库为空 —— 添加后每段视频结尾会自动拼接；多尺寸素材建议按档位添加多张</div>`;
      return;
    }
    list.innerHTML = bEnds.map((e, i) => `
      <div class="b-end-row" data-idx="${i}">
        <div class="thumb">
          ${e.isImg ? `<img src="${e.url}">` : `<video src="${e.url}" muted preload="metadata"></video>`}
        </div>
        <div class="meta">
          <div class="t" title="${UI.escapeHtml(e.name)}">${UI.escapeHtml(e.name.slice(0, 16))}<span class="b-end-tag">${e.isImg ? '图' : '视频'} · ${e.vw}×${e.vh} · ${ratioBucket(e.vw, e.vh)}</span></div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px">
            <select class="input b-end-bucket" data-idx="${i}" style="width:auto;padding:2px 26px 2px 8px;font-size:11px">
              ${B_BUCKETS.map((b) => `<option value="${b.key}" ${e.bucket === b.key ? 'selected' : ''}>${b.label}</option>`).join('')}
            </select>
            <span style="font-size:11px;color:var(--text-3)">时长</span>
            <input class="input b-end-dur" data-idx="${i}" type="number" value="${e.dur}" min="1" max="30" style="width:56px;padding:2px 6px;font-size:11px">秒
          </div>
        </div>
        <button class="btn-icon b-end-del" data-idx="${i}" title="移除">🗑</button>
      </div>`).join('');
    list.querySelectorAll('.b-end-bucket').forEach((s) => {
      s.addEventListener('change', () => {
        const e = bEnds[Number(s.dataset.idx)];
        if (e) { e.bucket = s.value; UI.toast(`已设置「${e.name.slice(0, 10)}」为 ${s.selectedOptions[0].text}`, 'ok', 1200); }
      });
    });
    list.querySelectorAll('.b-end-dur').forEach((inp) => {
      inp.addEventListener('change', () => {
        const e = bEnds[Number(inp.dataset.idx)];
        if (e) e.dur = Math.min(Math.max(parseFloat(inp.value) || 4, 1), 30);
      });
    });
    list.querySelectorAll('.b-end-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const e = bEnds[Number(btn.dataset.idx)];
        if (!e) return;
        try { URL.revokeObjectURL(e.url); } catch { /* ignore */ }
        bEnds.splice(Number(btn.dataset.idx), 1);
        renderBEnds(el);
        const nm2 = el.querySelector('#bpEndName');
        if (nm2) nm2.textContent = bEnds.length ? `已 ${bEnds.length} 张` : '未添加';
      });
    });
  }

  /** 从作品中心把视频作品加入批量列表 */
  async function bGalleryDialog(el) {
    let works = [];
    try {
      works = await Store.list(); // 不按 type 过滤：成片/视频生成都可能是可加的视频
    } catch { /* ignore */ }
    const usable = works.filter((w) => w.url && w.type !== 'image');
    UI.modal(`
      <p style="font-size:12px;color:var(--text-2);margin-bottom:8px">点击作品加入批量列表（可连续点选，完成后点下方按钮）</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:380px;overflow-y:auto;margin-bottom:10px">
        ${usable.length ? usable.map((w) => `
          <div style="cursor:pointer;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;overflow:hidden" data-wid="${w.id}">
            <div style="aspect-ratio:16/10;background:#0a0d14;overflow:hidden">
              <video src="${API.proxyUrl(w.url)}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>
            </div>
            <div style="padding:6px 8px;font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escapeHtml(w.title || '作品')}</div>
          </div>`).join('')
        : '<div class="empty-state" style="grid-column:1/-1"><p>作品中心暂无视频作品<br>（批量面板接受本地上传视频）</p></div>'}
      </div>
      <button class="btn btn-primary btn-block" id="bGalDone">完成（已加入 ${0}）</button>
    `, { title: '从作品中心批量加入视频' });
    const doneBtn = document.getElementById('bGalDone');
    const cntEl = () => { /* noop */ };
    void cntEl;
    document.querySelectorAll('#modalBody [data-wid]').forEach((box) => {
      box.addEventListener('click', async () => {
        const w = usable.find((x) => x.id === box.dataset.wid);
        if (!w || box.dataset.added) return;
        box.dataset.added = '1';
        box.style.opacity = '.5';
        try {
          const blob = await API.fetchBlob(API.proxyUrl(w.url));
          const name = (w.title || '作品') + '.mp4';
          const file = new File([blob], name, { type: 'video/mp4' });
          await addBFiles([file]);
          doneBtn.textContent = `完成（已加入 ${bFiles.length}）`;
        } catch {
          box.dataset.added = '';
          box.style.opacity = '';
          UI.toast('作品下载失败', 'err');
        }
      });
    });
    doneBtn.addEventListener('click', () => {
      UI.closeModal();
      renderBList(el);
      updateBCount(el);
      UI.toast(`已加入 ${bFiles.length} 个视频`, 'ok', 2000);
    });
  }

  /* ---------- 批量：参数解析 & 工具 ---------- */
  /** 解析 "0:05" / "1:02.5" / 秒数 */
  function parseTime(v) {
    const s = String(v ?? '').trim();
    if (!s) return 0;
    const m = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function extOf(name) {
    const m = /\.(mp4|webm|mov|mkv|m4v|png|jpe?g)$/i.exec(name || '');
    return m ? '.' + m[1].toLowerCase() : '.mp4';
  }

  /** 输出目标尺寸（长边=清晰度档位，画幅按比例） */
  function targetWH(f, p, noUpscale) {
    let vw = f.vw || 1280, vh = f.vh || 720;
    if (p.ratio === 'orig') {
      const long = Math.max(vw, vh);
      const target = noUpscale ? Math.min(p.q, long) : p.q;
      const k = target / long;
      return { W: Math.round(vw * k / 2) * 2, H: Math.round(vh * k / 2) * 2 };
    }
    const ars = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5, '2:3': 2 / 3 };
    const ar = ars[p.ratio] || 16 / 9;
    let W, H;
    if (ar >= 1) { W = p.q; H = Math.round(W / ar); } else { H = p.q; W = Math.round(H * ar); }
    W = Math.max(2, Math.round(W / 2) * 2);
    H = Math.max(2, Math.round(H / 2) * 2);
    return { W, H };
  }

  function fitExpr(W, H, fit) {
    // setsar=1：不同来源素材缩放后 SAR 可能失配导致 concat 报错，统一为方像素
    return fit === 'contain'
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  }

  /** 音频段：真实音轨 或 静音补位 */
  function aSeg(real, inIdx, s, e, label) {
    const fmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
    if (real) return `[${inIdx}:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS,${fmt}[${label}]`;
    const d = Math.max(e - s, 0.01).toFixed(3);
    return `anullsrc=r=44100:cl=stereo,atrim=duration=${d},${fmt}[${label}]`;
  }

  /** 从 DOM 读取批量参数 */
  function readBP(el, task) {
    const p = { task };
    p.start = Math.max(parseTime(el.querySelector('#bpStart')?.value) || 0, 0);
    p.endMode = el.querySelector('#bpEndMode')?.value || 'full';
    p.maxLen = Math.max(parseFloat(el.querySelector('#bpMaxLen')?.value) || 0, 1);
    p.ratio = el.querySelector('#bpRatio')?.value || 'orig';
    p.fit = el.querySelector('#bpFit')?.value || 'crop';
    p.q = parseInt(el.querySelector('#bpQ')?.value, 10) || 720;
    p.fps = parseFloat(el.querySelector('#bpFps')?.value) || 1;
    p.ends = bEnds.slice(); // 尾板库快照（每张含 bucket/dur/url）
    return p;
  }

  /* ---------- 批量：执行 ---------- */
  async function runBatch(el) {
    if (bRunning) return UI.toast('正在批量处理中，请稍候', 'warn');
    if (!bFiles.length) return UI.toast('请先添加视频素材', 'warn');
    const task = (el.querySelector('.b-task.active') || el.querySelector('.b-task'))?.dataset.task || 'trimEnd';
    const p = readBP(el, task);
    if (task === 'trimEnd' && !p.ends.length) return UI.toast('尾板库为空，请先添加尾板（视频或图片）', 'warn');

    // 引擎未加载则触发加载并等待完成（首次约 32MB，之后走缓存）
    if (!ffmpegLoaded) {
      ensureFFmpeg();
      UI.toast('⏳ 剪辑引擎加载中（首次约 32MB），请稍候…', 'warn', 4000);
    }
    for (let w = 0; w < 90 && !ffmpegLoaded; w++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ffmpegLoaded) {
      return UI.toast('剪辑引擎加载失败，请刷新页面重试', 'err', 6000);
    }

    bRunning = true;
    bCancel = false;
    bResults = [];
    const runBtn = el.querySelector('#bRun');
    const stopBtn = el.querySelector('#bStop');
    runBtn.disabled = true;
    stopBtn.style.display = '';
    const progEl = el.querySelector('#bProgress');
    const n = bFiles.length;
    let done = 0, okN = 0;

    window.MA._ffmpegProgress = (ratio) => {
      if (!progEl || ratio <= 0 || ratio >= 1) return;
      const bar = progEl.querySelector('.fill');
      if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
      const cur = progEl.querySelector('#bCurPct');
      if (cur) cur.textContent = `当前文件 ${Math.round(ratio * 100)}%`;
    };
    // 收集 ffmpeg 日志（失败时展示最后 25 行定位原因）
    const logBuf = [];
    window.MA._ffmpegLog = (type, message) => {
      logBuf.push(message);
      if (logBuf.length > 400) logBuf.shift();
    };

    const renderHead = () => {
      if (!progEl) return;
      progEl.innerHTML = `
        <div class="progress-bar"><div class="fill" style="width:${n ? Math.round((done / n) * 100) : 0}%"></div></div>
        <p style="font-size:12px;color:var(--text-2);margin-top:8px">
          总进度 <b>${done}/${n}</b> · 成功 <b style="color:var(--ok)">${okN}</b><span id="bCurName" style="margin-left:8px;color:var(--text-3)"></span>
          <span id="bCurPct" style="color:var(--text-3)"></span>
        </p>`;
    };
    renderHead();

    for (let i = 0; i < n; i++) {
      if (bCancel) break;
      const f = bFiles[i];
      const curName = progEl.querySelector('#bCurName');
      if (curName) {
        let hint = `→ ${i + 1}/${n} ${f.name}`;
        if (task === 'trimEnd' && p.ends.length) {
          const bk = targetBucketOf(f, p);
          const picked = pickEndFor(bk, p.ends);
          if (picked) hint += `（尾板: ${picked.name.replace(/\.[^.]+$/, '')} · ${bk}）`;
        }
        curName.textContent = hint;
      }
      renderResultLine({ name: f.name, ok: null, spinning: true });
      try {
        const out = await processOne(f, task, p);
        const hasOut = !!(out && (out.url || (Array.isArray(out.imgs) && out.imgs.length)));
        if (hasOut) {
          bResults.push({ ...out, ok: true });
          okN++;
          // 存入作品中心
          try {
            if (out.url) {
              await Store.add({ type: 'project', kind: 'batch', title: out.name, url: out.url, thumb: '', duration: out.dur || 0 });
            }
          } catch { /* ignore */ }
          renderResultLine({ ...out, ok: true });
        } else {
          throw new Error(out && out.err ? out.err : '无输出');
        }
      } catch (e) {
        console.error('[batch]', task, f.name, e);
        let errText = (e && (e.message || (e.stack ? String(e.stack).slice(0, 300) : String(e)))) || '未知错误';
        // 退出码错误时附上 ffmpeg 日志尾部，方便定位
        if (logBuf.length && /退出码|execution|执行失败|错误|Error/i.test(errText)) {
          const tail = logBuf.slice(-25).join('\n');
          if (tail.trim()) errText += '\n—— ffmpeg 日志 ——\n' + tail;
        }
        bResults.push({ name: f.name, ok: false, err: errText });
        renderResultLine({ name: f.name, ok: false, err: errText });
      }
      done++;
      renderHead();
    }

    bRunning = false;
    runBtn.disabled = false;
    stopBtn.style.display = 'none';
    window.MA._ffmpegProgress = null;
    window.MA._ffmpegLog = null;
    if (bCancel) {
      UI.toast('已停止批量处理', 'warn');
    } else {
      UI.toast(`批量完成：成功 ${okN} / ${n} 🎉`, okN === n ? 'ok' : 'warn', 5000);
    }
    updateResCount(el);
  }

  /** 结果区：追加一行（spinning=true 表示处理中占位） */
  function renderResultLine(r) {
    const wrap = document.querySelector('#bResults');
    if (!wrap) return;
    const id = 'bres_' + Math.random().toString(36).slice(2, 7);
    if (r.spinning) {
      const el2 = document.createElement('div');
      el2.id = id;
      el2.className = 'b-res-row';
      el2.innerHTML = `<span class="badge badge-run">⏳</span><span class="b-r-name">${UI.escapeHtml(r.name)}</span><span style="font-size:12px;color:var(--text-3)">处理中…</span>`;
      wrap.prepend(el2);
      // 记录到 data 供更新
      wrap.dataset.spin = id;
      return;
    }
    // 移除旧占位
    const spin = wrap.querySelector(`#${wrap.dataset.spin}`);
    if (spin) spin.remove();
    delete wrap.dataset.spin;

    const row = document.createElement('div');
    row.className = 'b-res-row';
    const hasOut = !!(r.ok && (r.url || (Array.isArray(r.imgs) && r.imgs.length)));
    if (hasOut) {
      const isImgs = Array.isArray(r.imgs) && r.imgs.length && !r.url;
      const inner = isImgs
        ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
             ${r.imgs.map((im, k) => `<a href="${im.url}" download="${UI.escapeHtml(r.name.replace(/\.\w+$/, ''))}_${k + 1}.${im.ext || 'png'}" title="下载第 ${k + 1} 帧"><img src="${im.url}" style="height:58px;border-radius:6px;border:1px solid var(--border)"></a>`).join('')}
           </div>
           <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
             <button class="btn btn-sm btn-primary" data-dlall>⬇ 下载全部 ${r.imgs.length} 帧</button>
             <span style="font-size:11.5px;color:var(--text-3)">共 ${r.imgs.length} 帧 · 点缩略图可逐张下载</span>
           </div>`
        : `<video src="${r.url}" controls preload="metadata" style="width:150px;height:86px;border-radius:6px;background:#000;object-fit:contain"></video>
           <div style="flex:1;min-width:120px">
             <div class="b-r-name">✅ ${UI.escapeHtml(r.name)}</div>
             <div style="font-size:11px;color:var(--text-3)">${r.dur ? UI.fmtDur(r.dur) : ''}${r.endName ? ' · 尾板:' + UI.escapeHtml(r.endName.replace(/\.[^.]+$/, '')) : ''} · 已保存到作品中心</div>
           </div>
           <a class="btn btn-sm" href="${r.url}" download="${UI.escapeHtml(r.name)}">⬇ 下载</a>`;
      row.innerHTML = inner;
      if (isImgs) {
        row.querySelector('[data-dlall]').addEventListener('click', () => {
          r.imgs.forEach((im, k) => {
            const a = document.createElement('a');
            a.href = im.url;
            a.download = `${r.name.replace(/\.\w+$/, '')}_${k + 1}.${im.ext || 'png'}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
          });
        });
      }
    } else {
      row.innerHTML = `<span class="badge badge-err">❌</span><span class="b-r-name">${UI.escapeHtml(r.name)}</span><span style="font-size:11.5px;color:var(--danger);flex:1;white-space:pre-line;word-break:break-all">${UI.escapeHtml(r.err || '处理失败')}</span>`;
    }
    wrap.prepend(row);
  }

  function updateResCount(el) {
    const c = el.querySelector('#bResCount');
    if (c) c.textContent = `${bResults.length} 条`;
  }

  /** 单条处理调度 */
  async function processOne(f, task, p) {
    const base = f.name.replace(/\.[^.]+$/, '');
    const t = B_TASKS.find((x) => x.key === task);
    const suffix = t ? t.suffix : '';
    if (task === 'frames') return processFrames(f, base, suffix, p);
    if (task === 'mute') return processMute(f, base, suffix);
    if (task === 'trimEnd') {
      // 多尺寸尾板匹配：按素材输出画幅选板（精确档 → 通用 → 第一张）
      const bucket = targetBucketOf(f, p);
      const end = pickEndFor(bucket, p.ends);
      if (!end) throw new Error('尾板库为空');
      const out = await processTrimVid(f, base, suffix, p, true, false, end);
      out.endName = end.name;
      return out;
    }
    // trim / compress
    return processTrimVid(f, base, suffix, p, false, task === 'compress');
  }

  /** 裁剪视频（可选拼尾板）；isCompress=true 时不裁切只缩放重编码；end=本素材匹配到的尾板 */
  async function processTrimVid(f, base, suffix, p, withEnd, isCompress, end) {
    const inst = ffmpeg;
    const inExt = extOf(f.name);
    const inName = 'b_in' + inExt;
    const dur = f.dur || 120;
    const start = isCompress ? 0 : Math.max(p.start, 0);
    const effEnd = isCompress ? dur : (p.endMode === 'len' ? Math.min(start + p.maxLen, dur) : dur);
    if (effEnd - start < 0.3) throw new Error('裁剪后长度不足 0.3 秒，请检查开始秒数/保留长度');
    const mainD = effEnd - start;

    // 目标尺寸（原比例输出时不放大低清素材；换画幅时按目标档缩放属必要裁切）
    const { W, H } = targetWH(f, p, p.ratio === 'orig');
    const fit = fitExpr(W, H, p.fit);
    const crf = isCompress ? 26 : 23;

    await rm(inst, inName);
    await inst.writeFile(inName, await toU8(await fetchFileLike(f.url)));
    const inputs = ['-i', inName];

    // 尾板素材准备（trimEnd，end=已按尺寸匹配的单张尾板）
    let endD = 0, endIn = null, endIsImg = false, endReal = 0;
    if (withEnd && end) {
      endIsImg = end.isImg;
      endD = Math.max(parseFloat(end.dur) || 4, 1);
      endIn = 'b_end' + extOf(end.name);
      await rm(inst, endIn);
      await inst.writeFile(endIn, await toU8(await fetchFileLike(end.url)));
      if (!endIsImg) {
        endReal = await probeDur(end.url);
        endD = Math.max(Math.min(endD, endReal || endD), 0.5); // 视频：取前 N 秒（不超过实际时长）
      }
      if (endIsImg) inputs.push('-loop', '1', '-t', endD.toFixed(3), '-i', endIn);
      else inputs.push('-i', endIn); // 视频尾板全片读入，由下方 trim=0:endD 截取
    }
    const endIdx = 1;

    // 音轨探测（主视频 + 尾板视频）
    const mainHasA = withEnd ? await probeAudio(f.url) : false;
    const endHasA = withEnd && end && !end.isImg ? await probeAudio(end.url) : false;

    const mainE = effEnd.toFixed(3);
    const mainS = start.toFixed(3);
    const v0 = `[0:v]trim=start=${mainS}:end=${mainE},setpts=PTS-STARTPTS,${fit},fps=25,format=yuv420p[v0]`;

    // 构建（auto=按探测 / silent=全静音）
    const build = (audioMode) => {
      const real0 = audioMode === 'auto' && mainHasA;
      const parts = [v0];
      if (!withEnd || !end) {
        const a0 = aSeg(real0, 0, start, effEnd, 'a0');
        parts.push(a0);
        return [...inputs, '-filter_complex', parts.join(';'), '-map', '[v0]', '-map', '[a0]',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf),
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
          '-t', mainD.toFixed(3), '-y', 'b_out.mp4'];
      }
      // 尾板视频段（图片输入已 -loop -t，直接滤镜）
      const real1 = audioMode === 'auto' && endHasA && !endIsImg;
      const v1 = endIsImg
        ? `[${endIdx}:v]${fit},fps=25,format=yuv420p[v1]`
        : `[${endIdx}:v]trim=start=0:end=${endD.toFixed(3)},setpts=PTS-STARTPTS,${fit},fps=25,format=yuv420p[v1]`;
      const a0 = aSeg(real0, 0, start, effEnd, 'a0');
      const a1 = aSeg(real1, endIdx, 0, endD, 'a1');
      const total = mainD + endD;
      parts.push(v1, a0, a1);
      parts.push(`[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`);
      return [...inputs, '-filter_complex', parts.join(';'), '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf),
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
        '-t', total.toFixed(3), '-y', 'b_out.mp4'];
    };

    await rm(inst, 'b_out.mp4');
    try {
      await execOk(inst, build('auto'));
    } catch (eAudio) {
      console.warn('[batch] audio pass failed, silent retry:', (eAudio.message || '').slice(0, 80));
      await rm(inst, 'b_out.mp4');
      await execOk(inst, build('silent'));
    }
    const data = await inst.readFile('b_out.mp4');
    if (!data || data.length < 2000) throw new Error('输出文件异常');
    const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const outName = `${base}_${suffix}.mp4`;
    const outDur = Math.round((withEnd && end ? mainD + endD : mainD) * 100) / 100;
    await rm(inst, inName);
    if (endIn) await rm(inst, endIn);
    await rm(inst, 'b_out.mp4');
    return { url, name: outName, dur: outDur };
  }

  /** 抽帧：每隔 N 秒输出一帧 JPG */
  async function processFrames(f, base, suffix, p) {
    const inst = ffmpeg;
    const inName = 'b_in' + extOf(f.name);
    await rm(inst, inName);
    await inst.writeFile(inName, await toU8(await fetchFileLike(f.url)));
    const interval = Math.max(p.fps, 0.2);
    const total = Math.floor((f.dur || 60) / interval) + 1;
    // PNG 输出：mjpeg 编码在部分 wasm core 会 memory out of bounds，PNG 稳定
    await execOk(inst, ['-i', inName, '-vf', `fps=1/${interval}`, '-an', '-f', 'image2', 'b_f_%03d.png']);
    const imgs = [];
    for (let k = 1; k <= total; k++) {
      const fn = 'b_f_' + String(k).padStart(3, '0') + '.png';
      try {
        const data = await inst.readFile(fn);
        if (data && data.length > 500) {
          const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
          imgs.push({ url, ext: 'png' });
          await rm(inst, fn);
        }
      } catch { break; }
    }
    await rm(inst, inName);
    if (!imgs.length) throw new Error('未抽到帧（视频太短或解码失败）');
    return { imgs, name: `${base}_${suffix}`, ok: true };
  }

  /** 静音：画面保持原分辨率，去掉声音 */
  async function processMute(f, base, suffix) {
    const inst = ffmpeg;
    const inName = 'b_in' + extOf(f.name);
    await rm(inst, inName);
    await inst.writeFile(inName, await toU8(await fetchFileLike(f.url)));
    await execOk(inst, ['-i', inName, '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an', '-y', 'b_out.mp4']);
    const data = await inst.readFile('b_out.mp4');
    if (!data || data.length < 2000) throw new Error('输出文件异常');
    const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const outName = `${base}_${suffix}.mp4`;
    await rm(inst, inName);
    await rm(inst, 'b_out.mp4');
    return { url, name: outName, dur: f.dur };
  }

  /** 探测 source 时长（元数据） */
  function probeDur(source) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve(v.duration || 0);
      v.onerror = () => resolve(0);
      v.src = source;
      setTimeout(() => resolve(0), 5000);
    });
  }

  /** 音轨探测：mozHasAudio 立即判断；Chrome 播 0.05s 触发解码；decodeAudioData 兜底 */
  function probeAudio(source) {
    return new Promise((resolve) => {
      let settled = false;
      let v = null;
      const timer = setTimeout(() => done(true), 8000);
      function done(val) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (v) { v.pause(); v.removeAttribute('src'); v.load(); } } catch { /* ignore */ }
        resolve(val);
      }
      try {
        v = document.createElement('video');
        v.muted = true; v.volume = 0; v.playsInline = true;
      } catch { return done(true); }
      v.onloadeddata = () => {
        if (typeof v.mozHasAudio === 'boolean') return done(v.mozHasAudio);
        v.currentTime = 0.05;
        v.play().then(() => {
          const check = () => {
            if (typeof v.webkitAudioDecodedByteCount === 'number') {
              if (v.webkitAudioDecodedByteCount > 0) return done(true);
              setTimeout(() => done(v.webkitAudioDecodedByteCount > 0 ? true : fallback()), 1500);
              return;
            }
            fallback();
          };
          setTimeout(check, 800);
        }).catch(() => fallback());
      };
      v.onerror = () => done(true);
      v.src = source;
      function fallback() {
        (async () => {
          try {
            const resp = await fetch(source);
            const buf = await resp.arrayBuffer();
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const audio = await ctx.decodeAudioData(buf.slice(0, 3 * 1024 * 1024));
            ctx.close();
            done(audio && audio.length > 0);
          } catch { done(true); }
        })();
      }
    });
  }

  return { render, addRemote, ensureFFmpegPublic };
})();
