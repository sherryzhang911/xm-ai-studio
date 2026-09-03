/* ============================================================
 * storyboard.js — 故事板 Storyboard（可视化剧本）
 * 场景卡片 + 拖拽排序 + AI 批量生图/生视频 + 一键流水线
 * ============================================================ */
window.StoryboardView = (() => {
  const LS_KEY = 'materall_storyboard';
  const CAMERAS = ['固定镜头', '推近', '拉远', '左摇', '右摇', '上摇', '下摇', '环绕', '跟随', '俯拍', '仰拍', '手持'];
  let shots = []; // {id, visual, camera, duration, audio, imageUrl, status, videoTaskId, videoUrl}

  /* ---------- 持久化 ---------- */
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(shots.map((s) => ({
      id: s.id, visual: s.visual, camera: s.camera, duration: s.duration,
      audio: s.audio, imageUrl: s.imageUrl, status: s.status, videoUrl: s.videoUrl,
    }))));
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) shots = JSON.parse(raw);
    } catch { shots = []; }
    return shots;
  }

  /* ---------- 渲染 ---------- */
  function render(el) {
    load();
    el.innerHTML = `
      <div class="sb-toolbar">
        <button class="btn btn-sm" id="sbAddShot">➕ 添加场景</button>
        <button class="btn btn-sm" id="sbAI">✨ AI 生成分镜</button>
        <button class="btn btn-sm" id="sbBatchImage">🖼️ 批量生图</button>
        <button class="btn btn-sm" id="sbBatchVideo">🎬 批量生视频</button>
        <button class="btn btn-primary btn-sm" id="sbPipeline">🏭 一键流水线成片</button>
        <span style="flex:1"></span>
        <span class="badge badge-wait" id="sbCount">0 个场景</span>
        <button class="btn btn-sm btn-ghost" id="sbClear">清空</button>
      </div>
      <div class="card" style="background:transparent;border:none;padding:0">
        <div class="sb-board" id="sbBoard"></div>
      </div>`;
    bindEvents(el);
    renderBoard(el);
  }

  function bindEvents(el) {
    el.querySelector('#sbAddShot').addEventListener('click', () => {
      addShot();
      renderBoard(el);
      UI.toast('已添加场景，请填写画面描述', 'ok');
    });
    el.querySelector('#sbClear').addEventListener('click', () => {
      if (shots.length && confirm('确定清空整个故事板吗？')) {
        shots = [];
        save();
        renderBoard(el);
      }
    });
    el.querySelector('#sbAI').addEventListener('click', () => {
      const text = prompt('输入你的创意想法，AI 将拆解为分镜场景：\n（例如：一条 15 秒的夏日冰饮广告）');
      if (!text) return;
      aiSplit(text, el);
    });
    el.querySelector('#sbBatchImage').addEventListener('click', () => batchImage(el));
    el.querySelector('#sbBatchVideo').addEventListener('click', () => batchVideo(el));
    el.querySelector('#sbPipeline').addEventListener('click', () => {
      window.MA.nav('pipeline');
      window.MA.dispatch('pipeline:fromStoryboard');
    });
  }

  function renderBoard(el) {
    const board = el.querySelector('#sbBoard');
    const count = el.querySelector('#sbCount');
    count.textContent = `${shots.length} 个场景`;
    if (shots.length === 0) {
      board.innerHTML = `<div class="empty-state" style="width:100%">
        <div class="big-ico">📋</div>
        <p>故事板是可视化剧本（Visual Script）<br>添加场景 → 生成画面 → 生成视频 → 一键成片</p>
        <button class="btn btn-primary" onclick="window.MA.dispatch('storyboard:demo')">🚀 加载示例故事板</button>
      </div>`;
      return;
    }
    board.innerHTML = shots.map((s, i) => `
      <div class="sb-card" draggable="true" data-id="${s.id}" data-idx="${i}">
        <div class="sb-top">
          <span class="sb-num">${i + 1}</span>
          <span class="badge badge-wait" style="font-size:10px">${s.videoUrl ? '成片' : s.videoTaskId ? '视频中' : s.imageUrl ? '有画面' : '待生图'}</span>
          <div class="ops">
            <button class="btn-icon" data-op="del" title="删除">🗑</button>
          </div>
        </div>
        <div class="sb-img" data-op="img" title="点击上传/替换画面">
          ${s.imageUrl
            ? `<img src="${API.proxyUrl(s.imageUrl)}" draggable="false">`
            : `<span class="ph">${s.videoUrl ? '🎬 视频已生成' : '🖼️ 点击添加画面 / 批量生图'}</span>`}
        </div>
        <textarea class="sb-note" data-f="visual" placeholder="画面描述（主体 / 动作 / 环境 / 光影）">${UI.escapeHtml(s.visual)}</textarea>
        <div class="sb-params">
          <select data-f="camera" title="镜头运动">
            ${CAMERAS.map((c) => `<option ${s.camera === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <select data-f="duration" title="时长">
            ${[3, 5, 8, 10, 15].map((d) => `<option value="${d}" ${Number(s.duration) === d ? 'selected' : ''}>${d}s</option>`).join('')}
          </select>
        </div>
        <div class="sb-status" data-actions="${s.id}">
          ${s.imageUrl && !s.videoTaskId ? `<button class="btn btn-sm" data-op="genvideo">🎬 生视频</button>` : ''}
          ${!s.imageUrl ? `<button class="btn btn-sm" data-op="genimg">🖼️ 生图</button>` : ''}
          ${s.videoUrl ? `<button class="btn btn-sm" data-op="play">▶ 播放</button>
            <button class="btn btn-sm" data-op="toedit">✂️ 剪辑</button>` : ''}
          ${s.videoTaskId && !s.videoUrl ? `<span class="badge badge-run"><span class="spinner sm"></span>生成中</span>` : ''}
        </div>
      </div>`).join('');

    /* 事件绑定 */
    board.querySelectorAll('.sb-card').forEach((card) => {
      const id = card.dataset.id;
      const shot = shots.find((s) => s.id === id);

      // 拖拽排序
      card.addEventListener('dragstart', (e) => {
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', id);
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        board.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
        card.classList.add('drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop-target');
        const fromId = e.dataTransfer.getData('text/plain');
        if (!fromId || fromId === id) return;
        const from = shots.findIndex((s) => s.id === fromId);
        const to = shots.findIndex((s) => s.id === id);
        if (from < 0 || to < 0) return;
        const [moved] = shots.splice(from, 1);
        shots.splice(to, 0, moved);
        save();
        renderBoard(el);
      });

      // 删除
      card.querySelector('[data-op="del"]').addEventListener('click', () => {
        shots = shots.filter((s) => s.id !== id);
        save();
        renderBoard(el);
      });

      // 上传图片
      card.querySelector('[data-op="img"]').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          shot.imageUrl = await UI.fileToDataUrl(f);
          shot.status = 'ready';
          save();
          renderBoard(el);
        };
        input.click();
      });

      // 字段编辑
      card.querySelectorAll('[data-f]').forEach((ctrl) => {
        const f = ctrl.dataset.f;
        const evt = ctrl.tagName === 'TEXTAREA' ? 'input' : 'change';
        ctrl.addEventListener(evt, () => {
          if (f === 'duration') shot.duration = Number(ctrl.value);
          else shot[f] = ctrl.value;
          save();
        });
      });

      // 操作按钮
      const actions = card.querySelector('[data-actions]');
      if (actions) {
        actions.addEventListener('click', async (e) => {
          const op = e.target.closest('[data-op]')?.dataset.op;
          if (!op) return;
          if (op === 'genimg') await genImageForShot(shot, el);
          if (op === 'genvideo') await genVideoForShot(shot, el);
          if (op === 'play') {
            UI.modal(`<video src="${API.proxyUrl(shot.videoUrl)}" controls autoplay style="width:100%;border-radius:10px;background:#000"></video>`, { title: `场景 ${shots.indexOf(shot) + 1} 视频` });
          }
          if (op === 'toedit') {
            window.MA.nav('editor');
            window.MA.dispatch('editor:addRemote', { url: shot.videoUrl, name: `场景${shots.indexOf(shot) + 1}`, type: 'video' });
          }
        });
      }
    });
  }

  /* ---------- 操作 ---------- */
  function addShot(partial = {}) {
    const shot = {
      id: UI.uid('sb'),
      visual: '',
      camera: '固定镜头',
      duration: 5,
      audio: '',
      imageUrl: '',
      status: 'draft',
      videoTaskId: '',
      videoUrl: '',
      ...partial,
    };
    shots.push(shot);
    save();
    return shot;
  }

  /** AI 拆解创意为分镜 */
  async function aiSplit(text, el) {
    const btn = el.querySelector('#sbAI');
    btn.disabled = true;
    btn.textContent = 'AI 拆解中…';
    try {
      const sys = '你是资深分镜导演。把用户创意拆解为 4-8 个镜头，严格输出 JSON 数组，格式：[{"visual":"画面描述（主体/动作/环境/光影）","camera":"镜头运动（推近/拉远/摇/环绕/固定等）","duration":5,"audio":"音效或台词"}]，不要输出任何其他内容。';
      const reply = await API.chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], temperature: 0.7 });
      const arr = JSON.parse(reply.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0] || '[]');
      if (!arr.length) throw new Error('AI 未返回有效分镜');
      arr.forEach((s) => addShot({
        visual: s.visual || '',
        camera: s.camera || '固定镜头',
        duration: Number(s.duration || 5),
        audio: s.audio || '',
      }));
      UI.toast(`已生成 ${arr.length} 个分镜场景`, 'ok');
    } catch (e) {
      const msg = e.message || '';
      if (/does not exist|do not have access|not supported|not found/i.test(msg)) {
        UI.toast('⚠️ 所有候选对话模型均不可用：请到火山方舟「模型广场」开通任一豆包对话模型，并在创意助手中设置', 'err', 8000);
      } else {
        UI.toast(`拆解失败：${e.message}`, 'err', 6000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ AI 生成分镜';
      renderBoard(el);
    }
  }

  /** 单场景生图 */
  async function genImageForShot(shot, el) {
    if (!shot.visual) return UI.toast('请先填写画面描述', 'warn');
    shot.status = 'generating';
    save();
    renderBoard(el);
    try {
      const data = await API.genImage({
        model: 'doubao-seedream-4-0-250828',
        prompt: shot.visual + (shot.camera && shot.camera !== '固定镜头' ? `，镜头运动：${shot.camera}` : ''),
        size: '1K',
        count: 1,
      });
      const url = data.items?.[0]?.url;
      if (!url) throw new Error('未返回图片');
      shot.imageUrl = url;
      shot.status = 'ready';
      try {
        await Store.add({ type: 'image', kind: 'ai-image', title: shot.visual.slice(0, 36), url, prompt: shot.visual });
      } catch { /* ignore */ }
      UI.toast('场景画面已生成', 'ok');
    } catch (e) {
      shot.status = 'draft';
      UI.toast(`生图失败：${e.message}`, 'err', 6000);
    }
    save();
    renderBoard(el);
  }

  /** 单场景图生视频 */
  async function genVideoForShot(shot, el) {
    if (!shot.imageUrl) return UI.toast('请先生成或上传画面', 'warn');
    if (shot.videoTaskId) return UI.toast('该场景已有视频任务在生成', 'warn');
    shot.videoTaskId = 'pending';
    shot.status = 'video';
    save();
    renderBoard(el);
    try {
      const data = await API.createVideo({
        model: 'doubao-seedance-2-0-260128',
        text: (shot.visual || '画面自然动起来') + (shot.camera && shot.camera !== '固定镜头' ? `，镜头${shot.camera}` : '') + (shot.audio ? `，${shot.audio}` : ''),
        imageUrl: shot.imageUrl,
        ratio: '16:9',
        duration: Math.min(Number(shot.duration) || 5, 10),
        resolution: '720p',
      });
      shot.videoTaskId = data.id;
      save();
      renderBoard(el);
      pollShotVideo(shot, el);
    } catch (e) {
      shot.videoTaskId = '';
      shot.status = 'ready';
      UI.toast(`视频任务提交失败：${e.message}`, 'err', 6000);
      save();
      renderBoard(el);
    }
  }

  async function pollShotVideo(shot, el) {
    try {
      const data = await API.videoStatus(shot.videoTaskId);
      if (data.videoUrl) {
        shot.videoUrl = data.videoUrl;
        shot.status = 'done';
        try {
          await Store.add({ type: 'video', kind: 'ai-video', title: shot.visual.slice(0, 36), url: data.videoUrl, prompt: shot.visual });
        } catch { /* ignore */ }
        UI.toast('场景视频生成完成 🎉', 'ok');
      } else if (data.status === 'failed' || data.status === 'expired') {
        shot.videoTaskId = '';
        shot.status = 'ready';
        UI.toast('场景视频生成失败', 'err');
      } else {
        setTimeout(() => pollShotVideo(shot, el), 5000);
      }
    } catch {
      setTimeout(() => pollShotVideo(shot, el), 6000);
    }
    save();
    renderBoard(el);
  }

  /** 批量生图（顺序执行，避免限流） */
  async function batchImage(el) {
    const pending = shots.filter((s) => !s.imageUrl && s.visual);
    if (!pending.length) return UI.toast('没有待生图的场景（已全部有画面）', 'warn');
    if (!confirm(`将为 ${pending.length} 个场景批量生成画面（逐个进行，约 10-30 秒/张），继续？`)) return;
    for (let i = 0; i < pending.length; i++) {
      UI.toast(`批量生图 ${i + 1}/${pending.length}：场景 ${shots.indexOf(pending[i]) + 1}`, 'info', 2000);
      await genImageForShot(pending[i], el);
    }
    UI.toast('批量生图完成', 'ok');
  }

  /** 批量生视频 */
  async function batchVideo(el) {
    const pending = shots.filter((s) => s.imageUrl && !s.videoTaskId);
    if (!pending.length) return UI.toast('没有待生成视频的场景（需要先有画面）', 'warn');
    if (!confirm(`将为 ${pending.length} 个场景批量提交视频任务，继续？`)) return;
    for (const s of pending) {
      await genVideoForShot(s, el);
    }
    UI.toast('视频任务已全部提交，生成中…', 'ok');
  }

  /* ---------- 外部接口 ---------- */
  function addShots(arr) {
    arr.forEach((s) => addShot(s));
    return shots.length;
  }
  function addImage(url, visual) {
    addShot({ visual: visual || '', imageUrl: url, status: 'ready' });
  }
  function addTextShots(text) {
    // 按段落拆分为场景
    const parts = String(text || '').split(/\n{2,}|(?<=。)\s*(?=[0-9])/).map((p) => p.trim()).filter((p) => p.length > 4);
    if (parts.length === 0) parts.push(text);
    parts.forEach((p) => addShot({ visual: p }));
  }
  function getShots() {
    return shots.slice();
  }
  function demo() {
    shots = [
      { id: UI.uid('sb'), visual: '清晨城市苏醒，航拍缓缓拉远，金色阳光洒满高楼，薄雾缭绕，电影级调色', camera: '拉远', duration: 5, imageUrl: '', status: 'draft', videoTaskId: '', videoUrl: '' },
      { id: UI.uid('sb'), visual: '女主角推开落地窗，伸懒腰，逆光剪影，头发被晨风吹动，特写侧脸', camera: '推近', duration: 5, imageUrl: '', status: 'draft', videoTaskId: '', videoUrl: '' },
      { id: UI.uid('sb'), visual: '一杯冰美式放在窗台，冰块碰撞，气泡上升，微距特写，水珠清晰', camera: '固定镜头', duration: 5, imageUrl: '', status: 'draft', videoTaskId: '', videoUrl: '' },
      { id: UI.uid('sb'), visual: '女主角拿起咖啡转身看向镜头，微笑，背景城市虚化，暖色调收尾', camera: '环绕', duration: 5, imageUrl: '', status: 'draft', videoTaskId: '', videoUrl: '' },
    ];
    save();
    const el = document.querySelector('#content');
    if (el) renderBoard(el);
  }

  return { render, addShots, addImage, addTextShots, getShots, demo };
})();
