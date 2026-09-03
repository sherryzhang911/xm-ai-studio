/* ============================================================
 * image.js — AI 生图（火山方舟 doubao-seedream 系列）
 * 文生图 / 图生图 / 参数面板 / 结果保存与流转
 * ============================================================ */
window.ImageView = (() => {
  const MODELS = [
    { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0', note: '高质量 · 2K/3K/4K' },
    { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0', note: '文生图/图生图/组图 · 4K' },
    { id: 'doubao-seedream-4-5-251128', name: 'Seedream 4.5', note: '多图融合 · 4K' },
  ];
  // 方舟 API 合法尺寸：'宽x高'（如 1024x1792）或 2k / 3k / 4k（不支持 1K）
  const SIZES = ['2k', '3k', '4k', '自定义']; 
  const SIZE_CUSTOM = { w: 1024, h: 1792 };
  const PRESETS = [
    '游戏广告主视觉，赛博朋克风，霓虹光效，角色特写，电影级光影，4K 高清',
    '产品海报，极简白底，产品居中，柔和阴影，高级质感，商业摄影',
    '雪山日出，航拍视角，暖金光洒在山脊，云海翻涌，风光大片，超清细节',
    '治愈系插画，少女与猫，暖色调，手绘质感，细节丰富',
    '电商主图，食品特写，诱人光泽，浅色背景，构图饱满',
  ];

  let results = []; // {url, prompt, model, time, saved}

  function render(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <div class="gen-panel">
          <div class="card">
            <div class="card-title"><span class="ico">🖼️</span>生图参数</div>

            <div class="tabs" id="imgMode">
              <div class="tab active" data-mode="t2i">文生图</div>
              <div class="tab" data-mode="i2i">图生图</div>
            </div>

            <label class="field">
              <span class="field-label">模型</span>
              <select class="input" id="imgModel">
                ${MODELS.map((m) => `<option value="${m.id}">${m.name}（${m.note}）</option>`).join('')}
              </select>
            </label>

            <div id="i2iPanel" style="display:none">
              <label class="field">
                <span class="field-label">参考图（可多选，最多 10 张）</span>
                <input type="file" id="imgRefs" accept="image/*" multiple>
              </label>
              <div id="refPreviews" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
            </div>

            <label class="field">
              <span class="field-label">提示词</span>
              <textarea class="input" id="imgPrompt" placeholder="描述你想生成的画面… 支持中文，含"引号"可提升文字生成准确率" style="min-height:110px"></textarea>
            </label>
            <div class="prompt-presets" id="imgPresets">
              ${PRESETS.map((p) => `<span class="preset-chip">${p.slice(0, 14)}…</span>`).join('')}
            </div>

            <label class="field" style="margin-top:12px">
              <span class="field-label">负面提示词（可选）</span>
              <input class="input" id="imgNegative" placeholder="低质量、模糊、变形等">
            </label>

            <div class="grid grid-2" style="gap:10px">
              <label class="field">
                <span class="field-label">尺寸</span>
                <select class="input" id="imgSize">
                  ${SIZES.map((s) => `<option value="${s}">${s === '自定义' ? '自定义（宽x高）' : s}</option>`).join('')}
                </select>
              </label>
              <label class="field" id="imgSizeCustomWrap" style="display:none">
                <span class="field-label">宽 x 高（像素）</span>
                <input class="input" id="imgSizeCustom" placeholder="如 1024x1792" value="${SIZE_CUSTOM.w}x${SIZE_CUSTOM.h}">
              </label>
              <label class="field">
                <span class="field-label">数量</span>
                <select class="input" id="imgCount">
                  ${[1, 2, 3, 4].map((n) => `<option value="${n}">${n} 张</option>`).join('')}
                </select>
              </label>
            </div>

            <label class="field">
              <span class="field-label">随机种子（可选）</span>
              <input class="input" id="imgSeed" placeholder="留空则随机">
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);margin-bottom:14px">
              <input type="checkbox" id="imgWatermark" style="accent-color:var(--primary-2)"> 添加水印
            </label>

            <button class="btn btn-primary btn-block" id="imgGenerate">✨ 开始生成</button>
          </div>
        </div>

        <div class="gen-result">
          <div class="card" style="min-height:480px">
            <div class="card-title">
              <span class="ico">🖼️</span>生成结果
              <span class="badge badge-wait" id="imgResultMeta">共 0 张</span>
            </div>
            <div id="imgResultGrid" class="result-grid">
              <div class="empty-state"><div class="big-ico">🎨</div><p>设置参数并点击「开始生成」<br>AI 将调用 Seedream 模型创作图片</p></div>
            </div>
          </div>
        </div>
      </div>`;

    /* ---- 交互 ---- */
    const promptEl = el.querySelector('#imgPrompt');
    const modeTabs = el.querySelectorAll('#imgMode .tab');
    const refs = [];
    const refPreviews = el.querySelector('#refPreviews');

    modeTabs.forEach((tab) => tab.addEventListener('click', () => {
      modeTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      el.querySelector('#i2iPanel').style.display = tab.dataset.mode === 'i2i' ? 'block' : 'none';
    }));

    // 尺寸联动：选择「自定义」时显示宽x高输入框
    const sizeSel = el.querySelector('#imgSize');
    const sizeCustomWrap = el.querySelector('#imgSizeCustomWrap');
    sizeSel.addEventListener('change', () => {
      sizeCustomWrap.style.display = sizeSel.value === '自定义' ? 'block' : 'none';
    });

    el.querySelector('#imgPresets').addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (chip) { promptEl.value = PRESETS[Array.from(chip.parentNode.children).indexOf(chip)]; }
    });

    const refInput = el.querySelector('#imgRefs');
    refInput.addEventListener('change', async () => {
      refs.length = 0;
      for (const f of Array.from(refInput.files || []).slice(0, 10)) {
        try { refs.push(await UI.fileToDataUrl(f)); } catch { /* ignore */ }
      }
      refPreviews.innerHTML = refs.map((r) => `<img src="${r}" style="width:52px;height:52px;object-fit:cover;border-radius:8px;border:1px solid var(--border-light)">`).join('');
    });

    async function generate() {
      const prompt = promptEl.value.trim();
      if (!prompt) return UI.toast('请先填写提示词', 'warn');
      // 计算尺寸：自定义时取「宽x高」
      let size = el.querySelector('#imgSize').value;
      if (size === '自定义') {
        size = (el.querySelector('#imgSizeCustom').value || '').trim();
        if (!/^\d{2,5}x\d{2,5}$/i.test(size)) {
          return UI.toast('自定义尺寸格式应为「宽x高」，例如 1024x1792', 'warn');
        }
      }
      const btn = el.querySelector('#imgGenerate');
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner sm"></div> 生成中…';
      const resultMeta = el.querySelector('#imgResultMeta');
      resultMeta.innerHTML = '<span class="spinner sm"></span> 调用 Seedream 中…';
      try {
        const data = await API.genImage({
          model: el.querySelector('#imgModel').value,
          prompt,
          negative_prompt: el.querySelector('#imgNegative').value.trim(),
          size,
          count: Number(el.querySelector('#imgCount').value),
          images: refs,
          watermark: el.querySelector('#imgWatermark').checked,
          seed: el.querySelector('#imgSeed').value,
        });
        const items = data.items || [];
        const newResults = items.map((it) => ({ url: it.url, prompt, model: el.querySelector('#imgModel').value, time: Date.now(), saved: false }));
        results = [...newResults, ...results].slice(0, 60);
        // 保存到作品中心
        for (const r of newResults) {
          try {
            await Store.add({
              type: 'image', kind: 'ai-image',
              title: prompt.slice(0, 40),
              url: r.url, prompt,
              model: el.querySelector('#imgModel').value,
            });
            r.saved = true;
          } catch { /* ignore */ }
        }
        renderGrid(el);
        UI.toast(`成功生成 ${items.length} 张图片`, 'ok');
      } catch (e) {
        resultMeta.textContent = '生成失败';
        UI.toast(e.message, 'err', 6000);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '✨ 开始生成';
      }
    }
    el.querySelector('#imgGenerate').addEventListener('click', generate);
    promptEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
    });

    renderGrid(el);
  }

  function renderGrid(el) {
    const grid = el.querySelector('#imgResultGrid');
    const meta = el.querySelector('#imgResultMeta');
    meta.textContent = `共 ${results.length} 张`;
    if (results.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="big-ico">🎨</div><p>设置参数并点击「开始生成」<br>AI 将调用 Seedream 模型创作图片</p></div>`;
      return;
    }
    grid.innerHTML = results.map((r, i) => `
      <div class="media-card">
        <div class="thumb"><img src="${r.url}" alt="生成图片" loading="lazy"></div>
        <div class="meta"><span class="t">${UI.escapeHtml(r.prompt.slice(0, 24)) || '未命名'}</span><span class="badge ${r.saved ? 'badge-ok' : 'badge-wait'}">${r.saved ? '已存' : '未存'}</span></div>
        <div class="hover-actions">
          <button class="btn btn-primary btn-sm" data-act="video" data-idx="${i}">🎬 生视频</button>
          <button class="btn btn-sm" data-act="board" data-idx="${i}">📋 故事板</button>
          <button class="btn btn-sm" data-act="dl" data-idx="${i}">⬇ 下载</button>
        </div>
      </div>`).join('');

    grid.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = results[Number(btn.dataset.idx)];
        if (!r) return;
        if (btn.dataset.act === 'video') {
          window.MA.nav('video');
          window.MA.dispatch('video:setFirstFrame', r.url);
          UI.toast('已设置为首帧图，填写动作描述即可生成视频', 'ok');
        } else if (btn.dataset.act === 'board') {
          window.MA.nav('storyboard');
          window.MA.dispatch('storyboard:addImage', r.url, r.prompt);
          UI.toast('图片已加入故事板', 'ok');
        } else if (btn.dataset.act === 'dl') {
          const a = document.createElement('a');
          a.href = API.proxyUrl(r.url);
          a.download = `materall_${Date.now()}.png`;
          a.target = '_blank';
          a.click();
        }
      });
    });
  }

  /** 接收外部填充提示词 */
  function onFill(prompt) {
    const el = document.querySelector('#imgPrompt');
    if (el) el.value = prompt || '';
  }

  return { render, onFill };
})();
