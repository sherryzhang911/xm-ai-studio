/* ============================================================
 * ui.js — 通用 UI 组件库：toast / modal / 图标 / 格式化
 * ============================================================ */
window.UI = (() => {
  /* ---------- Toast ---------- */
  function toast(msg, type = 'info', ms = 3200) {
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    const icoMap = { ok: '✅', err: '⚠️', warn: '💡', info: 'ℹ️' };
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="t-ico">${icoMap[type] || 'ℹ️'}</span><span>${escapeHtml(msg)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  /* ---------- Modal ---------- */
  function modal(html, { title = '', width } = {}) {
    const mask = document.getElementById('modalMask');
    const box = document.getElementById('modalBox');
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = html;
    if (width) box.style.width = width;
    mask.classList.remove('hidden');
    box.classList.remove('hidden');
    return box;
  }
  function closeModal() {
    document.getElementById('modalMask').classList.add('hidden');
    document.getElementById('modalBox').classList.add('hidden');
  }
  function initModal() {
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalMask').addEventListener('click', closeModal);
  }

  /* ---------- 工具 ---------- */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** 简易 Markdown 渲染（代码块/表格/列表/加粗/标题） */
  function md(text) {
    if (!text) return '';
    let t = escapeHtml(text);
    // 代码块
    t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => `<div class="code-block">${code.trim()}</div>`);
    // 表格
    t = t.replace(/\|(.+)\|\n\|[\s\-\|]+\|\n((?:\|.+\|\n?)+)/g, (m, head, rows) => {
      const hs = head.split('|').map((x) => x.trim()).filter(Boolean);
      const rss = rows.trim().split('\n').map((r) => r.split('|').map((x) => x.trim()).filter(Boolean));
      let html = '<table class="md-table"><thead><tr>' + hs.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
      rss.forEach((r) => { html += '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>'; });
      return html + '</tbody></table>';
    });
    // 标题
    t = t.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    // 列表
    t = t.replace(/^\s*[-*]\s+(.+)$/gm, '• $1<br>');
    // 加粗
    t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    return t;
  }

  /** 图片文件转 data URL */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /** 生成随机 id */
  function uid(prefix = 'id') {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 防抖 */
  function debounce(fn, ms = 300) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /** 检查我的模型权限（方舟账号已开通模型，经 /api/models） */
  async function showModelsModal() {
    try {
      const r = await API.listModels();
      const ids = (r.ids || []).filter(Boolean);
      const chip = (id) => `<span style="display:inline-block;background:var(--bg-soft);border:1px solid var(--border-light);border-radius:999px;padding:3px 10px;font-size:12px;margin:3px 4px 0 0;font-family:monospace">${escapeHtml(id)}</span>`;
      if (!ids.length) {
        modal(`<p style="color:var(--text-2);font-size:13px;line-height:1.8">你的账号下未查询到已开通模型。<br>请到火山方舟「<b>开通管理</b>」开通所需模型：<br><span style="font-size:12px;color:var(--text-3)">视觉识别：doubao-seed-1-6-vision 或 doubao-1.5-vision-pro<br>对话：doubao-seed / doubao-pro 系列</span></p>
          <div class="settings-links" style="margin-top:12px"><a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">前往开通管理 →</a></div>`, { title: '🔎 我的模型权限' });
        return;
      }
      const vision = ids.filter((id) => /vision|vl-/i.test(id));
      const text = ids.filter((id) => !/vision|vl-/i.test(id));
      modal(`
        <p style="font-size:13px;color:var(--text-2);margin-bottom:6px">已开通 <b>${ids.length}</b> 个模型：</p>
        ${vision.length ? `<div style="margin-bottom:8px"><b style="font-size:12px;color:var(--ok,#4ade80)">👁️ 视觉模型（识别/翻译文字用）：</b><br>${vision.map(chip).join('')}</div>` : '<div style="margin-bottom:8px"><b style="font-size:12px;color:var(--danger,#f87171)">⚠️ 未开通任何视觉模型</b><br><span style="font-size:12px;color:var(--text-3)">「文字本地化 / 仿拍复刻拆解」需要视觉模型，请到开通管理开通 doubao-seed-1-6-vision</span></div>'}
        ${text.length ? `<div><b style="font-size:12px;color:var(--text-1)">💬 文本对话模型（创意助手等）：</b><br>${text.map(chip).join('')}</div>` : ''}
        <div class="settings-links" style="margin-top:12px"><a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement" target="_blank">前往开通管理 →</a></div>
        <p style="font-size:11px;color:var(--text-3);margin-top:8px">识别/翻译会自动尝试你已开通的视觉模型；语音合成不在方舟内，需火山「语音技术」的 AK/SK（配音模块用 ElevenLabs 或系统语音）。</p>`, { title: '🔎 我的模型权限' });
    } catch (e) {
      toast('查询失败：' + ((e.message || '').slice(0, 100)), 'err', 6000);
    }
  }

  /** SVG 图标（内联） */
  const ICONS = {
    grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 2l1.9 5.7L19.6 9.6l-5.7 1.9L12 17.2l-1.9-5.7L4.4 9.6l5.7-1.9L12 2z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-5-5-9 9"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="14" height="13" rx="2"/><path d="M16.5 10l5-3v10l-5-3"/></svg>',
    board: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M9 4v14M15 4v14M3 9h18M3 13h18"/></svg>',
    pipe: '<svg viewBox="0 0 24 24"><path d="M4 8h16v3H4zM4 13h16v3H4z"/><path d="M2 8h2v8H2zM20 8h2v8h-2z"/><path d="M7 9.5v5M12 9.5v5M17 9.5v5"/></svg>',
    cut: '<svg viewBox="0 0 24 24"><path d="M6 4l12 16M18 4L6 20"/><circle cx="6" cy="6.5" r="2.6"/><circle cx="6" cy="17.5" r="2.6"/><path d="M8.5 6.5L20 13M8.5 17.5L20 11"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 014.5 5h5l2 2.5h8A1.5 1.5 0 0121 9v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18V6.5z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.6 2.1 2.6-.5 1 2.5 2.6.5-.6 2.6 1.8 2-1.8 2 .6 2.6-2.6.5-1 2.5-2.6-.5-1.6 2.1-1.6-2.1-2.6.5-1-2.5-2.6-.5.6-2.6L2.8 12l1.8-2-.6-2.6 2.6-.5 1-2.5 2.6.5L12 2.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5l13 7.5-13 7.5v-15z" fill="currentColor" stroke="none"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/></svg>',
    dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 11.5L20 4l-4.5 16-4-6.5L4 11.5z"/><path d="M11.5 13.5L20 4"/></svg>',
    wand: '<svg viewBox="0 0 24 24"><path d="M4 20L18 6M15 4l1 2.5L18.5 7.5 16 8.5 15 11l-1-2.5L11.5 7.5 14 6.5 15 4z"/><path d="M19 13l.7 1.8L21.5 15.5l-1.8.7L19 18l-.7-1.8-1.8-.7 1.8-.7L19 13z"/></svg>',
    film: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  };
  function icon(name, size = 18) {
    const svg = ICONS[name] || ICONS.spark;
    return `<span class="nav-ico" style="width:${size}px;height:${size}px">${svg}</span>`;
  }

  return { toast, modal, closeModal, initModal, escapeHtml, fmtTime, fmtDur, md, fileToDataUrl, uid, debounce, icon, showModelsModal };
})();
