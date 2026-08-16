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
    await loadClassic('core/bio.js');
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
        <div class="pc-tabs pc-maintabs">
          <button class="pc-tab pc-on" data-tab="status">状态</button>
          <button class="pc-tab" data-tab="signal">信号</button>
          <button class="pc-tab" data-tab="log">日志</button>
        </div>

        <div class="pc-pane" data-pane="status">
          <div class="pc-grid">
            <div id="pc-bio-box" class="pc-bio-box"><b>🧬 BIO</b><span id="pc-bio">检测中</span></div>
            <div id="pc-novel-box" class="pc-bio-box"><b>📚 Novel</b><span id="pc-novel">检测中</span></div>
            <div><b>🧠 Memory</b><span id="pc-memory">检测中</span></div>
          </div>
          <div class="pc-row">
            <button id="pc-open-memory">打开 Memory</button>
          </div>
          <div class="pc-bio-block">
            <div class="pc-hint">🧬 BIO 生理状态（内嵌，无需另开旧面板）</div>
            <div id="pc-bio-status"></div>
          </div>
          <label class="pc-check"><input type="checkbox" id="pc-single" checked> 唯一入口（隐藏子引擎悬浮球）</label>
          <button id="pc-export">导出 Core 状态</button>
        </div>

        <div class="pc-pane" data-pane="signal" hidden>
          <div class="pc-hint">统一认知包：身体/记忆信号汇总，是否处理由主脑决定。</div>
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

        <div class="pc-pane" data-pane="bio" hidden>
          <div class="pc-bio-bar">
            <button id="pc-bio-back">← 返回主界面</button>
            <span>🧬 BIO 模块</span>
          </div>
          <div class="pc-tabs pc-bio-tabs">
            <button class="pc-bio-tab pc-on" data-bv="status">状态</button>
            <button class="pc-bio-tab" data-bv="action">操作</button>
            <button class="pc-bio-tab" data-bv="log">日志</button>
            <button class="pc-bio-tab" data-bv="settings">设置</button>
            <button class="pc-bio-tab" data-bv="api">API</button>
          </div>

          <div class="pc-bio-pane" data-bv-pane="status">
            <div class="pc-row"><button id="pc-bio-refresh2">🔄 刷新状态</button></div>
            <div id="pc-bio-status-full"></div>
          </div>

          <div class="pc-bio-pane" data-bv-pane="action" hidden>
            <div class="pc-hint">先「立即总结近文并判断」，再视需要「手动提交当前状态到提示词」。</div>
            <button id="pc-bio-read2">立即总结近文并判断</button>
            <button id="pc-bio-submit2">手动提交当前状态到提示词</button>
            <button id="pc-bio-clear2">清除本轮信号（阅后即焚）</button>
            <pre id="pc-bio-result"></pre>
          </div>

          <div class="pc-bio-pane" data-bv-pane="log" hidden>
            <div class="pc-row">
              <button class="pc-bf pc-on" data-bf="all">全部</button>
              <button class="pc-bf" data-bf="summary">summary</button>
              <button class="pc-bf" data-bf="signal">signal</button>
              <button class="pc-bf" data-bf="report">report</button>
              <button class="pc-bf" data-bf="quiet">quiet</button>
              <button class="pc-bf" data-bf="rules">rules</button>
              <button class="pc-bf" data-bf="error">error</button>
            </div>
            <button id="pc-bio-clear-log">清空日志</button>
            <pre id="pc-bio-events"></pre>
          </div>

          <div class="pc-bio-pane" data-bv-pane="settings" hidden>
            <div class="pc-hint">观察项与阈值（沿用 BIO 配置）</div>
            <label class="pc-check"><input type="checkbox" data-bk="drink"> 饮水</label>
            <label class="pc-check"><input type="checkbox" data-bk="meal"> 进食</label>
            <label class="pc-check"><input type="checkbox" data-bk="urination"> 排尿</label>
            <label class="pc-check"><input type="checkbox" data-bk="bowel_movement"> 排便</label>
            <label class="pc-check"><input type="checkbox" data-bk="sleep"> 睡眠</label>
            <label class="pc-check"><input type="checkbox" data-bf="trackReproductive"> 经期/受孕/孕期</label>
            <label class="pc-check"><input type="checkbox" data-bf="offscreenAdvance"> 离场仍推进时间</label>
            <label class="pc-check"><input type="checkbox" data-bf="injectEnabled"> 写入主创提示词</label>
            <label class="pc-check"><input type="checkbox" data-bf="hardSync"> 防脱钩约束</label>
            <label class="pc-field">上报最低阶段
              <select data-bsel="reportMinStage">
                <option value="关注">关注（较敏感）</option>
                <option value="迫切">迫切（推荐）</option>
                <option value="应急">应急（很少打扰）</option>
              </select>
            </label>
            <label class="pc-field">自动读取间隔（轮）<input type="number" data-bnum="autoEvery" min="1"></label>
            <label class="pc-field">日志保留条数<input type="number" data-bnum="logMax" min="10"></label>
            <div class="pc-row"><button id="pc-bio-save-settings">保存设置</button><button id="pc-bio-reset">清空全部状态</button></div>
          </div>

          <div class="pc-bio-pane" data-bv-pane="api" hidden>
            <div class="pc-hint">独立 API（近文总结/判断用，沿用 BIO 配置）</div>
            <label class="pc-field">Base URL<input type="text" data-bapi="baseUrl"></label>
            <label class="pc-field">API Key<input type="password" data-bapi="apiKey"></label>
            <label class="pc-field">模型<input type="text" data-bapi="model"></label>
            <div class="pc-row">
              <button id="pc-bio-fetch-models">拉取模型</button>
              <select id="pc-bio-model-list" style="display:none"></select>
            </div>
            <label class="pc-field">手动模型名（可选）<input type="text" data-bapi="modelManual"></label>
            <label class="pc-check"><input type="checkbox" data-bf="sideApiEnabled"> 启用独立 API</label>
            <label class="pc-check"><input type="checkbox" data-bf="rulesEnabled"> 禁令层</label>
            <label class="pc-field">禁令扫描间隔（轮）<input type="number" data-bnum="rulesEvery" min="1"></label>
            <div class="pc-field">禁令经验库：<span id="pc-bio-learned-count">0</span> 条</div>
            <div class="pc-row">
              <button id="pc-bio-export-learned">导出经验库</button>
              <button id="pc-bio-import-learned">导入经验库</button>
              <button id="pc-bio-clear-learned">清空</button>
              <input type="file" id="pc-bio-learned-file" accept="application/json,.json" style="display:none">
            </div>
            <button id="pc-bio-save-api">保存 API 设置</button>
          </div>
        </div>

        <div class="pc-pane" data-pane="novel" hidden>
          <div class="pc-bio-bar">
            <button id="pc-novel-back">← 返回主界面</button>
            <span>📚 Novel 模块</span>
          </div>
          <div class="pc-tabs pc-bio-tabs">
            <button class="pc-bio-tab pc-on" data-nv="status">状态</button>
            <button class="pc-bio-tab" data-nv="inj">注入</button>
            <button class="pc-bio-tab" data-nv="stage">阶段</button>
            <button class="pc-bio-tab" data-nv="log">日志</button>
          </div>

          <div class="pc-bio-pane" data-nv-pane="status">
            <div id="pc-novel-status"></div>
            <div class="pc-row"><button id="pc-novel-adv">高级（旧面板）</button></div>
          </div>

          <div class="pc-bio-pane" data-nv-pane="inj" hidden>
            <div id="pc-novel-inj"></div>
            <div class="pc-row"><button id="pc-novel-save-inj">保存注入设置</button></div>
          </div>

          <div class="pc-bio-pane" data-nv-pane="stage" hidden>
            <div id="pc-novel-stages"></div>
            <div class="pc-row"><button id="pc-novel-stage-on">全部开启</button><button id="pc-novel-stage-off">全部关闭</button></div>
          </div>

          <div class="pc-bio-pane" data-nv-pane="log" hidden>
            <div class="pc-row"><button id="pc-novel-clear-log">清空日志</button></div>
            <pre id="pc-novel-events"></pre>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const $ = (id) => document.getElementById(id);
    const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    // 内嵌 BIO 生理状态：直接读引擎快照/配置，在主面板内页渲染，不再依赖旧悬浮窗
    const BIO_NEED_LABEL = { drink:'饮水', meal:'进食', urination:'排尿', bowel_movement:'排便', sleep:'睡眠' };
    const BIO_STAGE = ['平稳', '关注', '迫切', '应急'];
    const bioRank = (s) => { const i = BIO_STAGE.indexOf(String(s || '')); return i < 0 ? 0 : i; };
    const bioCls = (s) => { const r = bioRank(s); return r >= 3 ? 'pc-s-emerg' : (r >= 2 ? 'pc-s-urgent' : (r >= 1 ? 'pc-s-watch' : 'pc-s-ok')); };
    function bioStatusCards() {
      const api = window.PyramidBio;
      if (!api?.getSnapshot) return '<div class="pc-hint">BIO 引擎未就绪，无法显示状态。</div>';
      const snap = api.getSnapshot() || {};
      const cfg = api.getConfig?.() || {};
      const chars = Object.entries(snap.characters || {}).filter(([,c]) => c);
      if (!chars.length) return '<div class="pc-hint">暂无已跟踪角色。在 BIO 模块「操作」页点「立即总结近文并判断」后会收录。</div>';
      const needs = Array.isArray(cfg.enabledNeeds) && cfg.enabledNeeds.length ? cfg.enabledNeeds : Object.keys(BIO_NEED_LABEL);
      return chars.map(([name, ch]) => {
        let tag = '';
        if (ch.pregnancy?.active) tag = '孕';
        else if (ch.menstrual_cycle?.phase === '月经期') tag = '经';
        else if (ch.present === false) tag = '离场';
        const chips = needs.map(k => {
          const n = ch.needs?.[k]; if (!n) return '';
          const st = n.stage || '平稳';
          return `<span class="pc-bio-tag ${bioCls(st)}">${escHtml(BIO_NEED_LABEL[k] || k)}·${escHtml(st)}</span>`;
        }).join('');
        let repro = '';
        if (cfg.trackReproductive) {
          if (ch.pregnancy?.active) repro = '孕期 · ' + escHtml(ch.pregnancy.phase || '');
          else if (ch.menstrual_cycle?.phase && ch.menstrual_cycle.phase !== '周期未知')
            repro = '周期 · ' + escHtml(ch.menstrual_cycle.phase) + (ch.menstrual_cycle.cycle_day != null ? ' D' + ch.menstrual_cycle.cycle_day : '');
          else if (ch.conception?.outcome && ch.conception.outcome !== '无') repro = '受孕 · ' + escHtml(ch.conception.outcome);
        }
        return `<div class="pc-bio-card">
          <div class="pc-bio-head"><b>${escHtml(name)}</b>${tag ? `<span class="pc-bio-tag pc-s-watch">${tag}</span>` : ''}<span class="pc-bio-repro">${repro}</span></div>
          <div class="pc-bio-needs">${chips || '<span class="pc-hint">无观察项</span>'}</div>
        </div>`;
      }).join('');
    }
    function renderBioStatus() {
      const el = $('pc-bio-status'); if (el) el.innerHTML = bioStatusCards();
    }
    function renderBioStatusFull() {
      const el = $('pc-bio-status-full'); if (el) el.innerHTML = bioStatusCards();
    }

    const set = () => {
      const s = window.PyramidCore.getStatus();
      for (const [id,key] of [['pc-bio','bio'],['pc-novel','novel'],['pc-memory','memory']]) {
        const el = $(id); if (el) el.textContent = s[key] ? '已接入' : '未检测到';
      }
      renderBioStatus();
    };

    // 主层分页
    let bioActive = false;
    function showPane(name) {
      wrap.querySelectorAll('.pc-pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
      if (name === 'log') renderEvents();
      if (name === 'bio') renderBioStatusFull();
      if (name === 'novel') renderNovelStatus();
    }
    function enterBio() { bioActive = true; wrap.classList.add('pc-bio-mode'); showPane('bio'); }
    function exitBio() { bioActive = false; wrap.classList.remove('pc-bio-mode'); showPane('status'); }
    function enterNovel() { bioActive = true; wrap.classList.add('pc-bio-mode'); showPane('novel'); }
    function exitNovel() { bioActive = false; wrap.classList.remove('pc-bio-mode'); showPane('status'); }
    wrap.querySelectorAll('.pc-tab').forEach(btn => btn.onclick = () => {
      if (bioActive) exitBio();
      wrap.querySelectorAll('.pc-tab').forEach(b => b.classList.toggle('pc-on', b === btn));
      showPane(btn.dataset.tab);
    });

    // BIO 第二层分页
    function switchBioView(bv) {
      wrap.querySelectorAll('[data-bv]').forEach(b => b.classList.toggle('pc-on', b.dataset.bv === bv));
      wrap.querySelectorAll('[data-bv-pane]').forEach(p => { p.hidden = p.dataset.bvPane !== bv; });
      if (bv === 'status') renderBioStatusFull();
      if (bv === 'log') renderBioEvents();
      if (bv === 'settings') loadBioSettings();
      if (bv === 'api') loadBioApi();
    }
    wrap.querySelectorAll('[data-bv]').forEach(b => b.onclick = () => switchBioView(b.dataset.bv));
    $('pc-bio-box').onclick = enterBio;
    $('pc-bio-back').onclick = exitBio;
    $('pc-bio-refresh2').onclick = () => { renderBioStatusFull(); $('pc-bio-result').textContent = 'BIO 状态已刷新。'; };

    // Novel 第二层分页
    const niCfg = () => window.extension_settings?.['novel-injector'] || {};
    const niOn = () => niCfg().pluginEnabled !== false;
    function renderNovelStatus() {
      const el = $('pc-novel-status'); if (!el) return;
      const cfg = niCfg();
      const name = cfg._autoSaveSourceName || '';
      const stageCount = Object.keys(cfg._stageStates || {}).length;
      const cnt = (window.niGetDebugLogs?.() || []).length;
      const logs = window.niGetDebugLogs?.() || [];
      const last = logs[logs.length - 1];
      const rows = [
        `<div class="pc-field">注入开关：<b>${niOn() ? '已启用' : '已停用'}</b></div>`,
        `<div class="pc-field">当前小说：<b>${name ? escHtml(name) : '—'}</b></div>`,
        `<div class="pc-field">阶段数量：<b>${stageCount}</b>${stageCount ? '' : '（暂无阶段数据）'}</div>`,
        `<div class="pc-field">调试日志：<b>${cnt}</b> 条</div>`,
      ];
      if (last) rows.push(`<div class="pc-field">最近日志：<span class="${last.level === 'error' ? 'pc-s-emerg' : (last.level === 'warn' ? 'pc-s-watch' : 'pc-s-ok')}">[${escHtml(last.t)} ${escHtml(last.level)}] ${escHtml(last.message)}</span></div>`);
      el.innerHTML = rows.join('');
    }
    // 注入设置：绑定原引擎真实配置项
    const NI_INJ_SPEC = [
      { k: 'pluginEnabled', type: 'bool', label: '启用注入' },
      { k: 'vecInjDisabled', type: 'bool', label: '禁用向量注入' },
      { k: 'charAutoSleepEnabled', type: 'bool', label: '阶段角色人设自动休眠' },
      { k: 'devAutoUpdateEnabled', type: 'bool', label: '偏差自动更新' },
      { k: 'userSubEnabled', type: 'bool', label: '用户代玩' },
      { k: 'autoSaveEnabled', type: 'bool', label: '自动保存快照' },
      { k: 'rawInjMode', type: 'sel', label: '原文注入模式', opts: [['nodes','剧情节点'], ['compressed','压缩原文']] },
      { k: 'recallTopK', type: 'num', label: '向量召回条数' },
    ];
    function renderNovelInj() {
      const el = $('pc-novel-inj'); if (!el) return;
      const cfg = niCfg();
      el.innerHTML = NI_INJ_SPEC.map(it => {
        if (it.type === 'bool') return `<label class="pc-check"><input type="checkbox" data-nik="${it.k}" ${cfg[it.k] !== false ? 'checked' : ''}> ${it.label}</label>`;
        if (it.type === 'sel') return `<label class="pc-field">${it.label}<select data-nik="${it.k}">${it.opts.map(([v,l]) => `<option value="${v}" ${String(cfg[it.k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
        return `<label class="pc-field">${it.label}<input type="number" min="1" data-nik="${it.k}" value="${cfg[it.k] ?? 3}"></label>`;
      }).join('');
    }
    function saveNovelInj() {
      const cfg = niCfg();
      wrap.querySelectorAll('[data-nik]').forEach(el => {
        const k = el.dataset.nik;
        if (el.type === 'checkbox') cfg[k] = el.checked;
        else if (el.tagName === 'SELECT') cfg[k] = el.value;
        else cfg[k] = parseInt(el.value, 10) || cfg[k];
      });
      if (typeof window.niSaveSettings === 'function') window.niSaveSettings();
    }
    // 阶段列表与开关（调用原引擎方法）
    function renderNovelStages() {
      const el = $('pc-novel-stages'); if (!el) return;
      const cfg = niCfg();
      const states = cfg._stageStates || {};
      const titles = cfg._stageTitles || {};
      const keys = Object.keys(states).sort((a, b) => a - b);
      if (!keys.length) { el.innerHTML = '<div class="pc-field">暂无阶段数据（先上传/清洗小说后会出现）。</div>'; return; }
      el.innerHTML = keys.map(i => {
        const on = states[i] !== false;
        return `<div class="pc-bio-card"><div class="pc-bio-head"><b>阶段 ${i}</b><span class="pc-bio-repro">${escHtml(titles[i] || '')}</span></div>
          <label class="pc-check"><input type="checkbox" data-nstage="${i}" ${on ? 'checked' : ''}> 参与注入</label></div>`;
      }).join('');
    }
    function switchNovelView(nv) {
      wrap.querySelectorAll('[data-nv]').forEach(b => b.classList.toggle('pc-on', b.dataset.nv === nv));
      wrap.querySelectorAll('[data-nv-pane]').forEach(p => { p.hidden = p.dataset.nvPane !== nv; });
      if (nv === 'status') renderNovelStatus();
      if (nv === 'inj') renderNovelInj();
      if (nv === 'stage') renderNovelStages();
      if (nv === 'log') renderNovelEvents();
    }
    function renderNovelEvents() {
      const el = $('pc-novel-events'); if (!el) return;
      const rows = (window.niGetDebugLogs?.() || []).slice().reverse().slice(0, 60).map(l =>
        `[${l.t}] ${l.level}  ${l.message}${l.detail ? '\n' + String(l.detail) : ''}`);
      el.textContent = rows.length ? rows.join('\n') : '暂无日志（触发一次异常/警告后会写到这里）。';
    }
    wrap.querySelectorAll('[data-nv]').forEach(b => b.onclick = () => switchNovelView(b.dataset.nv));
    $('pc-novel-box').onclick = enterNovel;
    $('pc-novel-back').onclick = exitNovel;
    $('pc-novel-adv').onclick = () => { try { window.niTogglePanel?.(); } catch (_) {} };
    $('pc-novel-save-inj').onclick = () => { saveNovelInj(); renderNovelInj(); renderNovelStatus(); };
    $('pc-novel-stages').addEventListener('change', (e) => {
      const t = e.target; if (!t.dataset?.nstage) return;
      const i = parseInt(t.dataset.nstage, 10);
      if (typeof window.niToggleStage !== 'function') return;
      try {
        const cur = niCfg()._stageStates?.[i] !== false;
        if (cur === !!t.checked) return;
        const res = window.niToggleStage(i);
        if (typeof res === 'boolean') t.checked = res;
      } catch (_) {}
      setTimeout(renderNovelStages, 60);
    });
    $('pc-novel-stage-on').onclick = () => { try { window.niSetAllStagesEnabled?.(true); } catch (_) {} setTimeout(renderNovelStages, 60); };
    $('pc-novel-stage-off').onclick = () => { try { window.niSetAllStagesEnabled?.(false); } catch (_) {} setTimeout(renderNovelStages, 60); };
    $('pc-novel-clear-log').onclick = () => { window.niClearDebugLogs?.(); renderNovelEvents(); renderNovelStatus(); };

    // BIO 操作
    $('pc-bio-read2').onclick = async () => {
      const api = window.PyramidBio;
      const out = $('pc-bio-result');
      if (!api?.readFromChat) { out.textContent = 'BIO 引擎未就绪。'; return; }
      out.textContent = '正在总结近文…（先总结再判断，不会无总结乱报）';
      try { await api.readFromChat(true); out.textContent = '总结完成，结果见「日志」分页。'; }
      catch (e) { out.textContent = '总结失败：' + e.message; }
      renderBioStatusFull(); renderBioEvents(); renderEvents();
    };
    $('pc-bio-submit2').onclick = () => {
      const api = window.PyramidBio;
      const out = $('pc-bio-result');
      if (!api?.forceSubmit) { out.textContent = 'BIO 引擎未就绪，无法提交。'; return; }
      try {
        api.forceSubmit();
        const sig = window.PyramidCore.bioSignal || api.getLastSignal?.() || '';
        out.textContent = sig ? '已提交，本轮提示词中的信号：\n\n' + sig : '已提交，但当前没有达到阈值的信号（无信号不主动演三急）。';
      } catch (e) { out.textContent = '提交失败：' + e.message; }
      renderBioEvents(); renderEvents();
    };
    $('pc-bio-clear2').onclick = () => { window.PyramidCore.clearBioSignal(); $('pc-bio-result').textContent = '已清除本轮 BIO 信号。'; };

    // BIO 日志
    let bioLogFilter = 'all';
    function renderBioEvents() {
      const el = $('pc-bio-events'); if (!el) return;
      const rows = (window.PyramidBio?.getLogs?.() || [])
        .filter(l => bioLogFilter === 'all' || l.type === bioLogFilter)
        .slice().reverse().slice(0, 60)
        .map(l => `[${l.time}] ${l.type}  ${l.msg}`);
      el.textContent = rows.length ? rows.join('\n') : '暂无日志（产生总结/信号后会出现在这里）。';
    }
    wrap.querySelectorAll('.pc-bf').forEach(b => b.onclick = () => {
      bioLogFilter = b.dataset.bf;
      wrap.querySelectorAll('.pc-bf').forEach(x => x.classList.toggle('pc-on', x === b));
      renderBioEvents();
    });
    $('pc-bio-clear-log').onclick = () => { window.PyramidBio?.clearLogs?.(); renderBioEvents(); };

    // BIO 设置（读/写真实 cfg）
    function bioCfg() { return window.PyramidBio?.getConfig?.(); }
    function loadBioSettings() {
      const cfg = bioCfg(); if (!cfg) return;
      wrap.querySelectorAll('[data-bk]').forEach(el => { el.checked = cfg.enabledNeeds.includes(el.dataset.bk); });
      wrap.querySelectorAll('[data-bf]').forEach(el => { el.checked = !!cfg[el.dataset.bf]; });
      const sel = wrap.querySelector('[data-bsel=reportMinStage]'); if (sel) sel.value = cfg.reportMinStage || '迫切';
      const an = wrap.querySelector('[data-bnum=autoEvery]'); if (an) an.value = cfg.autoEvery ?? 3;
      const lm = wrap.querySelector('[data-bnum=logMax]'); if (lm) lm.value = cfg.logMax ?? 80;
    }
    $('pc-bio-save-settings').onclick = () => {
      const cfg = bioCfg(); if (!cfg) { return; }
      cfg.enabledNeeds = Object.keys({ drink:1, meal:1, urination:1, bowel_movement:1, sleep:1 }).filter(k => wrap.querySelector(`[data-bk="${k}"]`)?.checked);
      wrap.querySelectorAll('[data-bf]').forEach(el => { cfg[el.dataset.bf] = !!el.checked; });
      const sel = wrap.querySelector('[data-bsel=reportMinStage]'); if (sel) cfg.reportMinStage = sel.value;
      const an = wrap.querySelector('[data-bnum=autoEvery]'); if (an) cfg.autoEvery = parseInt(an.value, 10) || 3;
      const lm = wrap.querySelector('[data-bnum=logMax]'); if (lm) cfg.logMax = parseInt(lm.value, 10) || 80;
      window.PyramidBio?.saveConfig?.();
      renderBioStatusFull();
      $('pc-bio-result').textContent = '观察项与阈值已保存。';
    };
    $('pc-bio-reset').onclick = () => {
      if (!confirm('确认清空全部生理状态？')) return;
      window.PyramidBio?.resetState?.();
      renderBioStatusFull();
      $('pc-bio-result').textContent = '状态已清空。';
    };

    // BIO API 设置
    function loadBioApi() {
      const cfg = bioCfg(); if (!cfg) return;
      wrap.querySelectorAll('[data-bapi]').forEach(el => { el.value = cfg[el.dataset.bapi] || ''; });
      wrap.querySelectorAll('[data-bf]').forEach(el => { el.checked = !!cfg[el.dataset.bf]; });
      const re = wrap.querySelector('[data-bnum=rulesEvery]'); if (re) re.value = cfg.rulesEvery ?? 2;
      renderLearnedCount();
    }
    function renderLearnedCount() {
      const el = $('pc-bio-learned-count'); if (el) el.textContent = String(window.PyramidBio?.getLearnedRules?.().length ?? 0);
    }
    $('pc-bio-save-api').onclick = () => {
      const cfg = bioCfg(); if (!cfg) { return; }
      wrap.querySelectorAll('[data-bapi]').forEach(el => {
        if (el.dataset.bapi === 'modelManual') return;
        cfg[el.dataset.bapi] = el.value;
      });
      const manual = wrap.querySelector('[data-bapi=modelManual]')?.value?.trim();
      if (manual) cfg.model = manual;
      wrap.querySelectorAll('[data-bf]').forEach(el => { cfg[el.dataset.bf] = !!el.checked; });
      const re = wrap.querySelector('[data-bnum=rulesEvery]'); if (re) cfg.rulesEvery = parseInt(re.value, 10) || 2;
      window.PyramidBio?.saveConfig?.();
      $('pc-bio-result').textContent = 'API 设置已保存。';
    };
    $('pc-bio-fetch-models').onclick = async () => {
      const cfg = bioCfg(); const out = $('pc-bio-result');
      if (!cfg || !window.PyramidBio?.fetchModels) { out.textContent = 'BIO 引擎未就绪。'; return; }
      cfg.baseUrl = wrap.querySelector('[data-bapi=baseUrl]')?.value || '';
      cfg.apiKey = wrap.querySelector('[data-bapi=apiKey]')?.value || '';
      window.PyramidBio?.saveConfig?.();
      const sel = $('pc-bio-model-list');
      try {
        const ids = await window.PyramidBio.fetchModels();
        if (!Array.isArray(ids) || !ids.length) throw new Error('列表为空');
        sel.innerHTML = ids.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
        sel.style.display = '';
        out.textContent = '已拉取 ' + ids.length + ' 个模型，从下拉选择后点「保存 API 设置」。';
      } catch (e) {
        sel.style.display = 'none';
        out.textContent = '拉取失败：' + (e.message || e);
      }
    };
    $('pc-bio-model-list').onchange = () => {
      const v = $('pc-bio-model-list').value;
      const m = wrap.querySelector('[data-bapi=model]'); if (m) m.value = v;
    };
    $('pc-bio-export-learned').onclick = () => {
      const list = window.PyramidBio?.getLearnedRules?.() || [];
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: list }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rpe-rule-memory-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {} }, 800);
    };
    const learnedFile = $('pc-bio-learned-file');
    $('pc-bio-import-learned').onclick = () => learnedFile?.click();
    learnedFile.onchange = async () => {
      const f = learnedFile.files && learnedFile.files[0]; learnedFile.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const incoming = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
        const cur = window.PyramidBio?.getLearnedRules?.() || [];
        const map = new Map(cur.map(x => [x.sig, x]));
        let added = 0;
        for (const it of incoming) {
          if (!it || typeof it !== 'object') continue;
          const sig = it.sig || ((Array.isArray(it.ids) ? it.ids.join(',') : '') + '|' + (it.reason || ''));
          if (!sig || sig === '|') continue;
          if (!map.has(sig)) { map.set(sig, it); added++; }
        }
        window.PyramidBio?.saveLearnedRules?.(Array.from(map.values()));
        renderLearnedCount();
        $('pc-bio-result').textContent = '已导入禁令经验库 +' + added + ' 新条。';
      } catch (e) { $('pc-bio-result').textContent = '导入失败：' + (e.message || e); }
    };
    $('pc-bio-clear-learned').onclick = () => { window.PyramidBio?.saveLearnedRules?.([]); renderLearnedCount(); $('pc-bio-result').textContent = '禁令经验库已清空。'; };

    // Core 主层信号
    $('pc-pack').onclick = () => { const p = compileCognitivePack(); $('pc-log').textContent = p || '当前没有可注入的统一数据。'; };
    $('pc-clear').onclick = () => { window.PyramidCore.clearBioSignal(); $('pc-log').textContent = '已清除本轮 BIO 信号。'; };

    // 主层日志：来自各引擎经 Core 汇合的事件
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
    window.PyramidCore.refreshUI = () => { try { set(); renderEvents(); renderBioStatusFull(); } catch (_) {} };
    window.PyramidCore.openPanel = () => { wrap.classList.add('open'); set(); };
    const fab = document.createElement('button'); fab.id='pyramid-core-fab'; fab.textContent='🔺'; fab.title='Pyramid Core'; fab.onclick=()=>{ wrap.classList.toggle('open'); set(); }; document.body.appendChild(fab);
    hideChildFabs();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUI, { once: true }); else mountUI();
  console.log(`[Pyramid Core Unified] v${VERSION} ready`, window.PyramidCore.getStatus());
})();
