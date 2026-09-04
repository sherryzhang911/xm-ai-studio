/**
 * XM AI Studio - 后端服务
 * 职责：
 *  1. 托管前端静态资源
 *  2. 代理火山方舟 API（生图 / 生视频 / 对话 / 任务查询），避免前端暴露密钥与 CORS 问题
 *  3. 提供文件下载代理，供前端 ffmpeg 剪辑模块拉取素材
 *
 * 鉴权策略：①请求头 X-ARK-Key / X-API-Key（访问者各自填写）
 *          ②服务端托管 Key（环境变量 ARK_API_KEY=方舟、BILI_API_KEY=Bilibili llmapi）
 *            部署者配置共享 Key 后访问者免填且看不到明文
 *          ③可选访问码 ACCESS_CODE：开启后所有 /api 请求需带 X-Access-Code 头（除 health）
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const BILI_BASE = 'https://llmapi.bilibili.co/v1'; // Bilibili llmapi 网关（OpenAI 兼容）
function baseOf(provider) { return provider === 'bili' ? BILI_BASE : ARK_BASE; }

// 跨域隔离：ffmpeg.wasm 多线程需要 SharedArrayBuffer，必须 COOP/COEP 头
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ---------------- 访问码（可选）：部署者可开启，仅授权者可调用 AI ----------------
 * 开启方式：环境变量 ACCESS_CODE=你的口令
 * 前端在 localStorage 保存口令后，所有 /api 请求自动带 X-Access-Code 头
 */
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
app.use('/api', (req, res, next) => {
  if (!ACCESS_CODE) return next();
  if (req.path === '/health') return next(); // health 放行，前端用它探测状态
  if ((req.headers['x-access-code'] || '').trim() === ACCESS_CODE) return next();
  return res.status(403).json({ error: { code: 'ACCESS_DENIED', message: '需要访问码：请联系部署者获取，在页面右上角「连接设置」中输入' } });
});

/* ---------------- 工具 ---------------- */

function resolveKey(req, providerHint) {
  // 三轨：①X-ARK-Key（方舟）②X-API-Key（当前服务商）③服务端托管 Key（按服务商取环境变量）
  const arkKey = (req.headers['x-ark-key'] || '').trim();
  if (arkKey) return arkKey;
  const headerKey = (req.headers['x-api-key'] || '').trim();
  if (headerKey) return headerKey;
  if (providerHint === 'bili') return (process.env.BILI_API_KEY || '').trim();
  return (process.env.ARK_API_KEY || '').trim();
}

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** 调用所选服务商 API（OpenAI 兼容），返回解析后的 JSON */
async function arkFetch(req, apiPath, body, extraHeaders = {}) {
  const key = resolveKey(req, req.body && req.body.provider);
  const base = baseOf(req.body && req.body.provider);
  if (!key) {
    const err = new Error('未配置所选服务商的 API Key');
    err.status = 401;
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600000); // 10 分钟超时
  try {
    const resp = await fetch(base + apiPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!resp.ok) {
      const msg = (data && (data.error && (data.error.message || data.message))) || data?.message || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.code = data?.error?.code || 'ARK_ERROR';
      err.detail = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- API 端点 ---------------- */

// 健康检查 / 配置状态
app.get('/api/health', (req, res) => {
  const hasArk = !!(process.env.ARK_API_KEY || '').trim();
  const hasBili = !!(process.env.BILI_API_KEY || '').trim();
  res.json({
    ok: true,
    name: 'XM AI Studio',
    version: '1.0.0',
    managed: { ark: hasArk, bili: hasBili, accessRequired: !!ACCESS_CODE },
    ark: {
      base: ARK_BASE,
      envKeyConfigured: hasArk,
      keyProvided: !!(req.headers['x-api-key'] || '').trim(),
    },
    bili: {
      base: BILI_BASE,
      envKeyConfigured: hasBili,
    },
  });
});

// 查询账号下已开通的模型列表（OpenAI 兼容 /models，用于自动探测可用对话模型；?provider=ark|bili）
app.get('/api/models', async (req, res) => {
  try {
    const key = resolveKey(req, req.query.provider);
    const base = baseOf(req.query.provider);
    if (!key) return fail(res, 401, 'MISSING_API_KEY', '未配置所选服务商的 API Key');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(`${base}/models`, {
        headers: { 'Authorization': `Bearer ${key}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept': 'application/json' },
        signal: controller.signal,
      });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!resp.ok) {
        // /models 可能不被部分账号支持，给出明确提示（附 Bearer 前缀便于诊断是否发错 Key）
        const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
        return fail(res, resp.status, 'ARK_ERROR', `${msg}（请求所用 Key 前缀: ${key.slice(0, 10)}${key.length > 10 ? '…' : ''}）`);
      }
      const ids = (data?.data || []).map((m) => m.id).filter(Boolean);
      res.json({ ids, raw: data });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    fail(res, 500, 'MODELS_ERROR', e.message);
  }
});

// AI 对话（豆包大模型）—— 用于创意助手、脚本拆解、提示词优化
app.post('/api/chat', async (req, res) => {
  try {
    const { model = 'doubao-seed-evolving', messages = [], temperature = 0.8, max_tokens, reasoning_effort } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return fail(res, 400, 'BAD_REQUEST', 'messages 不能为空');
    }
    const body = { model, messages, temperature };
    if (max_tokens) body.max_tokens = max_tokens;
    // 深度思考模型（seed-2-0 系列）支持 reasoning_effort，minimal=不思考（更快更省）
    if (reasoning_effort) body.reasoning_effort = reasoning_effort;
    let data;
    try {
      data = await arkFetch(req, '/chat/completions', body);
    } catch (e) {
      // 参数容错：个别模型不支持 temperature / reasoning_effort / max_tokens 时，逐级移除重试
      const msg = e.message || '';
      const isParamErr = /not valid|not supported|invalid|parameter/i.test(msg);
      if (isParamErr) {
        if (body.reasoning_effort && /reasoning/i.test(msg)) { delete body.reasoning_effort; data = await arkFetch(req, '/chat/completions', body); }
        else if (body.temperature !== undefined && /temperature/i.test(msg)) { delete body.temperature; data = await arkFetch(req, '/chat/completions', body); }
        else if (body.max_tokens !== undefined && /max_tokens/i.test(msg)) { delete body.max_tokens; data = await arkFetch(req, '/chat/completions', body); }
        else throw e;
      } else {
        throw e;
      }
    }
    // 深度思考模型的回复在 content 中；若为空则回退到 reasoning_content
    const msg = data?.choices?.[0]?.message || {};
    const content = msg.content ?? msg.reasoning_content ?? '';
    res.json({ content, raw: data });
  } catch (e) {
    fail(res, e.status || 500, e.code || 'CHAT_ERROR', e.message);
  }
});

// AI 生图（doubao-seedream 系列）
// 各模型支持的输出格式不同：Seedream 4.0/4.5 仅支持 jpeg；5.0 支持 png/jpeg。
// 为避免 "output_format is not supported" 报错，默认不传该参数（使用模型默认输出），
// 仅当显式传入且模型支持时才透传。
const SEEDREAM_OUTPUT_FORMATS = {
  'doubao-seedream-5-0-260128': ['png', 'jpeg'],
  'doubao-seedream-5-0-lite-260128': ['png', 'jpeg'],
  'doubao-seedream-4-5-251128': ['jpeg'],
  'doubao-seedream-4-0-250828': ['jpeg'],
};
app.post('/api/image', async (req, res) => {
  try {
    const {
      model = 'doubao-seedream-4-0-250828',
      prompt = '',
      negative_prompt,
      size = '1K',
      count = 1,
      images = [],          // 图生图参考图 URL 列表（或 data URL）
      output_format,        // 可选：显式指定输出格式
      watermark = false,
      seed,
    } = req.body;
    if (!prompt) return fail(res, 400, 'BAD_REQUEST', '提示词不能为空');

    // size 参数规范化：API 仅接受 '宽x高'（如 1024x1792）或 2k/3k/4k；
    // 不支持的取值（如 1K / 1k / 大写 2K）自动映射为 2k，避免 400 报错
    let finalSize = String(size || '2k').trim().toLowerCase();
    if (!/^\d{2,5}x\d{2,5}$/.test(finalSize) && !['2k', '3k', '4k'].includes(finalSize)) {
      finalSize = '2k';
    }

    const body = {
      model,
      prompt,
      size: finalSize,
      n: Math.min(Math.max(1, count), 4),
      response_format: 'url',
      watermark,
    };
    if (output_format) {
      const supported = SEEDREAM_OUTPUT_FORMATS[model] || ['png', 'jpeg'];
      if (supported.includes(output_format)) {
        body.output_format = output_format;
      }
      // 模型不支持时静默忽略，避免 400 报错
    }
    if (negative_prompt) body.negative_prompt = negative_prompt;
    if (seed !== undefined && seed !== null && seed !== '') body.seed = Number(seed);
    if (Array.isArray(images) && images.length > 0) {
      body.image = images.slice(0, 10).filter(Boolean);
    }
    const data = await arkFetch(req, '/images/generations', body);
    const items = (data?.data || []).map((it) => ({ url: it.url, b64: it.b64_json || null }));
    res.json({ items, usage: data?.usage || null });
  } catch (e) {
    fail(res, e.status || 500, e.code || 'IMAGE_ERROR', e.message);
  }
});

// Seedream 图像编辑（去除文字/Logo）：走 /images/generations + image 参考图 + prompt（4.0 编辑通道，edits 端点对 4.0 404 弃用）
app.post('/api/image/edit', async (req, res) => {
  try {
    const { image = '', prompt = '', model = 'doubao-seedream-4-0-250828', watermark = false } = req.body;
    if (!image || !prompt) return fail(res, 400, 'BAD_REQUEST', '缺少 image 或 prompt');
    const key = resolveKey(req);
    if (!key) return fail(res, 401, 'MISSING_API_KEY', '未配置所选服务商的 API Key（生图/局部重绘需火山方舟 Key）');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000);
    try {
      const body = { model, prompt, n: 1, response_format: 'url', watermark: !!watermark, image: [String(image)] };
      const resp = await fetch(`${ARK_BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!resp.ok) {
        const raw = data ? JSON.stringify(data) : text;
        const msg = (data?.error?.message) || raw || `HTTP ${resp.status}`;
        return fail(res, resp.status || 502, 'EDIT_ERROR', `方舟返回 ${resp.status}：${String(msg).slice(0, 400)}`);
      }
      const items = (data?.data || []).map((it) => ({ url: it.url, b64: it.b64_json || null }));
      res.json({ items, usage: data?.usage || null });
    } finally { clearTimeout(timer); }
  } catch (e) {
    fail(res, 502, 'EDIT_ERROR', '图像编辑调用异常：' + e.message);
  }
});

// 创建视频生成任务（doubao-seedance 系列）
app.post('/api/video', async (req, res) => {
  try {
    const {
      model = 'doubao-seedance-2-0-260128',
      text = '',
      imageUrl = null,           // 图生视频首帧 URL
      ratio,                     // 文生视频可用；图生视频请勿传（输出自动跟随首帧比例，传了不一致会报 not valid）
      duration = 5,
      resolution = '720p',
      generateAudio = true,
      watermark = true,
      seed,
      cameraFixed,
    } = req.body;
    if (!text) return fail(res, 400, 'BAD_REQUEST', '视频描述不能为空');
    const content = [{ type: 'text', text }];
    if (imageUrl) {
      content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
    }
    const body = {
      model,
      content,
      duration: Math.min(Math.max(3, duration), 30),
      resolution,
      watermark,
    };
    if (ratio) body.ratio = ratio;
    if (generateAudio !== undefined) body.generate_audio = !!generateAudio;
    if (seed !== undefined && seed !== null && seed !== '') body.seed = Number(seed);
    if (cameraFixed !== undefined && cameraFixed !== null && cameraFixed !== '') body.camera_fixed = !!cameraFixed;

    // 参数降级重试链：不同模型支持的参数不同（如 Seedance 2.5 t2v 不接受 duration，
    // 部分模型不支持 generate_audio / 1080p 等），遇到参数类错误时逐级移除后重试
    const attempts = [
      body,
      { ...body, duration: undefined, },
      { ...body, duration: undefined, resolution: undefined },
      { ...body, duration: undefined, resolution: undefined, generate_audio: undefined },
      { ...body, duration: undefined, resolution: undefined, generate_audio: undefined, watermark: undefined },
    ].map((b) => {
      const clean = {};
      Object.entries(b).forEach(([k, v]) => {
        if (v !== undefined && v !== null) clean[k] = v;
      });
      return clean;
    });

    let data = null;
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        data = await arkFetch(req, '/contents/generations/tasks', attempt);
        break;
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || '';
        const isParamError = /not valid|not supported|not allowed|invalid/i.test(msg) && !/api key|authentication|unauthorized|access/i.test(msg);
        if (!isParamError) break; // 非参数错误（如鉴权/配额）不重试
      }
    }
    if (!data) throw lastErr;
    res.json({ id: data?.id, status: data?.status || 'queued', data });
  } catch (e) {
    fail(res, e.status || 500, e.code || 'VIDEO_CREATE_ERROR', e.message);
  }
});

// 查询视频生成任务
app.get('/api/video/:id', async (req, res) => {
  try {
    const key = resolveKey(req);
    if (!key) return fail(res, 401, 'MISSING_API_KEY', '未配置火山方舟 API Key');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(`${ARK_BASE}/contents/generations/tasks/${req.params.id}`, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: controller.signal,
      });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!resp.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
        return fail(res, resp.status, 'ARK_ERROR', msg);
      }
      // 容错解析视频 URL：content 可能是数组（1.x/2.5）或对象（2.0 部分
      // 响应格式），也可能直接挂在 video_url 字段
      let content = data?.content;
      let videoUrl = null;
      if (Array.isArray(content)) {
        // 标准：type === 'video_url'；容错：任意带 video_url.url 的项；再容错：任意含 .url 字符串的项
        const item = content.find((c) => c && c.type === 'video_url')
          || content.find((c) => c && c.video_url && typeof c.video_url === 'object' && c.video_url.url)
          || content.find((c) => c && typeof c.url === 'string' && /^https?:\/\//.test(c.url));
        if (item) {
          videoUrl = item.video_url?.url || (typeof item.url === 'string' ? item.url : null);
        }
      } else if (content && typeof content === 'object') {
        // 对象格式：{ video_url: { url } } 或 { type:'video_url', video_url:{url} }
        videoUrl = content.video_url?.url
          || (Array.isArray(content.video_url) ? content.video_url[0]?.url : null)
          || (typeof content.video_url === 'string' ? content.video_url : null)
          || null;
      }
      if (!videoUrl) {
        // 兜底：从 data 根上找
        videoUrl = data?.video_url?.url || data?.video_url || null;
        if (typeof videoUrl === 'object' && videoUrl) videoUrl = videoUrl.url || null;
      }
      // succeeded 但没拿到 URL：序列化后正则兜底提取第一个 http mp4/视频链接
      if (!videoUrl && /succeeded|success/i.test(String(data?.status || ''))) {
        try {
          const raw = JSON.stringify(data);
          const m = raw.match(/https?:\/\/[a-z0-9.-]+\/[a-z0-9._~:/?#@!$&'()*+,;=%-]*\.(?:mp4|mov|webm)(?:\?[a-z0-9._~:/?#@!$&'()*+,;=%-]*)?/i);
          if (m) videoUrl = m[0].replace(/\\u0026/g, '&');
        } catch { /* ignore */ }
      }
      res.json({
        id: data?.id,
        status: data?.status,
        progress: data?.progress ?? null,
        videoUrl,
        content,
        data,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    fail(res, 500, 'VIDEO_QUERY_ERROR', e.message);
  }
});

// AI 配音 TTS 代理
// engine=google（免 Key，多语种 zh-CN/zh-TW/ko/ja/en/ru 等）；engine=elevenlabs（需前端传 xi-api-key + voice）
app.get('/api/tts', async (req, res) => {
  const { text = '', lang = 'ko', engine = 'google', voice = '' } = req.query;
  const key = req.headers['xi-api-key'] || '';
  if (!text) return fail(res, 400, 'BAD_REQUEST', '缺少文本');
  if (engine === 'elevenlabs') {
    if (!key) return fail(res, 400, 'BAD_REQUEST', 'ElevenLabs 需要 API Key');
    if (!voice) return fail(res, 400, 'BAD_REQUEST', 'ElevenLabs 需要 voice id');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        });
        if (!resp.ok) return fail(res, 502, 'TTS_ERROR', `ElevenLabs HTTP ${resp.status}`);
        res.setHeader('Content-Type', 'audio/mpeg');
        const buf = Buffer.from(await resp.arrayBuffer());
        res.send(buf);
      } finally { clearTimeout(timer); }
    } catch (e) { fail(res, 502, 'TTS_ERROR', e.message); }
    return;
  }
  // 微软 Edge TTS（免 Key 在线高质量合成，多语种神经网络音色）
  if (engine === 'edge') {
    const crypto = require('crypto');
    const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    const EDGE_VER = '1-143.0.3650.75';
    const VOICES = {
      'ko-KR': 'ko-KR-SunHiNeural', 'en-US': 'en-US-AriaNeural', 'ja-JP': 'ja-JP-NanamiNeural',
      'zh-TW': 'zh-TW-HsiaoChenNeural', 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'ru-RU': 'ru-RU-SvetlanaNeural',
    };
    try {
      const sel = voice || VOICES[lang] || 'zh-CN-XiaoxiaoNeural';
      const gec = (() => { let t = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n; t -= t % 300n; t *= 10000000n; return crypto.createHash('sha256').update(t.toString() + EDGE_TOKEN).digest('hex').toUpperCase(); })();
      const P2 = (n) => String(n).padStart(2, '0');
      const dateStr = () => { const d = new Date(); const D = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return D[d.getUTCDay()] + ' ' + M[d.getUTCMonth()] + ' ' + P2(d.getUTCDate()) + ' ' + d.getUTCFullYear() + ' ' + P2(d.getUTCHours()) + ':' + P2(d.getUTCMinutes()) + ':' + P2(d.getUTCSeconds()) + ' GMT+0000 (Coordinated Universal Time)'; };
      const escX = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + EDGE_TOKEN + '&ConnectionId=' + crypto.randomUUID().replace(/-/g, '') + '&Sec-MS-GEC=' + gec + '&Sec-MS-GEC-Version=' + EDGE_VER;
      const ws = new WebSocket(url, { headers: { 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0', 'Cookie': 'muid=' + crypto.randomUUID().replace(/-/g, '').toUpperCase() + ';' } });
      const chunks = [];
      const tmr = setTimeout(() => { try { ws.close(); } catch {} }, 22000);
      let settled = false;
      ws.onopen = () => {
        try {
          ws.send('X-Timestamp:' + dateStr() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
          ws.send('X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + dateStr() + 'Z\r\nPath:ssml\r\n\r\n<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'' + (lang || 'ko-KR') + '\'><voice name=\'' + sel + '\'><prosody pitch=\'+0Hz\' rate=\'+0%\' volume=\'+0%\'>' + escX(text.slice(0, 1500)) + '</prosody></voice></speak>');
        } catch (e) { try { ws.close(); } catch {} fail(res, 502, 'TTS_ERROR', e.message); }
      };
      ws.onmessage = async (ev) => {
        if (typeof ev.data === 'string') return;
        try {
          const buf = ev.data instanceof ArrayBuffer ? Buffer.from(ev.data) : Buffer.from(await ev.data.arrayBuffer());
          if (buf.length < 2) return;
          const hl = (buf[0] << 8) | buf[1];
          const audio = buf.slice(2 + hl);
          if (audio.length) chunks.push(audio);
        } catch { /* ignore */ }
      };
      ws.onerror = () => { clearTimeout(tmr); try { ws.close(); } catch {} fail(res, 502, 'TTS_ERROR', 'Edge TTS 连接失败（网络不可达）'); };
      ws.onclose = () => {
        if (settled) return; settled = true; clearTimeout(tmr);
        const total = chunks.reduce((s, a) => s + a.length, 0);
        if (total < 200) return fail(res, 502, 'TTS_ERROR', 'Edge TTS 未返回音频（超时或文本过长）');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.concat(chunks));
      };
    } catch (e) { fail(res, 502, 'TTS_ERROR', e.message); }
    return;
  }

  // MiniMax 海螺语音（开放平台 API：需 GroupId + API Key，注册送免费额度）
  if (engine === 'minimax') {
    const mmKey = req.headers['x-minimax-key'] || '';
    const groupId = req.query.groupId || '';
    if (!mmKey || !groupId) return fail(res, 400, 'BAD_REQUEST', 'MiniMax 需要 GroupId 与 API Key（海螺开放平台免费注册）');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const vId = req.query.voice || 'male-qn-qingse';
        const resp = await fetch(`https://api.minimax.chat/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mmKey}` },
          body: JSON.stringify({
            model: 'speech-02-hd',
            text: text.slice(0, 1800),
            stream: false,
            voice_setting: { voice_id: vId, speed: 1.0, vol: 1.0, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
          }),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || (json.base_resp && json.base_resp.status_code !== 0)) {
          const msg = (json.base_resp && (json.base_resp.status_msg || json.base_resp.status_code)) || ('HTTP ' + resp.status);
          return fail(res, 502, 'TTS_ERROR', 'MiniMax：' + String(msg).slice(0, 120));
        }
        const b64 = json.data && json.data.audio;
        if (!b64) return fail(res, 502, 'TTS_ERROR', 'MiniMax 未返回音频');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(b64, 'base64'));
      } finally { clearTimeout(timer); }
    } catch (e) { fail(res, 502, 'TTS_ERROR', e.message); }
    return;
  }

  // Google Translate TTS（免 Key 兜底，多语种：ko/ja/en/ru/zh-CN/zh-TW 等）
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text.slice(0, 500))}`;
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Referer: 'https://translate.google.com/' },
      });
      if (!resp.ok) return fail(res, 502, 'TTS_ERROR', `Google TTS HTTP ${resp.status}`);
      res.setHeader('Content-Type', resp.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await resp.arrayBuffer());
      res.send(buf);
    } finally { clearTimeout(timer); }
  } catch (e) { fail(res, 502, 'TTS_ERROR', e.message); }
});

// 文件下载代理（解决剪辑模块拉取 TOS 视频/图片时的 CORS 问题）
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url || '';
  if (!url || !/^https?:\/\//.test(url)) return fail(res, 400, 'BAD_REQUEST', '无效的 URL');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!resp.ok) {
        return fail(res, resp.status, 'PROXY_ERROR', `素材下载失败 HTTP ${resp.status}`);
      }
      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', resp.headers.get('content-length') || '');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      // 流式转发
      const reader = resp.body.getReader();
      const nodeStream = new (require('stream').Readable)({
        read() {},
      });
      nodeStream._reader = reader;
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { nodeStream.push(null); break; }
            nodeStream.push(Buffer.from(value));
          }
        } catch (e) {
          nodeStream.destroy(e);
        }
      })();
      nodeStream.pipe(res);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    fail(res, 502, 'PROXY_ERROR', e.message);
  }
});

// 静态资源（前端）
// HTML 不缓存（保证发版后浏览器立即拿到最新 JS 版本号）；带版本参数的静态资源长缓存
app.use((req, res, next) => {
  if (/\.html(\?|$)/.test(req.url) || req.url === '/' || !/\.(css|js|wasm|png|jpg|svg|ico)(\?|$)/.test(req.url)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// SPA 兜底
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------------- 启动 ---------------- */

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  // 获取局域网 IP，方便分享给其他用户
  const nets = require('os').networkInterfaces();
  const lanIps = [];
  Object.values(nets).forEach((list) => {
    (list || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) lanIps.push(n.address);
    });
  });
  console.log('============================================');
  console.log('  XM AI Studio 已启动');
  console.log(`  本地访问: http://localhost:${PORT}`);
  lanIps.forEach((ip) => console.log(`  局域网访问: http://${ip}:${PORT}  ← 把这个链接发给同事`));
  console.log(`  方舟 API: ${ARK_BASE}`);
  console.log(`  Bilibili: ${BILI_BASE}`);
  const fmt = (v) => (v ? '已配置(共享托管)' : '未配置');
  console.log(`  托管 Key(共享免填): 方舟[${fmt((process.env.ARK_API_KEY || '').trim())}] Bili[${fmt((process.env.BILI_API_KEY || '').trim())}]`);
  console.log(`  访问码: ${ACCESS_CODE ? '已开启(需 X-Access-Code)' : '未开启'}`);
  console.log('============================================');
});

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message));
