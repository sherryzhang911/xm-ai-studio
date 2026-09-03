/* ============================================================
 * resize.js — 多尺寸适配：上传 1 个视频 → 批量输出多个包框尺寸
 * 尺寸：1920×1080 / 1080×1920 / 1080×1080 / 1080×1350 / 1200×1800
 * 引擎：复用 EditorView.ensureFFmpegPublic（ffmpeg.wasm 0.12 单线程核心，
 *       无 SharedArrayBuffer 依赖，静态分享版也可用）
 * ============================================================ */
window.ResizeView = (() => {
  const DB_NAME = 'materall_resize_media';
  const LS_KEY = 'materall_resize_cfg';
  const SIZES = [
    { w: 1920, h: 1080, tag: '横屏 16:9' },
    { w: 1080, h: 1920, tag: '竖屏 9:16' },
    { w: 1080, h: 1080, tag: '方形 1:1' },
    { w: 1080, h: 1350, tag: '4:5' },
    { w: 1200, h: 1800, tag: '2:3' },
  ];

  let mode = 'config';            // config | progress | done
  let video = null;               // { name, source(blobURL), duration, vw, vh, mediaKey }
  let fit = 'cover';              // cover | blur
  let selected = {};              // "w x h" -> true
  let exporting = false;
  let abort = false;
  let results = [];               // { url, w, h, dur, name, at }
  let curPct = 0, curStage = '', elapsed = 0;
  let timerInt = null;
  let logLines = [];

  /* ---------- 配置持久化（localStorage 轻量） ---------- */
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ fit, selected, saved: true })); } catch { /* ignore */ }
  }
  function loadCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (raw.fit === 'cover' || raw.fit === 'blur') fit = raw.fit;
      if (raw.saved && raw.selected && typeof raw.selected === 'object') {
        selected = raw.selected;
      } else {
        // 首次使用：默认全选
        SIZES.forEach((s) => { selected[`${s.w}x${s.h}`] = true; });
        saveCfg();
      }
    } catch {
      SIZES.forEach((s) => { selected[`${s.w}x${s.h}`] = true; });
    }
  }

  /* ---------- 媒体持久化（IndexedDB，大文件不走 localStorage） ---------- */
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('media')) {
          const os = db.createObjectStore('media', { keyPath: 'key' });
          os.createIndex('at', 'at', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function saveMediaBlob(file) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').put({ key: 'main', name: file.name, blob: file, at: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function restoreMedia() {
    try {
      const db = await openDB();
      const items = await new Promise((res, rej) => {
        const tx = db.transaction('media', 'readonly');
        const req = tx.objectStore('media').getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });
      if (!items.length) return false;
      const latest = items.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      const source = URL.createObjectURL(latest.blob);
      const meta = await readMeta(source);
      video = { name: latest.name, source, duration: meta.duration, vw: meta.vw, vh: meta.vh, mediaKey: 'main' };
      return true;
    } catch { return false; }
  }

  /* ---------- 工具 ---------- */
  function readMeta(source) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve({ duration: v.duration || 0, vw: v.videoWidth || 0, vh: v.videoHeight || 0 });
      v.onerror = () => resolve({ duration: 0, vw: 0, vh: 0 });
      v.src = source;
    });
  }
  async function fetchB(source) {
    let blob;
    if (/^data:/i.test(source) || /^https?:/i.test(source) || source.startsWith('blob:')) {
      const resp = await fetch(source);
      blob = await resp.blob();
    } else {
      blob = source;
    }
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function execOk(inst, args) {
    const code = await inst.exec(args);
    if (code !== 0) throw new Error(`ffmpeg 执行失败（退出码 ${code}）`);
  }
  async function rm(inst, name) {
    try { await inst.deleteFile(name); } catch { /* ignore */ }
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 渲染 ---------- */
  function render(el) {
    if (mode === 'progress') return renderProgress(el);
    if (mode === 'done') return renderDone(el);
    renderConfig(el);
  }

  function countSelected() {
    return SIZES.filter((s) => selected[`${s.w}x${s.h}`]).length;
  }

  function renderConfig(el) {
    const cnt = countSelected();
    const disabled = !video || cnt === 0;
    el.innerHTML = `
      <div class="rsz-layout">
        <div class="card">
          <div class="card-title"><span class="ico">🎬</span>源视频（上传 1 个）</div>
          ${video ? `
            <video src="${video.source}" controls style="width:100%;border-radius:10px;background:#000;max-height:230px"></video>
            <div style="margin:10px 0 12px">
              <div style="font-weight:600;font-size:13px;word-break:break-all">${UI.escapeHtml(video.name)}</div>
              <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">${UI.fmtDur(video.duration)} · ${video.vw}×${video.vh} · 刷新页面后自动恢复</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" id="rszChange">🔄 更换视频</button>
              <button class="btn btn-sm btn-ghost" id="rszClear">✕ 移除</button>
            </div>
          ` : `
            <div class="rsz-drop" id="rszDrop">
              <div style="font-size:28px">📁</div>
              <p style="margin:8px 0 4px;font-weight:600">点击或拖拽视频到这里</p>
              <p style="font-size:11.5px;color:var(--text-3)">支持 mp4 / webm / mov<br>推荐上传 1920×1080 或 1080×1080 源视频</p>
            </div>
          `}
          <input type="file" id="rszFile" accept="video/*" style="display:none">
        </div>

        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="card">
            <div class="card-title"><span class="ico">📐</span>适配方式</div>
            <div style="display:flex;gap:9px">
              <button class="btn btn-sm ${fit === 'cover' ? 'btn-primary' : ''}" id="rszFitCover">✂️ 裁切铺满</button>
              <button class="btn btn-sm ${fit === 'blur' ? 'btn-primary' : ''}" id="rszFitBlur">🌫️ 模糊填充</button>
            </div>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:9px;line-height:1.6">
              裁切铺满：画面铺满目标尺寸，超出部分居中裁掉（推荐，广告素材常用）<br>
              模糊填充：完整显示画面，两侧/上下用同源模糊背景补齐
            </p>
          </div>

          <div class="card">
            <div class="card-title">
              <span class="ico">🖼️</span>目标包框尺寸
              <span style="font-size:11px;color:var(--text-3)">（已选 ${cnt} 个）</span>
            </div>
            ${SIZES.map((s) => {
              const key = `${s.w}x${s.h}`;
              const on = !!selected[key];
              const ratio = (s.w / s.h).toFixed(2);
              return `
                <label class="rsz-size ${on ? 'on' : ''}" data-key="${key}">
                  <input type="checkbox" ${on ? 'checked' : ''} style="pointer-events:none">
                  <span class="rsz-ratio" style="width:${Math.round(44 * Math.min(s.w / s.h, 1.4))}px;height:${Math.round(44 * Math.min(s.h / s.w, 1.4))}px">${ratio}</span>
                  <span style="font-weight:700;font-size:13.5px">${s.w}×${s.h}</span>
                  <span class="rsz-badge">${s.tag}</span>
                </label>`;
            }).join('')}
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn btn-sm" id="rszAll">全选</button>
              <button class="btn btn-sm btn-ghost" id="rszNone">全不选</button>
            </div>
          </div>

          <button class="btn btn-primary btn-block" id="rszStart" ${disabled ? 'disabled' : ''}>
            🚀 一键适配 ${cnt} 个尺寸
          </button>
          <p style="font-size:11.5px;color:var(--text-3);line-height:1.7;margin:0">
            💡 一次上传批量输出：每个尺寸独立生成 MP4，自动保存到作品中心，完成后可逐个下载。首次使用需加载剪辑引擎（约 32MB，之后有缓存）。
          </p>
        </div>
      </div>`;
    bindConfigEvents(el);
  }

  function bindConfigEvents(el) {
    const fileInput = el.querySelector('#rszFile');
    const drop = el.querySelector('#rszDrop');
    if (drop) {
      drop.addEventListener('click', () => fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('drag');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }
    const chg = el.querySelector('#rszChange');
    if (chg) chg.addEventListener('click', () => fileInput.click());
    const clearBtn = el.querySelector('#rszClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      video = null;
      openDB().then((db) => {
        try { db.transaction('media', 'readwrite').objectStore('media').delete('main'); } catch { /* ignore */ }
      }).catch(() => {});
      render(document.querySelector('#content'));
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) handleFile(f);
      fileInput.value = '';
    });

    const fitCover = el.querySelector('#rszFitCover');
    const fitBlur = el.querySelector('#rszFitBlur');
    if (fitCover) fitCover.addEventListener('click', () => { fit = 'cover'; saveCfg(); render(document.querySelector('#content')); });
    if (fitBlur) fitBlur.addEventListener('click', () => { fit = 'blur'; saveCfg(); render(document.querySelector('#content')); });

    el.querySelectorAll('.rsz-size').forEach((item) => {
      // label 点击会转发给内部 checkbox 再冒泡回 label，同一 click 会触发两次处理，
      // 只处理 target 为 label 本身的那一次（checkbox 有 pointer-events:none，鼠标也点不到它）
      item.addEventListener('click', (e) => {
        if (e.target !== item) return;
        const key = item.dataset.key;
        selected[key] = !selected[key];
        saveCfg();
        render(document.querySelector('#content'));
      });
    });
    const allBtn = el.querySelector('#rszAll');
    if (allBtn) allBtn.addEventListener('click', () => {
      SIZES.forEach((s) => { selected[`${s.w}x${s.h}`] = true; });
      saveCfg();
      render(document.querySelector('#content'));
    });
    const noneBtn = el.querySelector('#rszNone');
    if (noneBtn) noneBtn.addEventListener('click', () => {
      SIZES.forEach((s) => { delete selected[`${s.w}x${s.h}`]; });
      saveCfg();
      render(document.querySelector('#content'));
    });

    const start = el.querySelector('#rszStart');
    if (start) start.addEventListener('click', () => run(el));
  }

  async function handleFile(file) {
    if (!file || !file.type.startsWith('video')) return UI.toast('请选择视频文件', 'warn');
    UI.toast(`读取中…（${fmtSize(file.size)}）`, 'info', 2500);
    const source = URL.createObjectURL(file);
    const meta = await readMeta(source);
    video = { name: file.name, source, duration: meta.duration, vw: meta.vw, vh: meta.vh, mediaKey: 'main' };
    saveCfg();
    saveMediaBlob(file).catch(() => { /* 存储失败不阻塞使用 */ });
    const el = document.querySelector('#content');
    if (el) render(el);
    UI.toast(`已上传 ✅ ${UI.fmtDur(video.duration)} · ${video.vw}×${video.vh}`, 'ok', 4000);
  }

  /* ---------- 进度界面 ---------- */
  function renderProgress(el) {
    el.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto;padding:30px 34px">
        <div style="display:flex;align-items:center">
          <span style="font-weight:700;font-size:15px">⚙️ 正在适配…</span>
          <span style="flex:1"></span>
          <span id="rsTime" style="font-size:12px;color:var(--text-3)">⏱ 已用 0s</span>
        </div>
        <div style="text-align:center;margin:28px 0 12px">
          <div id="rsPct" style="font-size:44px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">0%</div>
          <p id="rsStage" style="font-size:12.5px;color:var(--text-2);margin-top:4px">准备中…</p>
        </div>
        <div class="progress-bar" style="height:8px"><div class="fill" id="rsBar" style="width:0%"></div></div>
        <div id="rsLog" style="font-family:Consolas,monospace;font-size:11px;color:var(--text-3);background:var(--bg-soft);border-radius:8px;padding:10px;margin-top:16px;height:88px;overflow:auto;white-space:pre-wrap"></div>
        <button class="btn btn-sm btn-ghost" id="rsAbort" style="margin-top:14px">⏹ 停止（已完成的尺寸会保留）</button>
      </div>`;
    const abortBtn = el.querySelector('#rsAbort');
    if (abortBtn) abortBtn.addEventListener('click', () => { abort = true; });
  }

  function updateProgressUI() {
    const pct = el2('#rsPct'), bar = el2('#rsBar'), stage = el2('#rsStage'), log = el2('#rsLog');
    if (pct) pct.textContent = `${Math.round(curPct)}%`;
    if (bar) bar.style.width = `${Math.min(curPct, 100)}%`;
    if (stage) stage.textContent = curStage;
    if (log) log.textContent = logLines.slice(-6).join('\n');
  }
  function el2(id) { return document.getElementById(id); }

  /* ---------- 完成界面 ---------- */
  function renderDone(el) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h3 style="margin:0">🎉 适配完成（${results.length} 个尺寸）</h3>
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="rsAgain">🔄 再适配一次</button>
        <button class="btn btn-sm btn-ghost" id="rsNew">📁 更换视频</button>
      </div>
      <div class="result-grid">
        ${results.map((r) => `
          <div class="card" style="overflow:hidden">
            <video src="${r.url}" controls style="width:100%;aspect-ratio:${r.w}/${r.h};background:#000"></video>
            <div style="padding:11px 13px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-weight:700;font-size:13.5px">${r.w}×${r.h}</span>
                <span class="rsz-badge">${r.tag || ''}</span>
              </div>
              <div style="font-size:11.5px;color:var(--text-3);margin:4px 0 11px;word-break:break-all">${UI.escapeHtml(r.name || '视频')} · ${UI.fmtDur(r.dur)}</div>
              <a class="btn btn-primary btn-block btn-sm" href="${r.url}" download="适配_${r.w}x${r.h}_${Date.now()}.mp4">⬇ 下载 MP4</a>
            </div>
          </div>`).join('')}
      </div>
      <p style="font-size:11.5px;color:var(--text-3);margin-top:12px">📦 所有成片已自动保存到「作品中心」，可随时回看</p>`;
    const again = el.querySelector('#rsAgain');
    if (again) again.addEventListener('click', () => { mode = 'config'; render(document.querySelector('#content')); });
    const neu = el.querySelector('#rsNew');
    if (neu) neu.addEventListener('click', () => {
      video = null;
      openDB().then((db) => {
        try { db.transaction('media', 'readwrite').objectStore('media').delete('main'); } catch { /* ignore */ }
      }).catch(() => {});
      mode = 'config';
      render(document.querySelector('#content'));
    });
  }

  /* ---------- 批量执行 ---------- */
  async function run(el) {
    if (exporting) return;
    if (!video) return UI.toast('请先上传视频', 'warn');
    const targets = SIZES.filter((s) => selected[`${s.w}x${s.h}`]);
    if (!targets.length) return UI.toast('请至少勾选一个目标尺寸', 'warn');

    exporting = true; abort = false; results = [];
    mode = 'progress'; elapsed = 0; curPct = 0; curStage = '正在加载剪辑引擎…'; logLines = [];
    render(el);
    updateProgressUI();

    clearInterval(timerInt);
    timerInt = setInterval(() => {
      elapsed++;
      const t = el2('#rsTime');
      if (t) t.textContent = `⏱ 已用 ${elapsed}s`;
    }, 1000);

    const ffmpeg = await window.EditorView.ensureFFmpegPublic();
    if (!ffmpeg) {
      exporting = false; clearInterval(timerInt);
      mode = 'config';
      const content = document.querySelector('#content');
      if (content) render(content);
      return UI.toast('剪辑引擎加载失败，请检查网络后重试', 'err', 6000);
    }
    window.MA._ffmpegLog = (type, message) => {
      logLines.push(`[${type}] ${message}`);
      if (logLines.length > 200) logLines.shift();
      updateProgressUI();
    };

    try {
      for (let i = 0; i < targets.length; i++) {
        if (abort) { curStage = '已停止'; updateProgressUI(); break; }
        const t = targets[i];
        curStage = `正在适配 ${t.w}×${t.h}（${i + 1}/${targets.length}）…`;
        curPct = Math.round((i / targets.length) * 100);
        updateProgressUI();

        window.MA._ffmpegProgress = (ratio) => {
          curPct = Math.round(((i + Math.max(ratio, 0)) / targets.length) * 100);
          curStage = `正在适配 ${t.w}×${t.h}（${i + 1}/${targets.length}）· 本地处理中`;
          updateProgressUI();
        };

        const data = await convertOne(ffmpeg, t);
        const blob = new Blob([data], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        results.push({ url, w: t.w, h: t.h, tag: t.tag, dur: video.duration, name: video.name, at: Date.now() });
        try {
          await Store.add({ type: 'project', kind: 'resized', title: `尺寸适配 ${t.w}×${t.h}`, url, duration: video.duration });
        } catch { /* ignore */ }
        curPct = Math.round(((i + 1) / targets.length) * 100);
        updateProgressUI();
      }
      curStage = abort ? '已停止' : '完成 ✅';
      updateProgressUI();
    } catch (e) {
      console.error('[resize] error:', e);
      console.error('[resize] ffmpeg log tail:', logLines.slice(-15).join('\n'));
      UI.toast(`适配失败：${e.message || '未知错误'}`, 'err', 7000);
    } finally {
      exporting = false;
      clearInterval(timerInt);
      window.MA._ffmpegProgress = null;
      window.MA._ffmpegLog = null;
      mode = results.length ? 'done' : 'config';
      const content = document.querySelector('#content');
      if (content) render(content);
      if (mode === 'done') UI.toast(`适配完成：${results.length} 个尺寸 🎉`, 'ok', 5000);
      else if (abort) UI.toast('已停止，完成的尺寸已保留', 'warn', 4000);
    }
  }

  /** 单个尺寸转换：裁切铺满 / 模糊填充，输出 mp4（保留音轨） */
  async function convertOne(ffmpeg, t) {
    const lowName = (video.name || '').toLowerCase();
    const inName = 'rs_in' + (/\.webm$/.test(lowName) ? '.webm' : /\.(mov|mkv)$/.test(lowName) ? '.mov' : '.mp4');
    const outName = `rs_${t.w}x${t.h}.mp4`;
    await rm(ffmpeg, inName);
    await rm(ffmpeg, outName);
    await ffmpeg.writeFile(inName, await fetchB(video.source));

    let vf;
    if (fit === 'cover') {
      vf = `scale=${t.w}:${t.h}:force_original_aspect_ratio=increase,crop=${t.w}:${t.h}`;
    } else {
      vf = `split[a][b];` +
        `[a]scale=${t.w}:${t.h}:force_original_aspect_ratio=increase,crop=${t.w}:${t.h},gblur=sigma=24,eq=brightness=-0.15[bg];` +
        `[b]scale=${t.w}:${t.h}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
    }

    await execOk(ffmpeg, [
      '-i', inName,
      '-vf', vf, '-r', '25',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outName,
    ]);
    const data = await ffmpeg.readFile(outName);
    await rm(ffmpeg, inName);
    await rm(ffmpeg, outName);
    return data;
  }

  /* ---------- 启动时恢复 ---------- */
  async function initRestore() {
    loadCfg();
    if (!video) {
      const restored = await restoreMedia();
      if (restored) {
        const el = document.querySelector('#content');
        if (el && document.querySelector('[data-view=resize]')?.classList.contains('active')) {
          render(el);
          UI.toast('已恢复上次上传的视频 ✅', 'ok', 3000);
        }
      }
    }
  }
  document.addEventListener('DOMContentLoaded', initRestore);

  return { render };
})();
