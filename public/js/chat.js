/* ============================================================
 * chat.js — AI 创意助手（豆包大模型对话）
 * 能力：脚本策划 / 分镜拆解 / 提示词优化 / 文案生成，
 *       产出结果可一键应用到生图、生视频、故事板
 * ============================================================ */
window.ChatView = (() => {
  const ROLES = {
    planner: { name: '脚本策划', icon: '📝', sys: '你是资深广告策划与短视频脚本专家。用户会给你创意需求，请输出结构清晰的拍摄脚本：包括主题立意、目标受众、叙事结构、分镜列表（场景/画面/台词/时长）、节奏与风格建议。使用中文，使用 Markdown 列表与表格，语言精炼专业。' },
    director: { name: '分镜导演', icon: '🎬', sys: '你是资深分镜导演。请把用户描述的画面拆解为分镜脚本，每镜输出：镜头序号、画面描述（含主体/动作/环境/光影）、镜头运动（推/拉/摇/移/固定）、参考时长（3-8秒）、台词或音效建议。请使用如下 JSON 数组格式输出（不要输出其他内容）：\n[{"shot":1,"visual":"画面描述","camera":"镜头运动","duration":5,"audio":"音效/台词"}]' },
    prompt: { name: '提示词工程师', icon: '✨', sys: '你是 AI 绘画/视频提示词专家（熟悉即梦、Seedream、Seedance 模型）。请把用户想法改写为高质量提示词：包含主体、动作、环境、光影、风格、构图、画质词；若用户有多个镜头需求则逐条输出并编号；必要时给出中英双语版本。' },
    copywriter: { name: '文案剪辑师', icon: '🎙️', sys: '你是短视频文案与字幕专家。根据用户给出的视频内容，输出：1) 开场钩子文案（15字内）；2) 解说词/口播稿（按时间轴分段）；3) 字幕逐条列表（时间点+文本，JSON 数组格式）；4) 结尾引导文案。使用中文。' },
  };

  const PRESETS = [
    '帮我写一个 15 秒游戏广告脚本',
    '把这段文案拆成 5 个分镜镜头',
    '优化这句生图提示词：海边日落',
    '为一款奶茶新品写 30 秒种草视频脚本',
    '给我 3 条竖屏带货视频的开场钩子',
  ];

  // 火山方舟常用对话模型（按账号开通情况选择，也可自定义输入）
  const CHAT_MODELS = [
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

  let messages = [];
  let busy = false;

  /* ---------- 渲染 ---------- */
  function render(el) {
    el.innerHTML = `
      <div class="chat-layout">
        <div class="chat-main">
          <div class="chat-msgs" id="chatMsgs"></div>
          <div class="chat-inputbar">
            <div class="chat-suggest" id="chatSuggest">
              ${PRESETS.map((p) => `<span class="chip">${p}</span>`).join('')}
            </div>
            <div class="chat-inputrow">
              <textarea class="input" id="chatInput" placeholder="输入创意想法，让 AI 帮你策划、拆解、优化…（Enter 发送，Shift+Enter 换行）"></textarea>
              <button class="btn btn-primary" id="chatSend">${UI.icon('send', 16)}发送</button>
            </div>
          </div>
        </div>
        <div class="chat-side">
          <div class="card">
            <div class="card-title"><span class="ico">🧠</span>对话模型</div>
            <label class="field" style="margin-bottom:8px">
              <span class="field-label">模型 ID（全局生效，支持推理接入点 ep-xxx）</span>
              <input class="input" id="chatModelInput" placeholder="如 doubao-seed-evolving 或 ep-2026xxxx" value="${UI.escapeHtml(API.getChatModel())}" style="font-size:12px">
            </label>
            <div class="prompt-presets" id="chatModelPresets" style="margin-bottom:8px">
              ${CHAT_MODELS.map((m) => `<span class="preset-chip">${m}</span>`).join('')}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" id="chatModelSave">💾 保存</button>
              <button class="btn btn-sm" id="chatModelTest">🔍 检测可用</button>
              <button class="btn btn-sm" id="chatModelBatch" title="逐个真实调用候选模型（不走降级）">🧪 批量真实检测</button>
              <button class="btn btn-sm" id="chatModelScan" title="查询方舟官方已开通模型列表">🔄 自动检测已开通</button>
            </div>
            <div class="prompt-presets" id="chatModelScanned" style="margin-top:8px"></div>
            <p id="chatModelStatus" style="font-size:11.5px;margin-top:7px;color:var(--text-3)"></p>
            <p style="font-size:11px;color:var(--text-3);margin-top:6px">需在<a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">模型广场</a>开通模型后可用；若模型名调用报错，可到「在线推理」创建推理接入点，把 ep- 开头的接入点 ID 填到上方输入框</p>
          </div>
          <div class="card">
            <div class="card-title"><span class="ico">🎭</span>角色设定</div>
            <div id="roleList">
              ${Object.entries(ROLES).map(([k, r]) => `
                <div class="role-chip" data-role="${k}" style="margin:4px;display:inline-block;cursor:pointer">${r.icon} ${r.name}</div>
              `).join('')}
            </div>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:8px">不同角色决定 AI 的输出形态（脚本 / 分镜JSON / 提示词 / 文案）</p>
          </div>
          <div class="card">
            <div class="card-title"><span class="ico">⚡</span>快速任务</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <button class="btn btn-sm" data-task="script">🎬 生成 15s 广告脚本</button>
              <button class="btn btn-sm" data-task="storyboard">📋 拆解为分镜 JSON</button>
              <button class="btn btn-sm" data-task="prompt">✨ 优化提示词</button>
              <button class="btn btn-sm" data-task="caption">🎙️ 生成字幕文案</button>
            </div>
          </div>
          <div class="card">
            <div class="card-title"><span class="ico">💡</span>小贴士</div>
            <p style="font-size:12px;color:var(--text-2)">AI 输出的 <b>分镜 JSON</b> 可一键发往「故事板」，<b>提示词</b>可一键填入生图/生视频，实现"思考→创作"闭环。</p>
          </div>
        </div>
      </div>`;

    // 消息区
    const msgsEl = el.querySelector('#chatMsgs');
    const inputEl = el.querySelector('#chatInput');
    const sendBtn = el.querySelector('#chatSend');

    // 欢迎语
    if (messages.length === 0) {
      messages = [{ role: 'assistant', content: '你好，我是 XM 创意助手 ✨\n\n我可以帮你：\n• 策划短视频 / 广告脚本（开场钩子→节奏→结尾引导）\n• 把想法拆解为可直接执行的分镜 JSON\n• 优化 AI 生图 / 生视频提示词\n• 生成解说词与字幕文案\n\n选择左侧角色，或直接输入你的创意想法吧！' }];
    }
    renderMessages(msgsEl);

    // 角色切换
    el.querySelectorAll('[data-role]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const role = ROLES[chip.dataset.role];
        if (!role) return;
        const text = inputEl.value.trim();
        inputEl.value = '';
        push(msgsEl, 'user', `【${role.icon}${role.name}】\n${text || '请先给我一个创意或素材背景，我来帮你产出内容。'}`);
        await ask(msgsEl, role, text);
      });
    });

    // 快捷任务
    el.querySelectorAll('[data-task]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const map = {
          script: ['planner', '请为一个产品/游戏/品牌策划一条 15 秒的竖屏短视频广告脚本（用户后续会提供产品信息，请先给通用模板+示例）。'],
          storyboard: ['director', '把下面这段描述拆解为分镜 JSON：\n"一个旅行博主在雪山日出时的vlog开场，从起床到山顶，最后举着相机自拍"'],
          prompt: ['prompt', '优化这句生图提示词（给出优化版+中文版+英文版）：\n"海边日落，一个女孩在沙滩奔跑"'],
          caption: ['copywriter', '写一条 30 秒美食探店视频的字幕文案与解说词。'],
        };
        const [roleKey, q] = map[btn.dataset.task];
        const role = ROLES[roleKey];
        push(msgsEl, 'user', `【${role.icon}${role.name}】\n${q}`);
        await ask(msgsEl, role, '');
      });
    });

    // 对话模型设置
    const modelInput = el.querySelector('#chatModelInput');
    const modelStatus = el.querySelector('#chatModelStatus');
    el.querySelector('#chatModelPresets').addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (chip) modelInput.value = chip.textContent.trim();
    });
    el.querySelector('#chatModelSave').addEventListener('click', () => {
      const m = modelInput.value.trim();
      if (!m) return UI.toast('请输入模型 ID', 'warn');
      API.setChatModel(m);
      modelStatus.textContent = `✅ 已保存：${m}`;
      modelStatus.style.color = 'var(--ok)';
      UI.toast('对话模型已保存，后续 AI 请求将使用该模型', 'ok');
    });
    el.querySelector('#chatModelTest').addEventListener('click', async () => {
      const m = modelInput.value.trim();
      if (!m) return UI.toast('请输入模型 ID', 'warn');
      const btn = el.querySelector('#chatModelTest');
      btn.disabled = true;
      btn.textContent = '检测中…';
      modelStatus.textContent = `⏳ 正在真实调用模型「${m}」（不降级）…`;
      modelStatus.style.color = 'var(--text-3)';
      const r = await API.chatTest(m);
      if (r.ok) {
        modelStatus.textContent = `✅ 模型「${m}」真实可用，回复：${(r.reply || '').slice(0, 20)}`;
        modelStatus.style.color = 'var(--ok)';
        UI.toast('模型真实可用 ✅', 'ok');
      } else {
        const msg = r.message || '';
        if (/does not exist|do not have access|not supported|not found|model or endpoint/i.test(msg)) {
          modelStatus.textContent = `❌ 模型「${m}」不可用：未开通或不存在。\n💡 请到模型广场开通该模型，或换一个已开通的对话模型。`;
        } else if (/401|authentication|invalid.*key|Unauthorized/i.test(msg)) {
          modelStatus.textContent = `❌ API Key 鉴权失败：${msg.slice(0, 100)}`;
        } else if (/429|quota|rate|insufficient.*balance/i.test(msg)) {
          modelStatus.textContent = `⚠️ 配额或余额不足：${msg.slice(0, 100)}`;
        } else {
          modelStatus.textContent = `❌ ${msg.slice(0, 200)}`;
        }
        modelStatus.style.color = 'var(--danger)';
        UI.toast('模型不可用', 'err');
      }
      btn.disabled = false;
      btn.textContent = '🔍 检测可用';
    });

    // 批量真实验证候选模型（绕过降级链，逐个 chatTest）
    el.querySelector('#chatModelBatch').addEventListener('click', async () => {
      const candidates = [
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
      const btn = el.querySelector('#chatModelBatch');
      btn.disabled = true;
      btn.textContent = '批量检测中…';
      modelStatus.textContent = `⏳ 真实调用 ${candidates.length} 个候选模型（每个独立请求，不走降级链）…`;
      modelStatus.style.color = 'var(--text-3)';
      const results = [];
      for (const m of candidates) {
        const r = await API.chatTest(m);
        results.push({ m, ...r });
        modelStatus.textContent = `⏳ 已检测 ${results.length}/${candidates.length}…（${results.filter(x => x.ok).length} 个可用）`;
      }
      const okList = results.filter((x) => x.ok);
      const failList = results.filter((x) => !x.ok);
      const scanned = el.querySelector('#chatModelScanned');
      if (okList.length > 0) {
        scanned.innerHTML = okList.map((r) =>
          `<span class="preset-chip" data-m="${UI.escapeHtml(r.m)}" title="${UI.escapeHtml(r.reply)}">✅ ${UI.escapeHtml(r.m)}</span>`
        ).join('');
        scanned.querySelectorAll('.preset-chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            modelInput.value = chip.dataset.m;
            API.setChatModel(chip.dataset.m);
            modelStatus.textContent = `✅ 已选用：${chip.dataset.m}`;
            modelStatus.style.color = 'var(--ok)';
            UI.toast(`已选择：${chip.dataset.m}`, 'ok');
          });
        });
        modelStatus.textContent = `✅ 真实检测完成：${okList.length}/${candidates.length} 个可用，点击下方绿色 chip 选用。${failList.length ? '不可用：' + failList.map(x => x.m).join(', ') : ''}`;
        modelStatus.style.color = 'var(--ok)';
      } else {
        scanned.innerHTML = failList.map((r) =>
          `<span class="preset-chip" data-m="${UI.escapeHtml(r.m)}" title="${UI.escapeHtml(r.message)}">❌ ${UI.escapeHtml(r.m)}</span>`
        ).join('');
        modelStatus.textContent = `❌ 所有 ${candidates.length} 个候选模型都不可用。\n💡 你的账号下可能尚未开通任何豆包对话模型，请到模型广场开通：console.volcengine.com/ark → 模型广场`;
        modelStatus.style.color = 'var(--danger)';
      }
      btn.disabled = false;
      btn.textContent = '🧪 批量真实检测';
    });

    // 自动检测账号下已开通的模型
    el.querySelector('#chatModelScan').addEventListener('click', async () => {
      const btn = el.querySelector('#chatModelScan');
      const scanned = el.querySelector('#chatModelScanned');
      btn.disabled = true;
      btn.textContent = '检测中…';
      modelStatus.textContent = '⏳ 正在查询已开通模型…';
      modelStatus.style.color = 'var(--text-3)';
      scanned.innerHTML = '';
      try {
        const data = await API.listModels();
        const ids = data.ids || [];
        if (!ids.length) {
          modelStatus.textContent = '⚠️ 未查询到模型列表（该接口可能未开放），可改用「检测可用」逐个验证';
          modelStatus.style.color = 'var(--warn)';
          return;
        }
        // 优先展示对话类模型
        const chatLike = ids.filter((m) => /doubao|seed|pro|lite|chat/i.test(m));
        const shown = (chatLike.length ? chatLike : ids).slice(0, 40);
        scanned.innerHTML = shown.map((m) => `<span class="preset-chip" data-m="${UI.escapeHtml(m)}">${UI.escapeHtml(m)}</span>`).join('');
        scanned.querySelectorAll('.preset-chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            modelInput.value = chip.dataset.m;
            API.setChatModel(chip.dataset.m);
            modelStatus.textContent = `✅ 已选择并保存：${chip.dataset.m}`;
            modelStatus.style.color = 'var(--ok)';
            UI.toast(`已选择模型：${chip.dataset.m}`, 'ok');
          });
        });
        modelStatus.textContent = `✅ 查询到 ${ids.length} 个模型，点击上方任一模型即可选用（优先展示对话类）`;
        modelStatus.style.color = 'var(--ok)';
      } catch (e) {
        const msg = e.message || '';
        if (/not supported|not found|does not exist|no access/i.test(msg)) {
          modelStatus.textContent = '⚠️ 账号暂不支持自动查询模型列表，请到模型广场查看已开通模型后手动填写';
          modelStatus.style.color = 'var(--warn)';
        } else {
          modelStatus.textContent = `❌ ${msg}`;
          modelStatus.style.color = 'var(--danger)';
        }
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 自动检测已开通';
      }
    });

    // 建议 chips
    el.querySelectorAll('#chatSuggest .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.textContent;
        inputEl.focus();
      });
    });

    // 发送
    async function doSend() {
      const text = inputEl.value.trim();
      if (!text || busy) return;
      inputEl.value = '';
      push(msgsEl, 'user', text);
      await ask(msgsEl, { name: '创意助手', icon: '✨', sys: ROLES.planner.sys }, text);
    }
    sendBtn.addEventListener('click', doSend);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
  }

  function push(msgsEl, role, content) {
    messages.push({ role, content });
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const ava = role === 'user' ? '🧑' : '✨';
    el.innerHTML = `<div class="avatar">${ava}</div><div class="bubble"></div>`;
    const bubble = el.querySelector('.bubble');
    bubble.innerHTML = UI.md(content);
    attachActions(bubble, content, role);
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }

  /** 根据内容类型附加可执行按钮 */
  function attachActions(bubble, content, role) {
    if (role !== 'assistant') return;
    const actions = [];
    const hasShotsJson = /\[\s*\{[\s\S]*"shot"[\s\S]*\}\s*\]/.test(content) || content.includes('"visual"');
    if (hasShotsJson) {
      actions.push({ label: '📋 发往故事板', fn: () => sendToStoryboard(content) });
    }
    if (content.length > 8) {
      actions.push({ label: '🎬 去生成视频', fn: () => sendToVideo(content) });
      actions.push({ label: '🖼️ 去生图', fn: () => sendToImage(content) });
      if (!hasShotsJson) actions.push({ label: '📋 拆为场景', fn: () => sendToStoryboard(content) });
    }
    if (actions.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'ai-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-ghost';
      btn.textContent = a.label;
      btn.addEventListener('click', a.fn);
      wrap.appendChild(btn);
    });
    bubble.appendChild(wrap);
  }

  async function ask(msgsEl, role, userText) {
    if (busy) return;
    busy = true;
    const typing = document.createElement('div');
    typing.className = 'msg bot';
    typing.innerHTML = `<div class="avatar">✨</div><div class="bubble" style="display:flex;align-items:center;gap:8px"><div class="spinner sm"></div>${role.icon}${role.name} 思考中…</div>`;
    msgsEl.appendChild(typing);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    const history = messages.slice(-14).map((m) => ({ role: m.role, content: m.content }));
    if (role.sys) history.unshift({ role: 'system', content: role.sys });

    try {
      const reply = await API.chat({ messages: history, temperature: 0.8 });
      messages.push({ role: 'assistant', content: reply });
      typing.querySelector('.bubble').innerHTML = UI.md(reply);
      const bubble = typing.querySelector('.bubble');
      bubble.querySelector('.spinner')?.remove();
      attachActions(bubble, reply, 'assistant');
      msgsEl.scrollTop = msgsEl.scrollHeight;
      UI.toast('创意助手已回复', 'ok', 1600);
    } catch (e) {
      const msg = e.message || '';
      typing.querySelector('.bubble').innerHTML = '';
      if (/does not exist|do not have access|not supported|not found|model or endpoint/i.test(msg)) {
        typing.querySelector('.bubble').textContent = `❌ 对话模型不可用：${msg}\n\n💡 处理方法：\n1. 点击左侧「对话模型」→「🧪 批量真实检测」，一键找到你账号已开通的模型\n2. 老一代模型（doubao-pro-32k / doubao-1-5 系列）已退役，请换用新一代（如 doubao-seed-evolving / doubao-seed-2-1-pro）\n3. 若都没有，到模型广场开通豆包对话模型：console.volcengine.com/ark → 模型广场`;
        UI.toast('对话模型未开通或不存在，请在左侧切换模型', 'err', 6000);
      } else {
        typing.querySelector('.bubble').textContent = `❌ ${msg}`;
        UI.toast(msg, 'err');
      }
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    busy = false;
  }

  function renderMessages(msgsEl) {
    msgsEl.innerHTML = '';
    messages.forEach((m) => {
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      const ava = m.role === 'user' ? '🧑' : '✨';
      el.innerHTML = `<div class="avatar">${ava}</div><div class="bubble"></div>`;
      el.querySelector('.bubble').innerHTML = UI.md(m.content);
      attachActions(el.querySelector('.bubble'), m.content, m.role);
      msgsEl.appendChild(el);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ---------- 跨模块动作 ---------- */
  function sendToImage(content) {
    const prompt = extractPrompt(content);
    window.MA.nav('image');
    window.MA.dispatch('image:fillPrompt', prompt || content);
    UI.toast('提示词已填入 AI 生图', 'ok');
  }
  function sendToVideo(content) {
    window.MA.nav('video');
    window.MA.dispatch('video:fillPrompt', content);
    UI.toast('描述已填入 AI 生视频', 'ok');
  }
  function sendToStoryboard(content) {
    try {
      const arr = extractShots(content);
      if (arr && arr.length) {
        window.MA.nav('storyboard');
        window.MA.dispatch('storyboard:addShots', arr);
        UI.toast(`已导入 ${arr.length} 个分镜到故事板`, 'ok');
        return;
      }
    } catch { /* ignore */ }
    window.MA.nav('storyboard');
    window.MA.dispatch('storyboard:addTextShots', content);
    UI.toast('已按文本段创建场景卡片（可再手动完善）', 'ok');
  }

  function extractShots(content) {
    const m = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!m) return null;
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr.map((s) => ({
          visual: s.visual || s.prompt || s.description || s.画面 || '',
          camera: s.camera || s.镜头运动 || '',
          duration: Number(s.duration || s.时长 || 5),
          audio: s.audio || s.台词 || s.音效 || '',
        })).filter((s) => s.visual);
      }
    } catch { /* ignore */ }
    return null;
  }
  function extractPrompt(content) {
    // 取第一个看起来像提示词的句子
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l && !/^[#•\d.]/.test(l) && l.length > 8);
    return lines[0] || content.slice(0, 300);
  }

  return { render };
})();
