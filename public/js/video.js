/* ============================================================
 * video.js — AI 生视频（火山方舟 doubao-seedance 系列）
 * 文生视频 / 图生视频（首帧） / 任务轮询 / 作品流转
 * ============================================================ */
window.VideoView = (() => {
  const MODELS = [
    { id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', note: '30s 超长叙事 · 最新' },
    { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0', note: '高质量 · 多模态参考' },
    { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro', note: '稳定 · 支持音频' },
    { id: 'doubao-seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Fast', note: '极速 · 低延迟' },
  ];
  const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive'];
  const DURATIONS = [3, 5, 8, 10, 15, 20, 30];
  const RESOLUTIONS = ['480p', '720p', '1080p'];
  const PRESETS = [
    '镜头缓缓推近，人物转身看向镜头，微笑，背景城市夜景虚化，电影质感',
    '无人机航拍穿越云层，俯瞰雪山湖泊，光线从云隙洒下，震撼大场面',
    '产品特写旋转展示，灯光扫过表面，背景暗色渐变，商业广告质感',
    '小猫在窗边打哈欠，阳光洒进来，毛发细节清晰，治愈系',
  ];

  const TASKS_STORE = 'materall_video_tasks'; // 任务历史持久化（刷新后仍在，同域名内可见）
  let tasks = loadTasks(); // {id, text, model, time, status, videoUrl, error, polling}
  let firstFrameUrl = '';

  /** 读取历史任务（恢复 polling=false；过期的排队任务忽略） */
  function loadTasks() {
    try {
      const j = JSON.parse(localStorage.getItem(TASKS_STORE) || '[]');
      if (!Array.isArray(j)) return [];
      const now = Date.now();
      return j
        .filter((t) => t && t.id && ((t.status !== 'queued' && t.status !== 'running') || (t.time || 0) > now - 2 * 3600e3))
        .map((t) => ({ ...t, polling: false }));
    } catch { return []; }
  }
  function saveTasks() {
    try {
      const light = tasks.slice(0, 50).map((t) => ({
        id: t.id, text: t.text, model: t.model, time: t.time,
        status: t.status, videoUrl: t.videoUrl || null, error: t.error || '',
      }));
      localStorage.setItem(TASKS_STORE, JSON.stringify(light));
    } catch { /* ignore */ }
  }

  function render(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <div class="gen-panel">
          <div class="card">
            <div class="card-title"><span class="ico">🎬</span>视频生成参数</div>

            <div class="tabs" id="videoMode">
              <div class="tab active" data-mode="t2v">文生视频</div>
              <div class="tab" data-mode="i2v">图生视频</div>
            </div>

            <label class="field">
              <span class="field-label">模型</span>
              <select class="input" id="videoModel">
                ${MODELS.map((m) => `<option value="${m.id}">${m.name}（${m.note}）</option>`).join('')}
              </select>
            </label>

            <div id="i2vPanel" style="display:none">
              <label class="field">
                <span class="field-label">首帧图片</span>
                <div id="firstFrameBox" style="display:flex;gap:8px;align-items:center">
                  <input type="file" id="videoFrameFile" accept="image/*" style="display:none">
                  <button class="btn btn-sm" id="btnPickFrame">📁 上传图片</button>
                  <button class="btn btn-sm" id="btnClearFrame" style="display:none">✕ 清除</button>
                </div>
                <div id="framePreview" style="margin-top:8px;display:none">
                  <img id="framePreviewImg" style="max-width:180px;border-radius:9px;border:1px solid var(--border-light)">
                </div>
                <span class="field-hint">也可以先在「AI 生图」中生成，再从结果点「🎬 生视频」</span>
              </label>
            </div>

            <label class="field">
              <span class="field-label">视频描述</span>
              <textarea class="input" id="videoPrompt" placeholder="描述画面主体、动作、运镜、环境、光影… 越具体效果越好" style="min-height:110px"></textarea>
            </label>
            <div class="prompt-presets" id="videoPresets">
              ${PRESETS.map((p) => `<span class="preset-chip">${p.slice(0, 14)}…</span>`).join('')}
            </div>

            <div class="grid grid-2" style="gap:10px;margin-top:12px">
              <label class="field">
                <span class="field-label">画面比例</span>
                <select class="input" id="videoRatio">${RATIOS.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
              </label>
              <label class="field">
                <span class="field-label">时长（秒）</span>
                <select class="input" id="videoDuration">${DURATIONS.map((d) => `<option value="${d}">${d}s</option>`).join('')}</select>
              </label>
              <label class="field">
                <span class="field-label">分辨率</span>
                <select class="input" id="videoResolution">${RESOLUTIONS.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
              </label>
              <label class="field">
                <span class="field-label">随机种子</span>
                <input class="input" id="videoSeed" placeholder="可选">
              </label>
            </div>

            <label style="display:flex;align-items:center;gap:14px;font-size:13px;color:var(--text-2);margin-bottom:14px">
              <span><input type="checkbox" id="videoAudio" checked style="accent-color:var(--primary-2)"> 生成同步音频</span>
              <span><input type="checkbox" id="videoWm" style="accent-color:var(--primary-2)"> 水印</span>
            </label>

            <button class="btn btn-primary btn-block" id="videoSubmit">🚀 提交生成任务</button>
            <p style="font-size:11.5px;color:var(--text-3);margin-top:8px;text-align:center">任务将在云端异步生成，通常需要 1-5 分钟</p>
          </div>
        </div>

        <div class="gen-result">
          <div class="card" style="min-height:480px">
            <div class="card-title"><span class="ico">🎬</span>任务列表 <span class="badge badge-wait" id="videoTaskCount">0 个任务</span></div>
            <div id="videoTaskList" class="task-list">
              <div class="empty-state"><div class="big-ico">🎬</div><p>提交任务后将在这里实时跟踪生成进度<br>完成后可下载、保存，或直接送入「智能剪辑」</p></div>
            </div>
          </div>
        </div>
      </div>`;

    /* ---- 交互 ---- */
    const promptEl = el.querySelector('#videoPrompt');
    const modelSel = el.querySelector('#videoModel');
    const durationSel = el.querySelector('#videoDuration');

    // 模型联动：Seedance 2.5 最短支持 5 秒（t2v/i2v），其余模型支持 3 秒起
    function syncDurationOptions() {
      const isV25 = modelSel.value.includes('seedance-2-5');
      const options = (isV25 ? [5, 8, 10, 15, 20, 30] : [3, 5, 8, 10, 15, 20, 30]);
      durationSel.innerHTML = options.map((d) => `<option value="${d}">${d}s</option>`).join('');
    }
    syncDurationOptions();
    modelSel.addEventListener('change', syncDurationOptions);

    el.querySelectorAll('#videoMode .tab').forEach((tab) => tab.addEventListener('click', () => {
      el.querySelectorAll('#videoMode .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      el.querySelector('#i2vPanel').style.display = tab.dataset.mode === 'i2v' ? 'block' : 'none';
    }));

    el.querySelector('#videoPresets').addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (chip) promptEl.value = PRESETS[Array.from(chip.parentNode.children).indexOf(chip)];
    });

    // 首帧图
    const framePreview = el.querySelector('#framePreview');
    const framePreviewImg = el.querySelector('#framePreviewImg');
    const btnClearFrame = el.querySelector('#btnClearFrame');
    el.querySelector('#btnPickFrame').addEventListener('click', () => el.querySelector('#videoFrameFile').click());
    el.querySelector('#videoFrameFile').addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      firstFrameUrl = await UI.fileToDataUrl(f);
      framePreview.style.display = 'block';
      framePreviewImg.src = firstFrameUrl;
      btnClearFrame.style.display = '';
    });
    btnClearFrame.addEventListener('click', () => {
      firstFrameUrl = '';
      framePreview.style.display = 'none';
      btnClearFrame.style.display = 'none';
      el.querySelector('#videoFrameFile').value = '';
    });

    // 提交任务
    el.querySelector('#videoSubmit').addEventListener('click', submit);
    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });

    renderTasks(el);
    // 恢复历史：对仍排队的任务续上轮询（进入页面时刷新一次状态）
    setTimeout(() => {
      tasks.filter((t) => (t.status === 'queued' || t.status === 'running') && !t.polling)
        .forEach((t) => pollTask(t.id));
    }, 800);
  }

  async function submit() {
    const text = document.querySelector('#videoPrompt')?.value.trim();
    if (!text) return UI.toast('请先填写视频描述', 'warn');
    const useImage = document.querySelector('#i2vPanel')?.style.display !== 'none';
    if (useImage && !firstFrameUrl) return UI.toast('图生视频模式需要先选择首帧图片', 'warn');

    const btn = document.querySelector('#videoSubmit');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner sm"></div> 提交中…';
    try {
      const data = await API.createVideo({
        model: document.querySelector('#videoModel').value,
        text,
        imageUrl: useImage ? firstFrameUrl : null,
        ratio: document.querySelector('#videoRatio').value,
        duration: Number(document.querySelector('#videoDuration').value),
        resolution: document.querySelector('#videoResolution').value,
        generateAudio: document.querySelector('#videoAudio').checked,
        watermark: document.querySelector('#videoWm').checked,
        seed: document.querySelector('#videoSeed').value,
      });
      const task = {
        id: data.id,
        text,
        model: document.querySelector('#videoModel').value,
        time: Date.now(),
        status: 'queued',
        videoUrl: null,
        polling: false,
      };
      tasks = [task, ...tasks];
      saveTasks();
      renderTasks(document.querySelector('#videoTaskList')?.closest('.gen-result'));
      UI.toast('任务已提交，正在排队生成', 'ok');
      pollTask(task.id);
    } catch (e) {
      // 提交失败的错误直达用户：加入失败任务列表展示，而非仅一闪而过的 toast
      const msg = e.message || String(e);
      let hint = '';
      if (/api key|authentication|401/i.test(msg)) hint = 'API Key 无效：请到「连接设置」填入有效的方舟 Key（sk- 开头）';
      else if (/does not exist|do not have access/i.test(msg)) hint = '模型未开通：请到方舟「模型广场」开通所选 Seedance 模型';
      else if (/429|quota|rate/i.test(msg)) hint = '请求过快或配额不足，请稍后重试';
      tasks = [{ id: 'err_' + Date.now(), text, model: document.querySelector('#videoModel').value, time: Date.now(), status: 'failed', videoUrl: null, error: hint || msg.slice(0, 100), polling: false }, ...tasks];
      saveTasks();
      renderTasks(document.querySelector('#videoTaskList')?.closest('.gen-result'));
      UI.toast(hint || msg.slice(0, 80), 'err', 7000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🚀 提交生成任务';
    }
  }

  async function pollTask(id, retry = 0) {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.polling) return;
    task.polling = true;
    try {
      const data = await API.videoStatus(id);
      task.status = data.status || 'queued';
      if (data.videoUrl) {
        task.videoUrl = data.videoUrl;
        task.status = 'succeeded';
        saveTasks();
        // 自动保存到作品中心
        try {
          await Store.add({
            type: 'video', kind: 'ai-video',
            title: task.text.slice(0, 40),
            url: data.videoUrl,
            prompt: task.text,
            model: task.model,
          });
        } catch { /* ignore */ }
        UI.toast('视频生成完成 🎉', 'ok', 4000);
      } else if (data.status === 'failed') {
        task.error = '生成失败';
        saveTasks();
      } else {
        // 继续轮询
        setTimeout(() => { task.polling = false; pollTask(id); }, 5000);
      }
    } catch (e) {
      // 网络错误：重试 3 次后放弃
      if (retry < 3) {
        setTimeout(() => { task.polling = false; pollTask(id, retry + 1); }, 6000);
      } else {
        task.error = e.message;
        UI.toast(`任务状态查询失败：${e.message}`, 'err');
      }
    }
    const container = document.querySelector('#videoTaskList');
    if (container) renderTasks(container.closest('.gen-result'));
  }

  function renderTasks(el) {
    if (!el) return;
    const listEl = el.querySelector('#videoTaskList');
    const countEl = el.querySelector('#videoTaskCount');
    countEl.textContent = `${tasks.length} 个任务`;
    // 预览加载失败（视频链接可能已过期）→ 给出明确提示，用户可用右侧下载
    if (!listEl.__errBound) {
      listEl.__errBound = true;
      listEl.addEventListener('error', (e) => {
        if (!e.target || e.target.tagName !== 'VIDEO') return;
        const item = e.target.closest('.task-item');
        const thumb = item && item.querySelector('.thumb');
        if (item && thumb && !thumb.dataset.fail) {
          thumb.dataset.fail = '1';
          thumb.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:10.5px;color:var(--text-3);text-align:center;padding:2px">⚠️ 预览失败<br>链接可能已过期<br>用右侧「⬇ 下载」</div>';
        }
      }, true);
    }
    if (tasks.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="big-ico">🎬</div><p>提交任务后将在这里实时跟踪生成进度<br>完成后可下载、保存，或直接送入「智能剪辑」</p></div>`;
      return;
    }
    const statusMap = {
      queued: ['badge-wait', '排队中'],
      running: ['badge-run', '生成中'],
      succeeded: ['badge-ok', '已完成'],
      failed: ['badge-err', '失败'],
      expired: ['badge-err', '超时'],
      cancelled: ['badge-err', '已取消'],
    };
    listEl.innerHTML = tasks.map((t) => {
      const [cls, label] = statusMap[t.status] || statusMap.queued;
      const isRun = t.status === 'queued' || t.status === 'running';
      return `
      <div class="task-item" data-task="${t.id}">
        <div class="thumb">
          ${t.videoUrl
            ? `<video src="${API.proxyUrl(t.videoUrl)}" muted preload="metadata"></video>`
            : `<div style="display:flex;align-items:center;justify-content:center;height:100%">${isRun ? '<div class="spinner sm"></div>' : '🎬'}</div>`}
        </div>
        <div class="info">
          <div class="t">${UI.escapeHtml(t.text.slice(0, 46))}</div>
          <div class="s">${UI.fmtTime(t.time)} · ${UI.escapeHtml(t.model)}</div>
          ${isRun ? '<div class="progress-bar"><div class="fill" style="width:45%"></div></div>' : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          <span class="badge ${cls}">${t.error ? '错误' : label}</span>
          ${t.error ? `<span style="font-size:10.5px;color:var(--danger)">${UI.escapeHtml(t.error)}</span>` : ''}
        </div>
        <div class="ops">
          ${t.videoUrl ? `
            <button class="btn btn-sm btn-primary" data-op="edit" data-id="${t.id}">✂️ 剪辑</button>
            <button class="btn btn-sm" data-op="play" data-id="${t.id}">▶ 播放</button>
            <button class="btn btn-sm" data-op="dl" data-id="${t.id}">⬇ 下载</button>
          ` : ''}
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-op]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = tasks.find((x) => x.id === btn.dataset.id);
        if (!t || !t.videoUrl) return;
        if (btn.dataset.op === 'edit') {
          window.MA.nav('editor');
          window.MA.dispatch('editor:addRemote', { url: t.videoUrl, name: t.text.slice(0, 30), type: 'video' });
        } else if (btn.dataset.op === 'play') {
          UI.modal(`<video src="${API.proxyUrl(t.videoUrl)}" controls autoplay style="width:100%;border-radius:10px;background:#000"></video>`, { title: '视频预览' });
        } else if (btn.dataset.op === 'dl') {
          downloadVideo(t);
        }
      });
    });
  }

  /** 下载视频：先经代理拉取为 Blob 再保存；失败给出可读原因 */
  async function downloadVideo(t) {
    try {
      const blob = await API.fetchBlob(t.videoUrl);
      if (!blob || blob.size < 1000) throw new Error('返回内容为空');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `materall_video_${(t.text || 'clip').slice(0, 24)}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      UI.toast('下载已开始', 'ok', 2000);
    } catch (e) {
      const m = String((e && e.message) || e);
      let hint = '视频链接已过期或服务暂不可用，请重新生成';
      if (/401|403|404/.test(m)) hint = '视频链接已过期（生成平台的视频链接有时效），请重新生成一条';
      else if (/Failed to fetch|network|网络/i.test(m)) hint = '网络异常，请稍后重试';
      UI.toast(`下载失败：${hint}`, 'err', 6000);
      console.warn('[dl]', t.videoUrl, e);
    }
  }

  /** 外部：设置首帧图 */
  function setFirstFrame(url) {
    firstFrameUrl = url;
    const preview = document.querySelector('#framePreview');
    const img = document.querySelector('#framePreviewImg');
    const clearBtn = document.querySelector('#btnClearFrame');
    if (preview && img) {
      preview.style.display = 'block';
      img.src = url;
    }
    clearBtn && (clearBtn.style.display = '');
    const i2v = document.querySelector('#i2vPanel');
    if (i2v) i2v.style.display = 'block';
    const tabs = document.querySelectorAll('#videoMode .tab');
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === 'i2v'));
  }

  /** 外部：填充提示词 */
  function fillPrompt(text) {
    const el = document.querySelector('#videoPrompt');
    if (el) { el.value = (el.value ? el.value + '\n' : '') + text; }
  }

  /** 外部：直接提交任务（流水线使用） */
  async function submitTask(params) {
    return API.createVideo(params);
  }

  return { render, setFirstFrame, fillPrompt, submitTask, pollTask };
})();
