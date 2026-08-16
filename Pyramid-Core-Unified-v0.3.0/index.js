/**
 * Pyramid Core Unified v0.3.0
 * Single-extension integration layer.
 * The original engines are bundled as internal modules:
 *   - BIO / rpe-physio-monitor
 *   - Novel Injector
 *   - yuzuki-Memory
 * This file provides one bootstrap, one UI, one event bus and a unified
 * cognitive-pack bridge without deleting the original engines' storage namespaces.
 */
(async function () {
  'use strict';
  const VERSION = '0.3.0';
  const ROOT = new URL('./', import.meta.url).href;
  const state = {
    startedAt: Date.now(),
    events: [],
    lastPack: '',
    enabled: true,
  };
  const listeners = new Map();
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name)?.delete(fn); };
  const emit = (name, payload) => { (listeners.get(name) || []).forEach(fn => { try { fn(payload); } catch (e) { console.error('[PyramidCore]', e); } }); };
  const pushEvent = (type, data = {}) => {
    const ev = { id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`, type, at: new Date().toISOString(), data };
    state.events.push(ev); if (state.events.length > 100) state.events.shift(); emit(type, ev); emit('*', ev); return ev;
  };
  const loadClassic = (path) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(path, ROOT).href; s.async = false; s.dataset.pyramidCore = path;
    s.onload = () => resolve(); s.onerror = () => reject(new Error(`加载失败: ${path}`));
    document.head.appendChild(s);
  });
  const importModule = (path) => import(new URL(path, ROOT).href + `?pyramid=${VERSION}`);

  // Shared bridge exposed before child engines boot.
  window.PyramidCore = {
    version: VERSION,
    unified: true,
    state,
    on,
    emit,
    pushEvent,
    engines: {},
    getStatus() {
      return {
        bio: !!window.__RPE_STATE_INJECT__,
        novel: !!window.niGetDebugLogs,
        memory: !!window.YuzukiMemory?.loaded,
      };
    },
    storageKeys: {
      bio: 'rpe_physio_monitor_v06',
      memory: 'YuzukiMemory',
      novel: 'novel_injector',
    }
  };

  try {
    // BIO is a classic IIFE; load it first so its signal injector is available.
    await loadClassic('engines/bio/index.js');
    window.PyramidCore.engines.bio = { loaded: true };
  } catch (e) { console.error('[PyramidCore] BIO boot failed', e); window.PyramidCore.engines.bio = { loaded: false, error: e.message }; }

  try {
    await importModule('engines/yuzuki/index.js');
    window.PyramidCore.engines.memory = { loaded: !!window.YuzukiMemory?.loaded };
  } catch (e) { console.error('[PyramidCore] Memory boot failed', e); window.PyramidCore.engines.memory = { loaded: false, error: e.message }; }

  try {
    await importModule('engines/novel/index.js');
    window.PyramidCore.engines.novel = { loaded: true };
  } catch (e) { console.error('[PyramidCore] Novel boot failed', e); window.PyramidCore.engines.novel = { loaded: false, error: e.message }; }

  // Unified event hooks. Child engines keep their own storage/logic; Core owns the shared lifecycle.
  const emitFloor = () => {
    const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
    const chat = ctx?.chat;
    const last = Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
    pushEvent('floor', { mesId: last?.mesid ?? last?.mesId ?? null, role: last?.is_user ? 'user' : 'assistant', text: String(last?.mes || last?.message || '').slice(0, 4000) });
  };
  const hookEvents = () => {
    try {
      const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
      const es = ctx?.eventSource || window.eventSource;
      const et = ctx?.event_types || window.event_types;
      if (es?.on && et) {
        for (const key of ['MESSAGE_RECEIVED','MESSAGE_SENT','GENERATION_AFTER_COMMANDS','CHAT_CHANGED','CHARACTER_MESSAGE_RENDERED']) {
          const type = et[key]; if (type) es.on(type, emitFloor);
        }
      }
    } catch (e) { console.warn('[PyramidCore] event hook unavailable', e); }
  };
  hookEvents();

  // Build a compact, read-only cognitive pack from the engines' public state/variables.
  function getMacros() {
    const out = {};
    const names = ['MEMORY_PROMPT','VECTOR_MEMORY','MEMORY_SUMMARY','MEMORY_TABLE','MEMORY_TABLE_角色档案','MEMORY'];
    try {
      const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
      const macros = ctx?.macros || window.macros;
      for (const n of names) {
        try { if (macros?.get) out[n] = String(macros.get(n) ?? ''); } catch (_) {}
      }
    } catch (_) {}
    return out;
  }
  function getBioSignal() {
    try {
      const raw = window.__RPE_STATE_INJECT__;
      if (raw == null) return '';
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch (_) { return ''; }
  }
  function compileCognitivePack() {
    const macros = getMacros();
    const bio = getBioSignal();
    const parts = [];
    if (bio) parts.push('【BIO 生理信号】\n' + bio);
    if (macros.MEMORY_SUMMARY) parts.push('【记忆总结】\n' + macros.MEMORY_SUMMARY);
    if (macros.MEMORY_TABLE) parts.push('【记忆表格】\n' + macros.MEMORY_TABLE);
    if (macros.MEMORY_TABLE_角色档案) parts.push('【角色档案】\n' + macros.MEMORY_TABLE_角色档案);
    if (macros.VECTOR_MEMORY) parts.push('【向量记忆】\n' + macros.VECTOR_MEMORY);
    if (macros.MEMORY_PROMPT) parts.push('【记忆处理提示】\n' + macros.MEMORY_PROMPT);
    const pack = parts.join('\n\n');
    state.lastPack = pack;
    emit('cognitive-pack', pack);
    return pack;
  }
  window.PyramidCore.compileCognitivePack = compileCognitivePack;

  function mountUI() {
    if (document.getElementById('pyramid-core-panel')) return;
    const wrap = document.createElement('div'); wrap.id = 'pyramid-core-panel'; wrap.className = 'pyramid-core-panel'; wrap.innerHTML = `
      <div class="pc-head"><b>🔺 Pyramid Core</b><span>Unified v${VERSION}</span><button id="pc-close">×</button></div>
      <div class="pc-body">
        <div class="pc-grid">
          <div><b>🧬 BIO</b><span id="pc-bio">检测中</span></div>
          <div><b>📚 Novel</b><span id="pc-novel">检测中</span></div>
          <div><b>🧠 Memory</b><span id="pc-memory">检测中</span></div>
        </div>
        <button id="pc-pack">生成当前认知包</button>
        <button id="pc-export">导出 Core 状态</button>
        <pre id="pc-log"></pre>
      </div>`;
    document.body.appendChild(wrap);
    const set = () => { const s = window.PyramidCore.getStatus(); for (const [id,key] of [['pc-bio','bio'],['pc-novel','novel'],['pc-memory','memory']]) document.getElementById(id).textContent = s[key] ? '已接入' : '未检测到'; };
    document.getElementById('pc-close').onclick = () => wrap.classList.remove('open');
    document.getElementById('pc-pack').onclick = () => { const p = compileCognitivePack(); document.getElementById('pc-log').textContent = p || '当前没有可注入的统一数据。'; };
    document.getElementById('pc-export').onclick = () => { const blob = new Blob([JSON.stringify({ version: VERSION, state, status: window.PyramidCore.getStatus() }, null, 2)], {type:'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pyramid-core-state.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); };
    set(); window.PyramidCore.openPanel = () => { wrap.classList.add('open'); set(); };
    const fab = document.createElement('button'); fab.id='pyramid-core-fab'; fab.textContent='🔺'; fab.title='Pyramid Core'; fab.onclick=()=>wrap.classList.toggle('open'); document.body.appendChild(fab);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI, { once: true }); else mountUI();
  console.log(`[Pyramid Core Unified] v${VERSION} ready`, window.PyramidCore.getStatus());
})();
