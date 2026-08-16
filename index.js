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
    singleEntry: true,   // 唯一入口：隐藏子引擎悬浮球
    bioSignal: '',       // 本轮短信号，生成结束即清
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
    // 器官上交的短信号（本轮有效，阅后即焚）
    bioSignal: '',
    registerEngine(name, api) {
      this.engines[name] = Object.assign(this.engines[name] || {}, { loaded: true, api });
      pushEvent('engine-registered', { name });
      try { window.PyramidCore.refreshUI?.(); } catch (_) {}
      return true;
    },
    reportBioSignal(text, meta = {}) {
      const val = typeof text === 'string' ? text : (text == null ? '' : JSON.stringify(text));
      state.bioSignal = val;
      this.bioSignal = val;
      pushEvent(val ? 'bio-signal' : 'bio-signal-cleared', { text: val, ...meta });
      try { window.PyramidCore.refreshUI?.(); } catch (_) {}
      return val;
    },
    clearBioSignal() {
      state.bioSignal = '';
      this.bioSignal = '';
      pushEvent('bio-signal-cleared', {});
      try { window.PyramidCore.refreshUI?.(); } catch (_) {}
    },
    getStatus() {
      return {
        // BIO 以注册表/引擎 API 为准；旧写法读的是注入后才存在、清理后即空的临时值，会误报“未检测到”
        bio: !!(window.PyramidBio?.loaded || this.engines.bio?.api),
        novel: !!(window.niGetDebugLogs || window._niS),
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
    // 记忆引擎经 Core 汇合：保留其自身注入路径，仅登记接口供统一 UI/认知包取用
    if (window.YuzukiMemory) window.PyramidCore.registerEngine('memory', {
      loaded: true,
      openPanel: () => window.YuzukiMemory?.MemoryWindow?.open?.() ?? window.YuzukiMemory?.MemoryWindow?.toggle?.(),
      raw: window.YuzukiMemory,
    });
  } catch (e) { console.error('[PyramidCore] Memory boot failed', e); window.PyramidCore.engines.memory = { loaded: false, error: e.message }; }

  try {
    await importModule('engines/novel/index.js');
    window.PyramidCore.engines.novel = { loaded: true };
    window.PyramidCore.registerEngine('novel', {
      loaded: true,
      getLogs: () => window.niGetDebugLogs?.() ?? window.__NI_DEBUG_LOGS__ ?? [],
      raw: () => window._niS,
    });
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
      // 优先用 Core 汇合到的短信号；回落到引擎 API，最后才读旧全局
      if (state.bioSignal) return state.bioSignal;
      const viaApi = window.PyramidBio?.getLastSignal?.();
      if (viaApi) return viaApi;
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

  // 唯一入口：隐藏子引擎各自的悬浮球，统一由 Core 面板转入
  const CHILD_FABS = ['rpe-fab', 'ni-fab', 'ni-fab-ring', 'yzm-memory-floating-button'];
  function hideChildFabs() {
    if (!state.singleEntry) return;
    for (const id of CHILD_FABS) {
      const el = document.getElementById(id);
      if (el && el.dataset.pcHidden !== '1') { el.dataset.pcHidden = '1'; el.style.display = 'none'; }
    }
  }
  function showChildFabs() {
    for (const id of CHILD_FABS) {
      const el = document.getElementById(id);
      if (el) { el.dataset.pcHidden = '0'; el.style.display = ''; }
    }
  }
  // 子引擎的球是异步挂载的，持续收敛一段时间
  const fabSweep = setInterval(hideChildFabs, 1000);
  setTimeout(() => clearInterval(fabSweep), 60000);

  function mountUI() {
    if (document.getElementById('pyramid-core-panel')) return;
    const wrap = document.createElement('div'); wrap.id = 'pyramid-core-panel'; wrap.className = 'pyramid-core-panel'; wrap.innerHTML = `
      <div class="pc-head"><b>🔺 Pyramid Core</b><span>Unified v${VERSION}</span><button id="pc-close">×</button></div>
      <div class="pc-body">
        <div class="pc-tabs">
          <button class="pc-tab pc-on" data-tab="status">状态</button>
          <button class="pc-tab" data-tab="signal">信号</button>
          <button class="pc-tab" data-tab="log">日志</button>
        </div>

        <div class="pc-pane" data-pane="status">
          <div class="pc-grid">
            <div><b>🧬 BIO</b><span id="pc-bio">检测中</span></div>
            <div><b>📚 Novel</b><span id="pc-novel">检测中</span></div>
            <div><b>🧠 Memory</b><span id="pc-memory">检测中</span></div>
          </div>
          <div class="pc-row">
            <button id="pc-open-bio">打开 BIO 面板</button>
            <button id="pc-open-novel">打开 Novel</button>
            <button id="pc-open-memory">打开 Memory</button>
          </div>
          <label class="pc-check"><input type="checkbox" id="pc-single" checked> 唯一入口（隐藏子引擎悬浮球）</label>
          <button id="pc-export">导出 Core 状态</button>
        </div>

        <div class="pc-pane" data-pane="signal" hidden>
          <div class="pc-hint">身体只上交短信号，是否处理由主脑决定。</div>
          <button id="pc-bio-submit">手动提交当前 BIO 状态到提示词</button>
          <button id="pc-bio-read">立即总结近文并判断</button>
          <button id="pc-pack">生成当前认知包</button>
          <button id="pc-clear">清除本轮信号（阅后即焚）</button>
          <pre id="pc-log"></pre>
        </div>

        <div class="pc-pane" data-pane="log" hidden>
          <div class="pc-row">
            <button class="pc-f pc-on" data-f="all">全部</button>
            <button class="pc-f" data-f="summary">summary</button>
            <button class="pc-f" data-f="signal">signal</button>
            <button class="pc-f" data-f="report">report</button>
            <button class="pc-f" data-f="quiet">quiet</button>
          </div>
          <pre id="pc-events"></pre>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const $ = (id) => document.getElementById(id);
    const set = () => {
      const s = window.PyramidCore.getStatus();
      for (const [id,key] of [['pc-bio','bio'],['pc-novel','novel'],['pc-memory','memory']]) {
        const el = $(id); if (el) el.textContent = s[key] ? '已接入' : '未检测到';
      }
    };

    // 分页
    wrap.querySelectorAll('.pc-tab').forEach(btn => btn.onclick = () => {
      wrap.querySelectorAll('.pc-tab').forEach(b => b.classList.toggle('pc-on', b === btn));
      wrap.querySelectorAll('.pc-pane').forEach(p => { p.hidden = p.dataset.pane !== btn.dataset.tab; });
      if (btn.dataset.tab === 'log') renderEvents();
    });

    // 日志：来自各引擎经 Core 汇合的事件
    let logFilter = 'all';
    function renderEvents() {
      const el = $('pc-events'); if (!el) return;
      const rows = state.events.filter(ev => {
        if (logFilter === 'all') return true;
        return ev.type === 'bio-log' && ev.data?.type === logFilter;
      }).slice(-80).map(ev => {
        const t = (ev.data?.time) || String(ev.at).slice(11,19);
        const kind = ev.type === 'bio-log' ? ev.data.type : ev.type;
        const msg = ev.type === 'bio-log' ? ev.data.msg : JSON.stringify(ev.data).slice(0,180);
        return `[${t}] ${kind}  ${msg}`;
      });
      el.textContent = rows.length ? rows.join('\n') : '暂无记录（产生总结/信号后会出现在这里）。';
    }
    wrap.querySelectorAll('.pc-f').forEach(b => b.onclick = () => {
      logFilter = b.dataset.f;
      wrap.querySelectorAll('.pc-f').forEach(x => x.classList.toggle('pc-on', x === b));
      renderEvents();
    });

    $('pc-close').onclick = () => wrap.classList.remove('open');
    $('pc-pack').onclick = () => { const p = compileCognitivePack(); $('pc-log').textContent = p || '当前没有可注入的统一数据。'; };
    $('pc-clear').onclick = () => { window.PyramidCore.clearBioSignal(); $('pc-log').textContent = '已清除本轮 BIO 信号。'; };
    $('pc-bio-submit').onclick = () => {
      const api = window.PyramidBio;
      if (!api?.forceSubmit) { $('pc-log').textContent = 'BIO 引擎未就绪，无法提交。'; return; }
      try {
        api.forceSubmit();
        const sig = window.PyramidCore.bioSignal || api.getLastSignal?.() || '';
        $('pc-log').textContent = sig ? '已提交，本轮提示词中的信号：\n\n' + sig : '已提交，但当前没有达到阈值的信号（无信号不主动演三急）。';
      } catch (e) { $('pc-log').textContent = '提交失败：' + e.message; }
      renderEvents();
    };
    $('pc-bio-read').onclick = async () => {
      const api = window.PyramidBio;
      if (!api?.readFromChat) { $('pc-log').textContent = 'BIO 引擎未就绪。'; return; }
      $('pc-log').textContent = '正在总结近文…（先总结再判断，不会无总结乱报）';
      try { await api.readFromChat(true); $('pc-log').textContent = '总结完成，详见「日志」分页。'; }
      catch (e) { $('pc-log').textContent = '总结失败：' + e.message; }
      renderEvents();
    };
    $('pc-open-bio').onclick = () => window.PyramidBio?.openPanel?.() || ($('pc-log').textContent = 'BIO 面板不可用。');
    $('pc-open-novel').onclick = () => {
      const el = document.getElementById('ni-fab');
      if (el) { el.style.display = ''; el.click(); setTimeout(hideChildFabs, 1500); }
      else $('pc-log').textContent = 'Novel 入口未找到。';
    };
    $('pc-open-memory').onclick = () => {
      const api = window.YuzukiMemory?.MemoryWindow;
      if (api?.open) api.open();
      else if (api?.toggle) api.toggle();
      else {
        const el = document.getElementById('yzm-memory-floating-button');
        if (el) { el.style.display = ''; el.click(); setTimeout(hideChildFabs, 1500); }
        else $('pc-log').textContent = 'Memory 入口未找到。';
      }
    };
    $('pc-single').onchange = (e) => {
      state.singleEntry = !!e.target.checked;
      if (state.singleEntry) hideChildFabs(); else showChildFabs();
    };
    $('pc-export').onclick = () => { const blob = new Blob([JSON.stringify({ version: VERSION, state, status: window.PyramidCore.getStatus() }, null, 2)], {type:'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pyramid-core-state.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); };

    set();
    window.PyramidCore.refreshUI = () => { try { set(); renderEvents(); } catch (_) {} };
    window.PyramidCore.openPanel = () => { wrap.classList.add('open'); set(); };
    const fab = document.createElement('button'); fab.id='pyramid-core-fab'; fab.textContent='🔺'; fab.title='Pyramid Core'; fab.onclick=()=>{ wrap.classList.toggle('open'); set(); }; document.body.appendChild(fab);
    hideChildFabs();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI, { once: true }); else mountUI();
  console.log(`[Pyramid Core Unified] v${VERSION} ready`, window.PyramidCore.getStatus());
})();
