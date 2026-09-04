/* ============================================================
 * remake.js — 仿拍复刻 v2：竞品爆款素材 → 变成我的
 * 上传竞品爆款参考图（多张=分镜）→ AI 拆解爆款逻辑 → 分镜审查
 * （提示词/时长可编辑、候选图多选、单镜重生成、镜头一致性）
 * → 复刻生图 → 复刻视频（运镜 + 交叉转场拼接）
 * 参考行业实践：镜头一致性（Runway/可灵）、分镜可控（小云雀/可灵）、
 * 候选多图（即梦）、转场衔接（Runway 首尾帧）
 * ============================================================ */
window.RemakeView = (() => {
  const LS_KEY = 'materall_remake';
  const MAX_REFS = 9;
  const IMG_MODEL = 'doubao-seedream-4-5-251128'; // 多图融合/图生图
  // 本地运镜（zoompan，浏览器免费合成）节奏
  const RHYTHMS = { fast: { label: '快（1.5s/镜）', dur: 1.5 }, standard: { label: '标准（2.5s/镜）', dur: 2.5 }, slow: { label: '慢（4s/镜）', dur: 4 } };
  /** Seedance 模型（图生视频首帧）。max=单镜最长秒数；2.5 支持 4~30s，2.0 4~15s，1.x 2~12s */
  const SEEDANCE_MODELS = [
    { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5（最新 · 单镜最长 30s）', min: 4, max: 30 },
    { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0（单镜最长 15s）', min: 4, max: 15 },
    { id: 'doubao-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro（单镜最长 12s）', min: 4, max: 12 },
    { id: 'doubao-seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro（单镜最长 12s）', min: 2, max: 12 },
  ];
  const VIDEO_RES = '720p';
  const VIDEO_DUR_CHOICES = [4, 5, 6, 8, 10, 12, 15, 20, 30];
  const MOTION_CYCLE = ['zoomIn', 'zoomOut', 'panR', 'zoomIn', 'panL'];
  const MOTION_LABEL = { zoomIn: '推近', zoomOut: '拉远', panR: '右移', panL: '左移' };

  let st = {
    refs: [],          // 竞品参考 [{ name, source(blobURL), dataURL(压缩), w, h }]
    myRefs: [],        // 我的主体/场景参考图 [{ name, source, dataURL, w, h }]
    myDesc: '',
    styleNote: '',
    doImages: true,
    doVideo: false,
    aiVideo: true,       // 复刻视频引擎：true=AI 动态（Seedance 图生视频，需 Key）；false=本地运镜动画
    videoModel: 'doubao-seedance-2-5-260628', // AI 动态模型（默认 2.5，单镜最长 30s）
    videoDur: 8,         // AI 动态每镜时长（秒），按模型 min~max 校准
    rhythm: 'standard',
    aiSplit: true,
    nCandidates: 1,    // 每镜候选张数 1|2
    consistency: true, // 镜头一致性：后镜参考前镜复刻图
  };
  let mode = 'config';       // config | review | progress | done
  let shots = [];            // [{ ref, prompt, dur, urls:[], chosen, status:'idle'|'busy'|'ok'|'err', error }]
  let results = [];          // [{ kind:'img'|'video', url, name, at, w?, h? }]
  let running = false;
  let cur = { step: '', idx: 0, total: 0, pct: 0, logs: [] };

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        ...st,
        refs: st.refs.map((r) => ({ name: r.name, dataURL: r.dataURL, w: r.w, h: r.h })),
        myRefs: st.myRefs.map((r) => ({ name: r.name, dataURL: r.dataURL, w: r.w, h: r.h })),
      }));
    } catch { /* ignore */ }
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (saved.refs && Array.isArray(saved.refs)) {
        saved.refs = saved.refs.map((r) => ({ name: r.name, source: r.dataURL, dataURL: r.dataURL, w: r.w, h: r.h })).filter((r) => r.dataURL);
        Object.assign(st, saved);
      }
      if (saved.myRefs && Array.isArray(saved.myRefs)) {
        st.myRefs = saved.myRefs.map((r) => ({ name: r.name, source: r.dataURL, dataURL: r.dataURL, w: r.w, h: r.h })).filter((r) => r.dataURL);
      }
    } catch { /* ignore */ }
  }

  /* ---------- 图片处理 ---------- */
  function readImgMeta(source) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = source;
    });
  }
  function isImgDataURL(s) { return typeof s === 'string' && /^data:image\//i.test(s); }
  /** 任意图源（dataURL / blob: / http）→ 归一为 dataURL；非图片内容或失败一律返回 null（防止把 JSON/HTML 当图发给网关） */
  async function ensureDataURL(u) {
    if (isImgDataURL(u)) return u;
    try {
      const resp = await fetch(API.proxyUrl(u));
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!blob || !(blob.type || '').startsWith('image/')) return null;
      const d = await blobToDataURL(blob);
      return isImgDataURL(d) ? d : null;
    } catch { return null; }
  }
  function compressToDataURL(blob, maxSide = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const W = Math.max(16, Math.round(img.naturalWidth * scale));
        const H = Math.max(16, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }
  async function addRefFiles(files) {
    for (const f of files) {
      if (st.refs.length >= MAX_REFS) { UI.toast(`最多 ${MAX_REFS} 张参考图`, 'warn'); break; }
      if (f.type.startsWith('video/')) {
        try {
          UI.toast(`正在解析「${f.name}」并抽帧（自动生成分镜）…`, 'info', 5000);
          let frames = null;
          try {
            frames = await extractFramesNative(f, MAX_REFS - st.refs.length); // 原生：快且稳
          } catch (e) {
            UI.toast(`原生解析失败（${e.message || ''}），改用剪辑引擎抽帧…`, 'warn', 4000);
            frames = await extractFrames(f, MAX_REFS - st.refs.length);       // ffmpeg 兜底
          }
          if (!frames || !frames.length) { UI.toast(`「${f.name}」未抽出画面`, 'warn'); continue; }
          frames.forEach((fr, k) => {
            if (st.refs.length >= MAX_REFS) return;
            st.refs.push({ name: `${f.name} · 帧${k + 1}`, source: fr.dataURL, dataURL: fr.dataURL, w: fr.w, h: fr.h });
          });
          UI.toast(`✅ 「${f.name}」抽帧 ${frames.length} 张作为分镜参考`, 'ok', 4000);
        } catch (e) {
          console.warn('[remake] extract fail', e);
          UI.toast(`视频「${f.name}」抽帧失败：${e.message || ''}`, 'err', 5000);
        }
        continue;
      }
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 15 * 1024 * 1024) { UI.toast(`「${f.name}」超过 15MB，已跳过`, 'warn'); continue; }
      const source = URL.createObjectURL(f);
      const meta = await readImgMeta(source);
      // dataURL 必须始终是 data:image 前缀（曾出现压缩失败回退 blob URL → 网关 Invalid base64）
      let dataURL = null;
      try { dataURL = await compressToDataURL(f); } catch { /* 降级原图 */ }
      if (!dataURL) { try { dataURL = await blobToDataURL(f); } catch { dataURL = null; } }
      if (!dataURL || !isImgDataURL(dataURL)) {
        try { URL.revokeObjectURL(source); } catch { /* ignore */ }
        UI.toast(`「${f.name}」无法读取为图片，已跳过`, 'warn');
        continue;
      }
      st.refs.push({ name: f.name, source, dataURL, w: meta.w, h: meta.h });
    }
    save();
    const el = document.querySelector('#content');
    if (el && mode === 'config') renderConfig(el);
  }

  /** 我的主体/场景参考图上传（限制 5 张） */
  async function addMyRefFiles(files) {
    for (const f of files) {
      if (st.myRefs.length >= 5) { UI.toast('我的参考图最多 5 张', 'warn'); break; }
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 15 * 1024 * 1024) { UI.toast(`「${f.name}」超过 15MB，已跳过`, 'warn'); continue; }
      const source = URL.createObjectURL(f);
      const meta = await readImgMeta(source);
      let dataURL = null;
      try { dataURL = await compressToDataURL(f); } catch { /* 降级原图 */ }
      if (!dataURL) { try { dataURL = await blobToDataURL(f); } catch { dataURL = null; } }
      if (!dataURL || !isImgDataURL(dataURL)) {
        try { URL.revokeObjectURL(source); } catch { /* ignore */ }
        UI.toast(`「${f.name}」无法读取为图片，已跳过`, 'warn');
        continue;
      }
      st.myRefs.push({ name: f.name, source, dataURL, w: meta.w, h: meta.h });
    }
    save();
    const el = document.querySelector('#content');
    if (el && mode === 'config') renderConfig(el);
  }

  function readVideoMeta(source) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({ duration: v.duration || 5, w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => resolve({ duration: 5, w: 0, h: 0 });
      v.src = source;
    });
  }
  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }
  /** 原生 video+canvas 抽帧（首选：快、稳、无需 ffmpeg 引擎，静态分享版可用），返回 [{ dataURL, w, h }] */
  async function extractFramesNative(file, maxFrames = 9) {
    const source = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const metaOk = await new Promise((res) => {
      video.onloadedmetadata = () => res(true);
      video.onerror = () => res(false);
      video.src = source;
    });
    if (!metaOk || !video.duration || !video.videoWidth) {
      URL.revokeObjectURL(source);
      throw new Error('浏览器无法解析该视频（请使用 mp4/webm 格式）');
    }
    const dur = video.duration;
    const frames = Math.min(maxFrames, Math.max(1, Math.round(dur / 2)));
    const canvas = document.createElement('canvas');
    const out = [];
    for (let i = 0; i < frames; i++) {
      const t = Math.min(Math.max(0.05, (dur / frames) * (i + 0.5)), Math.max(dur - 0.05, 0.05));
      video.currentTime = t;
      await new Promise((res) => {
        video.onseeked = () => res();
        video.onerror = () => res();
        setTimeout(res, 3000);
      });
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      const scale = Math.min(1, 1024 / Math.max(vw, vh));
      canvas.width = Math.max(16, Math.round(vw * scale));
      canvas.height = Math.max(16, Math.round(vh * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      out.push({ dataURL: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height });
    }
    URL.revokeObjectURL(source);
    return out;
  }
  /** 用 ffmpeg 从视频均匀抽帧（兜底：原生抽帧失败时，最长边≤1024 JPEG），返回 [{ dataURL, w, h }] */
  async function extractFrames(file, maxFrames = 9) {
    const ffmpeg = await window.EditorView.ensureFFmpegPublic();
    if (!ffmpeg) throw new Error('剪辑引擎加载失败，无法抽帧');
    const source = URL.createObjectURL(file);
    const meta = await readVideoMeta(source);
    const dur = meta.duration || 5;
    const frames = Math.min(maxFrames, Math.max(1, Math.round(dur / 2)));
    const interval = Math.max(0.5, dur / frames);
    const inName = 'rm_vin' + (/\.webm$/i.test(file.name) ? '.webm' : /\.(mov|mkv)$/i.test(file.name) ? '.mov' : '.mp4');
    await rm(ffmpeg, inName);
    await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const out = [];
    for (let i = 0; i < frames; i++) {
      const fname = `rm_f_${i}.jpg`;
      await rm(ffmpeg, fname);
      try {
        const t = Math.min(i * interval, Math.max(dur - 0.1, 0)).toFixed(2);
        const code = await ffmpeg.exec(['-ss', t, '-i', inName, '-frames:v', '1', '-q:v', '3', '-y', fname]);
        if (code !== 0) continue;
        const data = await ffmpeg.readFile(fname);
        const dataURL = await blobToDataURL(new Blob([data], { type: 'image/jpeg' }));
        const m = await readImgMeta(dataURL);
        out.push({ dataURL, w: m.w, h: m.h });
      } catch (e) {
        console.warn('[remake] frame extract fail', i, e.message);
      }
      await rm(ffmpeg, fname);
    }
    await rm(ffmpeg, inName);
    URL.revokeObjectURL(source);
    return out;
  }

  /* ---------- 提示词 ---------- */
  function splitPrompt(i) {
    const style = st.styleNote ? `\n4. 整体画面风格要求：${st.styleNote}` : '';
    const myRefNote = st.myRefs.length ? `，主体形象以随图附带的「我的素材」参考图为准（保持参考图中的角色特征、画风、色调一致）` : '';
    return `你是一位资深游戏买量广告编导，正在「仿拍复刻」竞品爆款素材。这是竞品爆款广告的第 ${i + 1} 个画面（参考图）。${st.myRefs.length ? '另附若干张「我的素材」参考图（我的角色/玩法/场景）。' : ''}

请先分析该画面的爆款逻辑：构图方式（主体位置/景别/机位角度）、光线与色彩氛围、视觉焦点与卖点呈现手法。

然后输出【一条】可直接用于 AI 生图的复刻提示词（中文，120 字以内）：
1. 完整保留原图的构图、景别、机位、光线与色彩风格（原封不动照搬爆款逻辑）
2. 将画面中的角色、产品、UI 等主体全部替换为我的内容：「${st.myDesc}」${myRefNote}
3. 替换后的主体要自然融入原构图，位置与比例与原图主体一致
${style}
只输出提示词本身，不要分析过程、不要引号、不要任何前缀。`;
  }
  function fallbackPrompt() {
    const style = st.styleNote ? ` 整体画面风格要求：${st.styleNote}` : '';
    const myRefNote = st.myRefs.length ? '，主体形象以「我的素材」参考图为准（保持其角色特征、画风、色调一致）' : '';
    return `仿拍复刻：严格保留参考图片的构图、景别、机位、光线与色彩风格，将画面中的角色、产品与主体替换为：${st.myDesc}${myRefNote}。替换后的主体位置、比例与原图一致，自然融入原构图。${style}`;
  }
  /** Seedream 4.5 方式2：总像素 [2560x1440(3686400), 4096x4096(16777216)]，宽高比 [1/16, 16]，像素 16 对齐 */
  function sizeFromRef(w, h) {
    if (!w || !h) return '2048x2048';
    const MIN_PX = 3686400, MAX_PX = 16777216, MAX_SIDE = 4096;
    let W = Math.round(w), H = Math.round(h);
    const k = Math.sqrt(MIN_PX / (w * h));
    if (k > 1) { W = Math.round(w * k); H = Math.round(h * k); }
    W = Math.round(W / 16) * 16; H = Math.round(H / 16) * 16;
    // 16 对齐后若像素不足，按短边优先补足
    let guard = 0;
    while (W * H < MIN_PX && guard < 300) { if (W <= H) W += 16; else H += 16; guard++; }
    // 上限保护（极端比例）：单边 ≤4096 且总像素 ≤16777216
    if (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_PX) {
      const k2 = Math.min(MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_PX / (W * H)));
      W = Math.max(16, Math.floor(W * k2 / 16) * 16);
      H = Math.max(16, Math.floor(H * k2 / 16) * 16);
    }
    // 兜底：比例超出模型宽高比限制 [1/16,16]（如超长条图）→ 回退官方 2K 标准档
    if (W * H < MIN_PX) {
      const r = w / h;
      if (r > 1.5) return '2848x1600';   // 16:9 2K
      if (r > 0.85) return '2048x2048';  // 1:1 2K
      if (r > 0.55) return '1728x2304';  // 3:4 2K
      return '1600x2848';                // 9:16 2K
    }
    return `${W}x${H}`;
  }
  window.__remakeSizeFromRef = sizeFromRef; // 测试钩子
  /** Seedance 输出宽高比（跟随首帧比例，映射到模型支持档位） */
  function videoRatio(w, h) {
    if (!w || !h) return '9:16';
    const r = w / h;
    if (r > 1.7) return '16:9';
    if (r > 1.25) return '4:3';
    if (r > 0.85) return '1:1';
    if (r > 0.55) return '3:4';
    return '9:16';
  }
  /** 当前模型可选每镜时长（按模型 min~max 过滤），并校准 st.videoDur */
  function durOptions(modelId) {
    const m = SEEDANCE_MODELS.find((x) => x.id === modelId) || SEEDANCE_MODELS[0];
    const choices = VIDEO_DUR_CHOICES.filter((d) => d >= m.min && d <= m.max);
    if (!choices.includes(st.videoDur)) st.videoDur = m.min;
    return choices;
  }

  /* ---------- 运镜（ffmpeg zoompan + xfade，浏览器本地） ---------- */
  async function fetchU8(url) {
    const resp = await fetch(API.proxyUrl(url));
    if (!resp.ok) throw new Error(`下载图片失败 (HTTP ${resp.status})`);
    return new Uint8Array(await (await resp.blob()).arrayBuffer());
  }
  async function execOk(f, args) {
    const code = await f.exec(args);
    if (code !== 0) throw new Error(`ffmpeg 执行失败（退出码 ${code}）`);
  }
  async function rm(f, name) { try { await f.deleteFile(name); } catch { /* ignore */ } }

  function motionFilter(W, H, frames, style) {
    const d = frames;
    const cx = 'iw/2-(iw/zoom/2)', cy = 'ih/2-(ih/zoom/2)';
    switch (style) {
      case 'zoomIn': return `zoompan=z='min(zoom+0.006,1.35)':d=${d}:x='${cx}':y='${cy}':s=${W}x${H}:fps=25`;
      case 'zoomOut': return `zoompan=z='if(lte(on,1),1.35,max(zoom-0.006,1.0))':d=${d}:x='${cx}':y='${cy}':s=${W}x${H}:fps=25`;
      case 'panR': return `zoompan=z='1.2':d=${d}:x='(iw-iw/zoom)*(on/${d})':y='${cy}':s=${W}x${H}:fps=25`;
      case 'panL': return `zoompan=z='1.2':d=${d}:x='(iw-iw/zoom)*(1-on/${d})':y='${cy}':s=${W}x${H}:fps=25`;
      default: return `zoompan=z='1.0':d=${d}:x='${cx}':y='${cy}':s=${W}x${H}:fps=25`;
    }
  }
  async function makeMotionClip(ffmpeg, imgUrl, durSec, style, W, H, idx) {
    const inName = `rm_in_${idx}.jpg`;
    const outName = `rm_seg_${idx}.mp4`;
    await rm(ffmpeg, inName); await rm(ffmpeg, outName);
    await ffmpeg.writeFile(inName, await fetchU8(imgUrl));
    const frames = Math.max(10, Math.round(durSec * 25));
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${motionFilter(W, H, frames, style)}`;
    await execOk(ffmpeg, [
      '-i', inName, '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
      '-r', '25', '-t', durSec.toFixed(2), '-y', outName,
    ]);
    const data = await ffmpeg.readFile(outName);
    await rm(ffmpeg, inName); await rm(ffmpeg, outName);
    return data;
  }
  /** 多段运镜片段 + 交叉淡化转场拼接成片（xfade 链） */
  async function concatSegments(ffmpeg, segNames, durs) {
    if (segNames.length === 1) {
      await rm(ffmpeg, 'rm_final.mp4');
      await execOk(ffmpeg, ['-i', segNames[0], '-c', 'copy', '-y', 'rm_final.mp4']);
      const data = await ffmpeg.readFile('rm_final.mp4');
      await rm(ffmpeg, 'rm_final.mp4');
      segNames.forEach((n) => rm(ffmpeg, n));
      return data;
    }
    // xfade 链：offset 逐段累加（前段时长 - 转场时长）
    const fade = 0.35;
    const inputs = [];
    segNames.forEach((n) => inputs.push('-i', n));
    const filters = [];
    let prev = '[0:v]';
    let offset = durs[0] - fade;
    for (let i = 1; i < segNames.length; i++) {
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}[v${i}]`);
      prev = `[v${i}]`;
      if (i < segNames.length - 1) offset += durs[i] - fade;
    }
    filters.push(`${prev}format=yuv420p[vout]`);
    await rm(ffmpeg, 'rm_final.mp4');
    await execOk(ffmpeg, [...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-y', 'rm_final.mp4']);
    const data = await ffmpeg.readFile('rm_final.mp4');
    await rm(ffmpeg, 'rm_final.mp4');
    segNames.forEach((n) => rm(ffmpeg, n));
    return data;
  }

  /* ---------- 渲染 ---------- */
  function render(el) {
    load();
    if (mode === 'review') return renderReview(el);
    if (mode === 'progress') return renderProgress(el);
    if (mode === 'done') return renderDone(el);
    renderConfig(el);
  }

  function renderConfig(el) {
    el.innerHTML = `
      <div class="rsz-layout">
        <div class="card">
          <div class="card-title"><span class="ico">📸</span>① 竞品爆款素材（图或视频，最多 ${MAX_REFS} 个画面）</div>
          <p style="font-size:12px;color:var(--text-3);margin-bottom:10px">上传竞品爆款的截图或<b>整段视频（自动抽帧成多张分镜）</b>，AI 拆解它的构图/机位/光线/氛围等爆款逻辑，再替换成你的内容</p>
          <input type="file" id="rmRefFile" accept="video/*,image/*" multiple style="display:none">
          <div class="rsz-drop" id="rmDrop">
            <div style="font-size:26px">🖼️</div>
            <p style="margin:8px 0 4px;font-weight:600">点击或拖拽竞品素材到这里（图片 / 视频均可）</p>
            <p style="font-size:11.5px;color:var(--text-3)">视频会自动抽帧生成分镜序列；截图可多选，1~9 个画面</p>
          </div>
          ${st.refs.length ? `
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
            ${st.refs.map((r, i) => `
              <div style="position:relative;border:1px solid var(--border-light);border-radius:9px;padding:5px;background:var(--bg-soft,#0e1119)">
                <img src="${r.dataURL || r.source}" style="height:64px;border-radius:6px;display:block">
                <p style="font-size:10px;color:var(--text-3);margin:4px 0 0;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}. ${UI.escapeHtml(r.name)}</p>
                <div style="display:flex;gap:3px;margin-top:3px">
                  <button class="btn-icon rm-ref-move" data-i="${i}" data-dir="-1" title="上移" style="font-size:10px">↑</button>
                  <button class="btn-icon rm-ref-move" data-i="${i}" data-dir="1" title="下移" style="font-size:10px">↓</button>
                  <button class="btn-icon rm-ref-del" data-i="${i}" title="删除" style="font-size:10px">✕</button>
                </div>
              </div>`).join('')}
          </div>` : ''}
        </div>

        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="card">
            <div class="card-title"><span class="ico">🎮</span>② 我的主体与玩法（替换进去的内容）</div>
            <textarea id="rmMyDesc" class="input" rows="3" style="width:100%;resize:vertical" placeholder="例如：我的游戏《星海割草》是一款割草肉鸽手游，核心玩法是角色自动攻击、满屏技能特效、敌人一波波涌来，主打爽快割草与角色成长，角色是机甲少女造型">${UI.escapeHtml(st.myDesc)}</textarea>

            <div class="card-title" style="margin-top:12px"><span class="ico">🧩</span>③ 我的主体/场景参考图（可选，用于替换的形象）</div>
            <p style="font-size:12px;color:var(--text-3);margin-bottom:10px">上传你的角色设定图、玩法截图、场景图（最多 5 张），复刻时主体会按参考图中的形象替换，比纯文字更精准</p>
            <input type="file" id="rmMyFile" accept="image/*" multiple style="display:none">
            <div class="rsz-drop" id="rmMyDrop" style="padding:16px">
              <p style="margin:4px 0;font-weight:600">📎 添加我的参考图（可多选）</p>
              <p style="font-size:11px;color:var(--text-3)">角色 / 玩法 / 场景图</p>
            </div>
            ${st.myRefs.length ? `
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
              ${st.myRefs.map((r, i) => `
                <div style="position:relative;border:1px solid var(--border-light);border-radius:9px;padding:5px;background:var(--bg-soft,#0e1119)">
                  <img src="${r.dataURL || r.source}" style="height:52px;border-radius:6px;display:block">
                  <p style="font-size:10px;color:var(--text-3);margin:4px 0 0;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.escapeHtml(r.name)}</p>
                  <button class="btn-icon rm-myref-del" data-i="${i}" title="移除" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.65)">✕</button>
                </div>`).join('')}
            </div>` : ''}

            <div class="card-title" style="margin-top:12px"><span class="ico">🎨</span>④ 画面风格要求（可选）</div>
            <textarea id="rmStyle" class="input" rows="2" style="width:100%;resize:vertical" placeholder="例如：整体偏暗黑科幻风、冷色调、粒子光效">${UI.escapeHtml(st.styleNote)}</textarea>
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">⚙️</span>⑤ 输出选项</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--text-1)">
              <label style="display:flex;gap:6px;cursor:pointer"><input type="checkbox" id="rmDoImg" ${st.doImages ? 'checked' : ''} style="accent-color:var(--primary-2)"> 复刻图片</label>
              <label style="display:flex;gap:6px;cursor:pointer"><input type="checkbox" id="rmDoVid" ${st.doVideo ? 'checked' : ''} style="accent-color:var(--primary-2)"> 复刻视频</label>
            </div>
            ${st.doVideo ? `
            <div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;font-size:13px;color:var(--text-1)">
              <label style="display:flex;gap:6px;align-items:center">视频引擎
                <select class="input" id="rmAiVideo" style="width:auto;padding:6px 26px 6px 10px">
                  <option value="1" ${st.aiVideo ? 'selected' : ''}>AI 动态视频（Seedance 图生视频）</option>
                  <option value="0" ${!st.aiVideo ? 'selected' : ''}>本地运镜动画（免费免 Key）</option>
                </select>
              </label>
              ${st.aiVideo ? `
              <label style="display:flex;gap:6px;align-items:center">模型
                <select class="input" id="rmVModel" style="width:auto;max-width:250px;padding:6px 26px 6px 10px">
                  ${SEEDANCE_MODELS.map((m) => `<option value="${m.id}" ${st.videoModel === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
                </select>
              </label>
              <label style="display:flex;gap:6px;align-items:center">每镜时长
                <select class="input" id="rmVDur" style="width:auto;padding:6px 26px 6px 10px">
                  ${durOptions(st.videoModel).map((d) => `<option value="${d}" ${st.videoDur === d ? 'selected' : ''}>${d}s</option>`).join('')}
                </select>
              </label>` : ''}
            </div>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:8px;line-height:1.6">${st.aiVideo
              ? `AI 动态需要方舟 Key（模型需在方舟控制台开通）；单镜最长 ${(SEEDANCE_MODELS.find((m) => m.id === st.videoModel) || SEEDANCE_MODELS[0]).max}s，多镜拼接成片可更长；输出 720p；生成失败自动降级本地运镜`
              : `本地运镜节奏：${Object.values(RHYTHMS).map((v) => v.label).join(' / ')}`}</p>` : ''}
            <div style="display:flex;gap:14px;margin-top:10px;flex-wrap:wrap;font-size:13px;color:var(--text-1)">
              <label style="display:flex;gap:6px;align-items:center">节奏
                <select class="input" id="rmRhythm" style="width:auto;padding:6px 26px 6px 10px">
                  ${Object.entries(RHYTHMS).map(([k, v]) => `<option value="${k}" ${st.rhythm === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
              </label>
              <label style="display:flex;gap:6px;align-items:center">每镜候选
                <select class="input" id="rmNcand" style="width:auto;padding:6px 26px 6px 10px">
                  <option value="1" ${st.nCandidates === 1 ? 'selected' : ''}>1 张</option>
                  <option value="2" ${st.nCandidates === 2 ? 'selected' : ''}>2 张（可选优）</option>
                </select>
              </label>
              <label style="display:flex;gap:6px;cursor:pointer"><input type="checkbox" id="rmAiSplit" ${st.aiSplit ? 'checked' : ''} style="accent-color:var(--primary-2)"> AI 拆解爆款逻辑</label>
              <label style="display:flex;gap:6px;cursor:pointer"><input type="checkbox" id="rmConsist" ${st.consistency ? 'checked' : ''} style="accent-color:var(--primary-2)"> 镜头一致性（后镜参考前镜成图）</label>
            </div>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:10px;line-height:1.7">💡 流程：AI 分析每张参考图的构图/机位/光线/氛围（复用爆款逻辑）→ <b>分镜审查</b>（可改每镜提示词/时长，选候选图）→ 复刻生图 → 生成复刻视频。图片生成需已配置方舟 API Key；AI 动态视频不可用时自动降级为本地运镜。</p>
          </div>

          <button class="btn btn-primary btn-block" id="rmStart" ${st.refs.length && st.myDesc.trim() ? '' : 'disabled'}>🚀 开始仿拍复刻</button>
        </div>
      </div>`;
    bindConfigEvents(el);
  }

  function bindConfigEvents(el) {
    const fileInput = el.querySelector('#rmRefFile');
    const drop = el.querySelector('#rmDrop');
    if (drop) {
      drop.addEventListener('click', () => fileInput.click());
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault(); drop.classList.remove('drag');
        addRefFiles(Array.from(e.dataTransfer.files || []));
      });
    }
    fileInput.addEventListener('change', () => { addRefFiles(Array.from(fileInput.files || [])); fileInput.value = ''; });
    const myFile = el.querySelector('#rmMyFile');
    const myDrop = el.querySelector('#rmMyDrop');
    if (myDrop) {
      myDrop.addEventListener('click', () => myFile.click());
      myDrop.addEventListener('dragover', (e) => { e.preventDefault(); myDrop.classList.add('drag'); });
      myDrop.addEventListener('dragleave', () => myDrop.classList.remove('drag'));
      myDrop.addEventListener('drop', (e) => {
        e.preventDefault(); myDrop.classList.remove('drag');
        addMyRefFiles(Array.from(e.dataTransfer.files || []));
      });
    }
    myFile.addEventListener('change', () => { addMyRefFiles(Array.from(myFile.files || [])); myFile.value = ''; });
    el.querySelectorAll('.rm-myref-del').forEach((b) => b.addEventListener('click', () => {
      st.myRefs.splice(Number(b.dataset.i), 1); save(); render(document.querySelector('#content'));
    }));
    el.querySelectorAll('.rm-ref-del').forEach((b) => b.addEventListener('click', () => {
      st.refs.splice(Number(b.dataset.i), 1); save(); render(document.querySelector('#content'));
    }));
    el.querySelectorAll('.rm-ref-move').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.i), dir = Number(b.dataset.dir), j = i + dir;
      if (j < 0 || j >= st.refs.length) return;
      [st.refs[i], st.refs[j]] = [st.refs[j], st.refs[i]];
      save(); render(document.querySelector('#content'));
    }));
    const myDesc = el.querySelector('#rmMyDesc');
    myDesc.addEventListener('input', () => { st.myDesc = myDesc.value; save(); const s = el.querySelector('#rmStart'); if (s) s.disabled = !(st.refs.length && st.myDesc.trim()); });
    el.querySelector('#rmStyle').addEventListener('input', (e) => { st.styleNote = e.target.value; save(); });
    el.querySelector('#rmDoImg').addEventListener('change', (e) => { st.doImages = e.target.checked; save(); });
    el.querySelector('#rmDoVid').addEventListener('change', (e) => { st.doVideo = e.target.checked; save(); render(document.querySelector('#content')); });
    el.querySelector('#rmAiVideo')?.addEventListener('change', (e) => { st.aiVideo = e.target.value === '1'; save(); render(document.querySelector('#content')); });
    el.querySelector('#rmVModel')?.addEventListener('change', (e) => {
      st.videoModel = e.target.value;
      const m = SEEDANCE_MODELS.find((x) => x.id === st.videoModel);
      if (m) st.videoDur = Math.min(Math.max(st.videoDur, m.min), m.max);
      save(); render(document.querySelector('#content'));
    });
    el.querySelector('#rmVDur')?.addEventListener('change', (e) => { st.videoDur = Number(e.target.value); save(); });
    el.querySelector('#rmRhythm').addEventListener('change', (e) => { st.rhythm = e.target.value; save(); });
    el.querySelector('#rmNcand').addEventListener('change', (e) => { st.nCandidates = Number(e.target.value); save(); });
    el.querySelector('#rmAiSplit').addEventListener('change', (e) => { st.aiSplit = e.target.checked; save(); });
    el.querySelector('#rmConsist').addEventListener('change', (e) => { st.consistency = e.target.checked; save(); });
    el.querySelector('#rmStart').addEventListener('click', () => run(el));
  }

  /* ---------- 分镜审查视图（行业标配：生成前可控） ---------- */
  function renderReview(el) {
    el.innerHTML = `
      <div style="max-width:980px;margin:0 auto">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <h3 style="margin:0">🎬 分镜审查（${shots.length} 镜）</h3>
          <span style="font-size:12px;color:var(--text-3)">AI 已拆解爆款逻辑并生成复刻提示词，可逐镜修改后生成</span>
          <span style="flex:1"></span>
          <button class="btn btn-primary" id="rmGenAll" ${shots.every((s) => s.status === 'ok') ? 'disabled' : ''}>🚀 全部生成</button>
          <button class="btn" id="rmToVideo" title="${st.aiVideo ? 'AI 动态视频（Seedance）· 约 1~10 分钟/镜' : '本地运镜动画'}">🎬 合成复刻视频${st.aiVideo ? '（AI 动态）' : ''}</button>
          <button class="btn btn-ghost btn-sm" id="rmReviewBack">← 返回配置</button>
        </div>
        <div id="rmShotList">
          ${shots.map((s, i) => shotCard(s, i)).join('')}
        </div>
        <div id="rmReviewVideo"></div>
      </div>`;
    bindReviewEvents(el);
  }

  function shotCard(s, i) {
    const dur = s.dur || RHYTHMS[st.rhythm].dur;
    const statusIcon = s.status === 'ok' ? '✅' : s.status === 'err' ? '❌' : s.status === 'busy' ? '⏳' : '○';
    return `
      <div class="card" style="margin-bottom:12px;padding:14px">
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <div style="flex-shrink:0">
            <img src="${s.ref.dataURL || s.ref.source}" style="height:110px;border-radius:8px;display:block;border:1px solid var(--border-light)">
            <p style="font-size:10.5px;color:var(--text-3);margin:4px 0 0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}. ${UI.escapeHtml(s.ref.name)}</p>
          </div>
          <div style="flex:1;min-width:260px">
            <div style="display:flex;gap:10px;margin-bottom:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:13px;font-weight:700">镜头 ${i + 1} ${statusIcon}</span>
              <label style="font-size:12px;color:var(--text-2);display:flex;gap:5px;align-items:center">时长
                <select class="input rm-shot-dur" data-i="${i}" style="width:auto;padding:4px 22px 4px 8px;font-size:12px">
                  ${Object.entries(RHYTHMS).map(([k, v]) => `<option value="${v.dur}" ${dur === v.dur ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
              </label>
              <span style="flex:1"></span>
              <button class="btn btn-sm rm-shot-gen" data-i="${i}" ${s.status === 'busy' ? 'disabled' : ''}>${s.status === 'ok' ? '🔄 重新生成' : '🖼️ 生成'}</button>
            </div>
            <textarea class="input rm-shot-prompt" data-i="${i}" rows="2" style="width:100%;resize:vertical;font-size:12.5px">${UI.escapeHtml(s.prompt)}</textarea>
            <p class="rm-shot-err" data-i="${i}" style="font-size:11px;color:var(--danger,#f87171);margin:6px 0 0;${s.error ? '' : 'display:none'}">${UI.escapeHtml(s.error || '')}</p>
            <div class="rm-shot-imgs" data-i="${i}" style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
              ${(s.urls || []).map((u, k) => `
                <div style="cursor:pointer;border:2px solid ${s.chosen === k ? 'var(--primary-2,#4f7cff)' : 'transparent'};border-radius:10px;padding:4px;background:var(--bg-soft,#0e1119)" data-k="${k}">
                  <img src="${API.proxyUrl(u)}" style="height:130px;border-radius:6px;display:block">
                  <p style="font-size:10px;color:var(--text-3);margin:4px 0 0;text-align:center">候选 ${k + 1}${s.chosen === k ? ' ✓' : ''}</p>
                </div>`).join('')}
            </div>
          </div>
        </div>
      </div>`;
  }

  function bindReviewEvents(el) {
    el.querySelector('#rmReviewBack').addEventListener('click', () => { mode = 'config'; render(document.querySelector('#content')); });
    el.querySelector('#rmGenAll').addEventListener('click', async () => {
      const btn = el.querySelector('#rmGenAll');
      btn.disabled = true;
      for (let i = 0; i < shots.length; i++) {
        if (shots[i].status !== 'ok') await genShot(i, el);
      }
      btn.disabled = false;
      renderReview(document.querySelector('#content'));
      UI.toast('全部镜头生成完成', 'ok', 4000);
    });
    el.querySelector('#rmToVideo').addEventListener('click', () => {
      if (!st.aiVideo) UI.toast('当前为「本地运镜」模式（生成的是运镜 PPT）。如需 AI 动态视频，请返回配置把视频引擎切为「AI 动态视频」', 'warn', 7000);
      makeVideo(el);
    });
    el.querySelectorAll('.rm-shot-dur').forEach((sel) => sel.addEventListener('change', () => {
      shots[Number(sel.dataset.i)].dur = Number(sel.value);
    }));
    el.querySelectorAll('.rm-shot-prompt').forEach((ta) => ta.addEventListener('input', () => {
      shots[Number(ta.dataset.i)].prompt = ta.value;
    }));
    el.querySelectorAll('.rm-shot-gen').forEach((btn) => btn.addEventListener('click', () => genShot(Number(btn.dataset.i), el)));
    el.querySelectorAll('.rm-shot-imgs > div').forEach((box) => box.addEventListener('click', () => {
      const i = Number(box.parentElement.dataset.i);
      shots[i].chosen = Number(box.dataset.k);
      renderReview(document.querySelector('#content'));
    }));
  }

  /** 单镜复刻生图（含候选多图 + 镜头一致性参考前镜成图） */
  async function genShot(i, el) {
    const s = shots[i];
    if (s.status === 'busy') return;
    s.status = 'busy'; s.error = '';
    const content = document.querySelector('#content');
    if (content && mode === 'review') renderReview(content);
    try {
      // 参考图统一归一为 dataURL；失效图自动剔除（避免把 blob URL 当 base64 发给网关 → Invalid base64）
      const imgsArr = await Promise.all(
        [s.ref.dataURL, ...st.myRefs.map((r) => r.dataURL)].map((u) => ensureDataURL(u)),
      );
      const images = imgsArr.filter(Boolean);
      if (!images.length) throw new Error('参考图不可用（可能已失效），请重新上传竞品参考图');
      if (images.length < imgsArr.length) cur.logs.push(`⚠️ ${imgsArr.length - images.length} 张参考图已失效被跳过`);
      if (st.consistency && i > 0) {
        const prev = shots[i - 1];
        if (prev && prev.status === 'ok' && prev.urls && prev.urls.length) {
          const prevF = await ensureDataURL(prev.urls[prev.chosen || 0]);
          if (prevF) images.push(prevF);
        }
      }
      const data = await API.genImage({
        model: IMG_MODEL,
        prompt: s.prompt,
        size: sizeFromRef(s.ref.w, s.ref.h),
        count: st.nCandidates,
        images,
      });
      const urls = (data?.items || []).map((it) => it.url).filter(Boolean);
      if (!urls.length) throw new Error('生图未返回图片');
      s.urls = urls;
      s.chosen = Math.min(s.chosen || 0, urls.length - 1);
      s.status = 'ok';
      cur.logs.push(`[镜${i + 1}] ✅ 复刻图生成（${urls.length} 张候选）`);
      try { await Store.add({ type: 'image', kind: 'remake-img', title: `复刻图 镜${i + 1}`, url: urls[s.chosen] }); } catch { /* ignore */ }
    } catch (e) {
      console.error('[remake] genShot fail', e);
      s.status = 'err'; s.error = e.message || '生成失败';
      cur.logs.push(`[镜${i + 1}] ❌ ${s.error}`);
      UI.toast(`镜头 ${i + 1} 生成失败：${s.error}`, 'err', 6000);
    }
    const el2 = document.querySelector('#content');
    if (el2 && mode === 'review') renderReview(el2);
  }

  async function toDataURL(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- AI 动态视频（Seedance 图生视频，首帧 Base64） ---------- */
  function setVideoProgress(area, i, n, stage, s) {
    if (!area) return;
    const pct = n ? Math.min(99, Math.round((i / n) * 100)) : 0;
    area.innerHTML = `
      <div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:4px">
          <span>🎬 复刻视频：${stage}</span>
          <span>${i + 1}/${n} 镜${s ? ` · ${UI.escapeHtml(s.ref.name || '')}` : ''}</span>
        </div>
        <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
        <p style="font-size:11px;color:var(--text-3);margin:4px 0 0">AI 动态视频（Seedance）· 约 1~10 分钟/镜（视时长与模型）· 输出 720p</p>
      </div>`;
  }
  function aiMotionPrompt(basePrompt) {
    return `${basePrompt}。请让画面自然地动起来（轻微镜头运动、主体动作、光效/粒子流动皆可），严格保持首帧的构图、主体形象、画风与色彩完全一致，画面质量稳定清晰。`;
  }
  async function pollVideo(taskId, maxSec, onTick) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxSec * 1000) {
      await new Promise((r) => setTimeout(r, 8000));
      let d = null;
      try { d = await API.videoStatus(taskId); } catch { continue; }
      const status = d?.status || '';
      if (/succeeded|completed/i.test(status)) {
        if (d?.videoUrl) return d.videoUrl;
        throw new Error('任务完成但未拿到视频地址');
      }
      if (/failed|error/i.test(status)) {
        throw new Error(d?.data?.error?.message || d?.error?.message || 'AI 视频生成失败');
      }
      if (onTick) onTick(`AI 生成中…（${Math.round((Date.now() - t0) / 1000)}s）`);
    }
    return null;
  }
  /** 多段 AI 视频拼接成片：优先 concat -c copy，失败降级重编码 */
  async function concatAiClips(clips) {
    if (clips.length === 1) {
      const blob = await (await fetch(API.proxyUrl(clips[0].url))).blob();
      return { url: URL.createObjectURL(blob), totalDur: clips[0].dur || 5 };
    }
    const ffmpeg = await window.EditorView.ensureFFmpegPublic();
    if (!ffmpeg) throw new Error('剪辑引擎加载失败');
    const names = [];
    for (let i = 0; i < clips.length; i++) {
      const name = `rm_ai_${i}.mp4`;
      await rm(ffmpeg, name);
      await ffmpeg.writeFile(name, await fetchU8(clips[i].url));
      names.push(name);
    }
    await rm(ffmpeg, 'rm_ai_list.txt');
    await ffmpeg.writeFile('rm_ai_list.txt', names.map((n) => `file '${n}'`).join('\n'));
    let data = null;
    try {
      await rm(ffmpeg, 'rm_ai_final.mp4');
      const code = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'rm_ai_list.txt', '-c', 'copy', '-y', 'rm_ai_final.mp4']);
      if (code === 0) { try { data = await ffmpeg.readFile('rm_ai_final.mp4'); } catch { data = null; } }
    } catch { data = null; }
    if (!data || !data.length) {
      const inputs = [];
      names.forEach((n) => inputs.push('-i', n));
      const filter = `${names.map((_, i) => `[${i}:v:0]`).join('')}concat=n=${names.length}:v=1:a=0[vout]`;
      await rm(ffmpeg, 'rm_ai_final.mp4');
      await execOk(ffmpeg, [...inputs, '-filter_complex', filter, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-y', 'rm_ai_final.mp4']);
      data = await ffmpeg.readFile('rm_ai_final.mp4');
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    names.forEach((n) => rm(ffmpeg, n));
    rm(ffmpeg, 'rm_ai_list.txt'); rm(ffmpeg, 'rm_ai_final.mp4');
    return { url, totalDur: clips.reduce((a, c) => a + (c.dur || 5), 0) };
  }
  /** Seedance 图生视频：复刻图/参考帧做首帧 → AI 动态镜头 → 拼接成片 */
  async function makeAiVideo(el, okShots, videoArea) {
    const ref0 = st.refs[0];
    // 图生视频不传 ratio：输出比例自动跟随首帧（传了与首帧不一致的 ratio 会被 Seedance 拒绝）
    const model = SEEDANCE_MODELS.find((m) => m.id === st.videoModel) || SEEDANCE_MODELS[0];
    const dur = Math.min(Math.max(st.videoDur || model.min, model.min), model.max);
    cur.logs.push(`🎬 AI 动态视频：模型 ${model.id} · 每镜 ${dur}s · 比例跟随首帧`);
    const jobs = [];
    for (let i = 0; i < okShots.length; i++) {
      const s = okShots[i];
      let firstFrame = s.ref.dataURL;
      if (s.urls && s.urls.length) {
        try { firstFrame = await toDataURL(API.proxyUrl(s.urls[s.chosen || 0])); } catch { /* 保持参考帧 */ }
      } else {
        firstFrame = (await ensureDataURL(firstFrame)) || null; // 参考帧归一，失效则为 null
      }
      if (!firstFrame) throw new Error(`镜${i + 1} 首帧参考图不可用，请重新生成该镜或重新上传参考图`);
      setVideoProgress(videoArea, i, okShots.length, '提交图生视频任务…', s);
      const task = await API.createVideo({
        model: st.videoModel,
        text: aiMotionPrompt(s.prompt),
        imageUrl: firstFrame,
        // ratio 不传：输出跟随首帧比例（Seedance 图生视频强制要求）
        duration: dur,
        resolution: VIDEO_RES,
        generateAudio: false,
        watermark: true,
      });
      if (!task?.id) throw new Error('视频任务未返回 ID');
      jobs.push({ taskId: task.id, s });
    }
    const clips = [];
    for (let i = 0; i < jobs.length; i++) {
      const { taskId, s } = jobs[i];
      setVideoProgress(videoArea, i, jobs.length, 'AI 生成中（约 1~10 分钟/镜）…', s);
      const url = await pollVideo(taskId, 300 + dur * 20, (msg) => setVideoProgress(videoArea, i, jobs.length, msg, s));
      if (!url) throw new Error(`AI 生成超时（超过 ${Math.round((300 + dur * 20) / 60)} 分钟）`);
      clips.push({ url, dur });
      cur.logs.push(`[镜${i + 1}] ✅ AI 动态视频生成（${dur}s）`);
    }
    setVideoProgress(videoArea, jobs.length, jobs.length, '正在拼接成片…');
    const { url, totalDur } = await concatAiClips(clips);
    results = results.filter((r) => r.kind !== 'video');
    results.push({ kind: 'video', url, at: Date.now() });
    try { await Store.add({ type: 'project', kind: 'remake-video', title: `仿拍复刻成片（${okShots.length} 镜 · AI 动态）`, url, duration: totalDur }); } catch { /* ignore */ }
    if (videoArea) {
      videoArea.innerHTML = `
        <div class="card" style="margin-top:12px;border-color:rgba(52,211,153,.4)">
          <div class="card-title"><span class="ico">🎬</span>复刻视频（${okShots.length} 镜 · AI 动态 · ${totalDur.toFixed(1)}s）</div>
          <video src="${url}" controls style="width:100%;border-radius:10px;background:#000;max-height:420px"></video>
          <a class="btn btn-primary btn-block" style="margin-top:10px" href="${url}" download="复刻视频_${Date.now()}.mp4">⬇ 下载复刻视频</a>
        </div>`;
    }
    UI.toast('复刻视频生成完成 🎉', 'ok', 5000);
  }

  /** 合成复刻视频：AI 动态优先（Seedance），不可用自动降级本地运镜 */
  /** 按错误信息给出可执行的解决建议（让降级不再"哑失败"） */
  function errAdvice(msg) {
    const m = msg || '';
    if (/api key|authentication|unauthorized|invalid key|key format/i.test(m)) return '请检查「连接设置」中的方舟 API Key 是否正确有效';
    if (/not (found|enabled|activated|supported|allowed)/i.test(m) || /model[^。，]{0,40}(未开通|没有权限|not|no)/i.test(m) || /尚未开通|未开通|没有开通/i.test(m)) {
      return `模型 ${st.videoModel} 未开通：请到火山方舟控制台「开通管理」开通该模型，或返回配置换用已开通的模型（2.0 / 1.5 Pro）`;
    }
    if (/quota|balance|insufficient|exceed|配额|余额|额度|限流/i.test(m)) return '方舟账户配额/余额不足或触发限流，请稍后重试或升级额度';
    if (/ratio[^.]{0,30}not valid|not valid[^.]{0,30}ratio/i.test(m)) return '视频比例参数冲突：图生视频已自动跟随首帧比例，请重试；若仍失败请换用 Seedance 2.0/1.5 Pro';
    if (/分享版|无本地服务|not exist|ENOTFOUND/i.test(m)) return '当前是无后端的分享版：AI 视频需要在本机运行 node server.js 后通过本地链接使用';
    if (/timeout|超时|timed out/i.test(m)) return 'AI 生成超时，请稍后重试或缩短每镜时长';
    if (/video_url|视频地址/i.test(m)) return '任务已完成但获取视频地址失败，请重试';
    return '请重试；若持续失败，请返回配置换用其他模型，或在本地服务（node server.js）环境下使用';
  }
  async function makeVideo(el) {
    let okShots = shots.filter((s) => s.status === 'ok');
    if (!okShots.length && st.aiVideo && shots.length) {
      // AI 动态模式：允许直接用参考帧做首帧（不先生图也能出片，Seedance 按提示词替换主体）
      okShots = shots.map((s) => ({ ...s, status: 'ok', urls: [] }));
      UI.toast('未生成复刻图，将直接用竞品参考帧做首帧（建议先在分镜页生成复刻图以替换主体）', 'warn', 6000);
    }
    if (!okShots.length) return UI.toast('请先生成复刻图（至少 1 镜）', 'warn');
    const videoArea = document.querySelector('#rmReviewVideo');
    if (videoArea) videoArea.innerHTML = '<p style="font-size:12.5px;color:var(--text-2);margin-top:6px">⏳ 准备生成复刻视频…</p>';
    if (st.aiVideo) {
      try {
        await makeAiVideo(el, okShots, videoArea);
        return;
      } catch (e) {
        const reason = (e && e.message) || String(e || '未知错误');
        const advice = errAdvice(reason);
        console.warn('[remake] Seedance 动态视频失败，降级本地运镜', e);
        cur.logs.push(`⚠️ AI 动态视频失败：${reason.slice(0, 200)}`);
        cur.logs.push(`💡 ${advice}`);
        UI.toast(`AI 动态视频失败：${reason.slice(0, 60)}… ${advice}（已降级本地运镜）`, 'warn', 9000);
        if (videoArea) {
          videoArea.innerHTML = `
            <div class="card" style="margin-top:12px;border-color:rgba(245,158,11,.5)">
              <div class="card-title"><span class="ico">⚠️</span>AI 动态视频未生效（本次已自动降级为本地运镜）</div>
              <p style="font-size:12px;color:var(--text-2);margin:0 0 6px">失败原因：${UI.escapeHtml(reason.slice(0, 180))}</p>
              <p style="font-size:12px;color:var(--warn,#f59e0b);margin:0 0 8px">💡 ${advice}</p>
              <button class="btn btn-sm" id="rmRetryAiVideo">↻ 返回配置更换模型后重试</button>
            </div>`;
          const retryBtn = videoArea.querySelector('#rmRetryAiVideo');
          if (retryBtn) retryBtn.addEventListener('click', () => { mode = 'config'; render(document.querySelector('#content')); });
        }
        // 无复刻图时本地运镜也无法合成，原因卡已说明问题，直接返回
        if (!okShots.some((s) => s.urls && s.urls.length)) return;
      }
    }
    await makeLocalVideo(el, okShots, videoArea);
  }

  /** 本地运镜方案：逐镜 zoompan 片段 + xfade 转场拼接（浏览器免费） */
  async function makeLocalVideo(el, okShots, videoArea) {
    if (!okShots.some((s) => s.urls && s.urls.length)) {
      const msg = '本地运镜需要至少 1 张复刻图，请先在分镜页生成复刻图（或改用 AI 动态视频）';
      cur.logs.push(`❌ ${msg}`);
      if (videoArea) videoArea.innerHTML = `<p style="font-size:12px;color:var(--danger,#f87171);margin-top:6px">❌ ${msg}</p>`;
      return UI.toast(msg, 'err', 6000);
    }
    UI.toast(`开始合成复刻视频（${okShots.length} 镜）…`, 'info', 3000);
    if (videoArea) videoArea.innerHTML = '<p style="font-size:12.5px;color:var(--text-2);margin-top:6px">⏳ 正在运镜+转场合成（浏览器本地处理）…</p>';
    try {
      const ffmpeg = await window.EditorView.ensureFFmpegPublic();
      if (!ffmpeg) throw new Error('剪辑引擎加载失败');
      const ref0 = st.refs[0];
      const scale = 1080 / Math.max(ref0.w || 16, ref0.h || 9);
      const W = Math.max(16, Math.round((ref0.w || 16) * scale / 2) * 2);
      const H = Math.max(16, Math.round((ref0.h || 9) * scale / 2) * 2);
      const segNames = [], durs = [];
      for (let i = 0; i < okShots.length; i++) {
        const s = okShots[i];
        const dur = s.dur || RHYTHMS[st.rhythm].dur;
        const style = MOTION_CYCLE[i % MOTION_CYCLE.length];
        const segName = `rm_seg_${i}.mp4`;
        const data = await makeMotionClip(ffmpeg, s.urls[s.chosen || 0], dur, style, W, H, i);
        await ffmpeg.writeFile(segName, data);
        segNames.push(segName);
        durs.push(dur);
        cur.logs.push(`[镜${i + 1}] ✅ 运镜「${MOTION_LABEL[style]}」`);
      }
      const finalData = await concatSegments(ffmpeg, segNames, durs);
      const blob = new Blob([finalData], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const totalDur = durs.reduce((a, b) => a + b, 0) - 0.35 * Math.max(0, durs.length - 1);
      results = results.filter((r) => r.kind !== 'video');
      results.push({ kind: 'video', url, at: Date.now() });
      try { await Store.add({ type: 'project', kind: 'remake-video', title: `仿拍复刻成片（${okShots.length} 镜）`, url, duration: totalDur }); } catch { /* ignore */ }
      if (videoArea) {
        videoArea.innerHTML = `
          <div class="card" style="margin-top:12px;border-color:rgba(52,211,153,.4)">
            <div class="card-title"><span class="ico">🎬</span>复刻视频（${okShots.length} 镜 · 运镜+转场 · ${totalDur.toFixed(1)}s）</div>
            <video src="${url}" controls style="width:100%;border-radius:10px;background:#000;max-height:420px"></video>
            <a class="btn btn-primary btn-block" style="margin-top:10px" href="${url}" download="复刻视频_${Date.now()}.mp4">⬇ 下载复刻视频</a>
          </div>`;
      }
      UI.toast('复刻视频合成完成 🎉', 'ok', 5000);
    } catch (e) {
      console.error('[remake] makeLocalVideo fail', e);
      cur.logs.push(`❌ 视频合成失败：${e.message}`);
      if (videoArea) videoArea.innerHTML = `<p style="font-size:12px;color:var(--danger,#f87171);margin-top:6px">❌ 视频合成失败：${UI.escapeHtml(e.message || '')}</p>`;
      UI.toast(`视频合成失败：${e.message || ''}`, 'err', 7000);
    }
  }

  /* ---------- 进度/完成（兼容旧流程入口，主要流程已移到分镜审查） ---------- */
  function renderProgress(el) {
    el.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto;padding:30px 34px">
        <div style="display:flex;align-items:center">
          <span style="font-weight:700;font-size:15px">🎬 正在仿拍复刻…</span>
          <span style="flex:1"></span>
          <span id="rmCur" style="font-size:12px;color:var(--text-3)"></span>
        </div>
        <div style="display:flex;gap:6px;margin:20px 0 18px" id="rmSteps">
          ${['AI 拆解爆款逻辑', '复刻生图', '运镜合成', '输出成片'].map((s, i) => `
            <div style="flex:1;text-align:center">
              <div id="rmStep${i}" style="height:5px;border-radius:3px;background:var(--border-light,#333);transition:all .3s"></div>
              <p id="rmStepT${i}" style="font-size:11px;color:var(--text-3);margin:6px 0 0">${s}</p>
            </div>`).join('')}
        </div>
        <div style="text-align:center;margin-bottom:12px">
          <span id="rmPct" style="font-size:44px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">0%</span>
        </div>
        <div class="progress-bar" style="height:10px"><div class="fill" id="rmBar" style="width:0%"></div></div>
        <p id="rmStage" style="font-size:12.5px;color:var(--text-2);margin-top:10px;text-align:center">准备中…</p>
        <div style="font-family:Consolas,monospace;font-size:11px;color:var(--text-3);background:var(--bg-soft);border-radius:8px;padding:10px;margin-top:16px;height:90px;overflow:auto;white-space:pre-wrap" id="rmLog"></div>
      </div>`;
  }
  function setStep(idx) {
    cur.stepIdx = idx;
    for (let i = 0; i < 4; i++) {
      const bar = document.getElementById('rmStep' + i);
      const txt = document.getElementById('rmStepT' + i);
      if (bar) bar.style.background = i < idx ? 'var(--ok,#34d399)' : i === idx ? 'var(--grad)' : 'var(--border-light,#333)';
      if (txt) txt.style.color = i <= idx ? 'var(--text-1,#eee)' : 'var(--text-3,#777)';
    }
  }
  function updateProgress() {
    const pct = document.getElementById('rmPct'), bar = document.getElementById('rmBar');
    const stage = document.getElementById('rmStage'), log = document.getElementById('rmLog'), curn = document.getElementById('rmCur');
    if (pct) pct.textContent = `${Math.round(cur.pct)}%`;
    if (bar) bar.style.width = `${Math.min(cur.pct, 100)}%`;
    if (stage) stage.textContent = cur.stage || '';
    if (curn) curn.textContent = cur.total > 1 ? `${cur.idx + 1} / ${cur.total}` : '';
    if (log) log.textContent = cur.logs.slice(-8).join('\n');
  }

  function renderDone(el) {
    const imgs = results.filter((r) => r.kind === 'img');
    const vids = results.filter((r) => r.kind === 'video');
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h3 style="margin:0">🎉 仿拍复刻完成</h3>
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="rmAgain">🔄 再复刻一次</button>
        <button class="btn btn-sm btn-ghost" id="rmBack">⚙️ 调整配置</button>
      </div>
      ${imgs.length ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-title"><span class="ico">🖼️</span>复刻图片（${imgs.length} 张 · 爆款构图已保留，主体已替换为你的玩法）</div>
        <div class="result-grid">
          ${imgs.map((r, i) => `
            <div class="card" style="overflow:hidden">
              ${r.failed || !r.url ? `
                <div style="width:100%;aspect-ratio:${r.w && r.h ? r.w / r.h : 'auto'};display:flex;align-items:center;justify-content:center;background:var(--bg-soft);color:var(--danger,#f87171);font-size:12.5px">❌ 画面 ${i + 1} 复刻失败</div>
              ` : `
                <img src="${API.proxyUrl(r.url)}" style="width:100%;aspect-ratio:${r.w && r.h ? r.w / r.h : 'auto'};object-fit:cover;background:#000" loading="lazy">
              `}
              <div style="padding:9px 11px">
                <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">画面 ${i + 1}${r.refName ? ` · 参考「${UI.escapeHtml(r.refName)}」` : ''}</div>
                ${r.failed || !r.url ? '' : `<a class="btn btn-primary btn-block btn-sm" href="${API.proxyUrl(r.url)}" target="_blank" rel="noopener" download="复刻图_${i + 1}_${Date.now()}.jpg">⬇ 下载</a>`}
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${vids.length ? `
      <div class="card">
        <div class="card-title"><span class="ico">🎬</span>复刻视频（${vids.length} 个 · 爆款节奏运镜+转场拼接）</div>
        <div class="result-grid">
          ${vids.map((r, i) => `
            <div class="card" style="overflow:hidden">
              <video src="${r.url}" controls style="width:100%;background:#000;max-height:360px"></video>
              <div style="padding:9px 11px">
                <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">${RHYTHMS[st.rhythm]?.label || ''} · ${st.refs.length} 个画面</div>
                <a class="btn btn-primary btn-block btn-sm" href="${r.url}" download="复刻视频_${Date.now()}.mp4">⬇ 下载</a>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}
      <p style="font-size:11.5px;color:var(--text-3);margin-top:12px">📦 所有复刻作品已自动保存到「作品中心」</p>
      <details style="margin-top:10px"><summary style="font-size:11.5px;color:var(--text-3);cursor:pointer">📋 查看本次执行日志</summary>
        <pre style="font-size:10.5px;color:var(--text-3);background:var(--bg-soft);border-radius:8px;padding:10px;margin-top:8px;max-height:160px;overflow:auto;white-space:pre-wrap">${UI.escapeHtml((window.__remakeLogs || []).join('\n'))}</pre>
      </details>`;
    el.querySelector('#rmAgain').addEventListener('click', () => { mode = 'config'; render(document.querySelector('#content')); });
    el.querySelector('#rmBack').addEventListener('click', () => { results = []; mode = 'config'; render(document.querySelector('#content')); });
  }

  /* ---------- 执行：拆解 → 分镜审查 ---------- */
  async function run(el) {
    if (running) return;
    if (!st.refs.length) return UI.toast('请先上传参考图', 'warn');
    if (!st.myDesc.trim()) return UI.toast('请填写我的主体与玩法描述', 'warn');
    running = true;
    cur = { stepIdx: 0, idx: 0, total: st.refs.length, pct: 0, logs: [], stage: '准备中…' };
    window.__remakeLogs = cur.logs;
    mode = 'progress';
    render(el);
    updateProgress();

    try {
      /* Step 1: AI 分镜拆解 */
      const prompts = [];
      for (let i = 0; i < st.refs.length; i++) {
        cur.idx = i;
        cur.stage = `AI 拆解画面 ${i + 1}/${st.refs.length} 的爆款逻辑…`;
        cur.pct = Math.round((i / st.refs.length) * 60);
        updateProgress();
        if (st.aiSplit) {
          try {
            const visImgs = (await Promise.all(
              [st.refs[i].dataURL, ...st.myRefs.map((m) => m.dataURL)].map((u) => ensureDataURL(u)),
            )).filter(Boolean);
            if (!visImgs.length) throw new Error('参考图不可用');
            const r = await API.chatVision(splitPrompt(i), visImgs);
            prompts.push(r.content || fallbackPrompt());
            cur.logs.push(`[镜${i + 1}] ✅ 爆款逻辑拆解完成`);
          } catch (e) {
            console.warn('[remake] vision fail, fallback', e);
            prompts.push(fallbackPrompt());
            cur.logs.push(`[镜${i + 1}] ⚠️ AI 拆解失败，改用模板提示词`);
          }
        } else {
          prompts.push(fallbackPrompt());
        }
        updateProgress();
      }
      /* Step 2: 进入分镜审查 */
      shots = st.refs.map((ref, i) => ({
        ref,
        prompt: prompts[i],
        dur: RHYTHMS[st.rhythm].dur,
        urls: [],
        chosen: 0,
        status: 'idle',
        error: '',
      }));
      mode = 'review';
      render(document.querySelector('#content'));
      UI.toast('爆款逻辑拆解完成，请审查分镜后生成', 'ok', 5000);
    } catch (e) {
      console.error('[remake] run error:', e);
      UI.toast(`仿拍复刻失败：${e.message || '未知错误'}`, 'err', 7000);
    } finally {
      running = false;
    }
  }

  return { render };
})();
