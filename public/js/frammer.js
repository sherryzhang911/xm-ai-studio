/* ============================================================
 * frammer.js — 包框合成（改尺寸 + 垫底图 + 尾板视频）
 * v5：专门进度界面（阶段/百分比/耗时/日志）+ 批量合成 +
 *     宽度至 200% + 偏移三合一控制（输入框/滑杆/拖拽）
 * ============================================================ */
window.FrammerView = (() => {
  const LS_KEY = 'materall_frammer';

  const CANVASES = [
    { key: '1080x1920', label: '1080×1920 竖屏（9:16 抖音/快手）', w: 1080, h: 1920, tag: '9:16' },
    { key: '1080x1080', label: '1080×1080 方图（1:1 信息流）', w: 1080, h: 1080, tag: '1:1' },
    { key: '1080x1350', label: '1080×1350 竖版（4:5 小红书）', w: 1080, h: 1350, tag: '4:5' },
    { key: '1200x1800', label: '1200×1800 竖版（2:3）', w: 1200, h: 1800, tag: '2:3' },
    { key: '1920x1080', label: '1920×1080 横屏（16:9 B站/YouTube）', w: 1920, h: 1080, tag: '16:9' },
  ];

  let st = {
    canvas: '1080x1920',
    sizes: ['1080x1920'],       // 勾选的目标尺寸（可多个 → 批量）
    mainVideo: null,            // { name, source, duration, vw, vh }
    bgImages: [],               // 多垫底图 [{ name, source, mediaKey, sizeKey, w, h }]
    bgImage: null,              // 当前预览/合成用垫底图（= bgImages[0] 或 null，兼容旧逻辑）
    bgColor: '#000000',
    blurBg: true,
    mainPos: 'center',
    mainScale: 1,               // 兼容旧字段：默认宽度比例
    offsetX: 0,                 // 兼容旧字段
    offsetY: 0,
    perSize: {},                // 每尺寸独立配置：{ [sizeKey]: { scale, ox, oy, auto } }
    currentKey: '1080x1920',    // 当前正在调节的尺寸（控件作用于它）
    trimStart: 0,
    trimEnd: 0,
    endcard: null,               // 兼容旧字段 / 当前预览尾板（= endcards[0] 或 null）
    endcards: [],                // 多尾板 [{ name, source, mediaKey, sizeKey, duration, vw, vh }]
    endcardMode: 'append',      // append | replace
    mainEndAt: 0,
    endcardStart: 0,
    endcardDuration: 5,
    logo: null,                  // Logo/水印（可选）：{ name, source, mediaKey, w, h }
  };

  // 运行态（不持久化）
  let exporting = false;
  let mode = 'config';        // config | progress | done
  let results = [];           // [{ url, w, h, dur, name, at }]
  let batchQueue = [];        // 批量：待处理 [{ name, source, duration, vw, vh }]
  let batchIdx = 0;           // 批量进度
  let batchTotal = 0;
  let timerInt = null;        // 秒表
  let elapsed = 0;
  let curPct = 0;
  let curStage = '';
  let logLines = [];          // ffmpeg 日志尾部

  /* ---------- 媒体存储：大文件用 IndexedDB（localStorage 只存元数据，视频 data URL 会超配额丢失） ---------- */
  const MEDIA_DB = 'materall_frammer_media';
  const MEDIA_STORE = 'media';
  let mediaDbP = null;
  function mediaDB() {
    if (mediaDbP) return mediaDbP;
    mediaDbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(MEDIA_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(MEDIA_STORE)) req.result.createObjectStore(MEDIA_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return mediaDbP;
  }
  async function mediaPut(key, blob) {
    const db = await mediaDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(MEDIA_STORE, 'readwrite');
      t.objectStore(MEDIA_STORE).put({ key, blob });
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }
  async function mediaGet(key) {
    const db = await mediaDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(MEDIA_STORE, 'readonly');
      const req = t.objectStore(MEDIA_STORE).get(key);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function mediaDel(key) {
    const db = await mediaDB();
    return new Promise((resolve) => {
      const t = db.transaction(MEDIA_STORE, 'readwrite');
      t.objectStore(MEDIA_STORE).delete(key);
      t.oncomplete = resolve;
      t.onerror = () => resolve();
    });
  }
  /** 文件 → { key }（存 IndexedDB）+ 生成 blob URL 供预览/合成 */
  async function storeMedia(file, slot) {
    const key = `${slot}_${Date.now()}`;
    await mediaPut(key, file);
    return { key, url: URL.createObjectURL(file) };
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      // 兼容旧数据：单垫底图 bgImage → bgImages 数组；单画布 canvas → sizes 数组；单尾板 endcard → endcards 数组
      if (saved.bgImage && !saved.bgImages) saved.bgImages = [saved.bgImage];
      if (!Array.isArray(saved.bgImages)) saved.bgImages = saved.bgImage ? [saved.bgImage] : [];
      if (saved.endcard && !saved.endcards) saved.endcards = [saved.endcard];
      if (!Array.isArray(saved.endcards)) saved.endcards = saved.endcard ? [saved.endcard] : [];
      if (!saved.sizes || !Array.isArray(saved.sizes) || !saved.sizes.length) {
        saved.sizes = [saved.canvas || '1080x1920'];
      }
      // 过滤掉不存在的尺寸 key
      saved.sizes = saved.sizes.filter((k) => CANVASES.some((c) => c.key === k));
      if (!saved.sizes.length) saved.sizes = ['1080x1920'];
      // 保留内存中已有效的 source（blob URL）：save() 会把 source 清空，合并时不能被覆盖，
      // 否则批量组合中途 render() 会把刚上传的媒体 source 冲掉（时序竞争）
      const keepMain = st.mainVideo?.source ? st.mainVideo.source : null;
      const keepEnds = (st.endcards || []).map((e) => (e && e.source ? e.source : null));
      const keepBgs = (st.bgImages || []).map((b) => (b && b.source ? b.source : null));
      const keepLogo = st.logo?.source ? st.logo.source : null;
      Object.assign(st, saved);
      if (keepMain && st.mainVideo && !st.mainVideo.source) st.mainVideo.source = keepMain;
      (st.endcards || []).forEach((e, i) => { if (e && !e.source && keepEnds[i]) e.source = keepEnds[i]; });
      (st.bgImages || []).forEach((b, i) => { if (b && !b.source && keepBgs[i]) b.source = keepBgs[i]; });
      if (st.logo && !st.logo.source && keepLogo) st.logo.source = keepLogo;
      st.endcard = (st.endcards && st.endcards[0]) || null;
      // 预览用第一个勾选尺寸
      st.canvas = st.sizes[0];
      st.bgImage = st.bgImages[0] || null;
      // 兼容旧数据：老版本全局 mainScale/offsetX/offsetY → 迁移到首个尺寸的 perSize
      if ((!saved.perSize || typeof saved.perSize !== 'object' || !Object.keys(saved.perSize).length) && (saved.mainScale !== 1 || saved.offsetX || saved.offsetY)) {
        st.perSize = {};
        st.perSize[st.sizes[0]] = { scale: saved.mainScale ?? 1, ox: saved.offsetX ?? 0, oy: saved.offsetY ?? 0, auto: false };
      }
      if (typeof st.perSize !== 'object' || !st.perSize) st.perSize = {};
      // 大文件兼容：旧数据可能存了 data URL（source），保留可用；新数据用 mediaKey + 内存 url
    } catch { /* ignore */ }
    // 恢复 IndexedDB 里的媒体 → 生成 blob URL
    restoreMedia();
  }
  async function restoreMedia() {
    const jobs = [];
    if (st.mainVideo?.mediaKey) {
      jobs.push(mediaGet(st.mainVideo.mediaKey).then(async (blob) => {
        if (blob) st.mainVideo.source = URL.createObjectURL(blob);
        else st.mainVideo = null; // 媒体丢失（如用户清了站点数据）
      }));
    }
    if (st.endcard?.mediaKey) {
      jobs.push(mediaGet(st.endcard.mediaKey).then(async (blob) => {
        if (blob) st.endcard.source = URL.createObjectURL(blob);
        else st.endcard = null;
      }));
    }
    for (let i = 0; i < (st.endcards || []).length; i++) {
      const ec = st.endcards[i];
      if (!ec?.mediaKey) continue;
      jobs.push(mediaGet(ec.mediaKey).then(async (blob) => {
        if (blob) ec.source = URL.createObjectURL(blob);
        else st.endcards.splice(i, 1);
      }));
    }
    if (st.logo?.mediaKey) {
      jobs.push(mediaGet(st.logo.mediaKey).then(async (blob) => {
        if (blob) st.logo.source = URL.createObjectURL(blob);
        else st.logo = null;
      }));
    }
    for (let i = 0; i < (st.bgImages || []).length; i++) {
      const bg = st.bgImages[i];
      if (!bg?.mediaKey) continue;
      jobs.push(mediaGet(bg.mediaKey).then(async (blob) => {
        if (blob) bg.source = URL.createObjectURL(blob);
        else st.bgImages.splice(i, 1);
      }));
    }
    await Promise.all(jobs);
    st.bgImages = (st.bgImages || []).filter(Boolean);
    st.endcards = (st.endcards || []).filter(Boolean);
    // 与垫底图同理：批量合成时 st.endcard 被组合临时覆盖，这里不能抢回
    if (!st.endcard?.source) st.endcard = (st.endcards && st.endcards[0]) || null;
    // 旧数据兼容：无 sizeKey 字段的垫底图（旧版本上传的），按图片比例自动补匹配
    for (const bg of st.bgImages) {
      if (bg.sizeKey === undefined && bg.source) {
        const meta = await loadImgMeta(bg.source);
        bg.w = meta.w; bg.h = meta.h;
        bg.sizeKey = matchSizeKey(meta.w, meta.h);
        if (bg.sizeKey && !st.sizes.includes(bg.sizeKey)) st.sizes.push(bg.sizeKey);
      }
    }
    // 仅当当前垫底图失效时才重置为第一张；
    // 批量合成时 st.bgImage 被组合临时覆盖，这里不能抢回（否则每个组合都用第一张垫底图）
    if (!st.bgImage?.source) st.bgImage = st.bgImages[0] || null;
    // 恢复后重渲染（如当前在配置页）
    const el = document.querySelector('#content');
    if (el && mode === 'config' && document.querySelector('#fmExport')) renderConfig(el);
  }
  function save() {
    // localStorage 只存轻量元数据（不含 source data URL，避免超配额静默丢失）
    const light = {
      ...st,
      mainVideo: st.mainVideo ? { ...st.mainVideo, source: '' } : null,
      endcard: st.endcard ? { ...st.endcard, source: '' } : null,
      endcards: (st.endcards || []).map((e) => e ? { ...e, source: '' } : null).filter(Boolean),
      bgImage: null,
      bgImages: (st.bgImages || []).map((b) => b ? { ...b, source: '' } : null).filter(Boolean),
      logo: st.logo ? { ...st.logo, source: '' } : null,
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(light)); } catch { /* ignore */ }
  }

  /** 取某个尺寸的尾板：优先绑定该尺寸的，其次第一张通用尾板 */
  const endcardForSize = (key) => {
    const ends = st.endcards || [];
    return ends.find((e) => e.sizeKey === key) || ends.find((e) => !e.sizeKey) || null;
  };

  const getCv = () => CANVASES.find((c) => c.key === st.canvas) || CANVASES[0];

  /* ---------- 每尺寸独立配置（位置/大小 + Logo 位置/大小） ---------- */
  const getCfg = (key) => {
    if (!st.perSize[key]) st.perSize[key] = {};
    const cfg = st.perSize[key];
    if (cfg.scale === undefined) cfg.scale = 1;
    if (cfg.ox === undefined) cfg.ox = 0;
    if (cfg.oy === undefined) cfg.oy = 0;
    if (cfg.auto === undefined) cfg.auto = true;
    // Logo 每尺寸独立：归一化中心坐标（0~1）+ 宽度占画布比例
    if (cfg.logoX === undefined) cfg.logoX = 0.85;
    if (cfg.logoY === undefined) cfg.logoY = 0.88;
    if (cfg.logoScale === undefined) cfg.logoScale = 0.15;
    return cfg;
  };
  /** 更新某尺寸配置；scale/ox/oy 手动变化后退出「自动适配空心」模式 */
  const setCfg = (key, patch) => {
    const cfg = getCfg(key);
    Object.assign(cfg, patch);
    if ('scale' in patch || 'ox' in patch || 'oy' in patch) cfg.auto = false;
    return cfg;
  };
  /** 归零：scale=100%、偏移归零（有绑定垫底图时自动适配其空心区域） */
  function resetCfg(key, opts = {}) {
    const cv = CANVASES.find((c) => c.key === key) || CANVASES[0];
    const bg = bgForSize(key);
    const cfg = getCfg(key);
    if (bg && st.mainVideo && !opts.noAutoFit) {
      // 异步检测垫底图空心区域并适配
      detectHole(bg.source, cv.w, cv.h, st.mainVideo.vw / st.mainVideo.vh).then((fit) => {
        if (fit) {
          setCfg(key, { scale: fit.scale, ox: fit.ox, oy: fit.oy, auto: true });
          UI.toast(`已自动适配「${cv.w}×${cv.h}」垫底图空心区域 🎯`, 'ok', 3500);
        } else {
          setCfg(key, { scale: 1, ox: 0, oy: 0, auto: true });
          UI.toast(`未识别到「${cv.w}×${cv.h}」的空心区域，已归零居中`, 'warn', 4000);
        }
        save(); renderPreview(document.querySelector('#content'));
        syncOffsetUI(document.querySelector('#content'));
      });
      return;
    }
    setCfg(key, { scale: 1, ox: 0, oy: 0, auto: true });
    save();
    const cel = document.querySelector('#content');
    if (cel) { renderPreview(cel); syncOffsetUI(cel); }
  }
  /** 检测垫底图中的「空心区域」（与中心颜色相近的最大连通区）并计算主视频适配参数 */
  function detectHole(src, cvW, cvH, videoAr) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const AW = 140;
          const AH = Math.max(Math.round(AW * cvH / cvW), 40);
          const c = document.createElement('canvas');
          c.width = AW; c.height = AH;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          // 与合成一致的 cover 铺满
          const ir = img.naturalWidth / img.naturalHeight;
          const cr = AW / AH;
          let sw, sh, sx, sy;
          if (ir > cr) { sh = img.naturalHeight; sw = sh * cr; sx = (img.naturalWidth - sw) / 2; sy = 0; }
          else { sw = img.naturalWidth; sh = sw / cr; sx = 0; sy = (img.naturalHeight - sh) / 2; }
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, AW, AH);
          const data = ctx.getImageData(0, 0, AW, AH).data;
          const px = (x, y) => {
            const i = (y * AW + x) * 4;
            return [data[i], data[i + 1], data[i + 2]];
          };
          const cx = AW >> 1, cy = AH >> 1;
          const center = px(cx, cy);
          // BFS：与中心色接近（容差）的连通区域
          const TOL = 46;
          const visited = new Uint8Array(AW * AH);
          const stack = [[cx, cy]];
          visited[cy * AW + cx] = 1;
          let minX = cx, maxX = cx, minY = cy, maxY = cy, count = 0;
          while (stack.length) {
            const [x, y] = stack.pop();
            count++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= AW || ny >= AH) continue;
              const ni = ny * AW + nx;
              if (visited[ni]) continue;
              const p = px(nx, ny);
              if (Math.abs(p[0] - center[0]) + Math.abs(p[1] - center[1]) + Math.abs(p[2] - center[2]) > TOL) continue;
              visited[ni] = 1;
              stack.push([nx, ny]);
            }
          }
          const holeW = maxX - minX + 1, holeH = maxY - minY + 1;
          const areaRatio = count / (AW * AH);
          if (holeW < AW * 0.12 || holeH < AH * 0.12 || areaRatio < 0.05 || areaRatio > 0.92) return resolve(null);
          // 换算到画布像素
          const k = cvW / AW;
          const hw = Math.round(holeW * k), hh = Math.round(holeH * k);
          const hcx = Math.round((minX + maxX) / 2 * k), hcy = Math.round((minY + maxY) / 2 * k);
          // 主视频 contain 放入空心矩形
          let w = hw, h = Math.round(w / videoAr);
          if (h > hh) { h = hh; w = Math.round(h * videoAr); }
          resolve({
            scale: Math.min(w / cvW, 1.5),
            ox: hcx - cvW / 2,
            oy: hcy - cvH / 2,
          });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /** 当前配置下会生成的成片数量 = 勾选的尺寸数（每个尺寸一版，垫底图按尺寸一一对应） */
  function comboCount() {
    const sizes = st.sizes && st.sizes.length ? st.sizes : [st.canvas];
    return sizes.length;
  }
  /** 取某个尺寸的垫底图：优先绑定该尺寸的图，其次第一张通用图，都没有则 null（模糊/纯色底） */
  function bgForSize(cvKey) {
    const bgs = st.bgImages || [];
    return bgs.find((b) => b.sizeKey === cvKey) || bgs.find((b) => !b.sizeKey) || null;
  }
  /** 构建（视频 × 尺寸）组合队列：每张垫底图绑定一个尺寸，一一对应，不重复组合；每尺寸带独立位置配置 */
  function buildCombos(mainVideo) {
    const sizes = st.sizes && st.sizes.length ? st.sizes : [st.canvas];
    return sizes.map((cvKey) => ({ mainVideo, bgImage: bgForSize(cvKey), canvas: cvKey, cfg: getCfg(cvKey) }));
  }

  /* ============================================================
   * 渲染入口
   * ============================================================ */
  function render(el) {
    load();
    if (mode === 'progress') return renderProgress(el);
    if (mode === 'done') return renderDone(el);
    return renderConfig(el);
  }

  /* ============================================================
   * 配置界面
   * ============================================================ */
  function renderConfig(el) {
    const cv = getCv();
    el.innerHTML = `
      <div class="fram-layout">
        <div class="fram-panel">
          <div class="card">
            <div class="card-title"><span class="ico">🖼️</span>包框合成</div>
            <p style="font-size:12.5px;color:var(--text-3);margin-bottom:14px">
              横屏素材包框成竖屏/方形等尺寸：垫底图 + 主视频适配 + 尾板，本地合成
            </p>

            <label class="field">
              <span class="field-label">① 目标画布尺寸（勾选几个就出几个成片；垫底图按尺寸一一对应）</span>
              <div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:6px">
                ${CANVASES.map((c) => {
                  const on = st.sizes.includes(c.key);
                  return `<button type="button" class="btn btn-sm fm-size-chip ${on ? 'btn-primary' : ''}" data-size="${c.key}" id="fmSize_${c.key}">${c.w}×${c.h} ${c.tag}</button>`;
                }).join('')}
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-sm" id="fmSizeAll">全选</button>
                <button class="btn btn-sm btn-ghost" id="fmSizeNone">只留 1 个（单尺寸）</button>
                <span style="font-size:11.5px;color:var(--text-3);align-self:center">已选 ${st.sizes.length} 个</span>
              </div>
            </label>

            <label class="field">
              <span class="field-label">② 主视频（必选）</span>
              <input type="file" id="fmMainFile" accept="video/*" style="display:none">
              <div style="display:flex;gap:8px;align-items:center">
                <button class="btn btn-sm" id="fmMainPick">📁 上传主视频</button>
                ${st.mainVideo ? `<span style="font-size:12px;color:var(--ok)">✅ ${UI.escapeHtml(st.mainVideo.name)}（${(st.mainVideo.duration || 0).toFixed(1)}s）</span>
                  <button class="btn-icon" id="fmMainRemove" title="移除">✕</button>` : '<span style="font-size:12px;color:var(--text-3)">未选择</span>'}
              </div>
            </label>

            <label class="field">
              <span class="field-label">③ 垫底图（每张对应一个尺寸，自动按图片比例匹配；通用图用于未绑定的尺寸）</span>
              <input type="file" id="fmBgFile" accept="image/*" multiple style="display:none">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-sm" id="fmBgPick">📁 添加垫底图${st.bgImages.length ? `（已 ${st.bgImages.length} 张）` : ''}</button>
                <span style="font-size:12px;color:var(--text-3)">${st.bgImages.length ? '' : '未选（将使用' + (st.blurBg ? '主视频模糊背景' : '纯色背景') + '）'}</span>
              </div>
              ${st.bgImages.length ? `
              <div class="fm-bg-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:9px">
                ${st.bgImages.map((bg, i) => `
                  <div style="position:relative;border:1px solid var(--border-light);border-radius:9px;padding:6px;background:var(--bg-soft,#0e1119);width:108px">
                    <img src="${bg.source}" style="width:94px;height:52px;border-radius:6px;display:block;object-fit:cover">
                    <p style="font-size:10px;color:var(--text-3);margin:4px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${UI.escapeHtml(bg.name || '')}">${UI.escapeHtml(bg.name || '垫底图' + (i + 1))}${bg.w ? ` · ${bg.w}×${bg.h}` : ''}</p>
                    <select class="input fm-bg-size" data-idx="${i}" style="width:100%;padding:2px 4px;font-size:10.5px">
                      <option value="">通用（未绑定）</option>
                      ${CANVASES.map((c) => `<option value="${c.key}" ${bg.sizeKey === c.key ? 'selected' : ''}>${c.w}×${c.h}</option>`).join('')}
                    </select>
                    <button class="btn-icon fm-bg-del" data-idx="${i}" title="移除" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.65)">✕</button>
                  </div>`).join('')}
              </div>` : ''}
            </label>

            ${!st.bgImages.length ? `
            <div style="display:flex;gap:14px;align-items:center;font-size:12.5px;color:var(--text-2);margin:10px 0">
              <label style="display:flex;gap:5px;cursor:pointer"><input type="checkbox" id="fmBlur" ${st.blurBg ? 'checked' : ''} style="accent-color:var(--primary-2)"> 主视频模糊放大垫底</label>
              <label style="display:flex;gap:5px;align-items:center">纯色 <input type="color" id="fmColor" value="${st.bgColor}" style="width:26px;height:22px;border:none;background:none;cursor:pointer"></label>
            </div>` : ''}

            <div class="grid grid-2" style="gap:10px;margin-top:12px">
              <label class="field">
                <span class="field-label">主视频位置</span>
                <select class="input" id="fmPos">
                  <option value="center" ${st.mainPos === 'center' ? 'selected' : ''}>居中（上下对称）</option>
                  <option value="top" ${st.mainPos === 'top' ? 'selected' : ''}>贴顶</option>
                  <option value="bottom" ${st.mainPos === 'bottom' ? 'selected' : ''}>贴底</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">主画面宽度 <span id="fmScaleVal">${Math.round(getCfg(st.currentKey).scale * 100)}%</span>（可超画布）</span>
                <input type="range" id="fmScale" min="50" max="200" value="${Math.round(getCfg(st.currentKey).scale * 100)}" style="width:100%;accent-color:var(--primary-2)">
              </label>
            </div>

            <div style="margin-top:12px;border:1px solid var(--border-light);border-radius:10px;padding:10px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px">
                <span style="font-size:12.5px;font-weight:600;color:var(--text-1)">🎯 位置微调（当前：<span id="fmCurKey" style="color:var(--primary-2)">${st.currentKey.replace('x', '×')}</span> · 每个尺寸独立）</span>
                <button class="btn btn-sm" id="fmOffsetReset">↺ 归零并适配空心位</button>
              </div>
              <div class="grid grid-2" style="gap:10px">
                <label class="field" style="margin:0">
                  <span class="field-label">水平偏移（px）</span>
                  <div style="display:flex;gap:6px;align-items:center">
                    <input type="number" id="fmOffsetXNum" min="-${cv.w}" max="${cv.w}" value="${getCfg(st.currentKey).ox}" style="width:70px" class="input">
                    <input type="range" id="fmOffsetX" min="-${cv.w}" max="${cv.w}" value="${getCfg(st.currentKey).ox}" style="flex:1;accent-color:var(--primary-2)">
                  </div>
                </label>
                <label class="field" style="margin:0">
                  <span class="field-label">垂直偏移（px）</span>
                  <div style="display:flex;gap:6px;align-items:center">
                    <input type="number" id="fmOffsetYNum" min="-${cv.h}" max="${cv.h}" value="${getCfg(st.currentKey).oy}" style="width:70px" class="input">
                    <input type="range" id="fmOffsetY" min="-${cv.h}" max="${cv.h}" value="${getCfg(st.currentKey).oy}" style="flex:1;accent-color:var(--primary-2)">
                  </div>
                </label>
              </div>
              <p style="font-size:11px;color:var(--text-3);margin:8px 0 0">💡 每个尺寸独立调节：<b>点击预览格选中</b>该尺寸，或在预览中<b>直接拖动</b>；「归零」会识别垫底图<b>空心预留区域</b>自动适配主视频</p>
            </div>

            <label class="field" style="margin-top:12px">
              <span class="field-label">④ 尾板视频（可多段，每段对应一个尺寸；不绑定的尺寸无尾板）</span>
              <input type="file" id="fmEndFile" accept="video/*" multiple style="display:none">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-sm" id="fmEndPick">📁 添加尾板${st.endcards.length ? `（已 ${st.endcards.length} 段）` : ''}</button>
                <span style="font-size:12px;color:var(--text-3)">${st.endcards.length ? '' : '未选择（成片不带尾板）'}</span>
              </div>
              ${st.endcards.length ? `
              <div class="fm-bg-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:9px">
                ${st.endcards.map((ec, i) => `
                  <div style="position:relative;border:1px solid var(--border-light);border-radius:9px;padding:6px;background:var(--bg-soft,#0e1119);width:108px">
                    <div style="width:94px;height:52px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2a3550,#1a2235);font-size:22px">🎞️</div>
                    <p style="font-size:10px;color:var(--text-3);margin:4px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${UI.escapeHtml(ec.name || '')}">${UI.escapeHtml(ec.name || '尾板' + (i + 1))} · ${(ec.duration || 0).toFixed(1)}s</p>
                    <select class="input fm-end-size" data-idx="${i}" style="width:100%;padding:2px 4px;font-size:10.5px">
                      <option value="">通用（所有尺寸）</option>
                      ${CANVASES.map((c) => `<option value="${c.key}" ${ec.sizeKey === c.key ? 'selected' : ''}>${c.w}×${c.h}</option>`).join('')}
                    </select>
                    <button class="btn-icon fm-end-del" data-idx="${i}" title="移除" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.65)">✕</button>
                  </div>`).join('')}
              </div>` : ''}
            </label>
            ${st.endcards.length ? `
            <div style="margin-top:10px;border:1px solid var(--border-light);border-radius:10px;padding:10px">
              <div style="display:flex;gap:6px;margin-bottom:10px">
                <button class="btn btn-sm ${st.endcardMode !== 'replace' ? 'btn-primary' : ''}" id="fmModeAppend" style="flex:1">➕ 加在片尾</button>
                <button class="btn btn-sm ${st.endcardMode === 'replace' ? 'btn-primary' : ''}" id="fmModeReplace" style="flex:1">🔄 替换原尾板</button>
              </div>
              ${st.endcardMode === 'replace' ? `
              <label class="field" style="margin-bottom:10px">
                <span class="field-label">主视频保留到第几秒${st.mainVideo ? `（原片共 ${st.mainVideo.duration.toFixed(1)}s）` : ''}</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <input type="number" id="fmMainEndAt" min="0" max="${st.mainVideo ? Math.max(Math.floor(st.mainVideo.duration - 0.5), 1) : 30}" step="0.5" value="${st.mainEndAt || 0}" style="width:80px" class="input"> 秒
                  <span style="font-size:11px;color:var(--text-3)">0 = 自动</span>
                </div>
              </label>` : ''}
              <div style="display:flex;gap:12px;align-items:center;font-size:12.5px;color:var(--text-2);flex-wrap:wrap">
                <label style="display:flex;gap:5px;align-items:center">尾板素材起始
                  <input type="number" id="fmEndStart" min="0" max="${Math.max(Math.floor((endcardForSize(st.currentKey)?.duration || 30)) - 1, 0)}" step="0.5" value="${st.endcardStart || 0}" style="width:60px" class="input"> 秒
                </label>
                <label style="display:flex;gap:5px;align-items:center">时长
                  <input type="number" id="fmEndDur" min="1" max="30" step="0.5" value="${st.endcardDuration}" style="width:60px" class="input"> 秒
                </label>
              </div>
              <p style="font-size:11px;color:var(--text-3);margin:8px 0 0">当前尺寸（${st.currentKey.replace('x', '×')}）尾板素材共 ${(endcardForSize(st.currentKey)?.duration || 0).toFixed(1)}s，取 ${(st.endcardStart || 0).toFixed(1)}s ~ ${((st.endcardStart || 0) + st.endcardDuration).toFixed(1)}s 段落；其余尺寸用各自绑定的尾板</p>
            </div>` : ''}

            <label class="field" style="margin-top:12px">
              <span class="field-label">⑤ Logo/水印（可选）</span>
              <input type="file" id="fmLogoFile" accept="image/*" style="display:none">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-sm" id="fmLogoPick">📁 ${st.logo ? '更换 Logo' : '上传 Logo'}</button>
                ${st.logo ? `
                  <img src="${st.logo.source}" style="height:40px;border-radius:6px;border:1px solid var(--border-light);background:#fff">
                  <button class="btn-icon" id="fmLogoRemove" title="移除">✕</button>
                  <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-2)">当前尺寸（${st.currentKey.replace('x', '×')}）大小
                    <input type="range" id="fmLogoScale" min="8" max="40" value="${Math.round((getCfg(st.currentKey).logoScale || 0.15) * 100)}" style="width:110px;accent-color:var(--primary-2)">
                    <span id="fmLogoScaleVal">${Math.round((getCfg(st.currentKey).logoScale || 0.15) * 100)}%</span>
                  </label>
                  <span style="font-size:11px;color:var(--text-3)">预览格内可直接拖动位置（每个尺寸独立）</span>` : '<span style="font-size:12px;color:var(--text-3)">未选择（不叠加）· 支持透明 PNG</span>'}
              </div>
            </label>

            <div style="display:flex;gap:8px;margin-top:16px">
              <button class="btn btn-primary" style="flex:1" id="fmExport">${comboCount() > 1 ? `📦 批量合成 ${comboCount()} 个成片` : '🚀 合成并导出'}</button>
              <button class="btn" id="fmBatchPick" title="上传多个主视频，用当前配置（多尺寸×多垫底图）逐个合成">📦 多视频批量</button>
              <input type="file" id="fmBatchFile" accept="video/*" multiple style="display:none">
            </div>
            ${comboCount() > 1 ? `<p style="font-size:11.5px;color:var(--text-3);margin:8px 0 0">📦 每个尺寸一版成片（垫底图与尺寸一一对应），共 ${comboCount()} 个成片；进度页可随时返回配置页</p>` : ''}
          </div>
        </div>

        <div class="fram-preview">
          <div class="card" style="min-height:520px;display:flex;flex-direction:column">
            <div class="card-title"><span class="ico">👁️</span>实时预览（${comboCount() > 1 ? `${comboCount()} 个组合 · 与导出一致` : `${st.canvas.replace('x', '×')}`}）</div>
            <div id="fmPreviewWrap" style="flex:1;display:flex;justify-content:center;background:var(--bg-2,#111);border-radius:10px;overflow:auto;position:relative;padding:14px">
              <div id="fmPreview" style="width:100%"></div>
            </div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:10px" id="fmInfo"></div>
          </div>
        </div>
      </div>`;

    bindConfigEvents(el);
    renderPreview(el);
  }

  /* ---------- 配置界面事件 ---------- */
  function bindConfigEvents(el) {
    // 尺寸多选 chips
    el.querySelectorAll('.fm-size-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.size;
        if (st.sizes.includes(k)) {
          if (st.sizes.length === 1) return; // 至少保留 1 个
          st.sizes = st.sizes.filter((x) => x !== k);
        } else {
          st.sizes = [...st.sizes, k];
        }
        st.canvas = st.sizes[0];
        save(); render(el);
      });
    });
    el.querySelector('#fmSizeAll').addEventListener('click', () => {
      st.sizes = CANVASES.map((c) => c.key);
      st.canvas = st.sizes[0];
      save(); render(el);
    });
    el.querySelector('#fmSizeNone').addEventListener('click', () => {
      st.sizes = [st.canvas];
      save(); render(el);
    });

    el.querySelector('#fmMainPick').addEventListener('click', () => el.querySelector('#fmMainFile').click());
    el.querySelector('#fmMainFile').addEventListener('change', (e) => pickVideo(e, 'main', el));
    el.querySelector('#fmMainRemove')?.addEventListener('click', () => { st.mainVideo = null; save(); render(el); });
    el.querySelector('#fmBgPick').addEventListener('click', () => el.querySelector('#fmBgFile').click());
    el.querySelector('#fmBgFile').addEventListener('change', (e) => pickImages(e, el));
    el.querySelectorAll('.fm-bg-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const bg = st.bgImages[idx];
        if (bg?.mediaKey) mediaDel(bg.mediaKey).catch(() => {});
        st.bgImages.splice(idx, 1);
        st.bgImage = st.bgImages[0] || null;
        save(); render(el);
      });
    });
    el.querySelectorAll('.fm-bg-size').forEach((sel) => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.dataset.idx);
        const bg = st.bgImages[idx];
        if (!bg) return;
        bg.sizeKey = sel.value || null;
        if (bg.sizeKey && !st.sizes.includes(bg.sizeKey)) {
          st.sizes.push(bg.sizeKey);
          UI.toast(`已把「${bg.name}」绑定到 ${bg.sizeKey.replace('x', '×')} 并自动勾选该尺寸`, 'ok', 4000);
        } else if (!bg.sizeKey) {
          UI.toast(`「${bg.name}」设为通用垫底图（用于未绑定的尺寸）`, 'ok', 3000);
        }
        save(); render(el);
      });
    });
    el.querySelector('#fmBlur')?.addEventListener('change', (e) => { st.blurBg = e.target.checked; save(); renderPreview(el); });
    el.querySelector('#fmColor')?.addEventListener('input', (e) => { st.bgColor = e.target.value; save(); renderPreview(el); });
    el.querySelector('#fmPos').addEventListener('change', (e) => { st.mainPos = e.target.value; save(); renderPreview(el); });

    el.querySelector('#fmScale').addEventListener('input', (e) => {
      setCfg(st.currentKey, { scale: Number(e.target.value) / 100 });
      el.querySelector('#fmScaleVal').textContent = e.target.value + '%';
      save(); renderPreview(el);
    });

    // 偏移三合一：数字输入 + 滑杆 + 拖拽 全部同步（作用于当前选中尺寸，各尺寸独立）
    const setOffset = (axis, val) => {
      const cv = CANVASES.find((c) => c.key === st.currentKey) || getCv();
      const max = axis === 'x' ? cv.w : cv.h;
      const v = Math.min(Math.max(Math.round(val) || 0, -max), max);
      if (axis === 'x') setCfg(st.currentKey, { ox: v });
      else setCfg(st.currentKey, { oy: v });
      save(); renderPreview(el); syncOffsetUI(el);
    };
    el.querySelector('#fmOffsetX').addEventListener('input', (e) => setOffset('x', Number(e.target.value)));
    el.querySelector('#fmOffsetY').addEventListener('input', (e) => setOffset('y', Number(e.target.value)));
    el.querySelector('#fmOffsetXNum').addEventListener('change', (e) => setOffset('x', Number(e.target.value)));
    el.querySelector('#fmOffsetYNum').addEventListener('change', (e) => setOffset('y', Number(e.target.value)));
    el.querySelector('#fmOffsetReset').addEventListener('click', () => {
      resetCfg(st.currentKey);
      syncOffsetUI(el);
    });

    el.querySelector('#fmEndPick').addEventListener('click', () => el.querySelector('#fmEndFile').click());
    el.querySelector('#fmEndFile').addEventListener('change', (e) => pickEndcards(e, el));
    el.querySelectorAll('.fm-end-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const ec = st.endcards[idx];
        if (ec?.mediaKey) mediaDel(ec.mediaKey).catch(() => {});
        st.endcards.splice(idx, 1);
        st.endcard = st.endcards[0] || null;
        save(); render(el);
      });
    });
    el.querySelectorAll('.fm-end-size').forEach((sel) => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.dataset.idx);
        const ec = st.endcards[idx];
        if (!ec) return;
        ec.sizeKey = sel.value || null;
        if (ec.sizeKey && !st.sizes.includes(ec.sizeKey)) {
          st.sizes.push(ec.sizeKey);
          UI.toast(`已把尾板「${ec.name}」绑定到 ${ec.sizeKey.replace('x', '×')} 并自动勾选该尺寸`, 'ok', 4000);
        }
        save(); render(el);
      });
    });
    el.querySelector('#fmModeAppend')?.addEventListener('click', () => { st.endcardMode = 'append'; save(); render(el); });
    el.querySelector('#fmModeReplace')?.addEventListener('click', () => { st.endcardMode = 'replace'; save(); render(el); });
    el.querySelector('#fmMainEndAt')?.addEventListener('change', (e) => {
      const maxV = st.mainVideo ? Math.max(Math.floor(st.mainVideo.duration - 0.5), 1) : 30;
      st.mainEndAt = Math.min(Math.max(Number(e.target.value) || 0, 0), maxV);
      e.target.value = st.mainEndAt;
      save(); renderPreview(el);
    });
    el.querySelector('#fmEndStart')?.addEventListener('change', (e) => {
      const dur = endcardForSize(st.currentKey)?.duration || st.endcards[0]?.duration || 30;
      const maxStart = Math.max(Math.floor(dur) - st.endcardDuration, 0);
      st.endcardStart = Math.min(Math.max(Number(e.target.value) || 0, 0), maxStart);
      e.target.value = st.endcardStart;
      save(); renderPreview(el);
    });
    el.querySelector('#fmEndDur')?.addEventListener('change', (e) => {
      st.endcardDuration = Math.min(Math.max(Number(e.target.value) || 5, 1), 30);
      save(); renderPreview(el);
    });
    el.querySelector('#fmLogoPick')?.addEventListener('click', () => el.querySelector('#fmLogoFile').click());
    el.querySelector('#fmLogoFile')?.addEventListener('change', (e) => pickLogo(e, el));
    el.querySelector('#fmLogoRemove')?.addEventListener('click', () => { st.logo = null; save(); render(el); });
    el.querySelector('#fmLogoScale')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      const cfg = getCfg(st.currentKey);
      cfg.logoScale = v;
      const val = el.querySelector('#fmLogoScaleVal');
      if (val) val.textContent = e.target.value + '%';
      save(); renderPreview(el);
    });

    el.querySelector('#fmExport').addEventListener('click', async () => {
      if (!st.mainVideo) return UI.toast('请先上传主视频', 'warn');
      const combos = buildCombos(st.mainVideo);
      if (!combos.length) return UI.toast('请至少勾选一个目标尺寸', 'warn');
      batchQueue = combos; results = []; batchIdx = 0; batchTotal = combos.length;
      for (; batchIdx < batchQueue.length; batchIdx++) {
        await runExport(el, batchQueue[batchIdx], true);
      }
    });

    // 批量合成（多主视频 × 当前多尺寸×多垫底图 组合）
    el.querySelector('#fmBatchPick').addEventListener('click', () => el.querySelector('#fmBatchFile').click());
    el.querySelector('#fmBatchFile').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      batchQueue = []; results = [];
      for (const f of files) {
        if (f.size > 200 * 1024 * 1024) { UI.toast(`跳过 ${f.name}（超过 200MB）`, 'warn'); continue; }
        const source = URL.createObjectURL(f); // blob URL，直接可用
        const meta = await readMeta(source);
        batchQueue.push(...buildCombos({ name: f.name, source, ...meta }));
      }
      e.target.value = '';
      if (!batchQueue.length) return;
      UI.toast(`📦 批量模式：${files.length} 个视频 × ${st.sizes.length} 个尺寸 = ${batchQueue.length} 个成片`, 'ok', 5000);
      batchIdx = 0; batchTotal = batchQueue.length;
      for (; batchIdx < batchQueue.length; batchIdx++) {
        await runExport(el, batchQueue[batchIdx], true);
      }
    });
  }

  function syncOffsetUI(el) {
    const cfg = getCfg(st.currentKey);
    const sx = el.querySelector('#fmOffsetX'), sy = el.querySelector('#fmOffsetY');
    const nx = el.querySelector('#fmOffsetXNum'), ny = el.querySelector('#fmOffsetYNum');
    const sv = el.querySelector('#fmScale'), svl = el.querySelector('#fmScaleVal');
    const ck = el.querySelector('#fmCurKey');
    if (sx) sx.value = cfg.ox; if (nx) nx.value = cfg.ox;
    if (sy) sy.value = cfg.oy; if (ny) ny.value = cfg.oy;
    if (sv) sv.value = Math.round(cfg.scale * 100);
    if (svl) svl.textContent = Math.round(cfg.scale * 100) + '%';
    if (ck) ck.textContent = st.currentKey.replace('x', '×');
  }

  function readMeta(source) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({ duration: v.duration || 5, vw: v.videoWidth || 1920, vh: v.videoHeight || 1080 });
      v.onerror = () => resolve({ duration: 5, vw: 1920, vh: 1080 });
      v.src = source;
    });
  }

  async function pickVideo(e, slot, el) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) {
      UI.toast(`「${f.name}」超过 200MB 上限，请压缩后再试`, 'err', 6000);
      return;
    }
    // 1) 先用 blob URL 立即可用（不等任何转换）
    const source = URL.createObjectURL(f);
    UI.toast(`正在读取「${f.name}」（${(f.size / 1024 / 1024).toFixed(1)}MB）…`, 'info', 3000);
    // 2) 读取元数据
    const meta = await readMeta(source);
    // 3) 存 IndexedDB（持久化，大文件不受 localStorage 配额限制）
    let mediaKey = '';
    try {
      const m = await storeMedia(f, slot);
      mediaKey = m.key;
    } catch (err) {
      console.warn('[frammer] media store failed:', err);
      UI.toast('⚠️ 文件较大，本次会话可用；刷新页面后需重新上传', 'warn', 5000);
    }
    if (slot === 'main') {
      st.mainVideo = { name: f.name, source, mediaKey, ...meta };
      st.trimEnd = Math.min(st.trimEnd || 0, Math.floor(meta.duration));
      // webm（尤其含 Opus 音轨）在浏览器引擎兼容性差，提前告知
      if (/\.webm$/i.test(f.name) || f.type === 'video/webm') {
        UI.toast('⚠️ webm 格式在本地引擎中兼容性有限（可能无声或失败），建议先用 mp4 素材', 'warn', 6000);
      }
    } else {
      st.endcard = { name: f.name, source, mediaKey, ...meta };
      st.endcardStart = Math.min(st.endcardStart || 0, Math.max(Math.floor(meta.duration) - 1, 0));
    }
    save(); render(el);
    UI.toast(`${slot === 'main' ? '主视频' : '尾板'}已上传 ✅（${meta.duration.toFixed(1)}s · ${meta.vw}×${meta.vh}）`, 'ok', 4000);
  }

  /** 读取图片分辨率 */
  function loadImgMeta(source) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = source;
    });
  }
  /** 按宽高比匹配最接近的预设画布尺寸（比例差超过 12% 视为不匹配，返回 null） */
  function matchSizeKey(w, h) {
    if (!w || !h) return null;
    const r = w / h;
    let best = null, bestDiff = Infinity;
    for (const c of CANVASES) {
      const diff = Math.abs(r - c.w / c.h);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    return best && bestDiff < 0.12 ? best.key : null;
  }

  async function pickImages(e, el) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let added = 0, autoChecked = 0;
    const unmatchedNames = [];
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { UI.toast(`「${f.name}」超过 20MB，已跳过`, 'warn', 4000); continue; }
      if (!f.type.startsWith('image/')) continue;
      const source = URL.createObjectURL(f);
      const meta = await loadImgMeta(source);
      const sizeKey = matchSizeKey(meta.w, meta.h);
      let mediaKey = '';
      try {
        const m = await storeMedia(f, 'bg');
        mediaKey = m.key;
      } catch { /* ignore */ }
      st.bgImages.push({ name: f.name, source, mediaKey, w: meta.w, h: meta.h, sizeKey });
      if (sizeKey) {
        if (!st.sizes.includes(sizeKey)) { st.sizes.push(sizeKey); autoChecked++; }
      } else {
        unmatchedNames.push(f.name);
      }
      added++;
    }
    st.bgImage = st.bgImages[0] || null;
    save(); render(el);
    const notes = [];
    if (added) notes.push(`已添加 ${added} 张垫底图`);
    if (autoChecked) notes.push(`自动勾选 ${autoChecked} 个对应尺寸`);
    if (notes.length) UI.toast(`✅ ${notes.join('，')}`, 'ok', 4000);
    if (unmatchedNames.length) UI.toast(`⚠️ ${unmatchedNames[0]} 的比例未匹配到预设尺寸，已设为通用，可在列表中手动指定`, 'warn', 6000);
  }

  /** 多尾板上传：读元数据、按视频比例自动匹配尺寸、存 IndexedDB */
  async function pickEndcards(e, el) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let added = 0, autoChecked = 0;
    for (const f of files) {
      if (f.size > 200 * 1024 * 1024) { UI.toast(`「${f.name}」超过 200MB，已跳过`, 'warn', 4000); continue; }
      if (!f.type.startsWith('video/')) continue;
      const source = URL.createObjectURL(f);
      UI.toast(`正在读取尾板「${f.name}」…`, 'info', 2500);
      const meta = await readMeta(source);
      const sizeKey = matchSizeKey(meta.vw, meta.vh);
      let mediaKey = '';
      try {
        const m = await storeMedia(f, 'end');
        mediaKey = m.key;
      } catch { /* ignore */ }
      st.endcards.push({ name: f.name, source, mediaKey, sizeKey, duration: meta.duration, vw: meta.vw, vh: meta.vh });
      if (sizeKey && !st.sizes.includes(sizeKey)) { st.sizes.push(sizeKey); autoChecked++; }
      added++;
    }
    st.endcard = st.endcards[0] || null;
    save(); render(el);
    const notes = [];
    if (added) notes.push(`已添加 ${added} 段尾板`);
    if (autoChecked) notes.push(`自动勾选 ${autoChecked} 个对应尺寸`);
    if (notes.length) UI.toast(`✅ ${notes.join('，')}`, 'ok', 4000);
  }

  /** 上传 Logo/水印（可选，全局一个；位置/大小每尺寸独立存 perSize）。先显示后存库，避免 IndexedDB 阻塞卡顿 */
  async function pickLogo(e, el) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { UI.toast('Logo 超过 10MB，请压缩后再试', 'err', 5000); return; }
    if (!f.type.startsWith('image/')) return;
    const source = URL.createObjectURL(f);
    // 立即生效（尺寸先用正方形占位，读出真实比例后自动纠正）
    st.logo = { name: f.name, source, mediaKey: '', w: 0, h: 0 };
    (st.sizes || []).forEach((k) => { getCfg(k); });
    save(); render(el);
    UI.toast('Logo 已上传 ✅ 可在预览格内拖动位置（每个尺寸独立）', 'ok', 4000);
    // 后台读取图片尺寸（纠正预览比例）
    loadImgMeta(source).then((meta) => {
      if (!st.logo || st.logo.source !== source) return;
      st.logo.w = meta.w || 100; st.logo.h = meta.h || 100;
      save();
      const cel = document.querySelector('#content');
      if (cel && mode === 'config') renderPreview(cel);
    });
    // 后台存 IndexedDB（刷新后仍能恢复）
    storeMedia(f, 'logo').then((m) => {
      if (st.logo) { st.logo.mediaKey = m.key; save(); }
    }).catch(() => { /* 不阻塞使用 */ });
  }

  /* ---------- 预览（几何与导出一致；多尺寸 × 多垫底图全组合网格） ---------- */
  /* ---------- 拖拽全局单例（mousemove/mouseup 只绑定一次，避免每次渲染累积监听器导致卡顿） ---------- */
  let dragState = null; // { mode:'main'|'logo', item, cfg, pw, ph, scaleRatio, baseX, baseY, sx, sy, ox, oy }
  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const d = dragState;
    if (d.mode === 'main') {
      d.cfg.ox = Math.round(d.ox + (e.clientX - d.sx) * d.scaleRatio);
      d.cfg.oy = Math.round(d.oy + (e.clientY - d.sy) * d.scaleRatio);
      d.cfg.auto = false;
      d.item.style.left = (d.baseX + Math.round(d.cfg.ox / d.scaleRatio)) + 'px';
      d.item.style.top = (d.baseY + Math.round(d.cfg.oy / d.scaleRatio)) + 'px';
    } else if (d.mode === 'logo') {
      d.cfg.logoX = Math.min(Math.max((d.ox + (e.clientX - d.sx)) / d.pw, 0), 1);
      d.cfg.logoY = Math.min(Math.max((d.oy + (e.clientY - d.sy)) / d.ph, 0), 1);
      const lw = Math.max(10, Math.round(d.pw * (d.cfg.logoScale || 0.15)));
      const lh = Math.max(10, Math.round(lw * (((st.logo && st.logo.h) || 1) / ((st.logo && st.logo.w) || 1))));
      d.item.style.left = Math.min(Math.max(Math.round(d.cfg.logoX * d.pw - lw / 2), 0), d.pw - lw) + 'px';
      d.item.style.top = Math.min(Math.max(Math.round(d.cfg.logoY * d.ph - lh / 2), 0), d.ph - lh) + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState = null;
    save();
    const el = document.querySelector('#content');
    if (el) { renderPreview(el); syncOffsetUI(el); }
  });

  function renderPreview(el) {
    const box = el.querySelector('#fmPreview');
    const info = el.querySelector('#fmInfo');
    if (!box) return;
    const combos = buildCombos(st.mainVideo);
    const MAX_CELLS = 12;
    const show = combos.slice(0, MAX_CELLS);
    const multi = combos.length > 1;
    const cellH = multi ? 230 : 360;

    box.innerHTML = `
      <div style="display:${multi ? 'grid' : 'block'};grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;width:100%;justify-items:center">
        ${show.map((c, i) => previewCell(c, i, cellH)).join('')}
      </div>
      ${combos.length === 0 ? '<p style="color:var(--text-3,#777);font-size:12.5px;text-align:center;margin-top:30px">勾选目标尺寸后显示预览</p>' : ''}
      ${combos.length > MAX_CELLS ? `<p style="font-size:11px;color:var(--text-3);margin-top:10px;text-align:center">预览显示前 ${MAX_CELLS} 个组合，导出将生成全部 ${combos.length} 个成片</p>` : ''}
    `;

    // 拖拽：mousedown 只设置全局 dragState（单例监听器处理移动/松手）
    box.querySelectorAll('.fm-cell-drag').forEach((item) => {
      if (!st.mainVideo) return;
      const c = show[Number(item.dataset.i)] || combos[0];
      const cv = CANVASES.find((x) => x.key === c.canvas) || CANVASES[0];
      const scale = cellH / cv.h;
      const pw = Math.round(cv.w * scale), ph = Math.round(cv.h * scale);
      const scaleRatio = cv.h / ph;
      const ar = (st.mainVideo.vw && st.mainVideo.vh) ? st.mainVideo.vw / st.mainVideo.vh : 16 / 9;
      const mainW = Math.round(pw * c.cfg.scale);
      const mainH = Math.round(mainW / ar);
      const baseY = st.mainPos === 'top' ? 0 : st.mainPos === 'bottom' ? ph - mainH : Math.round((ph - mainH) / 2);
      const baseX = Math.round((pw - mainW) / 2);
      item.addEventListener('mousedown', (e) => {
        // 按下即开始拖拽（不再因切换选中而打断；选中态在松手重绘后体现）
        if (st.currentKey !== c.canvas) { st.currentKey = c.canvas; syncOffsetUI(el); }
        dragState = { mode: 'main', item, cfg: c.cfg, scaleRatio, baseX, baseY, sx: e.clientX, sy: e.clientY, ox: c.cfg.ox, oy: c.cfg.oy };
        item.style.cursor = 'grabbing'; e.preventDefault();
      });
    });

    // Logo 拖拽：每个尺寸独立（更新该尺寸 cfg.logoX/logoY 归一化坐标）
    if (st.logo) {
      box.querySelectorAll('.fm-logo-drag').forEach((item) => {
        const c = show[Number(item.dataset.i)] || combos[0];
        const cv = CANVASES.find((x) => x.key === c.canvas) || CANVASES[0];
        const scale = cellH / cv.h;
        const pw = Math.round(cv.w * scale), ph = Math.round(cv.h * scale);
        const cfg = getCfg(c.canvas);
        item.addEventListener('mousedown', (e) => {
          // 按下即开始拖拽（与主视频一致）
          if (st.currentKey !== c.canvas) { st.currentKey = c.canvas; syncOffsetUI(el); }
          dragState = { mode: 'logo', item, cfg, pw, ph, sx: e.clientX, sy: e.clientY, ox: (cfg.logoX || 0.85) * pw, oy: (cfg.logoY || 0.88) * ph };
          item.style.cursor = 'grabbing'; e.preventDefault(); e.stopPropagation();
        });
      });
    }

    // 点击预览格：选中该尺寸（控件作用于它）
    box.querySelectorAll('.fm-cell-box').forEach((cellBox) => {
      cellBox.addEventListener('click', () => {
        const k = cellBox.dataset.key;
        if (!k || st.currentKey === k) return;
        st.currentKey = k;
        renderPreview(el);
        syncOffsetUI(el);
      });
    });

    if (info) {
      if (!st.mainVideo) { info.textContent = '上传主视频后显示时长信息'; return; }
      let effEnd = st.trimEnd > 0 ? st.trimEnd : st.mainVideo.duration;
      const curEnd = endcardForSize(st.currentKey);
      let modeNote = '';
      if (curEnd && st.endcardMode === 'replace') {
        const auto = Math.max(effEnd - st.endcardDuration, st.trimStart + 0.5);
        const kept = st.mainEndAt > 0 ? Math.min(st.mainEndAt, effEnd) : auto;
        modeNote = ` · 保留至 ${kept.toFixed(1)}s 后切换尾板`;
        effEnd = kept;
      }
      const mainDur = Math.max(effEnd - st.trimStart, 0);
      const total = mainDur + (curEnd ? st.endcardDuration : 0);
      info.textContent = `主视频 ${mainDur.toFixed(1)}s${curEnd ? ` ${st.endcardMode === 'replace' ? '替换为' : '+'} 尾板 ${st.endcardDuration}s` : ''} ≈ 总时长 ${total.toFixed(1)}s${modeNote} · ${combos.length} 个组合 · 当前尺寸偏移(${getCfg(st.currentKey).ox},${getCfg(st.currentKey).oy})`;
    }
  }

  /** 单个组合的预览格（垫底图/背景 + 主视频按当前配置适配） */
  function previewCell(c, i, cellH) {
    const cv = CANVASES.find((x) => x.key === c.canvas) || CANVASES[0];
    const scale = cellH / cv.h;
    const pw = Math.round(cv.w * scale), ph = Math.round(cv.h * scale);
    const scaleRatio = cv.h / ph;
    const bg = c.bgImage;

    let bgStyle = st.bgColor || '#000';
    let bgInner = '';
    if (bg) {
      bgInner = `<img src="${bg.source}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`;
    } else if (st.blurBg && st.mainVideo) {
      bgInner = `<video src="${st.mainVideo.source}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(${Math.round(pw / 12)}px) brightness(.55)" muted autoplay loop playsinline></video>`;
    } else if (st.blurBg && !st.mainVideo) {
      bgInner = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:12px">模糊背景需上传主视频</div>`;
    }

    const ar = (st.mainVideo && st.mainVideo.vw && st.mainVideo.vh) ? st.mainVideo.vw / st.mainVideo.vh : 16 / 9;
    const cfg = c.cfg || getCfg(c.canvas);
    const mainW = Math.round(pw * cfg.scale);
    const mainH = Math.round(mainW / ar);
    const baseY = st.mainPos === 'top' ? 0 : st.mainPos === 'bottom' ? ph - mainH : Math.round((ph - mainH) / 2);
    const baseX = Math.round((pw - mainW) / 2);
    const posX = Math.round(baseX + cfg.ox / scaleRatio);
    const posY = Math.round(baseY + cfg.oy / scaleRatio);
    const mainInner = st.mainVideo
      ? `<video src="${st.mainVideo.source}" style="display:block;width:${mainW}px;height:${mainH}px;object-fit:contain" muted loop playsinline></video>`
      : `<div style="width:${mainW}px;height:${mainH}px;border:2px dashed var(--border-light,#333);display:flex;align-items:center;justify-content:center;color:var(--text-3,#777);font-size:12px">上传主视频后在此显示</div>`;
    // Logo/水印（每尺寸独立位置与大小，中心点归一化坐标）
    const logoInner = st.logo ? (() => {
      const lw = Math.max(10, Math.round(pw * (cfg.logoScale || 0.15)));
      const lh = Math.max(10, Math.round(lw * ((st.logo.h || 1) / (st.logo.w || 1))));
      const lx = Math.min(Math.max(Math.round((cfg.logoX || 0.85) * pw - lw / 2), 0), pw - lw);
      const ly = Math.min(Math.max(Math.round((cfg.logoY || 0.88) * ph - lh / 2), 0), ph - lh);
      return `<img class="fm-logo-drag" data-i="${i}" src="${st.logo.source}" title="拖动 Logo（该尺寸独立）" style="position:absolute;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;object-fit:contain;cursor:grab;pointer-events:auto;z-index:3;opacity:.95;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">`;
    })() : '';

    return `
      <div class="fm-cell-box" data-key="${cv.key}" style="display:flex;flex-direction:column;gap:6px;width:100%;max-width:${pw}px;cursor:pointer;border-radius:10px;padding:6px;border:2px solid ${cv.key === st.currentKey ? 'var(--primary-2,#4f7cff)' : 'transparent'};background:${cv.key === st.currentKey ? 'rgba(79,124,255,.07)' : 'transparent'};transition:border-color .15s">
        <div style="font-size:11px;color:var(--text-2);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cv.w}×${cv.h}${bg ? ` · 垫图「${UI.escapeHtml(bg.name || '')}」` : ''}${st.logo ? ' · Logo' : ''}${cv.key === st.currentKey ? '<span style="color:var(--primary-2,#4f7cff)"> 🎯 调节中</span>' : ''}</div>
        <div style="position:relative;width:${pw}px;height:${ph}px;overflow:hidden;background:${bgStyle};border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45);margin:0 auto">
          ${bgInner}
          <div class="fm-cell-drag" data-i="${i}" style="position:absolute;top:${posY}px;left:${posX}px;cursor:grab;${st.mainVideo ? '' : 'pointer-events:none;'}">${mainInner}</div>
          ${logoInner}
          ${endcardForSize(cv.key) ? `<div style="position:absolute;bottom:4px;right:6px;font-size:9.5px;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:8px;pointer-events:none">${st.endcardMode === 'replace' ? '🔄 替换尾板' : '＋ 片尾'} ${st.endcardDuration}s</div>` : ''}
        </div>
      </div>`;
  }

  /* ============================================================
   * 进度界面（专门的合成进度页）
   * ============================================================ */
  function renderProgress(el) {
    const cv = getCv();
    const cur = batchQueue[batchIdx];
    const batchNote = batchTotal > 1 ? `<p style="font-size:13px;color:var(--text-2);margin:0 0 6px">📦 批量进度：<b>${batchIdx + 1} / ${batchTotal}</b>${cur ? ` · ${UI.escapeHtml(cur.mainVideo?.name || '')} · ${cur.canvas ? cur.canvas.replace('x', '×') : ''}${cur.bgImage ? ` · 垫图「${UI.escapeHtml(cur.bgImage.name || '')}」` : ''}` : ''}</p>` : '';
    el.innerHTML = `
      <div style="max-width:760px;margin:0 auto">
        <div class="card" style="padding:28px">
          <h2 style="margin:0 0 6px;font-size:20px">🎬 正在合成</h2>
          ${batchNote}
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 22px">${cv.w}×${cv.h} · 浏览器本地处理（不上传）· 可切换到其他页面，合成不会中断</p>

          <div style="display:flex;gap:6px;margin-bottom:22px" id="fmSteps">
            ${['载入素材', '探测音轨', '本地合成', '封装输出'].map((s, i) => `
              <div style="flex:1;text-align:center">
                <div id="fmStep${i}" style="height:5px;border-radius:3px;background:var(--border-light,#333);transition:all .3s"></div>
                <p id="fmStepT${i}" style="font-size:11px;color:var(--text-3);margin:7px 0 0">${s}</p>
              </div>`).join('')}
          </div>

          <div style="text-align:center;margin-bottom:14px">
            <span id="fmPct" style="font-size:44px;font-weight:800;background:linear-gradient(90deg,#8b7cf7,#4cc9f0);-webkit-background-clip:text;background-clip:text;color:transparent">${curPct}%</span>
          </div>
          <div class="progress-bar" style="height:12px;border-radius:6px;overflow:hidden"><div id="fmBar" class="fill" style="width:${curPct}%;transition:width .4s"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12.5px;color:var(--text-2)">
            <span id="fmStage">${UI.escapeHtml(curStage || '准备中…')}</span>
            <span id="fmTime">⏱ 已用 ${elapsed}s</span>
          </div>

          <div style="margin-top:18px;border:1px solid var(--border-light);border-radius:10px;background:rgba(0,0,0,.25);padding:10px;max-height:130px;overflow:hidden">
            <pre id="fmLog" style="font-size:10.5px;line-height:1.5;color:var(--text-3);margin:0;white-space:pre-wrap;word-break:break-all">${UI.escapeHtml(logLines.slice(-6).join('\n'))}</pre>
          </div>
          <p style="font-size:11px;color:var(--text-3);margin:10px 0 0;text-align:center">引擎实时日志（证明没卡住，数字在动就是在跑）</p>

          <button class="btn" style="margin:18px auto 0;display:block" id="fmCancelBack" title="不中断合成，只是先回配置页">← 返回配置页（合成继续后台进行）</button>
        </div>
      </div>`;
    el.querySelector('#fmCancelBack').addEventListener('click', () => {
      // 不中断合成，回到配置页（合成完成时会自动切结果页）
      mode = 'config'; render(el);
      UI.toast('合仍在后台进行，完成后自动提示', 'info', 4000);
    });
    updateProgressUI(el);
  }

  function updateProgressUI(el) {
    const pctEl = el.querySelector('#fmPct');
    const barEl = el.querySelector('#fmBar');
    const stageEl = el.querySelector('#fmStage');
    const timeEl = el.querySelector('#fmTime');
    if (!pctEl) return;
    pctEl.textContent = Math.round(curPct) + '%';
    if (barEl) barEl.style.width = Math.min(curPct, 100) + '%';
    if (stageEl) stageEl.textContent = curStage;
    if (timeEl) timeEl.textContent = `⏱ 已用 ${elapsed}s`;
    // 步骤条：根据 curStage 高亮
    const stages = ['载入', '探测', '合成中', '封装'];
    const idx = stages.findIndex((s) => (curStage || '').includes(s));
    for (let i = 0; i < 4; i++) {
      const bar = el.querySelector('#fmStep' + i);
      const txt = el.querySelector('#fmStepT' + i);
      if (bar) bar.style.background = i < idx ? 'var(--ok,#34d399)' : i === idx ? 'linear-gradient(90deg,#8b7cf7,#4cc9f0)' : 'var(--border-light,#333)';
      if (txt) txt.style.color = i <= idx ? 'var(--text-1,#eee)' : 'var(--text-3,#777)';
    }
    const logEl = el.querySelector('#fmLog');
    if (logEl) logEl.textContent = logLines.slice(-6).join('\n');
  }

  /* ============================================================
   * 完成界面（结果 + 下一个 / 批量入口）
   * ============================================================ */
  function renderDone(el) {
    el.innerHTML = `
      <div style="max-width:860px;margin:0 auto">
        <div class="card" style="padding:24px">
          <h2 style="margin:0 0 4px;font-size:20px">✅ 合成完成${batchTotal > 1 ? `（批量 ${results.length}/${batchTotal}）` : ''}</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 18px">成片已存作品中心；可在下方播放检查，或直接下载</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
            ${results.map((r, i) => `
            <div style="border:1px solid var(--border-light);border-radius:12px;padding:10px;background:rgba(52,211,153,.05)">
              <p style="font-size:12px;color:var(--text-2);margin:0 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎬 ${UI.escapeHtml(r.name || '成片')} · ${r.w}×${r.h}${r.bgName ? ` · 垫图「${UI.escapeHtml(r.bgName)}」` : ''} · ${r.dur.toFixed(1)}s</p>
              <video src="${r.url}" controls style="width:100%;border-radius:8px;background:#000;max-height:300px"></video>
              <a class="btn btn-primary btn-block" style="margin-top:8px" href="${r.url}" download="materall_${r.w}x${r.h}_${i}_${r.at}.mp4">⬇ 下载</a>
            </div>`).join('')}
          </div>
          <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap">
            <button class="btn btn-primary" id="fmNextOne" style="flex:1;min-width:180px">🔄 合成下一个（保留当前配置）</button>
            <button class="btn" id="fmBatchMore" style="flex:1;min-width:180px">📦 再批量合成多个视频</button>
            <button class="btn" id="fmBackConfig" style="flex:1;min-width:140px">⚙️ 调整配置</button>
          </div>
          <input type="file" id="fmBatchFile2" accept="video/*" multiple style="display:none">
        </div>
      </div>`;
    el.querySelector('#fmNextOne').addEventListener('click', () => {
      st.mainVideo = null; results = []; mode = 'config';
      save(); render(el);
      UI.toast('已保留画布/垫图/尾板/偏移配置，请上传下一个主视频', 'ok', 4000);
    });
    el.querySelector('#fmBackConfig').addEventListener('click', () => { results = []; mode = 'config'; render(el); });
    el.querySelector('#fmBatchMore').addEventListener('click', () => el.querySelector('#fmBatchFile2').click());
    el.querySelector('#fmBatchFile2').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      batchQueue = []; results = []; batchIdx = 0;
      for (const f of files) {
        if (f.size > 200 * 1024 * 1024) { UI.toast(`跳过 ${f.name}（超过 200MB）`, 'warn'); continue; }
        const source = await UI.fileToDataUrl(f);
        const meta = await readMeta(source);
        batchQueue.push(...buildCombos({ name: f.name, source, ...meta }));
      }
      e.target.value = '';
      if (!batchQueue.length) return;
      batchTotal = batchQueue.length;
      for (; batchIdx < batchQueue.length; batchIdx++) {
        await runExport(el, batchQueue[batchIdx], true);
      }
    });
  }

  /* ============================================================
   * 合成执行（进度界面 + ffmpeg）
   * ============================================================ */
  async function runExport(el, combo, isBatch) {
    if (exporting) return UI.toast('正在合成中，请等待完成', 'warn');
    const mainVideo = combo.mainVideo;
    exporting = true;
    mode = 'progress';
    elapsed = 0; curPct = 0; curStage = '载入素材…'; logLines = [];
    render(el);
    // 组合覆盖：必须在 render() 之后设置（render 内部 load() 会重置状态）
    const prevBg = st.bgImage, prevCv = st.canvas, prevEnd = st.endcard;
    const prevScale = st.mainScale, prevOx = st.offsetX, prevOy = st.offsetY;
    st.bgImage = combo.bgImage || null;
    st.canvas = combo.canvas || st.canvas;
    st.endcard = endcardForSize(combo.canvas) || null;
    st.mainScale = combo.cfg?.scale ?? 1;
    st.offsetX = combo.cfg?.ox ?? 0;
    st.offsetY = combo.cfg?.oy ?? 0;
    const cv = getCv();

    // 秒表：每秒更新（即使 ffmpeg ratio 不动，时间也在走，证明没卡死）
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      elapsed++;
      const pel = document.querySelector('#fmTime');
      if (pel) pel.textContent = `⏱ 已用 ${elapsed}s`;
    }, 1000);

    const ffmpeg = await (async () => {
      curStage = '正在加载剪辑引擎（首次约 32MB，之后有缓存）…';
      const el2 = document.querySelector('#content');
      if (mode === 'progress' && el2) updateProgressUI(el2);
      const inst = await window.EditorView.ensureFFmpegPublic();
      return inst;
    })();
    if (!ffmpeg) {
      exporting = false; clearInterval(timerInt);
      mode = 'config'; render(el);
      return UI.toast('剪辑引擎加载中，请稍后再试', 'warn');
    }
    curStage = '载入素材…';
    const el3 = document.querySelector('#content');
    if (mode === 'progress' && el3) updateProgressUI(el3);

    // ffmpeg 进度 + 日志回调（0.12 委托模式：引擎 on('progress')/on('log') → window.MA._ffmpeg*）
    window.MA._ffmpegLog = (type, message) => { logLines.push(`[${type}] ${message}`); if (logLines.length > 200) logLines.shift(); };
    let lastRatioMove = Date.now();
    window.MA._ffmpegProgress = (ratio) => {
      if (ratio > 0 && ratio < 1) {
        curPct = Math.max(curPct, 5 + ratio * 90); // 映射到 5%~95%
        lastRatioMove = Date.now();
        const eta = Math.round(elapsed / ratio - elapsed);
        curStage = `本地合成中${eta > 1 ? ` · 预计还需 ${eta}s` : ''}`;
      }
      const el2 = document.querySelector('#content');
      if (mode === 'progress' && el2) updateProgressUI(el2);
    };

    try {
      // ---- 第 1 步：载入素材 ----
      const mainIn = mainVideo.name && /\.(webm|mov|mkv)$/i.test(mainVideo.name) ? 'fm_main_in' + (/\.(webm)$/i.test(mainVideo.name) ? '.webm' : '.mp4') : 'fm_main.mp4';
      // 清理可能残留的同名文件
      await rm(ffmpeg, mainIn);
      await rm(ffmpeg, 'fm_out.mp4');
      await rm(ffmpeg, 'fm_bg.png');
      await rm(ffmpeg, 'fm_end.mp4');
      await ffmpeg.writeFile(mainIn, await fetchB(mainVideo.source));
      const inputs = ['-i', mainIn];
      const fp = [];

      // 主视频有效结尾
      let effEnd;
      if (st.endcard && st.endcardMode === 'replace') {
        const full = st.trimEnd > 0 ? st.trimEnd : mainVideo.duration;
        const auto = Math.max(full - st.endcardDuration, st.trimStart + 0.5);
        effEnd = st.mainEndAt > 0 ? Math.min(st.mainEndAt, full) : auto;
      } else {
        effEnd = st.trimEnd > 0 ? st.trimEnd : mainVideo.duration;
      }
      const mainDur = Math.max(effEnd - st.trimStart, 0.5);
      const trimEnd = effEnd.toFixed(2);
      const ar = (mainVideo.vw && mainVideo.vh) ? mainVideo.vw / mainVideo.vh : 16 / 9;
      const mainW = Math.round(cv.w * st.mainScale);
      const mainH = Math.round(mainW / ar);
      const baseY = st.mainPos === 'top' ? 0 : st.mainPos === 'bottom' ? cv.h - mainH : Math.round((cv.h - mainH) / 2);
      const baseX = Math.round((cv.w - mainW) / 2);
      const yPos = Math.round(baseY + (st.offsetY || 0));
      const xPos = Math.round(baseX + (st.offsetX || 0));
      const colorHex = (st.bgColor || '#000000').replace('#', '0x');

      // ---- 第 2 步：探测音轨 ----
      curStage = '探测音轨…'; curPct = Math.max(curPct, 4);
      const hasAudio = await probeAudio(mainVideo.source);
      const endHasAudio = st.endcard ? await probeAudio(st.endcard.source) : false;
      logLines.push(`[info] 主视频音轨: ${hasAudio ? '有' : '无'}${st.endcard ? ` · 尾板音轨: ${endHasAudio ? '有' : '无'}` : ''}`);

      // 背景层
      if (st.bgImage) {
        const bgIn = 'fm_bg.png';
        await ffmpeg.writeFile(bgIn, await fetchB(st.bgImage.source));
        inputs.push('-loop', '1', '-t', mainDur.toFixed(2), '-i', bgIn);
        const bgIdx = (inputs.filter((x) => x === '-i').length) - 1;
        fp.push(`[${bgIdx}:v]scale=${cv.w}:${cv.h}:force_original_aspect_ratio=increase,crop=${cv.w}:${cv.h},fps=25[bg]`);
      } else if (st.blurBg) {
        fp.push(`[0:v]trim=start=${st.trimStart.toFixed(2)}:end=${trimEnd},setpts=PTS-STARTPTS,scale=${cv.w}:${cv.h}:force_original_aspect_ratio=increase,crop=${cv.w}:${cv.h},gblur=sigma=18,eq=brightness=-0.12,fps=25[bg]`);
      } else {
        inputs.push('-f', 'lavfi', '-t', mainDur.toFixed(2), '-i', `color=c=${colorHex}:s=${cv.w}x${cv.h}:r=25`);
        const bgIdx = (inputs.filter((x) => x === '-i').length) - 1;
        fp.push(`[${bgIdx}:v]format=yuv420p[bg]`);
      }

      // 主视频
      fp.push(`[0:v]trim=start=${st.trimStart.toFixed(2)}:end=${trimEnd},setpts=PTS-STARTPTS,scale=${mainW}:${mainH}:force_original_aspect_ratio=decrease,fps=25[main]`);
      fp.push(`[bg][main]overlay=${xPos}:${yPos}:shortest=1[frammed]`);

      // ---- 第 3 步：合成 ----
      curStage = '本地合成中（最耗时阶段）…'; curPct = Math.max(curPct, 6);
      const encArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k'];
      const endStart = Math.max(0, st.endcardStart || 0);
      // 尾板输入与视频滤镜段
      let endIdxRef = 0;
      let endTrimEndRef = 0;
      if (st.endcard) {
        const endIn = 'fm_end.mp4';
        await ffmpeg.writeFile(endIn, await fetchB(st.endcard.source));
        inputs.push('-i', endIn);
        endIdxRef = (inputs.filter((x) => x === '-i').length) - 1;
        endTrimEndRef = Math.min(endStart + st.endcardDuration, st.endcard.duration || endStart + st.endcardDuration);
        fp.push(`[frammed]format=yuv420p[seg0v]`);
        fp.push(`[${endIdxRef}:v]trim=start=${endStart.toFixed(2)}:end=${endTrimEndRef.toFixed(2)},setpts=PTS-STARTPTS,scale=${cv.w}:${cv.h}:force_original_aspect_ratio=increase,crop=${cv.w}:${cv.h},fps=25,format=yuv420p[seg1v]`);
      }
      // 实际取用的尾板段落时长（素材可能短于 endcardDuration）
      const endSegDur = st.endcard ? Math.max(endTrimEndRef - endStart, 0.1) : 0;
      const totalDur = mainDur + endSegDur;

      logLines.push(`[info] 开始 ffmpeg 合成（${mainDur.toFixed(1)}s 视频 · ${cv.w}x${cv.h} · 音轨 ${hasAudio ? '保留' : '静音'}）`);
      // 先按探测结果合成；若失败（如实际无音轨导致滤镜报错）自动降级为全静音重试
      const buildArgs = (audioMode) => {
        const fp2 = fp.filter((s) => !/\[\d+:a\]|anullsrc/.test(s));
        if (st.endcard) {
          fp2.push(hasAudio && audioMode !== 'silent'
            ? `[0:a]atrim=start=${st.trimStart.toFixed(2)}:end=${trimEnd},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[seg0a]`
            : `anullsrc=r=44100:cl=stereo,atrim=duration=${mainDur.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[seg0a]`);
          fp2.push(endHasAudio && audioMode !== 'silent'
            ? `[${endIdxRef}:a]atrim=start=${endStart.toFixed(2)}:end=${endTrimEndRef.toFixed(2)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[seg1a]`
            : `anullsrc=r=44100:cl=stereo,atrim=duration=${endSegDur.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[seg1a]`);
          fp2.push(`[seg0v][seg0a][seg1v][seg1a]concat=n=2:v=1:a=1[outv][outa]`);
          return [...inputs, '-filter_complex', fp2.join(';'), '-map', '[outv]', '-map', '[outa]', ...encArgs, '-t', totalDur.toFixed(2), '-y', 'fm_out.mp4'];
        }
        fp2.push(`[frammed]format=yuv420p[outv]`);
        fp2.push(hasAudio && audioMode !== 'silent'
          ? `[0:a]atrim=start=${st.trimStart.toFixed(2)}:end=${trimEnd},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[outa]`
          : `anullsrc=r=44100:cl=stereo,atrim=duration=${mainDur.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[outa]`);
        return [...inputs, '-filter_complex', fp2.join(';'), '-map', '[outv]', '-map', '[outa]', ...encArgs, '-t', mainDur.toFixed(2), '-y', 'fm_out.mp4'];
      };

      try {
        await execOk(ffmpeg, buildArgs('auto'));
      } catch (eAudio) {
        logLines.push(`[warn] 带音轨合成失败，自动降级静音重试：${(eAudio.message || '').slice(0, 60)}`);
        console.warn('[frammer] audio attempt failed, retry silent', eAudio);
        // 清掉可能半写的输出再重试
        await rm(ffmpeg, 'fm_out.mp4');
        await execOk(ffmpeg, buildArgs('silent'));
      }

      // ---- 第 3.5 步：Logo 叠加（可选，覆盖全程画面） ----
      let outName = 'fm_out.mp4';
      if (st.logo) {
        const cfg = getCfg(st.canvas);
        const lw = Math.max(8, Math.round(cv.w * (cfg.logoScale || 0.15)));
        const lh = Math.max(8, Math.round(lw * ((st.logo.h || 1) / (st.logo.w || 1))));
        const lx = Math.min(Math.max(Math.round((cfg.logoX || 0.85) * cv.w - lw / 2), 0), cv.w - lw);
        const ly = Math.min(Math.max(Math.round((cfg.logoY || 0.88) * cv.h - lh / 2), 0), cv.h - lh);
        curStage = '叠加 Logo…';
        const elL = document.querySelector('#content');
        if (mode === 'progress' && elL) updateProgressUI(elL);
        window.__framLogoErr = null;
        try {
          await rm(ffmpeg, 'fm_logo.png');
          await rm(ffmpeg, 'fm_logo_out.mp4');
          await ffmpeg.writeFile('fm_logo.png', await fetchB(st.logo.source));
          const code = await ffmpeg.exec([
            '-i', 'fm_out.mp4', '-i', 'fm_logo.png',
            '-filter_complex', `[0:v][1:v]overlay=${lx}:${ly}[vout]`,
            '-map', '[vout]', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'copy',
            '-y', 'fm_logo_out.mp4',
          ]);
          if (code === 0) {
            try { const chk = await ffmpeg.readFile('fm_logo_out.mp4'); if (chk && chk.length > 1000) { outName = 'fm_logo_out.mp4'; window.__framLogoOk = true; } } catch (e) { window.__framLogoErr = 'read:' + e.message; }
          } else { window.__framLogoErr = 'exec code ' + code; }
        } catch (e) {
          window.__framLogoErr = (e.message || String(e)).slice(0, 160);
          console.warn('[frammer] logo overlay fail, 使用无 Logo 版本', e);
          logLines.push(`[warn] Logo 叠加失败，已输出无 Logo 版本：${(e.message || '').slice(0, 60)}`);
        }
      }

      // ---- 第 4 步：封装 ----
      curStage = '封装输出…'; curPct = 98;
      const data = await ffmpeg.readFile(outName);
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      results.push({ url, w: cv.w, h: cv.h, dur: totalDur, name: mainVideo.name, bgName: st.bgImage?.name || '', cvKey: st.canvas, at: Date.now() });

      try { await Store.add({ type: 'project', kind: 'frammed', title: `包框成片 ${cv.w}x${cv.h}${st.logo ? '·Logo' : ''}`, url, duration: totalDur }); } catch { /* ignore */ }
      await rm(ffmpeg, mainIn); await rm(ffmpeg, 'fm_out.mp4'); await rm(ffmpeg, 'fm_logo.png'); await rm(ffmpeg, 'fm_logo_out.mp4');
      if (st.bgImage) await rm(ffmpeg, 'fm_bg.png'); if (st.endcard) await rm(ffmpeg, 'fm_end.mp4');

      curPct = 100; curStage = '完成 ✅';
    } catch (e) {
      console.error('[frammer] export error:', e);
      console.error('[frammer] ffmpeg 日志尾部:', logLines.slice(-15).join('\n'));
      // 把失败原因也写进日志区，配置页可见（存 window 供查看）
      window.__framErr = { msg: e.message, log: logLines.slice(-15) };
      UI.toast(`合成失败：${e.message || '未知错误'}`, 'err', 7000);
      mode = 'config';
    } finally {
      // 恢复组合覆盖前的配置
      st.bgImage = prevBg;
      st.canvas = prevCv;
      st.endcard = prevEnd;
      st.mainScale = prevScale; st.offsetX = prevOx; st.offsetY = prevOy;
      exporting = false;
      clearInterval(timerInt);
      window.MA._ffmpegProgress = null;
      window.MA._ffmpegLog = null;
      // 单个或批量最后一个 → 结果页；批量中间 → 直接跑下一个（runExport 循环里处理）
      if (!(isBatch && batchIdx < batchTotal - 1)) {
        if (mode !== 'config') mode = 'done';
      } else {
        mode = 'progress'; // 批量中间，继续显示进度页
      }
      const content = document.querySelector('#content');
      if (content && (document.querySelector('[data-view=frammer]')?.classList.contains('active') || mode === 'progress')) {
        render(content);
      }
      if (mode === 'done') UI.toast(results.length > 1 ? `批量合成完成：${results.length} 个成片 🎉` : '包框成片生成成功 🎉', 'ok', 5000);
    }
  }

  /** 探测视频是否有音轨（可靠版）：
   *  webkitAudioDecodedByteCount 只有音频真正开始解码后才会 > 0，
   *  仅 preload=metadata 时恒为 0（旧版因此误判无音轨 → 输出静音）。
   *  方案：短暂播放触发音频解码；并用 decodeAudioData 兜底（能解出非静音数据即有音轨） */
  function probeAudio(source) {
    return new Promise((resolve) => {
      const finish = (val) => resolve(val);
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
        finish(val);
      };
      let v;
      try {
        v = document.createElement('video');
        v.muted = true;          // 静音播放，不出声
        v.volume = 0;
        v.playsInline = true;
      } catch {
        return finish(true); // 无法创建时保守假设有音轨（合成失败会自动降级）
      }
      const timer = setTimeout(() => done(true), 8000); // 超时保守按"有音轨"

      const checkDecoded = () => {
        if (typeof v.webkitAudioDecodedByteCount === 'number') {
          if (v.webkitAudioDecodedByteCount > 0) return done(true);
          // 播了一点还没解出音频，稍后再查（最长等 3s）
          setTimeout(() => {
            done(v.webkitAudioDecodedByteCount > 0 ? true : checkFallback());
          }, 1500);
          return;
        }
        checkFallback();
      };
      // 兜底：fetch + decodeAudioData（能解出实际数据即有音轨）
      const checkFallback = () => {
        (async () => {
          try {
            const resp = await fetch(source);
            const buf = await resp.arrayBuffer();
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const audio = await ctx.decodeAudioData(buf.slice(0, 3 * 1024 * 1024)); // 最多解 3MB
            ctx.close();
            done(audio && audio.length > 0);
          } catch {
            done(true); // 解析失败保守按有音轨
          }
        })();
      };

      v.onloadeddata = () => {
        // 元数据到了：先用 Firefox 的 mozHasAudio（立即准确）
        if (typeof v.mozHasAudio === 'boolean') return done(v.mozHasAudio);
        // Chrome：播放一小段触发音频解码
        v.currentTime = 0.05;
        v.play().then(() => setTimeout(checkDecoded, 800)).catch(() => checkFallback());
      };
      v.onerror = () => done(true);
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
    // ffmpeg writeFile 需要 Uint8Array
    return new Uint8Array(await blob.arrayBuffer());
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

  return { render };
})();
