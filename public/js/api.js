/* ============================================================
 * api.js — 后端 API 封装（多服务商：火山方舟 / Bilibili llmapi）
 * ============================================================ */
window.API = (() => {
  const PROVIDER_STORAGE = 'materall_api_provider';   // 'ark' | 'bili'
  const KEY_ARK = 'materall_ark_api_key';
  const KEY_BILI = 'materall_bili_api_key';
  const MODEL_ARK = 'materall_chat_model';
  const MODEL_BILI = 'materall_bili_chat_model';
  const ACCESS_STORE = 'materall_access_code'; // 服务端访问码（部署者开启 ACCESS_CODE 时必填）

  /** 服务端状态（health 探测结果）：managed=共享 Key 托管，accessRequired=需访问码 */
  let srv = { managed: { ark: false, bili: false }, accessRequired: false };

  function getAccessCode() { return localStorage.getItem(ACCESS_STORE) || ''; }
  function setAccessCode(code) {
    if (code) localStorage.setItem(ACCESS_STORE, code.trim());
    else localStorage.removeItem(ACCESS_STORE);
  }
  /** 当前识别/对话服务商是否由服务端托管 Key（免填） */
  function isManaged() {
    return getProvider() === 'bili' ? !!srv.managed.bili : !!srv.managed.ark;
  }
  /** 方舟（生图/生视频/擦除）是否由服务端托管 Key */
  function isArkManaged() { return !!srv.managed.ark; }
  /** 服务端是否开启访问码 */
  function accessRequired() { return !!srv.accessRequired; }
  /** 服务端托管状态原始值（供 UI 展示） */
  function getManaged() { return { ark: !!srv.managed.ark, bili: !!srv.managed.bili }; }

  function getProvider() { return localStorage.getItem(PROVIDER_STORAGE) || 'ark'; }
  function setProvider(p) { localStorage.setItem(PROVIDER_STORAGE, p === 'bili' ? 'bili' : 'ark'); }

  /** 当前对话模型（按服务商分别存储） */
  function getChatModel() {
    return localStorage.getItem(getProvider() === 'bili' ? MODEL_BILI : MODEL_ARK) ||
      (getProvider() === 'bili' ? '' : 'doubao-seed-evolving');
  }
  function setChatModel(m) {
    const k = getProvider() === 'bili' ? MODEL_BILI : MODEL_ARK;
    if (m) localStorage.setItem(k, m.trim());
    else localStorage.removeItem(k);
  }

  function getKey() {
    return localStorage.getItem(getProvider() === 'bili' ? KEY_BILI : KEY_ARK) || '';
  }
  function setKey(k) {
    const store = getProvider() === 'bili' ? KEY_BILI : KEY_ARK;
    if (k) localStorage.setItem(store, k.trim());
    else localStorage.removeItem(store);
  }
  function hasKey() {
    if (getKey()) return true;
    // 服务端托管共享 Key 时视为可用
    return isManaged();
  }
  // 方舟 Key（生图/生视频/AI 抹除固定走方舟；识别/对话切到方舟时也是它，双轨并存不冲突）
  function getArkKey() { return localStorage.getItem(KEY_ARK) || ''; }
  function setArkKey(k) {
    if (k) localStorage.setItem(KEY_ARK, k.trim());
    else localStorage.removeItem(KEY_ARK);
  }
  function hasArkKey() { return !!getArkKey() || isArkManaged(); }

  // 对话模型降级候选（2026-08 方舟当前有效 ID；老一代 doubao-pro-32k / 1.5 系列已退役）
  // 按推荐顺序：最新旗舰 Evolving → 2.1 → 2.0 → 1.6
  const MODEL_FALLBACKS = [
    'doubao-seed-evolving',
    'doubao-seed-2-1-pro',
    'doubao-seed-2-1-turbo',
    'doubao-seed-2-0-pro-260215',
    'doubao-seed-2-0-lite-260215',
    'doubao-seed-2-0-mini-260215',
    'doubao-seed-1-6-250615',
    'doubao-seed-1-6-flash-250615',
    'doubao-seed-1-6-vision-250615',
  ];

  function isModelError(msg) {
    // 模型不可用类错误：自动换下一个候选模型重试
    return /does not exist|do not have access|not supported|not found|model or endpoint|not valid|invalid.*model|model.*not valid|unsupported model|no such model|access.*denied|no cluster|cluster found|不存在或您无权访问|无权访问|vision not support|not support.*image|does not support image|system error|algo\.invalid|internal error/i.test(msg || '');
  }

  /** Bilibili llmapi 网关已实测可用的视觉模型（deepseek/doubao/gemini/kimi/glm/step；gpt-5.x/grok no cluster、claude 无权） */
  const BILI_VISION_OK = [
    'deepseek-v4-flash-vision',
    'Doubao-Seed-2.1-pro-260628',
    'Doubao-Seed-2.1-turbo-260628',
    'gemini-3.0-flash',
    'gemini-3.1-pro',
    'kimi-k2.5',
    'glm-5.3-flash',
    'step-3.7-flash',
  ];
  const BILI_VISION_OK_STORE = 'materall_bili_vision_ok'; // 最近一次成功模型（加速优先）

  /** 是否静态部署模式（无后端）：启动时探测 /api/health 失败即判定 */
  let staticMode = null; // null=未探测 true=静态 false=有后端
  async function probeHealth() {
    const r = await fetch('/api/health', { method: 'GET' });
    const okJson = r.ok && r.headers.get('content-type')?.includes('json');
    if (okJson) {
      try {
        const j = await r.json();
        if (j && j.managed) srv = { managed: { ark: !!j.managed.ark, bili: !!j.managed.bili }, accessRequired: !!j.managed.accessRequired };
        return j;
      } catch { /* ignore */ }
    }
    return null;
  }
  async function detectStaticMode() {
    if (staticMode !== null) return staticMode;
    try {
      const j = await probeHealth();
      staticMode = !j;
    } catch {
      staticMode = true;
    }
    return staticMode;
  }
  function isStaticMode() { return staticMode === true; }

  async function request(path, options = {}) {
    // 静态模式：AI 请求直接给出明确指引（本地功能如剪辑/包框合成不受影响）
    if (await detectStaticMode()) {
      throw new Error('当前为在线分享版（无本地服务）：AI 生图/生视频/创意助手需要服务端。\n如需完整 AI 功能，请在部署者电脑运行 node server.js 后通过其局域网链接访问');
    }
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    // 双轨 Key：生图/生视频/局部重绘固定走火山方舟（X-ARK-Key）；对话/识别/模型列表走当前服务商 Key（X-API-Key）
    // 本地未填 Key 时不带 Key 头 —— 服务端若配置了共享托管 Key（ARK_API_KEY/BILI_API_KEY）会自动兜底
    const isArkEndpoint = /^\/(api\/(image|video|proxy)|api\/image\/edit)/.test(path);
    if (isArkEndpoint) {
      const ark = getArkKey();
      if (ark) headers['X-ARK-Key'] = ark;
    } else {
      const key = getKey();
      if (key) headers['X-API-Key'] = key;
    }
    // 服务端开启访问码时携带（部署者授权后才可用）
    const ac = getAccessCode();
    if (ac) headers['X-Access-Code'] = ac;
    let resp;
    try {
      // AI 对话/模型探测加 100s 超时保护，避免"翻译中"无限挂起
      const needTimeout = !options.signal && (/^\/api\/chat/.test(path) || /^\/api\/models/.test(path));
      if (needTimeout) {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 100000);
        try {
          resp = await fetch(path, { ...options, headers, signal: ac.signal });
        } finally { clearTimeout(tm); }
      } else {
        resp = await fetch(path, { ...options, headers });
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('AI 请求超时（100 秒无响应）。可能是所选模型/网关繁忙，请重试或更换模型/服务商');
      }
      const loc = window.location;
      const onFile = loc.protocol === 'file:';
      const isPreview = loc.port && loc.port !== '3000' && /^(127\.|localhost)/i.test(loc.hostname);
      if (onFile) {
        throw new Error('当前是通过文件方式直接打开页面（file://），AI 服务不可用。\n请先在终端运行 node server.js 启动服务，然后访问 http://localhost:3000');
      }
      if (isPreview) {
        throw new Error(`当前是静态预览环境（端口 ${loc.port}），无法调用 AI 服务。\n请访问完整平台：http://localhost:3000（需先运行 node server.js 启动服务）`);
      }
      throw new Error('无法连接服务，请确认服务已启动（在项目目录运行 node server.js）。若你是通过局域网访问，请联系服务提供者确认服务在线');
    }
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok) {
      const msg = data?.error?.message || data?.error?.code || `请求失败 (HTTP ${resp.status})`;
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** 健康检查：返回服务与 API Key 状态（同时刷新托管/访问码状态） */
  async function health() {
    if (await detectStaticMode()) return { ok: false, static: true };
    return probeHealth();
  }

  /** 查询账号下已开通的模型列表（用于自动探测可用对话模型；provider 决定请求哪个网关） */
  async function listModels() {
    const p = getProvider();
    return request('/api/models?provider=' + p, { method: 'GET' });
  }
  let chatProbe = { at: 0, ids: [] };
  /** 探测账号已开通的文本对话模型（/api/models，5 分钟缓存；失败静默返回 []） */
  async function probeChatIds() {
    if (Date.now() - chatProbe.at < 300000) return chatProbe.ids;
    try {
      const r = await listModels();
      const p = getProvider();
      let ids;
      if (p === 'bili') {
        // Bilibili llmapi：模型名无 vision 标记，排除明显的非对话模型，全量作候选
        ids = (r.ids || []).filter((id) => !/embedding|rerank|whisper|tts|image|video|dall-e|flux|sdxl/i.test(id));
      } else {
        ids = (r.ids || []).filter((id) => !/vision|vl-|image|video|seedance|seedream/i.test(id));
      }
      chatProbe = { at: Date.now(), ids };
      return ids;
    } catch { chatProbe = { at: Date.now(), ids: [] }; return []; }
  }

  /** AI 对话（豆包 / Bilibili llmapi）—— 模型不可用时自动降级尝试候选模型，成功后自动保存 */
  async function chat({ model, messages, temperature = 0.8, max_tokens } = {}) {
    const p = getProvider();
    const probed = await probeChatIds();
    // Bilibili：候选 = 主模型 + 已开通列表；方舟：主模型 + 已开通 + 固定兜底
    const queue = [...new Set([model || getChatModel(), ...probed].filter(Boolean))].concat(p === 'ark' ? MODEL_FALLBACKS : []);
    if (!queue.length) queue.push(model || 'gpt-5.3');
    const tried = new Set();
    let lastErr = null;
    for (const m of queue) {
      if (tried.has(m)) continue;
      tried.add(m);
      try {
        // Seed 2.0 系列为深度思考模型：minimal = 不深度思考，更快更省
        const reasoning_effort = /seed-2-0/.test(m) ? 'minimal' : undefined;
        const data = await request('/api/chat', {
          method: 'POST',
          body: JSON.stringify({ model: m, messages, temperature, max_tokens, reasoning_effort, provider: p }),
        });
        // 若实际使用模型与配置不同（发生了降级），自动保存为全局默认
        if (m !== getChatModel()) {
          setChatModel(m);
          try { window.UI && window.UI.toast(`已自动切换对话模型：${m}`, 'ok', 4000); } catch { /* ignore */ }
        }
        return data.content || '';
      } catch (e) {
        lastErr = e;
        if (!isModelError(e.message || '')) {
          throw e; // 非模型问题（鉴权/网络/配额等）不降级，直接抛出
        }
      }
    }
    throw lastErr;
  }

  /** 检测指定模型是否可用——绕过降级链，直接调用该模型，返回 {ok, reply?, message?, model} */
  async function chatTest(model) {
    const p = getProvider();
    try {
      const reply = await request('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '请只回复两个字：正常' }],
          temperature: 0.1,
          max_tokens: 16,
          reasoning_effort: /seed-2-0/.test(model || '') ? 'minimal' : undefined,
          provider: p,
        }),
      });
      return { ok: true, reply: reply.content || '', model };
    } catch (e) {
      return { ok: false, message: e.message || String(e), model };
    }
  }

  // 视觉理解模型候选（自动探测账号已开通 vision 模型优先，其次固定候选降级）
  const VISION_FALLBACKS = [
    'doubao-seed-1-6-vision-250815',
    'doubao-seed-1-6-vision-250615',
    'doubao-1-5-vision-pro-32k-250115',
    'doubao-1-5-vision-pro-256k-250115',
    'doubao-vision-pro-32k-241028',
    'doubao-vision-lite-32k-250115',
  ];
  let visionProbe = { at: 0, ids: [] };
  /** 探测账号下已开通的视觉模型（经 /api/models，5 分钟缓存；失败静默返回 []） */
  async function probeVisionIds() {
    if (Date.now() - visionProbe.at < 300000) return visionProbe.ids;
    try {
      const r = await listModels();
      const p = getProvider();
      let ids;
      if (p === 'bili') {
        // Bilibili：网关无 vision 标记且多数模型名不可靠；直接以实测可用表为准（避免试 no-cluster 的 gpt-5.x 浪费时间）
        const nameHit = (r.ids || []).filter((id) => /vision|vl/i.test(id) && !/embedding/i.test(id));
        ids = [...BILI_VISION_OK, ...nameHit];
      } else {
        ids = (r.ids || []).filter((id) => /vision|vl-2|vl-1|seed-1-6-vision|seed-1-5-vision/i.test(id));
      }
      visionProbe = { at: Date.now(), ids };
      return ids;
    } catch { visionProbe = { at: Date.now(), ids: [] }; return []; }
  }
  /** 视觉分析（多模态）：输入文本 + 一张或多张图片 dataURL，返回模型回复 {content, model}；非模型类错误直接抛出 */
  async function chatVision(text, imageDataURLs, { model, temperature = 0.7, max_tokens = 600 } = {}) {
    const p = getProvider();
    const imgs = Array.isArray(imageDataURLs) ? imageDataURLs : [imageDataURLs];
    const probed = await probeVisionIds();
    const lastOk = localStorage.getItem(BILI_VISION_OK_STORE);
    // 队列：主模型 → 上次成功 → bili 实测可用视觉表 / 已开通候选 → (方舟)固定兜底
    let queue;
    if (p === 'bili') {
      queue = [...new Set([model || getChatModel(), lastOk, ...BILI_VISION_OK, ...probed].filter(Boolean))];
    } else {
      queue = [...new Set([model || getChatModel(), ...probed].filter(Boolean))].concat(VISION_FALLBACKS);
    }
    const tried = new Set();
    let lastErr = null;
    let triedModel = null;
    for (const m of queue) {
      if (tried.has(m)) continue;
      tried.add(m);
      try {
        const data = await request('/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            model: m,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text },
                ...imgs.filter(Boolean).map((u) => ({ type: 'image_url', image_url: { url: u } })),
              ],
            }],
            temperature,
            max_tokens,
            provider: p,
          }),
        });
        // Bilibili：记住本次成功的视觉模型，下次优先
        if (p === 'bili') { try { localStorage.setItem(BILI_VISION_OK_STORE, m); } catch { /* ignore */ } }
        return { content: data.content || '', model: m };
      } catch (e) {
        lastErr = e;
        triedModel = m;
        if (!isModelError(e.message || '')) throw e;   // 非模型问题（鉴权/网络/配额/图过大等）不换模型
      }
    }
    if (lastErr && tried.size > 1) {
      // 全部模型都试过仍失败：附上已尝试模型便于诊断
      lastErr.message = `${lastErr.message}（已自动尝试 ${tried.size} 个视觉模型：${[...tried].slice(0, 6).join('、')}…）`;
    }
    throw lastErr;
  }

  /** AI 生图（doubao-seedream） */
  async function genImage({ model, prompt, negative_prompt, size, count, images = [], watermark = false, seed } = {}) {
    return request('/api/image', {
      method: 'POST',
      body: JSON.stringify({ model, prompt, negative_prompt, size, count, images, watermark, seed }),
    });
  }

  /** 创建视频任务（doubao-seedance） */
  async function createVideo({ model, text, imageUrl, ratio, duration, resolution, generateAudio, watermark, seed, cameraFixed } = {}) {
    return request('/api/video', {
      method: 'POST',
      body: JSON.stringify({ model, text, imageUrl, ratio, duration, resolution, generateAudio, watermark, seed, cameraFixed }),
    });
  }

  /** 查询视频任务 */
  async function videoStatus(id) {
    return request(`/api/video/${id}`, { method: 'GET' });
  }

  /** 通过本地代理拉取远程素材（解决 CORS） */
  function proxyUrl(url) {
    if (!url) return url;
    if (/^data:/i.test(url) || /^blob:/i.test(url) || url.startsWith('/')) return url;
    if (url.startsWith('http')) {
      // 访问码用 query 传递：<video>/<img>/<a download> 等媒体元素无法携带请求头，代理接口据此鉴权
      const ac = getAccessCode();
      return `/api/proxy?url=${encodeURIComponent(url)}${ac ? `&ac=${encodeURIComponent(ac)}` : ''}`;
    }
    return url;
  }

  /** 通过代理下载为 Blob（剪辑素材用） */
  async function fetchBlob(url) {
    const p = proxyUrl(url);
    const resp = await fetch(p);
    if (!resp.ok) throw new Error(`素材下载失败 (HTTP ${resp.status})`);
    return resp.blob();
  }

  return { getKey, setKey, hasKey, getArkKey, setArkKey, hasArkKey, getProvider, setProvider, getChatModel, setChatModel, request, health, listModels, chat, chatTest, chatVision, genImage, createVideo, videoStatus, proxyUrl, fetchBlob, detectStaticMode, isStaticMode, isManaged, isArkManaged, accessRequired, getAccessCode, setAccessCode, getManaged };
})();
