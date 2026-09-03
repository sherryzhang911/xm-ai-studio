/* ============================================================
 * gallery.js — 作品中心（本地管理所有 AI 生成物）
 * ============================================================ */
window.GalleryView = (() => {
  const FILTERS = [
    { key: '', label: '全部' },
    { key: 'image', label: '🖼️ 图片' },
    { key: 'video', label: '🎬 视频' },
    { key: 'project', label: '🎞️ 成片' },
  ];
  let works = [];
  let filter = '';

  async function render(el) {
    el.innerHTML = `
      <div class="gallery-filters">
        ${FILTERS.map((f) => `<button class="btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-ghost'}" data-f="${f.key}">${f.label}</button>`).join('')}
        <span style="flex:1"></span>
        <span class="badge badge-wait" id="galleryCount"></span>
      </div>
      <div class="gallery-grid" id="galleryGrid">
        <div class="empty-state" style="grid-column:1/-1"><div class="spinner"></div></div>
      </div>`;

    el.querySelectorAll('[data-f]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filter = btn.dataset.f;
        render(el);
      });
    });

    try {
      works = await Store.list({ type: filter || undefined });
    } catch {
      works = [];
    }
    const grid = el.querySelector('#galleryGrid');
    el.querySelector('#galleryCount').textContent = `${works.length} 个作品`;
    if (works.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="big-ico">🗂️</div>
        <p>还没有作品<br>去 AI 生图 / AI 生视频 / 智能剪辑创作第一个作品吧</p>
      </div>`;
      return;
    }
    grid.innerHTML = works.map((w) => {
      const isVideo = w.type === 'video' || w.kind === 'final-cut';
      const isFinal = w.type === 'project';
      return `
      <div class="work-card" data-id="${w.id}">
        <div class="thumb">
          ${isVideo
            ? `<video src="${API.proxyUrl(w.url)}" muted preload="metadata"></video>`
            : `<img src="${API.proxyUrl(w.url || w.thumb)}" loading="lazy">`}
          ${isFinal ? '<span style="position:absolute;top:8px;left:8px" class="badge badge-ok">🎞️ 成片</span>' : ''}
        </div>
        <div class="w-body">
          <div class="w-title">${UI.escapeHtml(w.title || '未命名作品')}</div>
          <div class="w-meta">
            <span>${isFinal ? '剪辑成片' : w.type === 'image' ? 'AI 图片' : 'AI 视频'}</span>
            <span>·</span>
            <span>${UI.fmtTime(w.createdAt || Date.now())}</span>
            ${w.duration ? `<span>·</span><span>${UI.fmtDur(w.duration)}</span>` : ''}
          </div>
          <div class="w-ops">
            <button class="btn btn-sm" data-op="preview">👁 预览</button>
            ${isVideo ? `<button class="btn btn-sm btn-primary" data-op="edit">✂️ 剪辑</button>` : `<button class="btn btn-sm" data-op="tovideo">🎬 生视频</button>`}
            <button class="btn btn-sm" data-op="download">⬇ 下载</button>
            <button class="btn btn-sm btn-danger" data-op="del">删除</button>
          </div>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('[data-op]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.work-card');
        const w = works.find((x) => x.id === card.dataset.id);
        if (!w) return;
        const op = btn.dataset.op;
        if (op === 'preview') {
          const isVideo = w.type === 'video' || w.kind === 'final-cut';
          UI.modal(
            isVideo
              ? `<video src="${API.proxyUrl(w.url)}" controls autoplay style="width:100%;border-radius:10px;background:#000"></video>`
              : `<img src="${API.proxyUrl(w.url || w.thumb)}" style="width:100%;border-radius:10px">`,
            { title: UI.escapeHtml(w.title || '作品') }
          );
        } else if (op === 'edit') {
          window.MA.nav('editor');
          window.MA.dispatch('editor:addRemote', { url: w.url, name: w.title || '素材', type: 'video' });
        } else if (op === 'tovideo') {
          window.MA.nav('video');
          window.MA.dispatch('video:setFirstFrame', w.url || w.thumb);
          UI.toast('已设置为首帧图', 'ok');
        } else if (op === 'download') {
          const a = document.createElement('a');
          a.href = API.proxyUrl(w.url || w.thumb);
          a.download = `materall_${w.id}.${w.type === 'image' ? 'png' : 'mp4'}`;
          a.target = '_blank';
          a.click();
        } else if (op === 'del') {
          if (confirm(`删除作品「${w.title || '未命名'}」？`)) {
            await Store.remove(w.id);
            UI.toast('已删除', 'ok');
            render(el);
          }
        }
      });
    });
  }

  return { render };
})();
