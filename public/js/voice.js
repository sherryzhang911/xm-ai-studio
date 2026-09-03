/* ============================================================
 * voice.js — AI 配音（多语种 TTS）
 * 全部为「在线合成」：输入文案 → 点生成 → 直接出 MP3，无任何网页跳转/内嵌。
 * 引擎：
 *   ElevenLabs（xi key，多语种/克隆音色）
 *   Google 免费（免 Key，浏览器直连优先）
 *   微软 Edge 免费（免 Key，神经网络音色，走本地服务 /api/tts）
 *   MiniMax 海螺（GroupId + key，开放平台免费额度）
 *   系统语音（免 Key 试听）
 * 「⬆ 导入音频」为通用工具：把外部生成的音频带回本页试听/下载/转存作品中心。
 * ============================================================ */
window.VoiceView = (() => {
  const LS_KEY = 'materall_voice';
  const LANGS = [
    { code: 'ko-KR', label: '韩语', el: 'ko' },
    { code: 'en-US', label: '英语', el: 'en' },
    { code: 'ja-JP', label: '日语', el: 'ja' },
    { code: 'zh-TW', label: '繁体中文', el: 'zh' },
    { code: 'zh-CN', label: '简体中文', el: 'zh' },
    { code: 'ru-RU', label: '俄语', el: 'ru' },
  ];

  let st = {
    text: '',
    lang: 'ko-KR',
    engine: 'google',        // elevenlabs | google | edge | minimax | system
    voice: '',               // ElevenLabs voice id
    elevenKey: '',
    mmKey: '',               // MiniMax API Key
    mmGroup: '',             // MiniMax GroupId
    mmVoice: '',             // MiniMax Voice ID
    rate: 1,
  };
  let audioUrl = null;
  let audioName = '';

  function load() {
    try { Object.assign(st, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch { /* ignore */ }
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch { /* ignore */ }
  }
  const curLang = () => LANGS.find((L) => L.code === st.lang) || LANGS[0];

  function render(el) {
    load();
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;max-width:920px;margin:0 auto">
        <div class="card">
          <div class="card-title"><span class="ico">🎙️</span>AI 配音（多语种 · 在线合成）</div>
          <label class="field"><span class="field-label">① 文案（支持多行 / 多条）</span>
            <textarea id="vvText" class="input" rows="5" style="width:100%;resize:vertical" placeholder="输入要配音的文案，例如：지금 바로 다운로드&#10;下载即玩，统帅三国">${UI.escapeHtml(st.text)}</textarea></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span style="font-size:12.5px;color:var(--text-2)">目标语言：</span>
            ${LANGS.map((L) => `<button class="btn btn-sm ${st.lang === L.code ? 'btn-primary' : ''}" data-lang="${L.code}">${L.label}</button>`).join('')}
          </div>

          <div style="margin-top:12px;font-size:13px;color:var(--text-1);font-weight:600">② 合成引擎（选一个 → 点下方「生成配音」直接出音频）</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <button class="btn btn-sm ${st.engine === 'google' ? 'btn-primary' : ''}" data-eng="google" title="免 Key，浏览器直连优先">🆓 Google 免费</button>
            <button class="btn btn-sm ${st.engine === 'edge' ? 'btn-primary' : ''}" data-eng="edge" title="免 Key，微软神经网络音色（韩 SunHi 等），需本地服务">🆓 微软 Edge 免费</button>
            <button class="btn btn-sm ${st.engine === 'elevenlabs' ? 'btn-primary' : ''}" data-eng="elevenlabs" title="多语种自然、30s 样本可克隆">🎯 ElevenLabs</button>
            <button class="btn btn-sm ${st.engine === 'minimax' ? 'btn-primary' : ''}" data-eng="minimax" title="音质顶级，开放平台免费额度">🎧 MiniMax 海螺</button>
            <button class="btn btn-sm ${st.engine === 'system' ? 'btn-primary' : ''}" data-eng="system" title="免 Key 离线试听（浏览器限制无法导出）">🔉 系统语音（试听）</button>
          </div>

          ${st.engine === 'elevenlabs' ? `
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <label class="field" style="flex:1;min-width:220px"><span class="field-label">ElevenLabs API Key（xi-api-key，免费注册即有）</span>
              <input class="input" id="vvKey" type="password" placeholder="sk_xxxx（elevenlabs.io 免费注册）" value="${UI.escapeHtml(st.elevenKey)}"></label>
            <label class="field" style="flex:1;min-width:220px"><span class="field-label">音色 Voice ID（克隆音色填你的 voice id）</span>
              <input class="input" id="vvVoice" placeholder="留空用默认；克隆音色填 20 位 voice id" value="${UI.escapeHtml(st.voice)}"></label>
          </div>` : ''}

          ${st.engine === 'minimax' ? `
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <label class="field" style="flex:1;min-width:200px"><span class="field-label">MiniMax API Key（海螺开放平台免费注册）</span>
              <input class="input" id="vvMmKey" type="password" placeholder="eyJhbGci…（platform.minimaxi.com 获取）" value="${UI.escapeHtml(st.mmKey)}"></label>
            <label class="field" style="flex:1;min-width:160px"><span class="field-label">GroupId</span>
              <input class="input" id="vvMmGroup" placeholder="控制台「账户管理」里查" value="${UI.escapeHtml(st.mmGroup)}"></label>
            <label class="field" style="flex:1;min-width:200px"><span class="field-label">Voice ID（可选，音色库查）</span>
              <input class="input" id="vvMmVoice" placeholder="留空用默认多语种音色" value="${UI.escapeHtml(st.mmVoice)}"></label>
          </div>` : ''}

          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="vvGen">🎙️ 生成配音</button>
            <button class="btn" id="vvPlay" disabled>▶ 试听</button>
            <button class="btn" id="vvDownload" disabled>⬇ 下载 MP3</button>
            <button class="btn" id="vvImport">⬆ 导入音频（外部生成的音频带回本页）</button>
            <input type="file" id="vvImportFile" accept="audio/*" style="display:none">
            <span style="font-size:11.5px;color:var(--text-3);align-self:center">命名：<input class="input" id="vvName" placeholder="vo_ko_20260902" style="width:170px;padding:4px 8px;display:inline-block"></span>
          </div>
          <p style="font-size:11.5px;color:var(--text-3);margin-top:8px;line-height:1.8">💡 <b>引擎说明：</b><br>
            • <b>Google 免费</b>：免 Key 在线（浏览器直连优先，失败自动回落本地服务）；韩/英/日/繁中/简中/俄全支持。<br>
            • <b>微软 Edge 免费</b>：免 Key，微软神经网络音色（韩 SunHi 女声 / 日 Nanami / 中 Xiaoxiao），音质接近真人；走本地服务（分享版需 <code>node server.js</code>）。<br>
            • <b>ElevenLabs</b>：免费注册送 Key（约 10k 字符/月），多语种自然、支持 30s 样本克隆音色（官网 Instant Voice Clone 后填 Voice ID）。<br>
            • <b>MiniMax 海螺</b>：音质顶级多语种；Key + GroupId 在 <a href="https://platform.minimaxi.com" target="_blank">platform.minimaxi.com</a> 免费注册获取（新用户送额度）。<br>
            • <b>系统语音</b>：免 Key 离线试听语感（浏览器限制无法导出，仅试听）。<br>
            • <b>火山引擎</b>：语音合成需火山「语音技术」AK/SK（<a href="https://console.volcengine.com/speech/app" target="_blank">控制台</a>），方舟 Key 不可用于 TTS。</p>
        </div>
      </div>`;
    bindEvents(el);
  }

  function bindEvents(el) {
    el.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { st.lang = b.dataset.lang; save(); render(el); }));
    el.querySelectorAll('[data-eng]').forEach((b) => b.addEventListener('click', () => { st.engine = b.dataset.eng; save(); render(el); }));
    el.querySelector('#vvText').addEventListener('input', (e) => { st.text = e.target.value; save(); });
    const keyEl = el.querySelector('#vvKey');
    if (keyEl) keyEl.addEventListener('input', (e) => { st.elevenKey = e.target.value.trim(); save(); });
    const voiceEl = el.querySelector('#vvVoice');
    if (voiceEl) voiceEl.addEventListener('input', (e) => { st.voice = e.target.value.trim(); save(); });
    const mmk = el.querySelector('#vvMmKey');
    if (mmk) mmk.addEventListener('input', (e) => { st.mmKey = e.target.value.trim(); save(); });
    const mmg = el.querySelector('#vvMmGroup');
    if (mmg) mmg.addEventListener('input', (e) => { st.mmGroup = e.target.value.trim(); save(); });
    const mmv = el.querySelector('#vvMmVoice');
    if (mmv) mmv.addEventListener('input', (e) => { st.mmVoice = e.target.value.trim(); save(); });
    el.querySelector('#vvGen').addEventListener('click', () => genAudio(el));
    el.querySelector('#vvPlay').addEventListener('click', () => { if (audioUrl) { const a = document.createElement('audio'); a.src = audioUrl; a.play(); } });
    el.querySelector('#vvDownload').addEventListener('click', () => {
      const nm = (el.querySelector('#vvName').value || 'voice').trim() || 'voice';
      if (!audioUrl) return;
      const a = document.createElement('a'); a.href = audioUrl; a.download = nm + '.mp3'; a.click();
      try { Store.add({ type: 'project', kind: 'tts', title: `配音 ${nm}`, url: audioUrl, duration: 0 }); } catch { /* ignore */ }
      UI.toast('已开始下载', 'ok');
    });
    // 导入外部音频（通用工具）
    el.querySelector('#vvImport').addEventListener('click', () => el.querySelector('#vvImportFile').click());
    const impFile = el.querySelector('#vvImportFile');
    if (impFile) impFile.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { UI.toast('音频超过 20MB', 'warn'); return; }
      audioUrl = URL.createObjectURL(f);
      audioName = f.name;
      const play = el.querySelector('#vvPlay'), dl = el.querySelector('#vvDownload');
      play.disabled = false; dl.disabled = false;
      const nm = (f.name || 'voice').replace(/\.[^.]+$/, '');
      try { Store.add({ type: 'project', kind: 'tts', title: `配音 ${nm}`, url: audioUrl, duration: 0 }); } catch { /* ignore */ }
      UI.toast('音频已导入，可试听 / 下载 / 转存作品中心 ✅', 'ok', 4000);
      e.target.value = '';
    });
  }

  async function genAudio(el) {
    const text = (st.text || '').trim();
    if (!text) return UI.toast('请先输入文案', 'warn');
    const gen = el.querySelector('#vvGen');
    if (gen.dataset.busy) return;                 // 生成中防重复点击
    gen.dataset.busy = '1';
    gen.disabled = true; gen.textContent = '⏳ 生成中…';
    try {
      let url, name;
      const stamp = () => `voice_${st.lang.split('-')[0]}_${Date.now()}.mp3`;
      if (st.engine === 'system') {
        // 系统语音仅试听
        await systemTTS(text);
        gen.disabled = false; gen.textContent = '🎙️ 生成配音';
        return;
      } else if (st.engine === 'google') {
        const gl = { 'ko-KR': 'ko', 'en-US': 'en', 'ja-JP': 'ja', 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', 'ru-RU': 'ru' }[st.lang] || 'ko';
        let blob = null, via = '';
        try {
          const ac = new AbortController();
          const tm = setTimeout(() => ac.abort(), 8000);
          const r0 = await fetch('https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + gl + '&q=' + encodeURIComponent(text.slice(0, 200)), { mode: 'cors', signal: ac.signal });
          clearTimeout(tm);
          if (r0.ok) { blob = await r0.blob(); via = '浏览器直连'; }
        } catch { /* 直连失败/超时 → 本地服务代理 */ }
        if (!blob) {
          const r1 = await fetch('/api/tts?text=' + encodeURIComponent(text.slice(0, 500)) + '&lang=' + gl + '&engine=google');
          if (!r1.ok) {
            const err = await r1.json().catch(() => ({}));
            UI.toast('Google 免费合成失败：' + (err.message || 'HTTP ' + r1.status) + '。请确认浏览器可访问 translate.google.com（如代理），或换「微软 Edge 免费 / ElevenLabs / MiniMax」', 'err', 9000);
            return;
          }
          blob = await r1.blob(); via = '本地服务';
        }
        url = URL.createObjectURL(blob);
        name = stamp();
        UI.toast('Google 免费合成成功（' + via + '）✅', 'ok', 2500);
      } else if (st.engine === 'edge') {
        // 微软 Edge 免费（服务端 /api/tts）
        const resp = await fetch('/api/tts?text=' + encodeURIComponent(text.slice(0, 1500)) + '&lang=' + st.lang + '&engine=edge');
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          UI.toast('Edge 合成失败：' + (err.message || 'HTTP ' + resp.status) + '。Edge 需本地服务（node server.js），或换 Google 免费 / ElevenLabs / MiniMax', 'err', 9000);
          return;
        }
        url = URL.createObjectURL(await resp.blob());
        name = stamp();
        UI.toast('微软 Edge 免费合成成功 ✅', 'ok', 2500);
      } else if (st.engine === 'minimax') {
        if (!st.mmKey || !st.mmGroup) { UI.toast('MiniMax 需要填写 API Key 与 GroupId（platform.minimaxi.com 免费注册）', 'warn', 7000); return; }
        const qs = new URLSearchParams({ text: text.slice(0, 1800), lang: curLang().el, engine: 'minimax', groupId: st.mmGroup, voice: st.mmVoice });
        const resp = await fetch('/api/tts?' + qs.toString(), { headers: { 'x-minimax-key': st.mmKey } });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          UI.toast('MiniMax 合成失败：' + (err.message || 'HTTP ' + resp.status), 'err', 8000);
          return;
        }
        url = URL.createObjectURL(await resp.blob());
        name = stamp();
        UI.toast('MiniMax 海螺合成成功 ✅', 'ok', 2500);
      } else {
        // elevenlabs
        if (!st.elevenKey) { UI.toast('ElevenLabs 需要填写 API Key（可切 Google 免费 / 微软 Edge / MiniMax）', 'warn', 7000); return; }
        const qs = new URLSearchParams({ text: text.slice(0, 900), lang: curLang().el, engine: 'elevenlabs', voice: st.voice || '21m00Tcm4TlvDq8ikWAM' });
        const resp = await fetch('/api/tts?' + qs.toString(), { headers: { 'xi-api-key': st.elevenKey } });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          UI.toast('生成失败：' + (err.message || err.error || 'HTTP ' + resp.status), 'err', 7000);
          return;
        }
        url = URL.createObjectURL(await resp.blob());
        name = stamp();
      }
      audioUrl = url; audioName = name;
      const play = el.querySelector('#vvPlay'), dl = el.querySelector('#vvDownload');
      play.disabled = false; dl.disabled = false;
      UI.toast('配音生成完成，可试听 / 下载 ✅', 'ok', 3000);
    } catch (e) {
      UI.toast('配音生成失败：' + (e.message || '').slice(0, 80), 'err', 7000);
    } finally {
      gen.dataset.busy = '';
      gen.disabled = false; gen.textContent = '🎙️ 生成配音';
    }
  }

  /** 系统语音（SpeechSynthesis）试听 */
  function systemTTS(text) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) return reject(new Error('浏览器不支持系统语音'));
      const lang = curLang().code;
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => x.lang === lang) || voices.find((x) => x.lang.startsWith(lang.split('-')[0])) || null;
      const u = new SpeechSynthesisUtterance(text);
      if (v) u.voice = v;
      u.lang = v ? v.lang : lang;
      u.rate = st.rate || 1;
      speechSynthesis.speak(u);
      UI.toast('已开始朗读试听。要导出音频请用 Google 免费 / 微软 Edge / ElevenLabs / MiniMax 引擎', 'info', 5000);
      setTimeout(() => {
        try { speechSynthesis.cancel(); } catch { /* ignore */ }
        resolve();
      }, 6000);
    });
  }

  return { render };
})();
