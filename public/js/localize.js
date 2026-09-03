/* ============================================================
 * localize.js — 媒体文字本地化
 * 上传视频/图片 → AI 识别文字(OCR)并翻译（韩/英/日/繁中/俄）
 * → 消除原文字 → 译文按原位置重绘 → 输出与原文件属性一致的媒体
 * 视频: mp4/mov → 输出视频(mp4)；图片: jpg/png → 输出图片(jpg/png)
 * ============================================================ */
window.LocalizeView = (() => {
  const LS_KEY = 'materall_localize';
  const TARGET_LANGS = [
    { code: 'ko-KR', label: '韩语', font: '"Malgun Gothic","Apple SD Gothic Neo",sans-serif' },
    { code: 'en-US', label: '英语', font: 'Arial,Helvetica,sans-serif' },
    { code: 'ja-JP', label: '日语', font: '"Yu Gothic","Hiragino Sans",Meiryo,sans-serif' },
    { code: 'zh-TW', label: '繁体中文', font: '"Microsoft JhengHei","PingFang TC",sans-serif' },
    { code: 'ru-RU', label: '俄语', font: 'Arial,Helvetica,sans-serif' },
  ];
  const MAX_ITEMS = 40;

  let st = {
    media: null,       // { kind:'video'|'image', file, source(blobURL), name, type, vw, vh, duration }
    lang: 'ko-KR',
    items: [],         // 文字块 [{ id, text, translated, x,y,w,h(0~1), note }]
    analyzing: false,
    // 运行态
    frameDataUrl: null, // 当前分析帧（图片=原图 / 视频=中间帧）
  };

  function uid(p = 'it') { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- 工具 ---------- */
  function readFileMeta(file) {
    return new Promise((res, rej) => {
      if (file.type.startsWith('image/')) {
        const u = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => res({ kind: 'image', w: im.naturalWidth, h: im.naturalHeight, url: u });
        im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('图片读取失败')); };
        im.src = u;
        return;
      }
      if (file.type.startsWith('video/')) {
        const u = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'auto'; v.muted = true; v.playsInline = true;
        v.onloadedmetadata = () => res({ kind: 'video', w: v.videoWidth, h: v.videoHeight, duration: v.duration, url: u });
        v.onerror = () => { URL.revokeObjectURL(u); rej(new Error('视频读取失败')); };
        v.src = u;
        return;
      }
      rej(new Error('不支持的文件类型'));
    });
  }

  /** 从视频取一帧（用于 AI 识别定位 + 预览） */
  function grabFrame(url, duration, tRatio = 0.5, maxSide = 1080) {
    return new Promise((res) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadedmetadata = () => {
        const t = Math.min(Math.max(0.1, (duration || v.duration) * tRatio), Math.max((v.duration || 1) - 0.1, 0.1));
        v.currentTime = t;
        v.onseeked = () => {
          const sc = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(8, Math.round(v.videoWidth * sc));
          c.height = Math.max(8, Math.round(v.videoHeight * sc));
          const ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0, c.width, c.height);
          res({ dataURL: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, vw: v.videoWidth, vh: v.videoHeight });
        };
        v.onerror = () => res(null);
      };
      v.onerror = () => res(null);
      v.src = url;
    });
  }

  /* ---------- AI 识别 + 翻译 ---------- */
  /** 本地文件 → dataURL（AI 识别需可被网关访问的 data: 协议；blob URL 网关拉不到） */
  function fileToDataURL(file, maxSide = 1280, quality = 0.9) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('文件缺失'));
      const isPng = /png/i.test(file.type || file.name || '');
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const W = Math.max(8, Math.round(img.naturalWidth * sc));
        const H = Math.max(8, Math.round(img.naturalHeight * sc));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL(isPng ? 'image/png' : 'image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  async function analyzeAndTranslate() {
    const m = st.media;
    if (!m) return UI.toast('请先上传视频或图片', 'warn');
    if (API.detectStaticMode && (await API.detectStaticMode())) return UI.toast('本地化识别需要 AI 服务：请通过本地服务（node server.js）使用', 'warn', 6000);
    st.analyzing = true;
    render(document.querySelector('#content'));
    UI.toast('AI 识别文字并翻译中…', 'info', 5000);
    try {
      let frame = st.frameDataUrl;
      if (!frame) {
        if (m.kind === 'video') {
          const g = await grabFrame(m.source, m.duration);
          if (!g) throw new Error('视频抽帧失败');
          st.frameDataUrl = frame = g.dataURL;
        } else {
          // 图片：blob URL 无法被 AI 网关访问 → 转 dataURL（优先原始文件，避免再次读 blob）
          frame = st.media.file ? await fileToDataURL(st.media.file) : await fileToDataURL(new File([await (await fetch(m.source)).blob()], m.name, { type: m.type }));
          st.frameDataUrl = frame;
        }
      }
      const langLabel = TARGET_LANGS.find((x) => x.code === st.lang)?.label || '韩语';
      const prompt = `你是广告素材本地化专家。请识别这张画面里所有需要去除并本地化的元素：1) 所有文字（按钮、标题、广告语、UI 文案等）；2) 明显的水印/Logo 图形（如需替换为文案则一并框出）。并翻译成${langLabel}。
严格只输出 JSON 数组，每个元素：{"text":"原文或LOGO","translated":"${langLabel}译文或留空","x":0.0,"y":0.0,"w":0.0,"h":0.0,"color":"#RRGGBB","weight":"bold|normal","family":"serif|sans","italic":false}（x,y,w,h 为相对整图的归一化坐标 0~1，框住该元素区域；color 为该文字主色；weight 为字形粗细；family 衬线/无衬线）。不要输出任何其他内容。若无文字输出 []。`;
      const r = await API.chatVision(prompt, frame, { temperature: 0.1, max_tokens: 1200 });
      const content = (r.content || '').trim().replace(/^```(json)?|```$/g, '').trim();
      let arr = null;
      try { arr = JSON.parse(content); } catch { /* 尝试提取数组 */ }
      if (!Array.isArray(arr)) {
        const m2 = content.match(/\[[\s\S]*\]/);
        if (m2) { try { arr = JSON.parse(m2[0]); } catch { /* ignore */ } }
      }
      if (!Array.isArray(arr) || !arr.length) {
        st.items = [];
        UI.toast('未识别到画面文字（或画面无文字）', 'warn', 5000);
        save(); render(document.querySelector('#content'));
        return;
      }
      st.items = arr.slice(0, MAX_ITEMS).map((it) => ({
        id: uid(),
        text: String(it.text || '').slice(0, 120),
        translated: String(it.translated || '').slice(0, 160),
        x: clampNum(it.x), y: clampNum(it.y), w: clampNum(it.w), h: clampNum(it.h),
        note: it.note || '',
        color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(it.color || '') ? it.color : '',
        weight: it.weight === 'bold' ? 'bold' : '',
        family: it.family === 'serif' ? 'serif' : '',
        italic: !!it.italic,
        rmv: true,   // 默认勾选：去除原文字/Logo 并（有译文时）替换
      }));
      UI.toast(`识别到 ${st.items.length} 处文字并已翻译 ✅（可逐条编辑后生成）`, 'ok', 5000);
      save(); render(document.querySelector('#content'));
    } catch (e) {
      const msg = e.message || '';
      let hint = '';
      if (/api key|authentication|unauthorized/i.test(msg)) hint = '请在「连接设置」填写有效的方舟 API Key';
      else if (/not (found|enabled|supported)|does not exist|not valid|invalid/i.test(msg)) hint = '模型不可用：系统已自动轮换尝试你账号下已开通的模型；仍失败请点「🔎 检查我的模型权限」并到方舟控制台开通视觉模型（doubao-seed-1-6-vision / 1.5-vision-pro）';
      else hint = msg.slice(0, 80);
      UI.toast('AI 识别失败：' + hint, 'err', 9000);
      st.analyzing = false;
      render(document.querySelector('#content'));
    }
  }
  const clampNum = (v) => Math.min(Math.max(Number(v) || 0, 0), 1);

  /* ---------- 图片本地化（canvas：区域修复 + 译文绘制） ---------- */
  function patchRegion(ctx, X, Y, W, H) {
    // 边缘采样填充 + 轻模糊，消除原文字
    const P = 4, px = ctx.getImageData;
    const edge = ctx.getImageData(Math.max(0, X - P), Math.max(0, Y - P), Math.min(W + P * 2, ctx.canvas.width - Math.max(0, X - P)), Math.min(H + P * 2, ctx.canvas.height - Math.max(0, Y - P)));
    const d = edge.data;
    let r = 0, g = 0, b = 0, n = 0;
    // 只取边缘像素（环）避免文字中心污染平均色
    const wpx = edge.width, hpx = edge.height;
    for (let yy = 0; yy < hpx; yy++) {
      for (let xx = 0; xx < wpx; xx++) {
        const onEdge = xx < P || yy < P || xx >= wpx - P || yy >= hpx - P;
        if (!onEdge) continue;
        const i = (yy * wpx + xx) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    const rr = n ? r / n : 0, gg = n ? g / n : 0, bb = n ? b / n : 0;
    ctx.save();
    ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`;
    ctx.fillRect(X, Y, W, H);
    ctx.filter = 'blur(5px)';
    ctx.fillRect(X - 2, Y - 2, W + 4, H + 4);
    ctx.restore();
    // 二次柔化边缘
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = `rgba(${rr | 0},${gg | 0},${bb | 0},0.85)`;
    ctx.fillRect(X, Y, W, H);
    ctx.restore();
  }

  function langFont(code) {
    return TARGET_LANGS.find((x) => x.code === code)?.font || 'Arial,Helvetica,sans-serif';
  }
  // 衬线（宋体类）字栈：原文字若为衬线字体（serif），译文用对应语言的衬线族复刻观感
  const SERIF_FONT = {
    'ko-KR': '"Batang","AppleMyungjo","Nanum Myeongjo",serif',
    'en-US': 'Georgia,"Times New Roman",serif',
    'ja-JP': '"Yu Mincho","Hiragino Mincho ProN","MS PMincho",serif',
    'zh-TW': '"PMingLiU","PingFang TC",serif',
    'ru-RU': 'Georgia,"Times New Roman",serif',
  };

  /** 从原图区域像素提取文字样式（前景文字色/笔画粗细），译文按此复刻，无底自然融入 */
  function extractTextStyle(ctx, X, Y, W, H) {
    const iw = ctx.canvas.width, ih = ctx.canvas.height;
    X = Math.max(0, Math.min(Math.round(X), iw - 2)); Y = Math.max(0, Math.min(Math.round(Y), ih - 2));
    W = Math.max(2, Math.min(Math.round(W), iw - X)); H = Math.max(2, Math.min(Math.round(H), ih - Y));
    const d = ctx.getImageData(X, Y, W, H).data;
    // 背景色 = 四边环均值
    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const onEdge = xx < 2 || yy < 2 || xx >= W - 2 || yy >= H - 2;
        if (!onEdge) continue;
        const i = (yy * W + xx) * 4;
        br += d[i]; bg += d[i + 1]; bb += d[i + 2]; bn++;
      }
    }
    if (bn < 4) return { color: null };
    br /= bn; bg /= bn; bb /= bn;
    // 文字像素：与背景色差足够大（≈深色文字在白底/白字在深底/彩色字）
    let tr = 0, tg = 0, tb = 0, tn = 0;
    for (let p = 0; p < d.length; p += 4) {
      const dr = d[p] - br, dg = d[p + 1] - bg, db = d[p + 2] - bb;
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 150) { tr += d[p]; tg += d[p + 1]; tb += d[p + 2]; tn++; }
    }
    const ratio = tn / (W * H);
    if (tn < 10 || ratio < 0.015) return { color: null };   // 无法分离前景（如超细字/渐变），由兜底色处理
    const r = Math.round(tr / tn), g = Math.round(tg / tn), b = Math.round(tb / tn);
    // 抗锯齿导致文字色偏背景：往反差方向推一点
    return { color: `rgb(${r},${g},${b})`, bold: ratio > 0.24 };
  }

  /** 图像源（dataURL/blob）→ canvas，供样式提取 */
  function loadImgCanvas(src) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        res(c);
      };
      im.onerror = () => res(null);
      im.src = src;
    });
  }

  /** 绘制译文：无底色无描边，完全仿原文字样式（颜色/粗细/衬线/斜体），只换语言不改画面设计 */
  function drawTranslation(ctx, it, W, H, style) {
    const X = it.x * W, Y = it.y * H, BW = Math.max(10, it.w * W), BH = Math.max(8, it.h * H);
    const txt = (it.translated || it.text || '').trim();
    if (!txt) return;
    const cx = X + BW / 2, cy = Y + BH / 2;
    // 字体族：原文字衬线与否优先（AI 可给 family 建议），否则语言默认
    const family = (it.family === 'serif') ? (SERIF_FONT[st.lang] || 'Georgia,serif') : langFont(st.lang);
    const weight = (style && style.bold) || it.weight === 'bold' ? '700' : '400';
    const italic = (it.italic && st.lang === 'en-US') ? 'italic ' : '';
    let size = Math.min(BH * 0.86, Math.max(9, Math.sqrt((BW * BH) / Math.max(txt.length, 1)) * 0.6));
    ctx.save();
    ctx.font = `${italic}${weight} ${size}px ${family}`;
    let tw = ctx.measureText(txt).width;
    while (tw > BW * 0.97 && size > 9) { size -= 1; ctx.font = `${italic}${weight} ${size}px ${family}`; tw = ctx.measureText(txt).width; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 文字颜色：优先像素提取的原文字色；AI 建议兜底；最后白色
    let color = null;
    if (style && style.color) color = style.color;
    else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(it.color || '')) color = it.color;
    else color = '#ffffff';
    ctx.fillStyle = color;
    ctx.fillText(txt, cx, cy);
    ctx.restore();
  }

  async function localizeImage() {
    const m = st.media;
    const act = st.items.filter((x) => x.rmv !== false && x.w > 0.01 && x.h > 0.01);
    const toDraw = act.filter((x) => x.translated);
    if (!act.length) return UI.toast('请先完成识别并勾选要去除的区域', 'warn');
    UI.toast('正在快速生成（本地修补 + 精确写译文）…', 'info', 3000);
    const img = new Image();
    img.src = m.source;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // ① 消除前先从原图提取每处样式 → ② 逐区域修补消除 → ③ 按样式无底绘制译文
    const styleMap = new Map();
    act.forEach((x) => {
      const X = Math.round(x.x * c.width), Y = Math.round(x.y * c.height);
      const W = Math.max(8, Math.round(x.w * c.width)), H = Math.max(6, Math.round(x.h * c.height));
      styleMap.set(x.id, extractTextStyle(ctx, X, Y, W, H));
    });
    act.forEach((x) => {
      const X = Math.round(x.x * c.width), Y = Math.round(x.y * c.height);
      const W = Math.max(8, Math.round(x.w * c.width)), H = Math.max(6, Math.round(x.h * c.height));
      patchRegion(ctx, X, Y, W, H);
    });
    toDraw.forEach((x) => drawTranslation(ctx, x, c.width, c.height, styleMap.get(x.id)));
    const isPng = /png/i.test(m.name || m.type);
    const dataURL = c.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.92);
    const outName = outFileName(m, 'png/jpg');
    showResult({ url: dataURL, name: outName, kind: 'image' });
  }

  /** AI 智能生成（图片）：Seedream 局部重绘抹除文字/Logo（复杂背景自然融合）→ 精确绘制译文 */
  async function localizeImageAI() {
    const m = st.media;
    const act = st.items.filter((x) => x.rmv !== false && x.w > 0.01 && x.h > 0.01);
    const toDraw = act.filter((x) => x.translated);
    if (!act.length) return UI.toast('请先完成识别并勾选要去除的区域', 'warn');
    if (!API.hasArkKey || !API.hasArkKey()) return UI.toast('AI 智能生成走火山方舟 Seedream：请在「连接设置」的「火山方舟 Key」栏填写（识别可继续用 Bilibili，两把 Key 可并存）', 'warn', 8000);
    UI.toast('AI 抹除文字/Logo 中（Seedream 局部重绘，约 10~30s）…', 'info', 10000);
    try {
      // 1) 原图像素提取样式（抹除前）
      const srcData = st.frameDataUrl || (st.media.file ? await fileToDataURL(st.media.file) : null);
      if (!srcData) throw new Error('无法读取原图');
      const base = await loadImgCanvas(srcData);
      if (!base) throw new Error('原图解析失败');
      const W = base.width, H = base.height;
      const bctx = base.getContext('2d');
      const styleMap = new Map();
      act.forEach((x) => {
        const X = Math.max(0, Math.round(x.x * W)), Y = Math.max(0, Math.round(x.y * H));
        const w = Math.max(8, Math.min(Math.round(x.w * W), W - X)), h = Math.max(6, Math.min(Math.round(x.h * H), H - Y));
        styleMap.set(x.id, extractTextStyle(bctx, X, Y, w, h));
      });
      // 2) Seedream 4.0 语义化编辑：AI 看图自动清除文字/Logo 并自然补全（无需蒙版；保留未勾选项）
      const keepL = st.items.filter((x) => x.rmv === false && (x.text || '').trim()).map((x) => x.text.trim()).slice(0, 8).join('、');
      let prompt = 'Edit this image: remove ALL text, letters, characters, watermark and logo marks visible in the image. Fill the removed areas naturally with the surrounding background so they look clean and untouched. Keep persons, objects, composition, colors and every other pixel exactly the same. Do NOT add or render any new text.';
      if (keepL) prompt += ` IMPORTANT: keep these elements completely untouched and visible: "${keepL}".`;
      // 3) 调 Seedream 图像编辑（API 封装自动携带方舟 Key）
      const data = await API.request('/api/image/edit', {
        method: 'POST',
        body: JSON.stringify({ image: srcData, prompt, model: 'doubao-seedream-4-0-250828' }),
      });
      const item = (data.items || [])[0];
      if (!item) throw new Error('AI 未返回结果图');
      // 4) 结果图 → 绘制译文
      let cleanSrc = item.b64 ? 'data:image/png;base64,' + item.b64 : null;
      if (!cleanSrc && item.url) {
        const blob = await API.fetchBlob(item.url);
        cleanSrc = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      }
      const clean = await loadImgCanvas(cleanSrc);
      if (!clean) throw new Error('AI 结果图加载失败');
      const cctx = clean.getContext('2d');
      toDraw.forEach((x) => drawTranslation(cctx, x, clean.width, clean.height, styleMap.get(x.id)));
      const isPng = /png/i.test(m.name || m.type);
      const dataURL = clean.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.92);
      showResult({ url: dataURL, name: outFileName(m, 'png/jpg'), kind: 'image', fromAI: true });
      UI.toast('AI 智能生成完成 ✅（抹除区域由 Seedream 融合）', 'ok', 4000);
    } catch (e) {
      const msg = e.message || '';
      let hint = msg;
      if (/api key|authentication|401|密钥|format is incorrect/i.test(msg)) hint = '方舟 Key 无效或未配置（AI 智能生成需 ☁️ 火山方舟 Key）';
      UI.toast('AI 生成失败：' + hint.slice(0, 320) + '（可改用 ⚡ 快速生成）', 'err', 11000);
      console.warn('[localize] AI edit fail', e);
    }
  }

  /* ---------- 视频本地化（ffmpeg：delogo 消除 + overlay 译文 PNG） ---------- */
  async function localizeVideo() {
    const m = st.media;
    const items = st.items.filter((x) => x.rmv !== false && x.w > 0.01 && x.h > 0.01);   // 勾选=要抹除的区域
    const toDraw = items.filter((x) => x.translated);                                     // 有译文=要写
    if (!items.length) return UI.toast('请先完成识别并勾选要去除的区域', 'warn');
    const ffmpeg = await window.EditorView.ensureFFmpegPublic();
    if (!ffmpeg) return UI.toast('剪辑引擎加载失败', 'err');
    UI.toast('正在本地化视频（抹字 + 覆盖译文，可能需要 1~3 分钟）…', 'info', 8000);
    const { vw, vh } = m;
    try {
      const inName = 'lz_in' + (/\.(mov)$/i.test(m.name) ? '.mov' : '.mp4');
      const buf = await (await fetch(m.source)).arrayBuffer();
      await rm(ffmpeg, inName); await rm(ffmpeg, 'lz_out.mp4'); await rm(ffmpeg, 'lz_ov.png');
      await ffmpeg.writeFile(inName, new Uint8Array(buf));
      // 1) 译文 overlay 透明 PNG（整帧尺寸，原分辨率绘制译文；样式从识别帧原图提取，无底仿原字）
      const oc = document.createElement('canvas');
      oc.width = vw; oc.height = vh;
      const octx = oc.getContext('2d');
      const styleMap = new Map();
      const frameC = st.frameDataUrl ? await loadImgCanvas(st.frameDataUrl) : null;
      if (frameC) {
        const fctx = frameC.getContext('2d');
        const sc = vw / frameC.width;   // 帧可能被压缩过，换算到原分辨率
        items.forEach((it) => {
          const X = it.x * vw / sc, Y = it.y * vh / sc;
          const W = Math.max(8, it.w * vw / sc), H = Math.max(6, it.h * vh / sc);
          styleMap.set(it.id, extractTextStyle(fctx, X, Y, W, H));
        });
      }
      toDraw.forEach((it) => drawTranslation(octx, it, vw, vh, styleMap.get(it.id)));
      const ovPng = oc.toDataURL('image/png');
      await ffmpeg.writeFile('lz_ov.png', new Uint8Array(await (await fetch(ovPng)).arrayBuffer()));
      // 2) 滤镜：delogo 抹除每个区域（enable 全片；区域按原分辨率像素）
      const fp = [];
      let prev = '[0:v]';
      items.forEach((it, idx) => {
        const X = Math.round(it.x * vw), Y = Math.round(it.y * vh);
        const W = Math.min(Math.max(4, Math.round(it.w * vw)), vw - X);
        const H = Math.min(Math.max(4, Math.round(it.h * vh)), vh - Y);
        const tag = `[v${idx}]`;
        fp.push(`${prev}delogo=x=${X}:y=${Y}:w=${W}:h=${H}:show=0${tag}`);
        prev = tag;
      });
      fp.push(`${prev}[vbase]`);
      fp.push(`[vbase][1:v]overlay=0:0[vout]`);
      const code = await ffmpeg.exec([
        '-i', inName, '-i', 'lz_ov.png',
        '-filter_complex', fp.join(';'),
        '-map', '[vout]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', 'lz_out.mp4',
      ]);
      if (code !== 0) throw new Error('视频合成失败(code ' + code + ')');
      const data = await ffmpeg.readFile('lz_out.mp4');
      await rm(ffmpeg, inName); await rm(ffmpeg, 'lz_ov.png'); await rm(ffmpeg, 'lz_out.mp4');
      const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      showResult({ url, name: outFileName(m, 'mp4'), kind: 'video' });
    } catch (e) {
      console.error('[localize] video error', e);
      UI.toast('视频本地化失败：' + (e.message || '').slice(0, 80), 'err', 7000);
    }
  }
  async function rm(ffmpeg, name) { try { await ffmpeg.deleteFile(name); } catch { /* ignore */ } }

  function outFileName(m, ext) {
    const langTag = st.lang.split('-')[0];
    const base = (m.name || 'media').replace(/\.[^.]+$/, '');
    return `${base}_${langTag}.${ext}`;
  }

  /* ---------- 结果 ---------- */
  function showResult({ url, name, kind }) {
    mode = 'done';
    result = { url, name, kind };
    const el = document.querySelector('#content');
    if (el) renderDone(el);
    UI.toast('✅ 本地化完成', 'ok', 4000);
  }

  /* ---------- 渲染 ---------- */
  let mode = 'config';
  let result = null;

  function render(el) {
    load();
    if (mode === 'done') return renderDone(el);
    renderConfig(el);
  }

  function renderConfig(el) {
    const m = st.media;
    el.innerHTML = `
      <div class="rsz-layout">
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="card">
            <div class="card-title"><span class="ico">🌍</span>媒体文字本地化（优化中）· 去文案/Logo → 翻译替换 → 输出</div>
            <input type="file" id="lzFile" accept="video/mp4,video/quicktime,video/*,image/jpeg,image/png,image/*" style="display:none">
            <div class="rsz-drop" id="lzDrop"><div style="font-size:24px">📂</div>
              <p style="margin:6px 0 2px;font-weight:600">拖拽上传 视频素材 / 图片素材</p>
              <p style="font-size:11px;color:var(--text-3)">支持 MP4 / MOV · JPG / PNG — 上传什么就输出什么</p></div>
            ${m ? `
              <div style="display:flex;gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap">
                <span class="chip" style="padding:4px 10px;border:1px solid var(--border-light);border-radius:999px;font-size:12px">${m.kind === 'video' ? '🎬' : '🖼️'} ${UI.escapeHtml(m.name)} · ${m.kind === 'video' ? `${(m.duration || 0).toFixed(1)}s` : `${m.vw}×${m.vh}`}</span>
                <button class="btn-icon" id="lzRemove" title="移除">✕</button>
              </div>` : ''}
          </div>

          <div class="card">
            <div class="card-title"><span class="ico">🔤</span>翻译目标语言</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${TARGET_LANGS.map((L) => `<button class="btn btn-sm ${st.lang === L.code ? 'btn-primary' : ''}" data-lang="${L.code}">${L.label}</button>`).join('')}
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn-primary" id="lzStart" ${m ? '' : 'disabled'}>🚀 开始任务（识别内容 → 拆分 → 翻译）</button>
              <button class="btn" id="lzModels" title="查看你的方舟账号已开通哪些模型">🔎 检查我的模型权限</button>
              ${st.items.length ? `<button class="btn" id="lzRegen" title="重新识别">↻ 重新识别</button>` : ''}
              ${st.items.length ? `<button class="btn btn-primary" id="lzGenAI" title="AI 抹除文字/Logo 后按样式写译文（复杂背景更自然，需方舟 Key）">✨ AI 智能生成</button>` : ''}
              ${st.items.length ? `<button class="btn" id="lzGen" title="本地快速修补（无 Key 可用，纯色背景效果好）">⚡ 快速生成</button>` : ''}
            </div>
            ${API.getKey() ? '' : '<p style="font-size:11.5px;color:var(--warn,#f59e0b);margin-top:8px">⚠️ 识别需要 AI：请在「连接设置」配置方舟 API Key 后使用；如已配置仍失败，点「🔎 检查我的模型权限」看是否开通视觉模型</p>'}
          </div>

          ${st.items.length ? `
          <div class="card">
            <div class="card-title"><span class="ico">📝</span>识别文字与译文（${st.items.length} 处，可编辑）</div>
            ${st.items.map((it, i) => `
              <div style="border:1px solid var(--border-light);border-radius:8px;padding:8px;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer;color:var(--text-2)"><input type="checkbox" data-rmv="${it.id}" ${it.rmv !== false ? 'checked' : ''} style="accent-color:var(--primary-2)"> ${(it.translated && it.rmv !== false) ? '去除并替换' : (it.rmv === false ? '保留不动' : '去除不替换')}</label>
                  <span style="font-size:11px;color:var(--text-3);margin-left:auto">#${i + 1} · 位置(${(it.x * 100).toFixed(0)}%,${(it.y * 100).toFixed(0)}%)</span>
                </div>
                <input class="input" data-edit="text" data-id="${it.id}" value="${UI.escapeHtml(it.text)}" placeholder="原文" style="width:100%;margin-bottom:4px;font-size:12px">
                <div style="display:flex;gap:6px;align-items:center">
                  <input class="input" data-edit="translated" data-id="${it.id}" value="${UI.escapeHtml(it.translated)}" placeholder="${UI.escapeHtml(TARGET_LANGS.find((L) => L.code === st.lang)?.label || '')}译文（留空=仅去除）" style="flex:1;font-size:12.5px">
                  <button class="btn-icon lz-del" data-id="${it.id}">✕</button>
                </div>
              </div>`).join('')}
          </div>
          <p style="font-size:11px;color:var(--text-3);margin-top:6px">✅ 默认全部「去除并替换」；想保留品牌 Logo/某处文字，取消该项勾选即可。AI 智能生成会把勾选项抹干净（复杂背景自然融合）后写入译文。</p>` : ''}
        </div>

        <div class="card" style="position:sticky;top:0">
          <div class="card-title"><span class="ico">👁️</span>识别预览${m ? `（${m.kind === 'video' ? '视频中间帧' : '原图'}）` : ''}</div>
          <div style="display:flex;justify-content:center;background:var(--bg-2,#111);border-radius:10px;padding:14px;overflow:auto">
            <div style="position:relative;width:min(100%,360px)" id="lzPreviewWrap">
              ${m ? `<img id="lzPrev" src="${m.kind === 'video' ? (st.frameDataUrl || m.source) : m.source}" style="width:100%;display:block;border-radius:6px">` : '<p style="color:#555;font-size:13px;padding:40px 0;text-align:center">上传后显示预览</p>'}
            </div>
          </div>
          <p style="font-size:11px;color:var(--text-3);margin-top:8px">💡 绿框为识别到的文字区域（只读预览）；可回到列表逐条修改译文。<br>输出文件格式与原上传一致：视频→视频(mp4)，图片→图片。</p>
        </div>
      </div>`;
    bindEvents(el);
    overlayBoxes(el);
  }

  /** 在预览图上画识别框（只读） */
  function overlayBoxes(el) {
    const img = el.querySelector('#lzPrev');
    const wrap = el.querySelector('#lzPreviewWrap');
    if (!img || !wrap || !st.items.length) return;
    if (!img.complete) { img.onload = () => overlayBoxes(el); return; }
    const rw = img.getBoundingClientRect();
    const iw = img.naturalWidth || rw.width, ih = img.naturalHeight || rw.height;
    const scale = rw.width / iw;
    for (const it of st.items) {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;border:2px solid #22c55e;pointer-events:none;z-index:3;left:${it.x * rw.width}px;top:${it.y * rw.height}px;width:${it.w * rw.width}px;height:${it.h * rw.height}px;`;
      wrap.appendChild(d);
    }
  }

  function bindEvents(el) {
    const file = el.querySelector('#lzFile');
    const drop = el.querySelector('#lzDrop');
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files?.[0]; if (f) await setMedia(f); });
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) await setMedia(f); file.value = ''; });
    el.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { st.lang = b.dataset.lang; save(); render(el); }));
    el.querySelector('#lzStart').addEventListener('click', () => analyzeAndTranslate());
    el.querySelector('#lzModels')?.addEventListener('click', () => UI.showModelsModal());
    el.querySelector('#lzRegen')?.addEventListener('click', () => { st.items = []; save(); render(el); setTimeout(() => analyzeAndTranslate(), 300); });
    el.querySelector('#lzRemove')?.addEventListener('click', () => { st.media = null; st.items = []; st.frameDataUrl = null; save(); render(el); });
    el.querySelector('#lzGen')?.addEventListener('click', () => {
      if (!st.media) return;
      if (st.media.kind === 'image') localizeImage();
      else localizeVideo();
    });
    el.querySelector('#lzGenAI')?.addEventListener('click', () => {
      if (!st.media) return;
      if (st.media.kind !== 'image') return UI.toast('AI 智能生成目前支持图片；视频请用「⚡ 快速生成」', 'warn', 5000);
      localizeImageAI();
    });
    el.querySelectorAll('[data-rmv]').forEach((cb) => cb.addEventListener('change', () => {
      const it = st.items.find((x) => x.id === cb.dataset.rmv);
      if (it) { it.rmv = cb.checked; save(); renderPreviewBoxes(el); }
    }));
    el.querySelectorAll('[data-edit]').forEach((inp) => inp.addEventListener('input', () => {
      const it = st.items.find((x) => x.id === inp.dataset.id);
      if (it) it[inp.dataset.edit] = inp.value;
      save();
    }));
    el.querySelectorAll('.lz-del').forEach((b) => b.addEventListener('click', () => {
      st.items = st.items.filter((x) => x.id !== b.dataset.id);
      save(); render(el);
    }));
    // 预览区文字框随窗口变化
    window.addEventListener('resize', () => {
      const cel = document.querySelector('#content');
      if (cel && document.querySelector('#lzPrev')) { renderPreviewBoxes(cel); }
    });
  }

  function renderPreviewBoxes(el) {
    const wrap = el.querySelector('#lzPreviewWrap');
    if (!wrap) return;
    wrap.querySelectorAll('div.lzbox').forEach((d) => d.remove());
    overlayBoxes(el);
  }

  async function setMedia(file) {
    if (!file) return;
    const m = await readFileMeta(file).catch((e) => { UI.toast(e.message, 'err'); return null; });
    if (!m) return;
    if (m.kind === 'image' && file.size > 20 * 1024 * 1024) return UI.toast('图片超过 20MB', 'warn');
    st.media = { kind: m.kind, file, source: m.url, name: file.name, type: file.type, vw: m.w, vh: m.h, duration: m.duration || 0 };
    st.items = []; st.frameDataUrl = null;
    save(); render(document.querySelector('#content'));
    UI.toast(`已载入 ${m.kind === 'video' ? '视频' : '图片'} ✅ 点击「开始任务」识别文字`, 'ok', 4000);
  }

  function renderDone(el) {
    const r = result;
    const sizeKB = Math.round(r.url.length / 1024);
    el.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto">
        <div class="card-title"><span class="ico">🎉</span>本地化完成</div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:12px">📄 输出：<b>${UI.escapeHtml(r.name)}</b> · ${sizeKB} KB（格式与上传一致：${r.kind === 'video' ? '视频 mp4' : '图片'}）</p>
        ${r.kind === 'image' ? `<img src="${r.url}" style="max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--border-light);margin-bottom:12px">` : `<video src="${r.url}" controls style="max-width:100%;max-height:420px;border-radius:10px;border:1px solid var(--border-light);margin-bottom:12px"></video>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="lzDownload">⬇ 下载</button>
          <button class="btn btn-ghost" id="lzBack">← 返回编辑</button>
        </div>
      </div>`;
    el.querySelector('#lzDownload').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = r.url; a.download = r.name; a.click();
      try { Store.add({ type: r.kind === 'video' ? 'video' : 'image', kind: 'localized', title: `本地化 ${r.name}`, url: r.url }); } catch { /* ignore */ }
      UI.toast('已开始下载', 'ok');
    });
    el.querySelector('#lzBack').addEventListener('click', () => { mode = 'config'; render(el); });
  }

  /* ---------- 持久化 ---------- */
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        lang: st.lang, items: st.items,
        media: st.media ? { kind: st.media.kind, name: st.media.name, type: st.media.type, vw: st.media.vw, vh: st.media.vh, duration: st.media.duration } : null,
      }));
    } catch { /* ignore */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (s.lang) st.lang = s.lang;
      if (Array.isArray(s.items)) st.items = s.items;
      // 刷新后 media 的 blob URL 失效（无 source）→ 清空提示重传；同会话内存 source 有效则保留
      if (!st.media || !st.media.source) st.media = null;
    } catch { /* ignore */ }
  }
  // 图片源 URL 无法持久化（blob），刷新后需重传——静默保持 media 元信息但无 source 时由 setMedia 重建
  window.addEventListener('beforeunload', () => { /* 由 save 处理 */ });

  return { render, __test: { patchRegion, drawTranslation, langFont, clampNum } };
})();
