/* ============================================================
 * pipeline.js — 流水线生产（小龙虾自动化模式）
 * "思考-创作-剪辑-输出" 全自动流水线：
 * 一句话创意 → AI 拆解分镜 → 批量生图 → 批量生视频 → 自动送入剪辑成片
 *
 * v2：支持随时停止、实时进度、单镜头手动控制（生图/生视频独立按钮）
 * ============================================================ */
window.PipelineView = (() => {
  const LS_KEY = 'materall_pipeline';
  const PHASES = [
    { key: 'split', label: 'AI 拆解分镜', ico: '🧠' },
    { key: 'images', label: '批量生成画面', ico: '🖼️' },
    { key: 'videos', label: '批量生成视频', ico: '🎬' },
    { key: 'edit', label: '智能剪辑成片', ico: '✂️' },
    { key: 'done', label: '输出成片', ico: '🚀' },
  ];

  let state = {
    phase: 'idle',        // idle | split | images | videos | edit | done | paused
    idea: '',
    shots: [],            // {visual, camera, duration, audio, imageUrl, videoTaskId, videoUrl, error}
    currentPhaseIdx: -1,
    refImage: '',         // 参考图 data URL（图生图：按参考图风格/形象生成画面）
  };

  // 运行控制：每次启动流水线生成新 token；停止 = 作废当前 token
  let runToken = null;
  // 进度：{ key: 'images'|'videos'|'split', done: n, total: m, label }
  let progress = null;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      Object.assign(state, saved);
      if (!Array.isArray(state.shots)) state.shots = [];
      if (typeof state.phase !== 'string') state.phase = 'idle';
    } catch { /* ignore */ }
    return state;
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  const isBusyPhase = () => ['split', 'images', 'videos'].includes(state.phase);
  const running = () => !!runToken;

  /* ---------- 渲染 ---------- */
  function render(el) {
    load();
    el.innerHTML = `
      <div class="pline-hero">
        <h2>🏭 流水线生产 <span class="grad-text">· 小龙虾自动化模式</span></h2>
        <p>输入一句话创意，AI 自动完成：分镜拆解 → 画面生成 → 视频生成 → 剪辑成片。也可以拆解后<b>逐个镜头手动控制</b>。</p>
        <div class="pline-input-row">
          <input class="input" id="plIdea" placeholder="例如：一条 15 秒的夏日冰饮种草视频，年轻人在海边便利店买到冰饮的瞬间" value="${UI.escapeHtml(state.idea)}">
          <button class="btn btn-primary" id="plStart" ${running() ? 'disabled' : ''}>🚀 启动流水线</button>
          ${running() ? '<button class="btn btn-danger" id="plStop">⏹ 停止</button>' : ''}
        </div>
        <div class="pline-ref" style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <input type="file" id="plRefFile" accept="image/*" style="display:none">
          ${state.refImage ? `
            <div style="position:relative">
              <img id="plRefImg" src="${state.refImage}" style="height:64px;border-radius:8px;border:1px solid var(--border-light)">
              <button id="plRefRemove" title="移除参考图" style="position:absolute;top:-7px;right:-7px;width:20px;height:20px;border-radius:50%;border:none;background:var(--danger,#f66);color:#fff;font-size:11px;cursor:pointer;line-height:1">✕</button>
            </div>
            <span style="font-size:12px;color:var(--text-2)">🎨 已设参考图：画面将按参考图的<b>风格与形象</b>生成</span>
          ` : `
            <button class="btn btn-sm" id="plRefPick">🖼️ 添加参考图（可选）</button>
            <span style="font-size:12px;color:var(--text-3)">上传角色/风格参考图，所有分镜画面将参考它生成，保持形象统一</span>
          `}
        </div>
        <div class="pline-flow">
          ${PHASES.map((p, i) => {
            const cls = i < state.currentPhaseIdx ? 'done' : i === state.currentPhaseIdx ? 'run' : '';
            return `<span class="pf ${cls}">${p.ico} ${p.label}${i < state.currentPhaseIdx ? ' ✓' : ''}</span>`;
          }).join('')}
        </div>
        ${progress ? `
        <div class="pline-progress" id="plProgress" style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:5px">
            <span>${progress.label || ''}</span>
            <span>${progress.done} / ${progress.total}</span>
          </div>
          <div class="progress-bar" style="height:8px"><div class="fill" style="width:${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%"></div></div>
        </div>` : ''}
      </div>
      <div id="plBody"></div>`;

    el.querySelector('#plStart')?.addEventListener('click', () => startPipeline(el));
    el.querySelector('#plStop')?.addEventListener('click', () => stopPipeline(el));
    el.querySelector('#plIdea')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !running()) startPipeline(el);
    });

    // 参考图（图生图，保持风格/形象统一）
    el.querySelector('#plRefPick')?.addEventListener('click', () => el.querySelector('#plRefFile')?.click());
    el.querySelector('#plRefFile')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return UI.toast('参考图请小于 8MB', 'warn');
      state.refImage = await UI.fileToDataUrl(f);
      save();
      render(el);
      UI.toast('参考图已添加，画面将参考其风格生成', 'ok');
    });
    el.querySelector('#plRefRemove')?.addEventListener('click', () => {
      state.refImage = '';
      save();
      render(el);
    });

    renderBody(el);
  }

  /* ---------- 停止 ---------- */
  function stopPipeline(el) {
    runToken = null;
    progress = null;
    if (isBusyPhase()) state.phase = 'paused';
    save();
    UI.toast('已停止流水线（已完成的素材会保留，可手动继续）', 'warn');
    render(el);
  }

  function renderBody(el) {
    const body = el.querySelector('#plBody');
    if (!body) return;

    if (state.phase === 'idle' || state.phase === 'split') {
      body.innerHTML = `<div class="empty-state"><div class="big-ico">🏭</div>
        <p>流水线将自动完成全部环节：<br><b>创意 → 分镜 → 画面 → 视频 → 成片</b></p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:6px">
          <button class="btn" id="plDemoIdea">💡 用示例创意</button>
          <button class="btn" id="plFromBoard">📋 从故事板导入</button>
        </div></div>`;
      body.querySelector('#plDemoIdea')?.addEventListener('click', () => {
        document.querySelector('#plIdea').value = '一条 15 秒的夏日冰饮种草视频：清晨海滩，主角跑进海边便利店，打开冰柜拿起一瓶汽水，转身面向镜头开瓶畅饮，气泡升腾，字幕"夏日限定"，结尾品牌 logo';
        UI.toast('示例创意已填入，点击启动流水线', 'ok');
      });
      body.querySelector('#plFromBoard')?.addEventListener('click', () => {
        const sb = window.StoryboardView.getShots();
        if (!sb.length) return UI.toast('故事板是空的，请先添加场景', 'warn');
        state.shots = sb.map((s) => ({
          visual: s.visual, camera: s.camera, duration: s.duration, audio: s.audio,
          imageUrl: s.imageUrl || '', videoTaskId: s.videoTaskId || '', videoUrl: s.videoUrl || '', error: '',
        }));
        state.idea = '从故事板导入';
        state.phase = 'paused';
        state.currentPhaseIdx = 0;
        save();
        render(el);
        UI.toast(`已从故事板导入 ${state.shots.length} 个分镜，可启动流水线或逐个手动生成`, 'ok');
      });
      return;
    }

    // paused 状态提示条：说明可手动/可继续
    const pausedTip = (state.phase === 'paused' && !running()) ? `
      <div class="card" style="margin-bottom:12px;border-color:rgba(250,204,21,.35)">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span>⏸ 流水线已暂停。已完成的素材保留，你可以：</span>
          <button class="btn btn-sm btn-primary" id="plResume">▶ 继续自动流程</button>
          <span style="font-size:12px;color:var(--text-3)">或在下方逐个镜头手动生成</span>
        </div>
      </div>` : '';

    // 每个镜头的进度信息
    const imgDone = state.shots.filter((s) => s.imageUrl).length;
    const vidDone = state.shots.filter((s) => s.videoUrl).length;
    const errCount = state.shots.filter((s) => s.error).length;

    body.innerHTML = `
      ${pausedTip}
      <div class="pline-stage">
        <div class="pline-stage-head">
          <h3>📋 分镜列表（${state.shots.length} 镜）</h3>
          <span style="font-size:12px;color:var(--text-2)">🖼️ 画面 ${imgDone}/${state.shots.length} · 🎬 视频 ${vidDone}/${state.shots.length}${errCount ? ` · ❌ 失败 ${errCount}` : ''}</span>
          <span style="flex:1"></span>
          ${running() && state.phase === 'videos' ? `<span class="badge badge-run">视频生成中… <span class="spinner sm" style="vertical-align:-4px"></span></span>` : ''}
          ${running() && state.phase === 'images' ? `<span class="badge badge-run">画面生成中…</span>` : ''}
          ${!running() && ['edit', 'done'].includes(state.phase) ? `<span class="badge badge-ok">全部完成 ✓</span>` : ''}
        </div>
        <div class="shots">
          ${state.shots.map((s, i) => `
            <div class="shot-card">
              <div class="shot-head">
                <span class="sb-num">${i + 1}</span>
                <span class="badge ${s.error ? 'badge-err' : s.videoUrl ? 'badge-ok' : s.videoTaskId ? 'badge-run' : s.imageUrl ? 'badge-ok' : 'badge-wait'}" style="font-size:10px" ${s.error ? `title="${UI.escapeHtml(s.error)}"` : ''}>
                  ${s.error ? '❌ 失败' : s.videoUrl ? '成片✓' : s.videoTaskId ? '视频中' : s.imageUrl ? '画面✓' : '待生成'}
                </span>
                <span style="font-size:11px;color:var(--text-3)">${s.camera || '固定镜头'} · ${s.duration || 5}s</span>
              </div>
              <div class="shot-note">${UI.escapeHtml(s.visual)}${s.audio ? `\n🎙️ ${UI.escapeHtml(s.audio)}` : ''}</div>
              <div class="shot-media">
                ${s.videoUrl ? `<video src="${API.proxyUrl(s.videoUrl)}" muted preload="metadata" controls playsinline style="width:100%;height:100%;object-fit:cover"></video>`
                  : s.imageUrl ? `<img src="${API.proxyUrl(s.imageUrl)}">`
                  : `<span class="ph">${s.error ? `<span style="color:var(--danger);font-size:11px;text-align:center;padding:0 8px">${UI.escapeHtml(String(s.error).slice(0, 80))}</span>` : state.phase === 'images' ? '<span class="spinner sm"></span>' : '等待生成'}</span>`}
              </div>
              <div class="shot-foot" style="flex-wrap:wrap;gap:6px">
                <span>${s.error ? '❌ 生成失败' : s.videoUrl ? '✅ 视频就绪' : s.videoTaskId ? '⏳ 云端生成中' : s.imageUrl ? '🖼️ 画面就绪' : '—'}</span>
                <span style="flex:1"></span>
                ${s.videoUrl ? `<button class="btn btn-sm" data-op="play" data-idx="${i}" title="预览视频">▶ 预览</button>` : ''}
                ${s.videoUrl ? `<button class="btn btn-sm" data-op="regen-v" data-idx="${i}" title="丢弃当前视频重新生成">🔄 重新生视频</button>` : ''}
                ${!s.imageUrl && !s.error ? `<button class="btn btn-sm" data-op="gen-img" data-idx="${i}">🖼️ 生图</button>` : ''}
                ${s.imageUrl && !s.videoUrl && !s.error && !s.videoTaskId ? `<button class="btn btn-sm" data-op="gen-vid" data-idx="${i}">🎬 生视频</button>` : ''}
                ${s.imageUrl && !s.videoUrl ? `<button class="btn btn-sm" data-op="reimg" data-idx="${i}" title="重新生成画面">🔁 换图</button>` : ''}
                ${s.error ? `<button class="btn btn-sm" data-op="retry" data-idx="${i}">🔄 重试</button>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>
      ${(['edit', 'done', 'paused'].includes(state.phase) && !running()) ? `
        <div class="card" style="border-color:${errCount ? 'rgba(255,99,132,.4)' : 'rgba(52,211,153,.4)'};background:linear-gradient(135deg,rgba(52,211,153,.08),rgba(108,92,231,.08))">
          <div class="card-title"><span class="ico">${errCount ? '⚠️' : '🎉'}</span>${errCount ? '部分素材生成失败，可重试后继续' : (vidDone ? '素材已就绪，进入最后一步' : '画面已就绪，可继续生成视频')}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${vidDone ? '<button class="btn btn-primary" id="plGoEdit">✂️ 打开智能剪辑，合成成片</button>' : ''}
            <button class="btn" id="plGenAllVid" ${imgDone === state.shots.length ? '' : 'disabled'}>🎬 一键生成全部视频</button>
            ${errCount ? '<button class="btn" id="plRetryFails">🔄 重试失败项</button>' : ''}
            <button class="btn" id="plRerun">🔄 重新运行流水线</button>
          </div>
        </div>` : ''}`;

    // 暂停后继续
    body.querySelector('#plResume')?.addEventListener('click', () => startPipeline(el));

    body.querySelectorAll('[data-op="play"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = state.shots[Number(btn.dataset.idx)];
        if (s?.videoUrl) {
          UI.modal(`<video src="${API.proxyUrl(s.videoUrl)}" controls autoplay style="width:100%;border-radius:10px;background:#000"></video>`, { title: `分镜 ${Number(btn.dataset.idx) + 1}` });
        }
      });
    });

    // 单镜头：生图
    body.querySelectorAll('[data-op="gen-img"]').forEach((btn) => {
      btn.addEventListener('click', () => genImageForShot(el, Number(btn.dataset.idx)));
    });
    // 单镜头：换图
    body.querySelectorAll('[data-op="reimg"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = state.shots[Number(btn.dataset.idx)];
        if (s) { s.imageUrl = ''; genImageForShot(el, Number(btn.dataset.idx)); }
      });
    });
    // 单镜头：生视频
    body.querySelectorAll('[data-op="gen-vid"]').forEach((btn) => {
      btn.addEventListener('click', () => genVideoForShot(el, Number(btn.dataset.idx)));
    });
    // 丢弃重生成视频
    body.querySelectorAll('[data-op="regen-v"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = state.shots[Number(btn.dataset.idx)];
        if (s) { s.videoUrl = ''; s.videoTaskId = ''; genVideoForShot(el, Number(btn.dataset.idx)); }
      });
    });

    // 单镜头重试 / 批量重试失败项
    body.querySelectorAll('[data-op="retry"]').forEach((btn) => {
      btn.addEventListener('click', () => retryShot(el, Number(btn.dataset.idx)));
    });
    body.querySelector('#plRetryFails')?.addEventListener('click', () => {
      state.shots.forEach((s, i) => { if (s.error) retryShot(el, i); });
    });

    // 一键生成全部视频
    body.querySelector('#plGenAllVid')?.addEventListener('click', async () => {
      const targets = state.shots.filter((s) => s.imageUrl && !s.videoUrl && !s.videoTaskId);
      if (!targets.length) return UI.toast('没有可生成视频的镜头', 'ok');
      UI.toast(`开始生成 ${targets.length} 个视频…`, 'ok');
      await generateVideos(el, targets);
    });

    const goEdit = body.querySelector('#plGoEdit');
    if (goEdit) goEdit.addEventListener('click', () => {
      window.MA.nav('editor');
      state.shots.filter((s) => s.videoUrl).forEach((s) => {
        window.MA.dispatch('editor:addRemote', { url: s.videoUrl, name: `分镜${state.shots.indexOf(s) + 1}`, type: 'video' });
      });
      UI.toast('分镜视频已全部加入时间线，点击「导出成片」', 'ok');
    });

    body.querySelector('#plRerun')?.addEventListener('click', () => {
      runToken = null;
      state = { phase: 'idle', idea: state.idea, shots: [], currentPhaseIdx: -1 };
      save();
      render(el);
    });
  }

  /* ---------- 单镜头：生成画面 ---------- */
  async function genImageForShot(el, idx) {
    const s = state.shots[idx];
    if (!s || !s.visual) return UI.toast('该镜头没有画面描述', 'warn');
    s.error = '';
    s.imgBusy = true;
    save(); renderBody(el);
    try {
      // 有参考图 → 图生图（风格/形象参考）；提示词强调保持一致
      const hasRef = !!state.refImage;
      const prompt = hasRef
        ? `参考所给图片的风格与人物形象（保持角色特征、画风、色调一致）：${s.visual}${s.camera && s.camera !== '固定镜头' ? `，镜头运动：${s.camera}` : ''}`
        : s.visual + (s.camera && s.camera !== '固定镜头' ? `，镜头运动：${s.camera}` : '');
      const data = await API.genImage({
        model: hasRef ? 'doubao-seedream-4-5-251128' : 'doubao-seedream-4-0-250828', // 4.5 支持多图融合/图生图
        prompt,
        size: '2k', count: 1,
        images: hasRef ? [state.refImage] : [],
      });
      s.imageUrl = data.items?.[0]?.url || '';
      if (!s.imageUrl) throw new Error('生图返回空结果');
      UI.toast(`分镜 ${idx + 1} 画面完成 ✅`, 'ok', 2000);
    } catch (e) {
      s.error = e.message;
      UI.toast(`分镜 ${idx + 1} 生图失败：${e.message}`.slice(0, 100), 'err', 6000);
    } finally {
      s.imgBusy = false;
      save(); renderBody(el);
    }
  }

  /* ---------- 单镜头：生成视频（含轮询到出片） ---------- */
  async function genVideoForShot(el, idx, { silent = false } = {}) {
    const s = state.shots[idx];
    if (!s) return;
    if (!s.imageUrl) {
      // 没图先生图
      await genImageForShot(el, idx);
      if (!s.imageUrl) return; // 生图失败已提示
    }
    s.error = '';
    s.vidBusy = true;
    save(); renderBody(el);
    try {
      const data = await API.createVideo({
        model: 'doubao-seedance-2-0-260128',
        text: (s.visual || '画面自然动起来') + (s.camera && s.camera !== '固定镜头' ? `，镜头${s.camera}` : '') + (s.audio ? `，${s.audio}` : ''),
        imageUrl: s.imageUrl,
        ratio: '16:9',
        duration: Math.min(Number(s.duration) || 5, 10),
        resolution: '720p',
      });
      if (!data?.id) throw new Error('任务创建失败：未返回任务 ID');
      s.videoTaskId = data.id;
      save(); renderBody(el);
      if (!silent) UI.toast(`分镜 ${idx + 1} 视频任务已提交，云端生成中…`, 'ok', 2500);
      await pollShotVideo(el, s, idx);
    } catch (e) {
      s.error = e.message;
      UI.toast(`分镜 ${idx + 1} 视频提交失败：${e.message}`.slice(0, 100), 'err', 6000);
    } finally {
      s.vidBusy = false;
      save(); renderBody(el);
    }
  }

  /* ---------- 轮询单个镜头视频 ---------- */
  function pollShotVideo(el, s, idx) {
    return new Promise((resolve) => {
      let elapsed = 0;
      const tick = async () => {
        if (!s.videoTaskId) return resolve();
        try {
          const data = await API.videoStatus(s.videoTaskId);
          if (data.videoUrl) {
            s.videoUrl = data.videoUrl;
            try {
              await Store.add({ type: 'video', kind: 'ai-video', title: (s.visual || '').slice(0, 36), url: data.videoUrl, prompt: s.visual });
            } catch { /* ignore */ }
            UI.toast(`分镜 ${idx + 1} 视频生成完成 🎉`, 'ok', 3000);
            save(); renderBody(el);
            return resolve();
          }
          if (['failed', 'expired', 'cancelled'].includes(data.status)) {
            s.videoTaskId = '';
            s.error = '视频生成失败（云端返回 ' + data.status + '）';
            save(); renderBody(el);
            return resolve();
          }
          // 进度提示
          if (data.progress != null) {
            const info = el?.querySelector('#plVideoProg');
            if (info) info.textContent = `分镜 ${idx + 1}：云端进度 ${Math.round(data.progress * 100)}%`;
          }
        } catch { /* 网络抖动，下轮重试 */ }
        elapsed += 5;
        if (elapsed > 600) { // 10 分钟超时
          s.error = '视频生成超时（10 分钟）';
          s.videoTaskId = '';
          save(); renderBody(el);
          return resolve();
        }
        setTimeout(tick, 5000);
      };
      tick();
    });
  }

  /* ---------- 单镜头重试 ---------- */
  async function retryShot(el, idx) {
    const s = state.shots[idx];
    if (!s) return;
    s.error = '';
    save(); renderBody(el);
    if (!s.imageUrl) {
      await genImageForShot(el, idx);
      if (!s.imageUrl) return;
    }
    if (!s.videoUrl) await genVideoForShot(el, idx);
  }

  /* ---------- 批量生成视频（手动触发版） ---------- */
  async function generateVideos(el, targets) {
    for (const s of targets) {
      const idx = state.shots.indexOf(s);
      await genVideoForShot(el, idx, { silent: true });
    }
  }

  /* ---------- 流水线执行 ---------- */
  async function startPipeline(el) {
    const ideaEl = el.querySelector('#plIdea');
    const idea = (ideaEl?.value || '').trim() || state.idea;
    if (!idea) return UI.toast('请输入创意想法', 'warn');
    if (running()) return;

    const token = Symbol('pipeline');
    runToken = token;
    const alive = () => runToken === token;

    state.idea = idea;
    save();

    try {
      // Step 1: AI 拆解
      if (!state.shots.length) {
        setPhase(el, 'split');
        progress = { key: 'split', done: 0, total: 1, label: '🧠 AI 正在拆解分镜…' };
        render(el);
        try {
          const sys = '你是资深分镜导演。把用户创意拆解为 4-8 个镜头，严格输出 JSON 数组，格式：[{"visual":"画面描述（主体/动作/环境/光影，40-80字）","camera":"推近/拉远/摇/环绕/固定等","duration":5,"audio":"音效或台词"}],不要输出任何其他内容。';
          const reply = await API.chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: idea }], temperature: 0.7 });
          const arr = JSON.parse(reply.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0] || '[]');
          if (!arr.length) throw new Error('AI 未返回有效分镜');
          state.shots = arr.map((s) => ({
            visual: s.visual || '', camera: s.camera || '固定镜头',
            duration: Number(s.duration || 5), audio: s.audio || '',
            imageUrl: '', videoTaskId: '', videoUrl: '', error: '',
          }));
          progress = { key: 'split', done: 1, total: 1, label: '🧠 拆解完成' };
          save();
          UI.toast(`✅ 拆解完成：${arr.length} 个分镜`, 'ok');
        } catch (e) {
          setPhase(el, 'idle');
          progress = null;
          const msg = e.message || '';
          if (/does not exist|do not have access|not supported|not found/i.test(msg)) {
            UI.toast('⚠️ 对话模型不可用：请到创意助手「对话模型」卡片检测可用模型后保存', 'err', 8000);
          } else {
            UI.toast(`分镜拆解失败：${e.message}`, 'err', 6000);
          }
          render(el);
          return;
        }
        if (!alive()) return; // 已停止
      }

      // Step 2: 批量生图（并发 2，带进度）
      const noImg = state.shots.filter((s) => !s.imageUrl);
      if (noImg.length) {
        setPhase(el, 'images');
        progress = { key: 'images', done: 0, total: noImg.length, label: '🖼️ 正在批量生成画面' };
        render(el);
        let done = 0;
        const run = async (shot) => {
          if (!alive()) return;
          try {
            // 参考图 → 图生图（风格/形象统一）
            const hasRef = !!state.refImage;
            const prompt = hasRef
              ? `参考所给图片的风格与人物形象（保持角色特征、画风、色调一致）：${shot.visual}${shot.camera && shot.camera !== '固定镜头' ? `，镜头运动：${shot.camera}` : ''}`
              : shot.visual + (shot.camera && shot.camera !== '固定镜头' ? `，镜头运动：${shot.camera}` : '');
            const data = await API.genImage({
              model: hasRef ? 'doubao-seedream-4-5-251128' : 'doubao-seedream-4-0-250828',
              prompt,
              size: '2k', count: 1,
              images: hasRef ? [state.refImage] : [],
            });
            shot.imageUrl = data.items?.[0]?.url || '';
            if (!shot.imageUrl) throw new Error('生图返回空结果');
          } catch (e) {
            shot.error = e.message;
          }
          done++;
          progress = { key: 'images', done, total: noImg.length, label: '🖼️ 正在批量生成画面' };
          save();
          render(el);
        };
        const queue = noImg.slice();
        const workers = [0, 1].map(async () => {
          while (queue.length && alive()) {
            const shot = queue.shift();
            await run(shot);
          }
        });
        await Promise.all(workers);
        if (!alive()) return; // 已停止
        const failCount = state.shots.filter((s) => s.error).length;
        if (failCount) {
          const firstErr = state.shots.find((s) => s && s.error);
          UI.toast(`⚠️ ${failCount} 个画面生成失败：${(firstErr && firstErr.error) || '未知错误'}`.slice(0, 120), 'err', 8000);
        } else {
          UI.toast('✅ 全部画面生成完成', 'ok');
        }
        progress = null;
        save();
      }

      // Step 3: 批量生视频（逐个提交 + 并行轮询，带进度）
      const noVideo = state.shots.filter((s) => s.imageUrl && !s.videoTaskId && !s.videoUrl);
      if (noVideo.length) {
        setPhase(el, 'videos');
        progress = { key: 'videos', done: 0, total: noVideo.length, label: '🎬 正在批量生成视频' };
        render(el);
        // 先全部提交任务
        for (const shot of noVideo) {
          if (!alive()) return;
          try {
            const data = await API.createVideo({
              model: 'doubao-seedance-2-0-260128',
              text: (shot.visual || '画面自然动起来') + (shot.camera && shot.camera !== '固定镜头' ? `，镜头${shot.camera}` : '') + (shot.audio ? `，${shot.audio}` : ''),
              imageUrl: shot.imageUrl,
              ratio: '16:9',
              duration: Math.min(Number(shot.duration) || 5, 10),
              resolution: '720p',
            });
            if (data?.id) shot.videoTaskId = data.id;
            else shot.error = '任务创建失败：未返回任务 ID';
          } catch (e) {
            shot.error = e.message;
          }
          save();
          renderBody(el);
        }
        if (!alive()) return;
        // 并行轮询所有任务
        let vidDone = 0;
        const vidTotal = noVideo.filter((s) => s.videoTaskId).length;
        await Promise.all(noVideo.filter((s) => s.videoTaskId).map((shot) => new Promise((resolve) => {
          let elapsed = 0;
          const tick = async () => {
            if (!alive() || !shot.videoTaskId) return resolve();
            try {
              const data = await API.videoStatus(shot.videoTaskId);
              if (data.videoUrl) {
                shot.videoUrl = data.videoUrl;
                try { await Store.add({ type: 'video', kind: 'ai-video', title: (shot.visual || '').slice(0, 36), url: data.videoUrl, prompt: shot.visual }); } catch { /* ignore */ }
                vidDone++;
                progress = { key: 'videos', done: vidDone, total: vidTotal, label: '🎬 正在批量生成视频' };
                save(); renderBody(el);
                return resolve();
              }
              if (['failed', 'expired', 'cancelled'].includes(data.status)) {
                shot.videoTaskId = '';
                shot.error = '视频生成失败';
                vidDone++;
                progress = { key: 'videos', done: vidDone, total: vidTotal, label: '🎬 正在批量生成视频' };
                save(); renderBody(el);
                return resolve();
              }
            } catch { /* 下轮重试 */ }
            elapsed += 5;
            if (elapsed > 600) {
              shot.error = '视频生成超时（10 分钟）';
              shot.videoTaskId = '';
              save(); renderBody(el);
              return resolve();
            }
            setTimeout(tick, 5000);
          };
          tick();
        })));
        if (!alive()) return;
        UI.toast('✅ 全部视频生成完成', 'ok');
        progress = null;
      }

      // Step 4: 完成
      setPhase(el, 'done');
      progress = null;
      save();
      render(el);
    } finally {
      if (runToken === token) runToken = null;
    }
  }

  function setPhase(el, phase) {
    state.phase = phase;
    state.currentPhaseIdx = PHASES.findIndex((p) => p.key === phase);
    save();
    render(el);
  }

  /** 从故事板导入（事件） */
  function fromStoryboard() {
    const sb = window.StoryboardView.getShots();
    if (sb.length) {
      state.shots = sb.map((s) => ({
        visual: s.visual, camera: s.camera, duration: s.duration, audio: s.audio,
        imageUrl: s.imageUrl || '', videoTaskId: s.videoTaskId || '', videoUrl: s.videoUrl || '', error: '',
      }));
      state.idea = '从故事板导入';
      state.phase = 'paused';
      state.currentPhaseIdx = 0;
      save();
      const el = document.querySelector('#content');
      if (el) render(el);
      UI.toast(`已导入 ${state.shots.length} 个分镜`, 'ok');
    }
  }

  return { render, fromStoryboard };
})();
