/* ============================================================
 * store.js — 作品中心（IndexedDB 持久化）
 * 作品类型：image | video | text | project
 * ============================================================ */
window.Store = (() => {
  const DB_NAME = 'materall_db';
  const DB_VER = 1;
  const STORE = 'works';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('type', 'type', { unique: false });
          os.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const os = t.objectStore(STORE);
      const out = fn(os);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    }));
  }

  function uid() {
    return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** 添加作品 */
  async function add(work) {
    const item = {
      id: uid(),
      createdAt: Date.now(),
      ...work,
    };
    await tx('readwrite', (os) => os.add(item));
    return item;
  }

  /** 删除作品 */
  async function remove(id) {
    await tx('readwrite', (os) => os.delete(id));
  }

  /** 更新作品 */
  async function update(id, patch) {
    const all = await list();
    const item = all.find((w) => w.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    await tx('readwrite', (os) => os.put(item));
    return item;
  }

  /** 查询作品列表（按时间倒序） */
  async function list(filter = {}) {
    const all = await tx('readonly', (os) => new Promise((res, rej) => {
      const req = os.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    let out = all.slice();
    if (filter.type) out = out.filter((w) => w.type === filter.type);
    if (filter.kind) out = out.filter((w) => w.kind === filter.kind);
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  /** 统计 */
  async function stats() {
    const all = await list();
    return {
      total: all.length,
      image: all.filter((w) => w.type === 'image').length,
      video: all.filter((w) => w.type === 'video').length,
      project: all.filter((w) => w.type === 'project').length,
    };
  }

  return { add, remove, update, list, stats, uid };
})();
