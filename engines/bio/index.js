/**
 * 角色生理监测 v0.6.49
 *
 * 设计原则（人类模拟）：
 * - 本程序 = 身体传感器 / 器官
 * - 主 API = 大脑
 * - 平时完全静默，只在后台记账
 * - 只有需求真正达到「人类会明显感觉到、需要处理」的阈值时，才向大脑发送极简客观信号
 * - 绝不以「我好难受、好饿、下面好痒」的方式抢戏
 *
 * 日常需求：取最近 10 层 → 总结时间与行为 → 阈值触发才上报
 * 分级冷却：关注/迫切/应急分别有不同再次提醒间隔，防止大脑长期忽略生理极限
 * 生殖系统：后台推进 + 投骰子决定来潮时机 + 必须留准备窗口 + 冷静上报
 * 日志：可查看程序做了什么、是否乱来
 */
(function () {
  'use strict';

  const EXT_KEY = 'rpe_physio_monitor_v06';
  const PROMPT_KEY = 'rpe_physio_state_v06';
  const RULE_LIB = [{"id": "no_signal_no_sanji", "title": "无信号不演三急", "tags": ["bio", "iron"], "keywords": ["尿", "饿", "渴", "困", "厕所", "BIO", "生理"], "priority": 100, "always_with_bio": true, "content": "【无信号不演三急】\n身体状态以 BIO 信号为准。\n- 无「迫切/应急」信号：禁止把排尿/饥渴/睡眠写成紧急危机或反复擦边；可有一闪而过的轻微不适，不得当主线。\n- 有信号：按阶段提高优先级；处理完恢复正常叙事。\n- 周期信息只作背景，不是发情指令。"}, {"id": "no_qianghua", "title": "禁止抢话", "tags": ["iron"], "keywords": [], "priority": 95, "always_with_bio": true, "content": "【禁止抢话/抢行动】\n- 禁止替玩家写未声明的台词、动作、决定、心理。\n- 用户已写出的动作：只作既成事实，禁止再写大段走位、坐下、伸手等过程特写（不要重演一遍）。\n- 用户未写的行动视为未发生。\n- 本轮重点写 NPC 反应、环境与对话，玩家侧保持短句或省略。"}, {"id": "no_proactive_nsfw", "title": "禁止主动发情", "tags": ["iron", "nsfw"], "keywords": ["发情", "性爱", "做爱"], "priority": 95, "always_with_bio": true, "content": "【禁止主动发情与性化剧情】\n- 用户未明确做出性相关行为或强烈性暗示前：禁止角色发情、情欲暴涨、主动往性爱推进。\n- 日常对话/争吵/普通接触保持非色情。\n- 性爱结束后恢复日常状态，禁止写成持续求欢。\n- 用户不主动，剧情不往性爱拉。"}, {"id": "post_sex_personality", "title": "性爱后性格恢复", "tags": ["iron", "nsfw"], "keywords": ["性爱", "事后", "高潮", "射精", "做爱", "操"], "priority": 90, "always_with_bio": false, "content": "【性爱后性格恢复】\n- 性爱中可失控；结束后必须逐渐恢复原性格与独立意识。\n- 禁止单次性爱导致永久工具化、只想被操、缠人不放。\n- 允许短暂余韵/羞耻/酸软，须在合理时间消退。\n- 重大态度转变需要时间与动机，禁止一次高潮锁死人设。"}, {"id": "protect_user_persona", "title": "用户人格保护", "tags": ["iron"], "keywords": ["暴君", "黑化"], "priority": 92, "always_with_bio": true, "content": "【用户人格保护】\n- 「我」的性格以用户实际言行与明确意愿为准。\n- 禁止擅自给「我」加暴君/冷血/活阎王/纯施虐者等标签并固化。\n- 禁止把用户温和动作改写成甩、扔、粗暴支配。\n- 临时强势可写，不得据此永久定性。"}, {"id": "info_isolation", "title": "信息隔离", "tags": ["iron"], "keywords": [], "priority": 80, "always_with_bio": false, "content": "【信息隔离】\n- 世界书/后台设定仅供 AI，角色本人不知道。\n- 角色只能依据亲身经历、所见所闻思考与说话。\n- 禁止跨角色传递其不应知道的私密关系或秘密。"}, {"id": "bio_stages", "title": "BIO阶段行为", "tags": ["bio", "behavior"], "keywords": ["迫切", "应急", "关注"], "priority": 85, "always_with_bio": true, "content": "【BIO 阶段行为｜有信号时】\n关注：可继续当前事，偶发分心，禁止反复自述身体。\n迫切：应找现成条件（厕/水/食/休息处）；社交场合用短借口离开，处理后回正常。\n应急：有条件应尽快处理；无条件则改路线、中断闲聊、创造条件。禁止应急下长时间纯聊天硬憋。\n信号只改优先级，不改人设。"}];
  const FLOORS = 10; // 固定取最近 10 层做总结
  const NEED_KEYS = ['drink', 'meal', 'urination', 'bowel_movement', 'sleep'];
  const LABEL = {
    drink: '饮水',
    meal: '进食',
    urination: '排尿',
    bowel_movement: '排便',
    sleep: '睡眠'
  };

  // 阈值（小时）：[关注, 迫切, 应急]
  // 只有「迫切」和「应急」才会上报大脑
  const THRESHOLD = {
    drink: [4, 7, 11],
    meal: [5, 9, 18],
    urination: [3, 4.5, 6.5],
    bowel_movement: [12, 20, 30],
    sleep: [14, 18, 26]
  };

  // 分级冷却（剧情小时）：同一需求再次上报的最小间隔
  // 应急阶段冷却短，防止大脑长期忽略生理极限
  const COOLDOWN_HOURS = {
    '关注': 5.0,
    '迫切': 2.0,
    '应急': 0.75
  };

  const STAGE_ORDER = ['平稳', '关注', '迫切', '应急'];
  const CYCLE_LEN = 28;

  const BLOCK = new Set([
    'sillytavern system', 'system', 'sys', '酒馆系统', 'user', '用户',
    'assistant', 'human', 'narrator', '{{user}}'
  ]);

  const defaultCfg = () => ({
    baseUrl: 'https://gcli.ggchan.dev/',
    apiKey: '',
    model: 'gemini-3.1-pro-preview',
    sideApiEnabled: true,
    injectEnabled: true,          // 是否允许向主提示词写入信号
    rulesEnabled: true,
    rulesEvery: 2,
    rulesCoarseFilter: true,           // 注入时附带本地短铁律
    hardSync: true,               // 是否加「请与状态保持一致」约束
    enabledNeeds: NEED_KEYS.slice(),
    trackReproductive: true,
    offscreenAdvance: true,
    autoEvery: 3,                 // 每 N 条 AI 回复自动读取一次
    excludeNames: '',
    fabLeft: null,
    fabTop: null,
    reportMinStage: '迫切',       // 只有达到这个阶段及以上才上报（迫切 / 应急）
    logMax: 80
  });

  let fab, panel, drag, busy = false, lastLog = '', view = 'home', viewChar = '';
  let cachedModels = [];
  let currentChatKey = 'global';

  // ==================== 基础工具 ====================
  function emptySnap() {
    return {
      version: 6,
      primed: false,
      assistantCount: 0,
      timeline: null,
      storyClock: null,
      characters: {},
      conceptionLedger: {},
      lastReadKey: '',
      // reportHistory: { "角色名|需求key": { hours, stage, count } }
      reportHistory: {}
    };
  }

  function getChatKey() {
    try {
      const ctx = getCtx();
      if (!ctx) return 'global';

      // 稳定 ID：禁止加入消息条数，否则每发一条都会换存档
      const chatId =
        ctx.chatId ??
        ctx.chat_id ??
        ctx.chatMetadata?.chat_id ??
        ctx.chatMetadata?.file_name ??
        ctx.chat_filename ??
        ctx.chatName ??
        '';

      const charId =
        ctx.characterId ??
        ctx.character_id ??
        (Array.isArray(ctx.characters) && ctx.characterId != null
          ? (ctx.characters[ctx.characterId]?.avatar || ctx.characters[ctx.characterId]?.name)
          : '') ??
        ctx.name2 ??
        '';

      const chat = ctx.chat;
      const hasMessages = Array.isArray(chat) && chat.length > 0;
      const looksEmptyHome = !String(chatId) && !String(charId) && !hasMessages;
      if (looksEmptyHome) return '__home__';

      const key = [String(charId || ''), String(chatId || '')]
        .map(x => String(x).trim())
        .filter(Boolean)
        .join('::');

      if (key) return key.slice(0, 180);

      // 没有稳定 id 时：只用「第一条消息」指纹（固定），不要用最后一条或长度
      if (hasMessages) {
        const a = String(chat[0]?.mes || chat[0]?.message || '').slice(0, 40);
        return ('fp::' + a).slice(0, 180);
      }
    } catch (_) {}
    return 'global';
  }

  function storageKey(k, chatScoped) {
    if (chatScoped) return EXT_KEY + '_c_' + currentChatKey + '_' + k;
    return EXT_KEY + '_' + k;
  }

  function load(k, def, chatScoped) {
    try {
      const raw = localStorage.getItem(storageKey(k, chatScoped));
      if (raw) {
        const o = JSON.parse(raw);
        return typeof def === 'function' ? Object.assign(def(), o) : Object.assign({}, def, o);
      }
    } catch (_) {}
    // 旧版全局 snap：只迁移一次到「非 home」聊天，且打迁移标记，避免主界面反复带出旧角色
    if (chatScoped && k === 'snap' && currentChatKey !== '__home__' && currentChatKey !== 'global') {
      try {
        const flag = localStorage.getItem(EXT_KEY + '_legacy_migrated');
        const legacy = localStorage.getItem(EXT_KEY + '_snap');
        if (!flag && legacy) {
          const o = JSON.parse(legacy);
          localStorage.setItem(EXT_KEY + '_legacy_migrated', '1');
          return Object.assign(emptySnap(), o);
        }
      } catch (_) {}
    }
    return typeof def === 'function' ? def() : def;
  }

  function save(k, v, chatScoped) {
    try { localStorage.setItem(storageKey(k, chatScoped), JSON.stringify(v)); } catch (_) {}
  }

  // cfg 全局；snap / logs 按聊天隔离
  let cfg = load('cfg', defaultCfg, false);
  let snapshot = emptySnap();
  let logs = [];

  function saveCfg() { save('cfg', cfg, false); }
  function saveSnap() { save('snap', snapshot, true); }
  function saveLogs() {
    if (logs.length > (cfg.logMax || 80)) logs = logs.slice(-(cfg.logMax || 80));
    save('logs', logs, true);
  }

  function switchToChat(key) {
    if (!key) key = 'global';
    if (key === currentChatKey && snapshot && snapshot.version) return false;
    // 先落盘旧聊天
    try { saveSnap(); saveLogs(); } catch (_) {}
    currentChatKey = key;
    snapshot = load('snap', emptySnap, true);
    logs = load('logs', () => [], true);
    if (!Array.isArray(logs)) logs = [];
    if (!snapshot.version || snapshot.version < 6) snapshot = emptySnap();
    // 主界面不展示其它聊天的角色
    if (key === '__home__') {
      snapshot = emptySnap();
    }
    view = 'home';
    viewChar = '';
    lastLog = '';
    const label = key === '__home__' ? '主界面' : (key === 'global' ? '默认' : key.slice(0, 32));
    addLog('system', '已切换聊天存档：' + label);
    if (panel) render();
    return true;
  }

  function ensureChatScope() {
    const key = getChatKey();
    if (key !== currentChatKey) switchToChat(key);
  }

  function addLog(type, msg) {
    const t = new Date();
    const time = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    logs.push({ time, type, msg: String(msg || '') });
    saveLogs();
    lastLog = msg;
    // 上交给统一 Core（Core 缺席时静默降级，BIO 仍可独立工作）
    try { window.PyramidCore?.pushEvent?.('bio-log', { type, msg: String(msg || ''), time }); } catch (_) {}
  }

  function getCtx() {
    try {
      if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext();
    } catch (_) {}
    try {
      if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
    } catch (_) {}
    return null;
  }

  function blocked(n) {
    if (!n) return true;
    const s = String(n).trim().toLowerCase();
    return !s || BLOCK.has(s) || s.includes('sillytavern') || /模拟器|system|prompt/i.test(s);
  }

  function isUserSideName(n) {
    if (!n) return true;
    const raw = String(n).trim();
    const s = raw.toLowerCase();
    if (blocked(raw)) return true;
    if (s === 'user' || s === '{{user}}' || s === '用户' || s.includes('{{user}}')) return true;
    try {
      const ctx = getCtx();
      if (!ctx) return false;
      const candidates = [];
      if (ctx.name1) candidates.push(String(ctx.name1));
      if (ctx.name) candidates.push(String(ctx.name));
      if (typeof ctx.user_name === 'string') candidates.push(ctx.user_name);
      const chat = ctx.chat || [];
      for (let i = chat.length - 1; i >= 0 && i >= chat.length - 20; i--) {
        const m = chat[i];
        if (m && m.is_user && m.name) candidates.push(String(m.name));
      }
      try {
        if (ctx.personas) {
          for (const k of Object.keys(ctx.personas)) {
            const p = ctx.personas[k];
            if (typeof p === 'string') candidates.push(p);
            else if (p?.name) candidates.push(String(p.name));
          }
        }
      } catch (_) {}
      for (const c of candidates) {
        if (!c) continue;
        if (String(c).trim() === raw || String(c).trim().toLowerCase() === s) return true;
      }
    } catch (_) {}
    return false;
  }

  function shouldTrackCharacter(n, sexHint) {
    if (isUserSideName(n)) return false;
    if (blocked(n)) return false;
    const ex = String(cfg.excludeNames || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    for (const e of ex) {
      if (e && (e === n || e.toLowerCase() === String(n).toLowerCase())) return false;
    }
    const sex = String(sexHint || '').toLowerCase();
    if (sex === 'male' || sex === 'm' || sex === '男' || sex === 'man' || sex === 'boy') return false;
    if (sex === 'female' || sex === 'f' || sex === '女' || sex === 'woman' || sex === 'girl') return true;
    const existing = snapshot.characters[n];
    if (existing && existing.sex === 'male') return false;
    return true;
  }

  function stageNeed(key, h) {
    const t = THRESHOLD[key] || [4, 8, 12];
    if (h >= t[2]) return '应急';
    if (h >= t[1]) return '迫切';
    if (h >= t[0]) return '关注';
    return '平稳';
  }

  function stageRank(s) {
    const i = STAGE_ORDER.indexOf(String(s || ''));
    return i < 0 ? 0 : i;
  }

  function shouldReportStage(stage) {
    return stageRank(stage) >= stageRank(cfg.reportMinStage || '迫切');
  }

  /**
   * 分级冷却判断：同一角色同一需求是否允许再次上报
   * - 首次达到阈值：立即上报
   * - 之后按阶段冷却：关注~5h / 迫切~2h / 应急~0.75h
   * - 阶段升级（例如从迫切变成应急）时强制允许再报一次
   */
  function canReportNeed(name, needKey, stage, nowHours) {
    if (!shouldReportStage(stage)) return false;
    if (nowHours == null || !Number.isFinite(nowHours)) return true;

    if (!snapshot.reportHistory) snapshot.reportHistory = {};
    const key = name + '|' + needKey;
    const hist = snapshot.reportHistory[key];

    // 从未上报过
    if (!hist || hist.hours == null) return true;

    // 阶段升级（更严重了）→ 允许立刻再报
    if (stageRank(stage) > stageRank(hist.stage)) return true;

    const cd = COOLDOWN_HOURS[stage] ?? COOLDOWN_HOURS['迫切'] ?? 2;
    const elapsedSinceReport = nowHours - hist.hours;
    return elapsedSinceReport >= cd;
  }

  function markReported(name, needKey, stage, nowHours) {
    if (!snapshot.reportHistory) snapshot.reportHistory = {};
    const key = name + '|' + needKey;
    const prev = snapshot.reportHistory[key] || { count: 0 };
    snapshot.reportHistory[key] = {
      hours: nowHours,
      stage,
      count: (prev.count || 0) + 1
    };
  }

  function buildNeedSignal(name, needKey, stage, elapsed, reportCount) {
    const base = `${name}：${LABEL[needKey]}已达「${stage}」阶段，约 ${fmtElapsed(elapsed)} 未满足。`;
    // 应急阶段且已提醒过至少一次 → 升级语气，强调生理极限
    if (stage === '应急' && reportCount >= 1) {
      return base + ' 持续未处理已接近生理极限，长时间强行忍耐不符合正常人类应急反应。';
    }
    if (stage === '迫切' && reportCount >= 2) {
      return base + ' 该状态已持续存在，建议尽快处理。';
    }
    return base;
  }

  function maxStage(a, b) {
    return stageRank(a) >= stageRank(b) ? a : b;
  }

  function stageClass(s) {
    const x = String(s || '');
    if (/应急|迫切|月经期|孕晚期|已受孕/.test(x)) return 'rpe-bad';
    if (/关注|易孕|孕中|黄体|待判定/.test(x)) return 'rpe-warn';
    if (/孕|经|卵泡|周期|受孕/.test(x)) return 'rpe-info';
    return 'rpe-ok';
  }

  function fmtElapsed(h) {
    if (h == null || !Number.isFinite(+h)) return '—';
    h = +h;
    if (h < 1) return Math.max(0, Math.round(h * 60)) + ' 分钟';
    if (h < 48) return (Math.round(h * 10) / 10) + ' 小时';
    return (Math.round(h / 24 * 10) / 10) + ' 天';
  }

  function timelineToHours(t) {
    if (!t || t.day == null) return null;
    return (Number(t.day) - 1) * 24 + (Number(t.hour) || 0) + (Number(t.minute) || 0) / 60;
  }

  function hoursToTimeline(hours) {
    if (hours == null || !Number.isFinite(hours)) return null;
    const totalMin = Math.max(0, Math.round(hours * 60));
    const day = Math.floor(totalMin / (24 * 60)) + 1;
    const rem = totalMin % (24 * 60);
    return { day, hour: Math.floor(rem / 60), minute: rem % 60 };
  }

  function timelineLabel(t) {
    t = t || snapshot.timeline;
    if (!t || t.day == null) return '';
    return `D${t.day} ${String(t.hour ?? 0).padStart(2, '0')}:${String(t.minute ?? 0).padStart(2, '0')}`;
  }

  function phaseFromCycleDay(day) {
    if (day == null || !Number.isFinite(+day)) return '周期未知';
    const d = ((Math.floor(+day) - 1) % CYCLE_LEN) + 1;
    if (d <= 5) return '月经期';
    if (d <= 11) return '卵泡期';
    if (d <= 16) return '易孕期';
    return '黄体期';
  }

  function pregnancyPhase(days) {
    if (days == null || !Number.isFinite(+days) || +days < 0) return '无';
    if (+days < 84) return '孕早期';
    if (+days < 196) return '孕中期';
    return '孕晚期';
  }

  function emptyChar() {
    return {
      mode: 'detailed',
      sex: 'female',
      present: true,
      needs: {},
      menstrual_cycle: {
        active: false,
        phase: '周期未知',
        cycle_day: null,
        last_period_start_hours: null,
        user_awareness: '未知',
        prepared: false,          // 是否已进入可准备窗口并通知过
        approaching_notified: false
      },
      conception: {
        sperm_entered: '否',
        outcome: '无',
        event_no: null,
        event_risk_percent: null,
        combined_risk_percent: null,
        elapsed_days: null,
        window_started_hours: null,
        user_awareness: '未知'
      },
      pregnancy: {
        active: false,
        confirmation: '待确认',
        phase: '无',
        gestation_days: null,
        started_hours: null,
        user_awareness: '未知'
      },
      updatedFromChat: false,
      lastSeenTimelineHours: null
    };
  }

  function ensureChar(name, sexHint) {
    if (!shouldTrackCharacter(name, sexHint)) return null;
    if (!snapshot.characters[name]) snapshot.characters[name] = emptyChar();
    const ch = snapshot.characters[name];
    if (sexHint) {
      const s = String(sexHint).toLowerCase();
      ch.sex = (s.startsWith('f') || sexHint === '女') ? 'female' : ((s.startsWith('m') || sexHint === '男') ? 'male' : ch.sex);
    }
    if (ch.sex === 'male') {
      delete snapshot.characters[name];
      return null;
    }
    ch.sex = 'female';
    return ch;
  }

  /**
   * 首次成为常驻时投骰定周期位置
   * 绝对排除：正在月经期（D1–D5）
   * 只允许：经期已过（卵泡/易孕/黄体）或快来之前（D26–D28 可准备）
   */
  function seedCycleOnFirstResident(ch, nowHours, name) {
    if (!cfg.trackReproductive || !ch) return null;
    if (ch.menstrual_cycle?.last_period_start_hours != null) return null; // 已有锚点
    if (ch.pregnancy?.active) return null;
    if (nowHours == null || !Number.isFinite(nowHours)) return null;

    // 允许日：6–28（排除 1–5 月经期）
    // 权重：卵泡 6–11、易孕 12–16、黄体 17–25、临近 26–28
    const bag = [];
    for (let d = 6; d <= 11; d++) bag.push(d, d);       // 卵泡期稍多
    for (let d = 12; d <= 16; d++) bag.push(d, d, d);    // 易孕期常见
    for (let d = 17; d <= 25; d++) bag.push(d, d);       // 黄体期
    for (let d = 26; d <= 28; d++) bag.push(d);          // 快来之前（可准备）

    const cycleDay = bag[Math.floor(Math.random() * bag.length)];
    const phase = phaseFromCycleDay(cycleDay);
    // 反推起始锚点：现在是第 cycleDay 天 → 起始在 (cycleDay-1) 天前
    const startHours = nowHours - (cycleDay - 1) * 24;

    ch.menstrual_cycle.last_period_start_hours = startHours;
    ch.menstrual_cycle.cycle_day = cycleDay;
    ch.menstrual_cycle.phase = phase;
    ch.menstrual_cycle.active = true;
    ch.menstrual_cycle.user_awareness = '未知';
    ch.menstrual_cycle.prepared = false;
    ch.menstrual_cycle.approaching_notified = false;
    ch.menstrual_cycle._periodStartedNotified = false;
    ch.menstrual_cycle._seeded = true;

    addLog('seed', name + ' 首次常驻，投骰周期 D' + cycleDay + ' · ' + phase + '（已排除月经期）');

    // 若抽中快来之前，可顺带进入可准备意识（仍不直接来潮）
    if (cycleDay >= 26) {
      ch.menstrual_cycle.approaching_notified = true;
      ch.menstrual_cycle.prepared = true;
      return {
        type: 'period_approaching',
        msg: name + '：根据周期推算，月经可能在未来 1–3 天内来潮。角色应具备基本准备意识。'
      };
    }
    return null;
  }

  // ==================== 正文收集与独立 API ====================
  function collectRecentStory(maxFloors) {
    const ctx = getCtx();
    const chat = ctx?.chat || [];
    const parts = [];
    for (let i = chat.length - 1; i >= 0 && parts.length < maxFloors; i--) {
      const m = chat[i];
      if (!m) continue;
      const text = (m.mes || m.message || '').trim();
      if (!text) continue;
      parts.unshift(`【${m.is_user ? '用户' : '正文'}】\n${text.slice(0, 2800)}`);
    }
    return parts.join('\n\n');
  }

  function fingerprintStory(story) {
    const s = story || '';
    return s.length + ':' + s.slice(0, 80) + ':' + s.slice(-80);
  }

  function completionsUrl() {
    let u = (cfg.baseUrl || '').trim();
    if (!u) return '';
    if (!u.endsWith('/')) u += '/';
    if (u.includes('/chat/completions')) return u.replace(/\/+$/, '');
    return u + 'chat/completions';
  }

  function modelsUrl() {
    let u = (cfg.baseUrl || '').trim();
    if (!u) return '';
    u = u.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/v1$/i, '');
    return u + '/v1/models';
  }

  async function fetchModelList() {
    if (!cfg.apiKey) throw new Error('未填 API Key');
    const res = await fetch(modelsUrl(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + cfg.apiKey }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let ids = [];
    if (Array.isArray(data?.data)) ids = data.data.map(x => x.id || x.name).filter(Boolean);
    else if (Array.isArray(data?.models)) ids = data.models.map(x => (typeof x === 'string' ? x : x.id)).filter(Boolean);
    cachedModels = [...new Set(ids)].sort();
    if (!cachedModels.length) throw new Error('列表为空');
    return cachedModels;
  }

  // 总结 + 事实抽取提示词（只抽取客观事实，禁止写感受）
  function factSystemPrompt() {
    return `你是身体状态事实抽取器，不是作者，也不是角色。
根据最近对话正文，只输出 JSON，禁止任何剧情描写、感受描写、心理活动。

输出格式：
{
  "timeline": {"day":数字,"hour":数字,"minute":数字} 或 null,
  "delta_hours": 数字或 null,          // 相对上一时间点流逝的小时数
  "summary": "一两句客观总结：过了约多少时间，角色主要在做什么，有没有明确进食/饮水/休息/如厕行为",
  "characters": [
    {
      "name": "仅女性角色名",
      "sex": "female",
      "present": true/false,
      "needs": {
        "drink": {"elapsed": 数字或null, "satisfied_now": true/false},
        "meal":  {"elapsed": 数字或null, "satisfied_now": true/false},
        "urination": {"elapsed": 数字或null, "satisfied_now": true/false},
        "bowel_movement": {"elapsed": 数字或null, "satisfied_now": true/false},
        "sleep": {"elapsed": 数字或null, "satisfied_now": true/false, "sleeping": true/false, "awake_for": 数字或null}
      },
      "facts": {
        "period_start": true/false,
        "cycle_day_hint": 数字或null,
        "phase_hint": "月经期|卵泡期|易孕期|黄体期|null",
        "sexual_exposure": {
          "occurred": true/false,
          "sperm_entered": "是|否|未知",
          "barrier_effective": true/false,
          "same_continuous_act": true/false,
          "emergency_contraception": true/false
        },
        "pregnancy_confirmed": true/false,
        "pregnancy_denied": true/false,
        "gestation_days_hint": 数字或null,
        "awareness": {"cycle":"已知|未知", "conception":"已知|未知", "pregnancy":"已知|未知"}
      }
    }
  ]
}

规则：
1. 只输出女性角色，严禁用户、男性、系统、{{user}}。
2. 【时间强制】timeline 与 delta_hours 至少填一个，禁止两者都为 null。
   - 正文有钟点/日期 → 填 timeline（day/hour/minute）。
   - 只有「一会儿/到家/继续」→ 估算 delta_hours（一轮对话约0.1～0.5小时，短途约0.2～1小时，禁止无故填0）。
   - 若有 previous.timeline，在其基础上累加 delta_hours。
3. elapsed 为距「上次真正满足该需求」的小时数；本段若未进食/饮水，elapsed 应随时间增加，勿一直 null。
4. 无明确依据时不要捏造月经来潮或怀孕。
5. summary 必须含时间，如「约过了0.3小时，…，未进食未饮水」。禁止只写情节；禁止身体感受词。`;
  }

  async function callFactApi(story) {
    if (!cfg.apiKey) throw new Error('未填 API Key');
    const url = completionsUrl();
    if (!url) throw new Error('未填 Base URL');

    const previous = {
      timeline: snapshot.timeline,
      characters: Object.entries(snapshot.characters).map(([name, c]) => ({
        name,
        needs: c.needs,
        menstrual_cycle: c.menstrual_cycle,
        conception: c.conception,
        pregnancy: c.pregnancy,
        present: c.present
      }))
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: factSystemPrompt() },
          {
            role: 'user',
            content: JSON.stringify({
              enabled_needs: cfg.enabledNeeds,
              track_reproductive: cfg.trackReproductive,
              previous,
              story_floors: story
            })
          }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + errText.slice(0, 120));
    }
    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || '';
    if (typeof content !== 'string') content = JSON.stringify(content);
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('无 JSON');
    return JSON.parse(m[0]);
  }

  // ==================== 生殖逻辑（可准备窗口 + 投骰子） ====================
  function riskPercent(exposure) {
    if (!exposure || !exposure.occurred) return 0;
    if (exposure.barrier_effective) return 2;
    if (exposure.sperm_entered === '否') return 1;
    if (exposure.emergency_contraception) return 5;
    return 18;
  }

  function rollConception(name, eventNo, baseRisk) {
    const key = name + '#' + eventNo;
    const led = snapshot.conceptionLedger[key];
    if (led && led.rolled) return led;
    const r = Math.random() * 100;
    const outcome = r < baseRisk ? '已受孕' : '未受孕';
    const rec = { rolled: true, outcome, risk: baseRisk, roll: r };
    snapshot.conceptionLedger[key] = rec;
    return rec;
  }

  /**
   * 经期来潮逻辑（核心改进）：
   * - 在预计窗口内投骰子决定是否真正开始
   * - 必须先进入「可准备」状态并通知一次，禁止直接跳到「正在大出血」
   */
  function tryAdvancePeriod(ch, nowHours, name) {
    if (!cfg.trackReproductive || ch.pregnancy?.active) return null;
    if (ch.menstrual_cycle.last_period_start_hours == null) return null;

    const daysSince = (nowHours - ch.menstrual_cycle.last_period_start_hours) / 24;
    let cycleDay = Math.floor(daysSince) % CYCLE_LEN + 1;
    if (cycleDay <= 0) cycleDay = 1;

    ch.menstrual_cycle.cycle_day = cycleDay;
    ch.menstrual_cycle.phase = phaseFromCycleDay(cycleDay);
    ch.menstrual_cycle.active = true;

    // 只有在「即将进入月经期」或「刚进入」的窄窗口才考虑通知
    // 禁止在毫无准备的情况下突然变成「正在月经期大出血」
    const isApproaching = cycleDay >= 26 || cycleDay <= 1; // 黄体期末 ~ 月经期初
    const isEarlyPeriod = cycleDay >= 1 && cycleDay <= 2;

    if (isApproaching && !ch.menstrual_cycle.approaching_notified) {
      // 投一个轻骰，决定是否提前通知「快来了」
      if (Math.random() < 0.55) {
        ch.menstrual_cycle.approaching_notified = true;
        ch.menstrual_cycle.prepared = true;
        return {
          type: 'period_approaching',
          msg: `${name}：根据既往周期规律，月经可能在未来 1–2 天内来潮。角色应具备基本准备意识（如携带卫生用品）。`
        };
      }
    }

    // 真正进入月经期第 1 天，且已经通知过准备，才上报「已来潮」
    if (isEarlyPeriod && ch.menstrual_cycle.prepared && !ch.menstrual_cycle._periodStartedNotified) {
      ch.menstrual_cycle._periodStartedNotified = true;
      return {
        type: 'period_started',
        msg: `${name}：月经期已开始（第 ${cycleDay} 天）。角色已知晓并应已做基本准备。`
      };
    }

    return null;
  }

  function advanceReproductiveTo(nowHours) {
    if (nowHours == null || !cfg.trackReproductive || !cfg.offscreenAdvance) return [];
    const signals = [];

    for (const [name, ch] of Object.entries(snapshot.characters)) {
      if (blocked(name)) continue;

      // 怀孕推进
      if (ch.pregnancy?.active && ch.pregnancy.started_hours != null) {
        ch.pregnancy.gestation_days = Math.max(0, (nowHours - ch.pregnancy.started_hours) / 24);
        ch.pregnancy.phase = pregnancyPhase(ch.pregnancy.gestation_days);
      }

      // 经期推进 + 可准备窗口
      const sig = tryAdvancePeriod(ch, nowHours, name);
      if (sig) signals.push(sig);

      // 受孕窗超时关闭
      if (ch.conception?.outcome === '待判定' && ch.conception.window_started_hours != null) {
        ch.conception.elapsed_days = Math.max(0, (nowHours - ch.conception.window_started_hours) / 24);
        if (ch.conception.elapsed_days > 14) {
          ch.conception.outcome = '未受孕';
        }
      }
    }
    return signals;
  }

  // ==================== 应用事实 + 生成上报信号 ====================
  /** 从正文解析绝对时刻（年-月-日 时:分），用于算流逝，不直接改写相对 D 日 */
  function parseStoryAbsoluteClock(storyText) {
    const s = String(storyText || '');
    if (!s.trim()) return null;

    // 只认「场景时间头」行：年月日 + 时:分，且像正文抬头（星期/天气/温度），排除待办档案
    const lineRe = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日([^\n]{0,60}?)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)([^\n]{0,40})/g;
    let m, last = null;
    while ((m = lineRe.exec(s)) !== null) {
      const mid = m[4] || '';
      const tail = m[7] || '';
      const line = (m[0] || '');
      // 排除柚月档案/待办：事项、待办、约定、优先级标记等
      if (/待办|事项|约定|追踪|档案|优先级/.test(line)) continue;
      if (/[（(]\s*[高中低]\s*[）)]/.test(line)) continue;
      // 场景头特征：星期 / 天气 / 温度；或中间只有点号装饰
      const sceneLike = /星期|周[一二三四五六日天]|晴|阴|雨|雪|℃|°C|气温/.test(mid + tail)
        || /^[\s·•・\-—~～|｜]*$/.test(mid.replace(/星期.?/g, ''));
      // 弱场景：行首附近且 mid 很短（纯「日 15:16」抬头）
      const weakHeader = mid.length <= 24 && !/搬|送|吃|洗|安顿|前往|跟随|带苏|带李/.test(line);
      if (!sceneLike && !weakHeader) continue;
      if (/搬|送|吃晚|安顿|前往|跟随李|跟随苏|带苏挽莹|带李宁/.test(line) && !sceneLike) continue;
      last = m;
    }
    if (!last) return null;
    const year = +last[1], month = +last[2], day = +last[3], hour = +last[5], minute = +last[6];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const ms = Date.UTC(year, month - 1, day, hour, minute);
    if (!Number.isFinite(ms)) return null;
    return {
      year: year, month: month, day: day, hour: hour, minute: minute, ms: ms,
      matched: String(last[0] || '').replace(/\s+/g, ' ').slice(0, 80)
    };
  }

  /** 只扫聊天正文楼层开头，不扫系统提示词/柚月档案 */
  function parseLatestStoryClock() {
    try {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      for (let i = chat.length - 1; i >= 0 && i >= chat.length - 15; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_system || m.extra?.rpe_physio_signal) continue;
        const text = String(m.mes || m.message || '');
        if (!text || text.indexOf('年') < 0) continue;
        // 时间头几乎总在楼层前部；避免扫到文末复述的待办
        const head = text.slice(0, 500);
        const clock = parseStoryAbsoluteClock(head);
        if (clock) return clock;
      }
    } catch (_) {}
    return null;
  }


  /** 首次常驻：按正文时刻估正常作息初值，全部低于「关注」，不报警、不演三急 */
  function seedEverydayNeedElapsed(hourOfDay) {
    const h = (hourOfDay != null && Number.isFinite(+hourOfDay)) ? +hourOfDay : 14;
    // 假设约 7 点起、8 点早饭、12 点午饭；下午场景常见
    const meal = h >= 13 ? Math.min(4.5, Math.max(0.8, h - 12)) : Math.min(4.0, Math.max(0.8, h - 8));
    const drink = Math.min(3.2, Math.max(0.4, 0.5 + (h % 5) * 0.35));
    const urination = Math.min(2.5, Math.max(0.4, 0.6 + (h % 4) * 0.4));
    const bowel_movement = Math.min(11, Math.max(3.5, 5 + Math.max(0, h - 10) * 0.35));
    const sleep = Math.min(13, Math.max(5, h - 7)); // 清醒时长，低于 sleep 关注 14h
    return { drink, meal, urination, bowel_movement, sleep };
  }

  function applyFacts(result, storyKey, isReplay) {
    if (!result || typeof result !== 'object') throw new Error('空结果');

    let nowHours = timelineToHours(snapshot.timeline);

    // 时间只认正文：有钟点则「设定」为当前时刻，禁止读取叠加、禁止 summary 推进
    if (!isReplay) {
      try {
        const storyTxt = (typeof collectRecentStory === 'function') ? collectRecentStory(FLOORS) : '';
        const clock = parseLatestStoryClock() || parseStoryAbsoluteClock(storyTxt);
        if (clock) {
          const prev = snapshot.storyClock;
          let day = (snapshot.timeline && snapshot.timeline.day != null)
            ? Number(snapshot.timeline.day)
            : 1;

          if (prev && prev.ms != null) {
            // 按日历日差移动相对 D 日，时刻直接用正文时:分（不累加 delta）
            const prevUtcDay = Date.UTC(prev.year, prev.month - 1, prev.day);
            const curUtcDay = Date.UTC(clock.year, clock.month - 1, clock.day);
            const dayDiff = Math.round((curUtcDay - prevUtcDay) / 86400000);
            if (Number.isFinite(dayDiff) && dayDiff !== 0) {
              day = Math.max(1, day + dayDiff);
            }
          } else if (!snapshot.timeline || snapshot.timeline.day == null) {
            day = 1;
          }

          snapshot.timeline = {
            day: day,
            hour: clock.hour,
            minute: clock.minute
          };
          nowHours = timelineToHours(snapshot.timeline);
          snapshot.storyClock = {
            ms: clock.ms,
            year: clock.year,
            month: clock.month,
            day: clock.day,
            hour: clock.hour,
            minute: clock.minute
          };
          saveSnap();
          addLog('system', '正文时间 → ' + timelineLabel() +
            '（' + clock.year + '/' + clock.month + '/' + clock.day + ' ' +
            String(clock.hour).padStart(2, '0') + ':' + String(clock.minute).padStart(2, '0') + '）' +
            (clock.matched ? ' 匹配「' + clock.matched + '」' : ''));
        } else {
          addLog('system', '正文未解析到时间头，本轮不改时钟（总结不拨表）');
        }
      } catch (e) {
        addLog('error', '解析正文时间失败: ' + (e && e.message ? e.message : e));
      }
    }

    // 明确：侧脑 summary / delta_hours / timeline 一律不推进时间

    // 先离场推进生殖
    const reproSignals = nowHours != null ? advanceReproductiveTo(nowHours) : [];

    const list = Array.isArray(result.characters) ? result.characters : [];
    const seen = new Set();
    const reportLines = [];

    // 把总结写进日志
    if (result.summary) {
      addLog('summary', result.summary);
    }

    for (const raw of list) {
      const name = String(raw.name || '').trim();
      const sexHint = raw.sex || raw.gender || raw.facts?.sex || '';
      if (!shouldTrackCharacter(name, sexHint)) continue;
      const ch = ensureChar(name, sexHint);
      if (!ch) continue;
      seen.add(name);
      const prevNeeds = ch.needs || {};
      const isFirstResident = !ch.updatedFromChat && !ch.menstrual_cycle?.last_period_start_hours;
      ch.present = raw.present !== false;
      ch.updatedFromChat = true;
      if (nowHours != null) ch.lastSeenTimelineHours = nowHours;

      // 首次成为常驻：立刻投骰定周期（排除正在月经期）
      if (isFirstResident && cfg.trackReproductive) {
        const seedSig = seedCycleOnFirstResident(ch, nowHours, name);
        if (seedSig) reportLines.push(seedSig.msg);
      }

      // —— 日常需求：距上次只跟正文时间锚走；首次用正常作息初值（低于关注）——
      if (!ch.needAnchors) ch.needAnchors = {};
      const needsIn = raw.needs || {};
      const firstNeedSeed = isFirstResident && nowHours != null && !ch._everydaySeeded;
      let everydaySeed = null;
      if (firstNeedSeed) {
        const hod = snapshot.timeline && snapshot.timeline.hour != null ? snapshot.timeline.hour : 14;
        everydaySeed = seedEverydayNeedElapsed(hod);
        ch._everydaySeeded = true;
        addLog('seed', name + ' 日常作息初值（正文约 ' + hod + ' 点，均低于关注，不上报）');
      }
      for (const k of cfg.enabledNeeds) {
        const src = needsIn[k] || {};
        const prevE = prevNeeds[k]?.elapsed;
        let elapsed = null;

        if (src.satisfied_now) {
          elapsed = 0;
          if (nowHours != null) ch.needAnchors[k] = nowHours;
        } else if (nowHours != null && ch.needAnchors[k] != null) {
          elapsed = Math.max(0, nowHours - ch.needAnchors[k]);
        } else if (nowHours != null && prevE != null && ch.lastSeenTimelineHours != null) {
          const dt = nowHours - ch.lastSeenTimelineHours;
          elapsed = Math.max(0, prevE + (dt > 0 ? dt : 0));
          ch.needAnchors[k] = nowHours - elapsed;
        } else if (firstNeedSeed && everydaySeed && everydaySeed[k] != null) {
          elapsed = everydaySeed[k];
          ch.needAnchors[k] = nowHours - elapsed;
        } else if (prevE == null && src.elapsed != null && Number.isFinite(+src.elapsed)) {
          // 非首次建档的兜底：侧脑 elapsed，但压到关注线以下，避免突然三急
          const t0 = (THRESHOLD[k] || [4, 8, 12])[0];
          elapsed = Math.min(Math.max(0, +src.elapsed), Math.max(0.2, t0 - 0.5));
          if (nowHours != null) ch.needAnchors[k] = nowHours - elapsed;
        } else {
          elapsed = prevE != null ? prevE : null;
        }

        let stage = '平稳';
        if (elapsed != null) stage = stageNeed(k, elapsed);

        ch.needs[k] = {
          elapsed,
          stage,
          awake_for: k === 'sleep' ? (src.awake_for != null ? +src.awake_for : elapsed) : undefined,
          sleeping: k === 'sleep' ? !!src.sleeping : undefined
        };

        // 满足后清除该需求的上报历史，允许下次重新开始计数
        if (elapsed === 0 && snapshot.reportHistory) {
          delete snapshot.reportHistory[name + '|' + k];
        }

        // 分级冷却：达到阈值且冷却时间已过才上报
        if (elapsed != null && canReportNeed(name, k, stage, nowHours)) {
          const hist = (snapshot.reportHistory || {})[name + '|' + k] || { count: 0 };
          const signal = buildNeedSignal(name, k, stage, elapsed, hist.count || 0);
          reportLines.push(signal);
          markReported(name, k, stage, nowHours);
        }
      }

      if (!cfg.trackReproductive) continue;
      const f = raw.facts || {};

      // 已孕优先
      if (f.pregnancy_confirmed || ch.pregnancy.active) {
        if (!ch.pregnancy.active) {
          ch.pregnancy.active = true;
          ch.pregnancy.confirmation = '已确认';
          ch.pregnancy.started_hours = nowHours != null
            ? nowHours - (f.gestation_days_hint != null ? +f.gestation_days_hint * 24 : 0)
            : null;
          ch.pregnancy.gestation_days = f.gestation_days_hint != null ? +f.gestation_days_hint : 0;
        }
        if (f.gestation_days_hint != null && Number.isFinite(+f.gestation_days_hint)) {
          ch.pregnancy.gestation_days = +f.gestation_days_hint;
          if (nowHours != null) ch.pregnancy.started_hours = nowHours - ch.pregnancy.gestation_days * 24;
        }
        ch.pregnancy.phase = pregnancyPhase(ch.pregnancy.gestation_days);
        if (f.awareness?.pregnancy) ch.pregnancy.user_awareness = f.awareness.pregnancy;
        ch.conception.outcome = '已受孕';
        ch.menstrual_cycle.active = false;
      }

      if (f.pregnancy_denied && ch.conception.outcome === '待判定') {
        ch.conception.outcome = '未受孕';
      }

      // 经期（未孕）
      if (!ch.pregnancy.active) {
        if (f.period_start && nowHours != null) {
          // 正文明确写了来潮，才直接记录，并视为已准备
          ch.menstrual_cycle.last_period_start_hours = nowHours;
          ch.menstrual_cycle.cycle_day = 1;
          ch.menstrual_cycle.phase = '月经期';
          ch.menstrual_cycle.active = true;
          ch.menstrual_cycle.prepared = true;
          ch.menstrual_cycle.approaching_notified = true;
        }
        if (f.cycle_day_hint != null && Number.isFinite(+f.cycle_day_hint)) {
          ch.menstrual_cycle.cycle_day = +f.cycle_day_hint;
          ch.menstrual_cycle.phase = f.phase_hint || phaseFromCycleDay(+f.cycle_day_hint);
          ch.menstrual_cycle.active = true;
          if (nowHours != null && ch.menstrual_cycle.last_period_start_hours == null) {
            ch.menstrual_cycle.last_period_start_hours = nowHours - (+f.cycle_day_hint - 1) * 24;
          }
        } else if (f.phase_hint) {
          ch.menstrual_cycle.phase = f.phase_hint;
          ch.menstrual_cycle.active = f.phase_hint !== '周期未知';
        }
        if (f.awareness?.cycle) ch.menstrual_cycle.user_awareness = f.awareness.cycle;

        // 用锚点重算
        if (ch.menstrual_cycle.last_period_start_hours != null && nowHours != null) {
          const days = Math.floor((nowHours - ch.menstrual_cycle.last_period_start_hours) / 24);
          ch.menstrual_cycle.cycle_day = (days % CYCLE_LEN) + 1;
          ch.menstrual_cycle.phase = phaseFromCycleDay(ch.menstrual_cycle.cycle_day);
          ch.menstrual_cycle.active = true;
        }
      }

      // 受孕暴露
      if (!ch.pregnancy.active) {
        const ex = f.sexual_exposure;
        if (ex && ex.occurred && (ex.sperm_entered === '是' || (ex.sperm_entered !== '否' && !ex.barrier_effective))) {
          ch.conception.sperm_entered = ex.sperm_entered === '否' ? '否' : '是';
          if (ch.conception.sperm_entered === '是') {
            const cont = !!ex.same_continuous_act && ch.conception.outcome === '待判定' && ch.conception.event_no != null;
            if (!cont) {
              ch.conception.event_no = (ch.conception.event_no || 0) + 1;
              if (nowHours != null) ch.conception.window_started_hours = nowHours;
            }
            ch.conception.outcome = '待判定';
            let risk = riskPercent(ex);
            if (ch.menstrual_cycle.phase === '易孕期') risk = Math.min(45, Math.round(risk * 1.6));
            if (ch.menstrual_cycle.phase === '月经期') risk = Math.max(3, Math.round(risk * 0.4));
            ch.conception.event_risk_percent = risk;
            ch.conception.combined_risk_percent = risk;

            if (!isReplay || !snapshot.conceptionLedger[name + '#' + ch.conception.event_no]?.rolled) {
              const rec = rollConception(name, ch.conception.event_no, risk);
              if (rec.outcome === '已受孕') {
                ch.conception.outcome = '已受孕';
                ch.pregnancy.active = true;
                ch.pregnancy.confirmation = '待确认';
                ch.pregnancy.gestation_days = 0;
                ch.pregnancy.started_hours = nowHours;
                ch.pregnancy.phase = '孕早期';
                ch.menstrual_cycle.active = false;
                reportLines.push(`${name}：受孕结果已判定为「已受孕」（风险约 ${risk}%）。`);
              } else {
                ch.conception.outcome = '未受孕';
              }
            } else {
              const rec = snapshot.conceptionLedger[name + '#' + ch.conception.event_no];
              ch.conception.outcome = rec.outcome;
            }
          }
        }
        if (f.awareness?.conception) ch.conception.user_awareness = f.awareness.conception;
        if (ch.conception.outcome === '待判定' && ch.conception.window_started_hours != null && nowHours != null) {
          ch.conception.elapsed_days = (nowHours - ch.conception.window_started_hours) / 24;
        }
      }
    }

    // 本批未出现的角色标记离场
    for (const name of Object.keys(snapshot.characters)) {
      if (!seen.has(name)) snapshot.characters[name].present = false;
    }

    // 合并生殖信号
    for (const s of reproSignals) {
      reportLines.push(s.msg);
    }

    snapshot.primed = true;
    snapshot.lastReadKey = storyKey;
    saveSnap();

    // 生成最终注入文本（只有真正有需要上报的内容才注入）
    return reportLines;
  }

  // ==================== 注入（极简信号） ====================

  function getRecentChatText(maxN) {
    try {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      const n = Math.max(1, maxN || 5);
      return chat.slice(-n).map(m => String(m?.mes || m?.message || '')).join('\n');
    } catch (_) {
      return '';
    }
  }

  // 粗筛已停用（保留函数避免旧引用报错）
  const RULE_COARSE = {
    suspect: [
      '你说', '你伸手', '你低头', '你决定', '你走向', '你看着', '你感到', '你想', '你做了', '你开口', '你伸',
      '发情', '情欲', '求操', '欲求不满', '湿透', '主动凑', '身子发软', '呼吸急促',
      '尿意', '憋尿', '要尿', '失禁', '好饿', '饿死', '好渴', '困得', '必须马上上厕所', '再不去厕所', '撑不住',
      '暴君', '活阎王', '冷血', '施虐', '黑化', '周扒皮', '狠狠甩', '像扔',
      '被操服', '当狗', '离不开', '求再来', '事后', '高潮后', '射精后',
      '她知道李宁', '听说了你和', '猜到你们', '知道秘密'
    ],
    exclude: [
      '你说得对', '你说的对', '偷笑', '偷懒', '周扒皮也愿意', '开玩笑', '打趣', '口头禅', '昵称'
    ]
  };

  function coarseRuleSuspect(text) {
    let raw = String(text || '');
    if (!raw.trim()) return { hit: false, reasons: [] };
    for (const ex of RULE_COARSE.exclude) {
      if (ex && raw.indexOf(ex) >= 0) raw = raw.split(ex).join(' ');
    }
    const reasons = [];
    for (const w of RULE_COARSE.suspect) {
      if (w && raw.indexOf(w) >= 0 && reasons.indexOf(w) < 0) reasons.push(w);
    }
    return { hit: reasons.length > 0, reasons: reasons.slice(0, 8) };
  }

  function ruleCatalogForApi() {
    return RULE_LIB.map(r => ({
      id: r.id,
      title: r.title,
      one_liner: String(r.content || '').split('\n').filter(Boolean)[0] || r.title
    }));
  }


  const LEARNED_KEY = 'rpe_physio_rule_memory_v1';
  const LEARNED_MAX = 80;

  function loadLearnedRules() {
    try {
      const raw = localStorage.getItem(LEARNED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveLearnedRules(arr) {
    try {
      localStorage.setItem(LEARNED_KEY, JSON.stringify((arr || []).slice(0, LEARNED_MAX)));
    } catch (_) {}
  }

  function rememberRuleDecision(decision, snippet) {
    if (!decision || typeof decision !== 'object') return;
    const reason = String(decision.reason || '').trim();
    const ids = Array.isArray(decision.activate) ? decision.activate.map(String).filter(Boolean) : [];
    if (!reason && !ids.length) return;

    const text = String(snippet || '').replace(/\s+/g, ' ').trim();
    const excerpt = text.slice(-120);
    let list = loadLearnedRules();
    const sig = ids.slice().sort().join(',') + '|' + reason;
    const hit = list.find(x => x.sig === sig);
    if (hit) {
      hit.count = (hit.count || 1) + 1;
      hit.excerpt = excerpt || hit.excerpt;
      hit.at = Date.now();
    } else {
      list.unshift({
        sig: sig,
        ids: ids,
        reason: reason || (ids.length ? '命中:' + ids.join(',') : '无违规'),
        excerpt: excerpt,
        count: 1,
        at: Date.now()
      });
    }
    list.sort(function(a, b) {
      return (b.count || 0) - (a.count || 0) || (b.at || 0) - (a.at || 0);
    });
    saveLearnedRules(list);
    addLog('rules', '禁令库记入 ' + (ids.length ? ids.join(',') : '空') +
      (reason ? '｜' + reason.slice(0, 40) : '') + '（库 ' + list.length + ' 条）');
  }


  function getPlayerName() {
    try {
      const ctx = getCtx();
      const n = (ctx?.name1 || ctx?.user_name || ctx?.userName || '').trim();
      if (n) return n;
    } catch (_) {}
    return '';
  }

  function getMessageReasoning(m) {
    if (!m) return '';
    const ex = m.extra || {};
    const candidates = [
      m.reasoning, m.thinking, m.thoughts,
      ex.reasoning, ex.thinking, ex.thoughts,
      ex.model_reasoning, ex.reason,
      typeof ex.reasoning_content === 'string' ? ex.reasoning_content : ''
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 2000);
    }
    return '';
  }

  function getRecentChatTextLabeled(maxN) {
    try {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      const parts = [];
      for (let i = chat.length - 1; i >= 0 && parts.length < (maxN || 8); i--) {
        const m = chat[i];
        if (!m) continue;
        const text = String(m.mes || m.message || '').trim();
        if (!text) continue;
        const tag = m.is_user ? '用户' : '正文';
        parts.unshift('【' + tag + '】\n' + text.slice(0, 1200));
      }
      return parts.join('\n\n');
    } catch (_) {
      return getRecentChatText(maxN || 8);
    }
  }

  function getLatestReasoningBlock() {
    try {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      for (let i = chat.length - 1; i >= 0 && i >= chat.length - 8; i--) {
        const m = chat[i];
        if (!m || m.is_user) continue;
        const r = getMessageReasoning(m);
        if (r) return r;
      }
    } catch (_) {}
    return '';
  }

  async function callRuleSelectApi(snippet, coarseReasons) {
    if (!cfg.apiKey) throw new Error('未填 API Key');
    const url = completionsUrl();
    if (!url) throw new Error('未填 Base URL');
    const catalog = ruleCatalogForApi();
    const sys = '你是禁令仓库管理员，不是作者。\n根据玩家名与带【用户】/【正文】标签的近文判断是否勾选铁律。\n只输出 JSON：{"activate":["id",...],"reason":"一句中文"}\n规则：\n1. 【最优先·抢话/抢行动】下列任一即勾选 no_qianghua：\n(a) 正文替玩家写了用户楼未出现的主动台词/动作/决定；\n(b) 用户已写短动作（如走到沙发坐下），正文仍用大段过程描写重演玩家走位、坐下、肢体、心理；\n(c) 思维链计划描写玩家主动行动。\n2. 允许：一句带过玩家已声明动作 + 重点写 NPC/环境。\n3. 其次：无用户性意图却发情；无BIO信号硬写三急；乱黑化玩家。\n4. activate 可空。禁止输出铁律正文，禁止写小说。';
    const player = getPlayerName();
    const reasoning = getLatestReasoningBlock();
    const user = JSON.stringify({
      player_name: player || '(未知，仅根据【用户】标签判断)',
      recent_text: String(snippet || '').slice(0, 3500),
      latest_reasoning: reasoning ? reasoning.slice(0, 1500) : null,
      catalog
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      })
    });
    if (!res.ok) throw new Error('禁令API HTTP ' + res.status);
    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || '';
    if (typeof content !== 'string') content = JSON.stringify(content);
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return { activate: [], reason: '无JSON' };
    const parsed = JSON.parse(m[0]);
    const ids = Array.isArray(parsed.activate) ? parsed.activate.map(String) : [];
    const valid = new Set(RULE_LIB.map(r => r.id));
    return { activate: ids.filter(id => valid.has(id)), reason: String(parsed.reason || '') };
  }

  function buildInjection(reportLines) {
    if (!cfg.injectEnabled || !reportLines || !reportLines.length) return '';
    const blocks = [];
    blocks.push('【身体传感器信号｜仅客观事实，请大脑自行决定是否处理】');
    try {
      if (snapshot && snapshot.timeline) blocks.push('当前剧情时间：' + timelineLabel());
    } catch (_) {}
    for (const line of reportLines) blocks.push('- ' + line);
    if (cfg.hardSync) {
      blocks.push('约束：以上为身体传感器发出的客观信号。角色应像正常人一样感知到这些信号。达到「应急」阶段时，长时间强行忍耐不符合正常人类反应，应在合理条件下尽快处理；平时不要每句都强调身体不适。');
    }
    return blocks.join('\n');
  }

  function buildRulesInjection(rules) {
    if (!cfg.injectEnabled || cfg.rulesEnabled === false) return '';
    if (!rules || !rules.length) return '';
    const blocks = ['【本轮短铁律｜独立于感官｜阅后即焚·勿在正文复述】'];
    for (const r of rules) {
      blocks.push('·' + r.title + '：');
      blocks.push(r.content);
    }
    return blocks.join('\n');
  }

  let lastRulesInjectKey = '';

  async function injectRulesFromContext(reason) {
    if (cfg.rulesEnabled === false || !cfg.injectEnabled) return false;
    if (!cfg.sideApiEnabled) {
      addLog('rules', '禁令：独立API关闭，跳过侧脑裁决');
      return false;
    }
    const text = getRecentChatTextLabeled(10);
    if (!text.trim()) {
      addLog('rules', '禁令：近文为空，跳过');
      return false;
    }
    // 粗筛已删除：标签近文 + 可选思维链 → 侧脑
    let decision;
    try {
      decision = await callRuleSelectApi(text, []);
    } catch (err) {
      addLog('error', '禁令侧脑失败: ' + (err && err.message ? err.message : err));
      return false;
    }
    try { rememberRuleDecision(decision, text); } catch (_) {}

    const ids = decision.activate || [];
    if (!ids.length) {
      addLog('rules', '禁令侧脑：activate=[]' + (decision.reason ? '（' + decision.reason + '）' : ''));
      return false;
    }
    const rules = ids.map(id => RULE_LIB.find(r => r.id === id)).filter(Boolean);
    if (!rules.length) return false;
    const key = ids.slice().sort().join('+');
    if (key === lastRulesInjectKey && reason !== 'manual') {
      addLog('rules', '禁令：与上次相同，跳过重复注入');
      return false;
    }
    const body = buildRulesInjection(rules);
    if (!body) return false;
    const ok = injectState(body);
    lastRulesInjectKey = key;
    addLog('rules', '禁令注入 ' + ids.join(', ') + ' ← ' + (reason || 'scan') + (decision.reason ? '｜' + decision.reason : '') + (ok ? '' : '（接口未确认）'));
    return true;
  }

  let lastInjectText = '';
  let bioInjectPending = false; // 已写入聊天，等本轮生成结束后删除

  function removeOldBioMessages(chat) {
    if (!Array.isArray(chat)) return;
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m && (m.extra?.rpe_physio_signal || m.name === 'BIO传感器' || (typeof m.mes === 'string' && m.mes.startsWith('【身体传感器信号')))) {
        chat.splice(i, 1);
      }
    }
  }

  /** TauriTavern 可靠路径：写入一条系统向消息，进入聊天上下文 */
  function injectAsChatMessage(val) {
    try {
      const ctx = getCtx();
      const chat = ctx?.chat;
      if (!Array.isArray(chat)) return false;
      removeOldBioMessages(chat);
      if (!val) {
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        return true;
      }
      const msg = {
        name: 'BIO传感器',
        is_user: false,
        is_system: true,
        mes: val,
        force_avatar: false,
        extra: { rpe_physio_signal: true, isSmallSys: true, type: 'system' }
      };
      chat.push(msg);
      if (typeof ctx.saveChat === 'function') ctx.saveChat();
      // 刷新 UI（若可用）
      try {
        if (typeof ctx.printMessages === 'function') ctx.printMessages();
        else if (typeof ctx.reloadCurrentChat === 'function') { /* skip full reload */ }
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  function injectState(text) {
    const ctx = getCtx();
    const val = text || '';
    lastInjectText = val;
    window.__RPE_STATE_INJECT__ = val;
    // 器官 → Core：短信号上交，由 Core 汇总本轮认知包
    try { window.PyramidCore?.reportBioSignal?.(val, { source: 'injectState' }); } catch (_) {}
    let ok = false;

    const trySet = (fn) => { try { fn(); return true; } catch (_) { return false; } };

    if (ctx?.setExtensionPrompt) {
      const attempts = [
        () => ctx.setExtensionPrompt(PROMPT_KEY, val, 0, 0, false, 'system'),
        () => ctx.setExtensionPrompt(PROMPT_KEY, val, 1, 0, true, 'system'),
        () => ctx.setExtensionPrompt(PROMPT_KEY, val, 2, 0, false, 'system'),
        () => ctx.setExtensionPrompt(PROMPT_KEY, val, 0, 0, false, 0),
        () => ctx.setExtensionPrompt(PROMPT_KEY, val),
      ];
      for (const a of attempts) {
        if (trySet(a)) { ok = true; break; }
      }
    }

    try {
      if (ctx && typeof ctx.extension_prompts === 'object') {
        ctx.extension_prompts[PROMPT_KEY] = { value: val, position: 0, depth: 0, scan: false, role: 0 };
        ok = true;
      }
    } catch (_) {}

    try {
      if (ctx?.chatMetadata) {
        if (!ctx.chatMetadata.rpe_physio) ctx.chatMetadata.rpe_physio = {};
        ctx.chatMetadata.rpe_physio.inject = val;
        ctx.chatMetadata.rpe_physio_prompt = val;
      }
    } catch (_) {}

    // 关键：写入聊天系统消息（生成时可见；生成结束后再删）
    if (val) {
      if (injectAsChatMessage(val)) {
        ok = true;
        bioInjectPending = true;
      }
    } else {
      // 清空
      injectAsChatMessage('');
      bioInjectPending = false;
    }

    return ok || !!val;
  }

  function cleanupBioAfterGeneration() {
    if (!bioInjectPending) return;
    try {
      const ctx = getCtx();
      const chat = ctx?.chat;
      if (!Array.isArray(chat)) return;
      removeOldBioMessages(chat);
      if (typeof ctx.saveChat === 'function') ctx.saveChat();
      bioInjectPending = false;
      addLog('system', '本轮生成结束，已移除临时 BIO 信号消息');
      // 阅后即焚：同步通知 Core 清掉本轮信号
      try { window.PyramidCore?.clearBioSignal?.(); } catch (_) {}
    } catch (e) {
      addLog('error', '清理 BIO 消息失败: ' + (e && e.message ? e.message : e));
    }
  }

  function reapplyInject() {
    // 聊天消息路径已在 chat 里，只需确保 extension prompt 仍在
    if (!lastInjectText) return;
    const ctx = getCtx();
    try {
      if (ctx?.setExtensionPrompt) {
        ctx.setExtensionPrompt(PROMPT_KEY, lastInjectText, 0, 0, false, 'system');
      }
    } catch (_) {}
  }

  function forceSubmitCurrentState() {
    ensureChatScope();
    const lines = [];
    const minRank = stageRank(cfg.reportMinStage || '迫切');

    for (const [name, ch] of Object.entries(snapshot.characters || {})) {
      if (!ch) continue;
      // 日常需求
      for (const k of NEED_KEYS) {
        if (cfg.enabledNeeds && !cfg.enabledNeeds.includes(k)) continue;
        const n = ch.needs?.[k];
        if (!n) continue;
        const st = n.stage || '平稳';
        if (stageRank(st) < minRank && stageRank(st) < stageRank('关注')) continue;
        // 手动提交：关注及以上都可带上，便于第一次对齐
        if (stageRank(st) >= stageRank('关注')) {
          lines.push(name + '：' + (LABEL[k] || k) + '处于「' + st + '」阶段（手动提交）。');
        }
      }
      // 生殖
      if (cfg.trackReproductive) {
        if (ch.pregnancy?.active) {
          lines.push(name + '：目前处于「' + (ch.pregnancy.phase || '孕期') + '」（手动提交）。');
        } else if (ch.menstrual_cycle?.phase && ch.menstrual_cycle.phase !== '周期未知') {
          const d = ch.menstrual_cycle.cycle_day != null ? '，周期第' + ch.menstrual_cycle.cycle_day + '天' : '';
          lines.push(name + '：生理周期为「' + ch.menstrual_cycle.phase + '」' + d + '（手动提交，仅供背景，非发情指令）。');
        }
        if (ch.conception?.outcome && ch.conception.outcome !== '无') {
          lines.push(name + '：受孕相关状态「' + ch.conception.outcome + '」（手动提交）。');
        }
      }
    }

    if (!lines.length) {
      // 仍提交一条时间锚，避免完全空白
      const names = Object.keys(snapshot.characters || {});
      if (!names.length) {
        addLog('system', '手动提交失败：当前没有常驻角色');
        lastLog = '无角色可提交';
        if (panel) render();
        return;
      }
      lines.push('当前无达到关注及以上的需求；周期等信息见上。若仅有平稳状态，大脑无需特别处理。');
      for (const name of names) {
        const ch = snapshot.characters[name];
        if (ch?.menstrual_cycle?.phase && ch.menstrual_cycle.phase !== '周期未知') {
          const d = ch.menstrual_cycle.cycle_day != null ? ' D' + ch.menstrual_cycle.cycle_day : '';
          lines.push(name + '：周期「' + ch.menstrual_cycle.phase + '」' + d + '（手动提交，背景信息）。');
        }
      }
    }

    // 手动提交：只发感官信号（铁律走独立扫描）
    const prevInject = cfg.injectEnabled;
    cfg.injectEnabled = true;
    let text = buildInjection(lines);
    cfg.injectEnabled = prevInject;
    if (!text) {
      text = ['【身体传感器信号｜手动提交】'].concat(lines.map(function(l){return '- ' + l;})).join('\n');

    } else {
      text = text.replace('【身体传感器信号｜仅客观事实，请大脑自行决定是否处理】', '【身体传感器信号｜手动提交｜仅客观事实】');
    }
    const ok = injectState(text);
    try { injectRulesFromContext('manual'); } catch (_) {}

    addLog('report', '手动提交 ' + lines.length + ' 条 → ' + (ok ? '已写入提示词' : '写入接口未确认，已存到缓存'));
    for (const l of lines) addLog('signal', l);
    lastLog = ok ? ('已提交 ' + lines.length + ' 条') : ('已提交(缓存) ' + lines.length + ' 条');
    // 切到日志页方便立刻看到
    view = 'log';
    if (panel) render();
  }

  // ==================== 主读取流程 ====================
  async function readFromChat(manual) {
    ensureChatScope();
    if (busy) return;
    busy = true;
    lastLog = manual ? '正在读取并总结最近 10 层…' : '自动读取中…';
    if (panel) render();
    try {
      const story = collectRecentStory(FLOORS);
      if (!story || story.length < 20) throw new Error('可用正文不足');
      if (!cfg.sideApiEnabled) throw new Error('请开启独立 API');

      const key = fingerprintStory(story);
      const isReplay = !!(snapshot.lastReadKey && snapshot.lastReadKey === key);

      addLog('read', manual ? '手动读取' : '自动读取');
      const result = await callFactApi(story);
      const reportLines = applyFacts(result, key, isReplay);

      const injectText = buildInjection(reportLines);
      injectState(injectText);

      // 读取后同样跑禁令侧脑（手动读取也要查抢话，不单靠间隔）
      try {
        await injectRulesFromContext(manual ? 'manual-read' : 'auto-read');
      } catch (re) {
        addLog('error', '禁令审查异常: ' + (re && re.message ? re.message : re));
      }

      if (reportLines.length) {
        addLog('report', '上报 ' + reportLines.length + ' 条信号 → 大脑');
        for (const l of reportLines) addLog('signal', l);
      } else {
        addLog('quiet', '未达上报阈值，保持静默');
      }

      lastLog = reportLines.length
        ? `已上报 ${reportLines.length} 条信号 · ${timelineLabel()}`
        : `静默 · ${timelineLabel() || '无时间'}`;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      addLog('error', msg);
      lastLog = (manual ? '失败: ' : '自动失败: ') + msg;
    } finally {
      busy = false;
      if (panel) render();
    }
  }

  // ==================== 事件绑定 ====================
  function tryBindEvents() {
    const ctx = getCtx();
    if (!ctx?.eventSource) return false;
    const es = ctx.eventSource;
    const ev = ctx.eventTypes || {};

    const on = (n, fn) => {
      try { if (n) es.on(n, fn); } catch (_) {}
    };

    on(ev.CHAT_CHANGED || 'CHAT_CHANGED', () => {
      try { ensureChatScope(); if (panel) render(); } catch (_) {}
    });
    on(ev.CHAT_ID_CHANGED || 'CHAT_ID_CHANGED', () => {
      try { ensureChatScope(); if (panel) render(); } catch (_) {}
    });

    // 生成前把当前信号注入
    on(ev.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS', () => {
      // 保持上次注入的内容即可
    });
    on(ev.GENERATION_STARTED || 'GENERATION_STARTED', () => {
      try { reapplyInject(); } catch (_) {}
      
    });
    on(ev.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS', () => {
      try { reapplyInject(); } catch (_) {}
    });

    on(ev.MESSAGE_RECEIVED || 'MESSAGE_RECEIVED', async (id) => {
      try {
        ensureChatScope();
        // 先清掉上一轮为生成而临时写入的 BIO 消息
        cleanupBioAfterGeneration();
        try { /* 禁令下轮生成前再扫 */ } catch (_) {}
        const chat = ctx.chat || [];
        const msg = (typeof id === 'number' && chat[id]) ? chat[id] : chat[chat.length - 1];
        if (!msg || msg.is_user) return;
        snapshot.assistantCount = (snapshot.assistantCount || 0) + 1;
        saveSnap();
        if (!snapshot.primed && snapshot.assistantCount < 2) return;
        const every = Math.max(1, +cfg.autoEvery || 3);
        if (snapshot.assistantCount % every === 0) {
          await readFromChat(false);
        }
        // 禁令：按 rulesEvery 侧脑勾选（无粗筛）
        const re = Math.max(1, +cfg.rulesEvery || 2);
        if (snapshot.assistantCount % re === 0) {
          try { await injectRulesFromContext('interval'); } catch (_) {}
        }
      } catch (_) {}
    });
    on(ev.GENERATION_ENDED || 'GENERATION_ENDED', () => {
      try { cleanupBioAfterGeneration(); } catch (_) {}
    });
    on(ev.GENERATION_STOPPED || 'GENERATION_STOPPED', () => {
      try { cleanupBioAfterGeneration(); } catch (_) {}
    });
    return true;
  }

  // ==================== UI ====================
  // 面板始终贴在悬浮按钮上方，不遮挡按钮；拖动按钮时面板跟随
  function placeFab(left, top) {
    if (!fab) return;
    const w = fab.offsetWidth || 56, h = fab.offsetHeight || 32;
    const x = Math.min(innerWidth - w - 4, Math.max(4, left));
    const y = Math.min(innerHeight - h - 4, Math.max(4, top));
    fab.style.left = x + 'px';
    fab.style.top = y + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    cfg.fabLeft = x;
    cfg.fabTop = y;
    saveCfg();
    // 面板打开时跟随按钮移动
    if (panel) positionPanelNearFab();
  }

  function positionPanelNearFab() {
    if (!panel || !fab) return;
    const fr = fab.getBoundingClientRect();
    const pw = panel.offsetWidth || 168;
    const ph = Math.min(panel.offsetHeight || 200, innerHeight * 0.52);
    const gap = 0; // 贴边，无空隙

    // 优先贴在按钮上方（下边沿对齐按钮上边沿）；上方不够则贴下方
    let top = fr.top - ph - gap;
    if (top < 8) top = fr.bottom + gap;

    // 水平：与按钮右对齐，形成连续边线
    let left = fr.right - pw;
    if (left < 8) left = 8;
    if (left + pw > innerWidth - 8) left = innerWidth - pw - 8;

    // 垂直最终钳制
    if (top + ph > innerHeight - 8) top = Math.max(8, innerHeight - ph - 8);
    if (top < 8) top = 8;

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function clampPanel() {
    positionPanelNearFab();
  }

  function bindDrag(el) {
    const down = (ev) => {
      const t = ev.touches ? ev.touches[0] : ev;
      const r = el.getBoundingClientRect();
      drag = { dx: t.clientX - r.left, dy: t.clientY - r.top, moved: false };
      el.classList.add('rpe-dragging');
      ev.preventDefault();
    };
    const move = (ev) => {
      if (!drag) return;
      const t = ev.touches ? ev.touches[0] : ev;
      const left = t.clientX - drag.dx;
      const top = t.clientY - drag.dy;
      if (Math.abs(left - (cfg.fabLeft || 0)) > 3 || Math.abs(top - (cfg.fabTop || 0)) > 3) drag.moved = true;
      placeFab(left, top); // 内部会同步移动面板
      ev.preventDefault();
    };
    const up = () => {
      if (!drag) return;
      const m = drag.moved;
      drag = null;
      el.classList.remove('rpe-dragging');
      if (!m) togglePanel();
    };
    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    addEventListener('mousemove', move, { passive: false });
    addEventListener('touchmove', move, { passive: false });
    addEventListener('mouseup', up);
    addEventListener('touchend', up);
  }

  function mountFab() {
    // 已收编进 Pyramid Core：不再挂独立 BIO 悬浮球。
    if (fab) return;
  }

  function togglePanel() {
    // 已收编进 Pyramid Core：不打开旧 BIO 面板。
  }

  function unmountPanel() {
    if (panel) try { panel.remove(); } catch (_) {}
    panel = null;
    // 保留 view / viewChar，下次打开回到关闭前的页面
  }

  function mountPanel() {
    // 已收编进 Pyramid Core：BIO 的查看/提交/日志全部在 Core 主面板内完成，不再弹独立窗。
    if (panel) return;
    return;
  }

  function head(title, back) {
    const b = back
      ? `<button type="button" class="icon-btn" data-nav="${back}">‹</button>`
      : `<button type="button" class="icon-btn" data-nav="menu">⚙</button>`;
    return `<div class="head">${b}<div class="title">${title}</div><button type="button" class="icon-btn" data-act="close">×</button></div>`;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function listChars() {
    return Object.keys(snapshot.characters).filter(k => {
      const ch = snapshot.characters[k];
      // 常驻：一旦建档就保留，直到用户主动删除
      return ch && !ch.removed && shouldTrackCharacter(k, ch.sex) && ch.sex !== 'male';
    });
  }

  function deleteChar(name) {
    if (!name || !snapshot.characters[name]) return;
    delete snapshot.characters[name];
    // 清掉该角色相关上报历史
    if (snapshot.reportHistory) {
      for (const k of Object.keys(snapshot.reportHistory)) {
        if (k.startsWith(name + '|')) delete snapshot.reportHistory[k];
      }
    }
    saveSnap();
    addLog('system', '已移除常驻：' + name);
    if (viewChar === name) viewChar = '';
    view = 'home';
    render();
  }

  function bindSwipeRows() {
    panel.querySelectorAll('.swipe-row').forEach(row => {
      const content = row.querySelector('.swipe-content');
      const delBtn = row.querySelector('.swipe-del');
      if (!content || !delBtn) return;
      let startX = 0, startY = 0, curX = 0, dragging = false, open = false, moved = false;

      // 强制实色，避免点按时变透明露出删除
      content.style.background = '#0a121e';
      content.style.opacity = '1';

      const setX = (x) => {
        curX = Math.max(-72, Math.min(0, x));
        content.style.transform = 'translateX(' + curX + 'px)';
      };
      const close = () => { open = false; moved = false; setX(0); };
      const openDel = () => { open = true; setX(-72); };

      const onStart = (ev) => {
        const t = ev.touches ? ev.touches[0] : ev;
        startX = t.clientX;
        startY = t.clientY;
        dragging = true;
        moved = false;
        content.style.transition = 'none';
        content.style.background = '#0a121e';
        content.style.opacity = '1';
        panel.querySelectorAll('.swipe-row').forEach(r => {
          if (r !== row) {
            const c = r.querySelector('.swipe-content');
            if (c) { c.style.transition = 'transform 0.18s'; c.style.transform = 'translateX(0)'; }
          }
        });
      };
      const onMove = (ev) => {
        if (!dragging) return;
        const t = ev.touches ? ev.touches[0] : ev;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        // 垂直滑动为主则放弃，避免误触
        if (!moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
          dragging = false;
          close();
          return;
        }
        if (Math.abs(dx) > 6) moved = true;
        if (open) setX(-72 + dx);
        else setX(Math.min(0, dx));
        if (moved) ev.preventDefault();
      };
      const onEnd = () => {
        if (!dragging && !moved) return;
        dragging = false;
        content.style.transition = 'transform 0.18s ease';
        content.style.background = '#0a121e';
        content.style.opacity = '1';
        if (moved && curX < -36) openDel();
        else close();
      };

      content.addEventListener('touchstart', onStart, { passive: true });
      content.addEventListener('touchmove', onMove, { passive: false });
      content.addEventListener('touchend', onEnd);
      content.addEventListener('mousedown', onStart);
      addEventListener('mousemove', onMove);
      addEventListener('mouseup', onEnd);

      content.addEventListener('click', (ev) => {
        if (open || moved || curX < -8) {
          ev.preventDefault();
          ev.stopPropagation();
          close();
          return;
        }
        const name = row.getAttribute('data-char');
        viewChar = name;
        view = 'char';
        render();
      });

      delBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const name = row.getAttribute('data-char');
        deleteChar(name);
      });
    });
  }

  function render() {
    if (!panel) return;

    if (view === 'home') {
      const list = listChars();
      let body;
      if (!list.length) {
        body = `<div class="empty">常驻女性角色会自动收录。<br>左滑可删除。<br>配置 API 后点「读取正文」。</div>
          <div class="btns"><button type="button" class="btn" data-act="read" ${busy ? 'disabled' : ''}>读取正文</button></div>`;
      } else {
        body = `<div class="char-list">${list.map(n => {
          const ch = snapshot.characters[n];
          let tag = '';
          if (ch.pregnancy?.active) tag = '孕';
          else if (ch.menstrual_cycle?.phase === '月经期') tag = '经';
          else if (ch.present === false) tag = '离场';
          return `<div class="swipe-row" data-char="${esc(n)}">
            <button type="button" class="swipe-del">删除</button>
            <div class="swipe-content char-item"><span>${esc(n)}</span><span class="hint">${tag ? tag + ' ' : ''}›</span></div>
          </div>`;
        }).join('')}</div>
        <div class="btns">
          <button type="button" class="btn ghost" data-act="read" ${busy ? 'disabled' : ''}>重新读取</button>
          <button type="button" class="btn ghost" data-act="submit">提交状态</button>
          <button type="button" class="btn ghost" data-nav="log">日志</button>
        </div>`;
      }
      panel.innerHTML = head('BIO SENSOR') + body + `<div class="log">${esc(lastLog || '')}</div>`;
      bindSwipeRows();
    } else if (view === 'char') {
      const name = viewChar;
      const ch = snapshot.characters[name];
      if (!ch?.updatedFromChat) {
        panel.innerHTML = head(esc(name), 'home') + `<div class="empty">无数据</div>`;
      } else {
        const cards = cfg.enabledNeeds.map(k => {
          const n = ch.needs[k];
          if (!n) return '';
          const st = n.stage || '—';
          const el = k === 'sleep' && n.sleeping ? '睡眠中' : fmtElapsed(n.awake_for != null ? n.awake_for : n.elapsed);
          const barCls = stageRank(st) >= 3 ? 'bar-bad' : (stageRank(st) >= 2 ? 'bar-warn' : (stageRank(st) >= 1 ? 'bar-warn' : 'bar-ok'));
          return `<div class="need-card med-row">
            <span class="med-bar ${barCls}"></span>
            <div class="med-main">
              <div class="med-top"><span class="nm">${LABEL[k]}</span><span class="st ${stageClass(st)}">${st}</span></div>
              <div class="med-sub">距上次</div>
            </div>
            <div class="med-wave" aria-hidden="true"></div>
            <div class="big">${el}</div>
          </div>`;
        }).join('');

        let extra = '';
        if (cfg.trackReproductive) {
          // 生殖状态动态标签：怀孕优先，否则周期，另可附带受孕窗
          if (ch.pregnancy?.active) {
            const days = ch.pregnancy.gestation_days != null ? (Math.round(ch.pregnancy.gestation_days * 10) / 10) + '天' : '';
            const conf = ch.pregnancy.confirmation && ch.pregnancy.confirmation !== '已确认' ? ' · ' + ch.pregnancy.confirmation : '';
            extra += `<div class="need-card med-row"><span class="med-bar bar-warn"></span><div class="med-main"><div class="med-top"><span class="nm">生殖</span><span class="st ${stageClass(ch.pregnancy.phase)}">${esc(ch.pregnancy.phase)}</span></div></div><div class="big">${esc(days)}${esc(conf)}</div></div>`;
          } else if (ch.menstrual_cycle && (ch.menstrual_cycle.active || (ch.menstrual_cycle.phase && ch.menstrual_cycle.phase !== '周期未知'))) {
            const day = ch.menstrual_cycle.cycle_day != null ? 'D' + ch.menstrual_cycle.cycle_day : '';
            const dayNum = ch.menstrual_cycle.cycle_day != null ? +ch.menstrual_cycle.cycle_day : 0;
            const pct = dayNum ? Math.min(100, Math.round(dayNum / 28 * 100)) : 0;
            extra += `<div class="cycle-strip">
              <div class="cycle-left"><div class="nm">周期 · <span class="${stageClass(ch.menstrual_cycle.phase)}">${esc(ch.menstrual_cycle.phase)}</span></div><div class="med-sub">${day ? '第 ' + day.slice(1) + ' 天' : ''}</div></div>
              <div class="cycle-ring" style="--p:${pct}"><span>${esc(day || '—')}</span></div>
            </div>`;
            if (ch.menstrual_cycle.prepared && /月经期|易孕期/.test(ch.menstrual_cycle.phase || '')) {
              extra += `<div class="need-card"><span class="nm">准备</span><span class="sep">·</span><span class="st rpe-ok">已可准备</span></div>`;
            }
          }
          if (!ch.pregnancy?.active && ch.conception?.outcome && ch.conception.outcome !== '无') {
            const risk = ch.conception.combined_risk_percent != null ? ch.conception.combined_risk_percent + '%' : '';
            extra += `<div class="need-card"><span class="nm">受孕</span><span class="sep">·</span><span class="st ${stageClass(ch.conception.outcome)}">${esc(ch.conception.outcome)}</span><span class="big">${esc(risk)}</span></div>`;
          }
          if (ch.present === false) {
            extra += `<div class="need-card"><span class="nm">在场</span><span class="sep">·</span><span class="st rpe-warn">离场</span><span class="ago">时间仍推进</span></div>`;
          }
        }

        const tl = timelineLabel();
        const title = `<span class="name-text">${esc(name)}</span>${tl ? `<span class="head-time">${esc(tl)}</span>` : ''}`;
        panel.innerHTML = head(title, 'home') +
          `<div class="need-grid med-grid">${cards}</div>` +
          (extra ? `<div class="extra-block">${extra}</div>` : '');
      }
    } else if (view === 'log') {
      const lines = (logs || []).slice().reverse().slice(0, 40).map(l => {
        const cls = l.type === 'error' ? 'rpe-bad' : (l.type === 'report' || l.type === 'signal' ? 'rpe-warn' : (l.type === 'quiet' ? 'rpe-ok' : ''));
        return `<div class="log-line"><span class="t">${esc(l.time)}</span> <span class="${cls}">[${esc(l.type)}]</span> ${esc(l.msg)}</div>`;
      }).join('');
      panel.innerHTML = head('运行日志', 'home') +
        `<div class="log-box">${lines || '<div class="empty">暂无日志</div>'}</div>
         <div class="btns"><button type="button" class="btn ghost" data-act="clear-log">清空日志</button></div>`;
    } else if (view === 'menu') {
      panel.innerHTML = head('设置', 'home') + `<div class="menu">
        <button type="button" data-nav="needs">观察项与阈值 <span>›</span></button>
        <button type="button" data-nav="api">独立 API <span>›</span></button>
        <button type="button" data-nav="log">运行日志 <span>›</span></button>
        <button type="button" data-act="read">立即读取正文</button>
        <button type="button" data-act="submit">主动提交当前状态</button>
        <button type="button" data-act="reset">清空全部状态</button>
      </div><div class="log">${esc(lastLog || '')}</div>`;
    } else if (view === 'needs') {
      panel.innerHTML = head('观察项与阈值', 'menu') + `<div class="tog-list">${
        NEED_KEYS.map(k => `<label class="tog-row"><span>${LABEL[k]}</span><input type="checkbox" data-need="${k}" ${cfg.enabledNeeds.includes(k) ? 'checked' : ''}></label>`).join('')
      }
        <label class="tog-row"><span>经期 / 受孕 / 孕期</span><input type="checkbox" data-f="trackReproductive" ${cfg.trackReproductive ? 'checked' : ''}></label>
        <label class="tog-row"><span>离场仍推进时间</span><input type="checkbox" data-f="offscreenAdvance" ${cfg.offscreenAdvance ? 'checked' : ''}></label>
        <label class="tog-row"><span>写入主创提示词</span><input type="checkbox" data-f="injectEnabled" ${cfg.injectEnabled ? 'checked' : ''}></label>
        <label class="tog-row"><span>防脱钩约束</span><input type="checkbox" data-f="hardSync" ${cfg.hardSync ? 'checked' : ''}></label>
      </div>
      <div class="field" style="margin-top:6px">
        <span style="font-size:10px;color:#9a9aac">上报最低阶段</span>
        <select data-k="reportMinStage" style="width:100%;margin-top:2px;padding:5px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.3);color:#eee;font-size:11px">
          <option value="关注" ${cfg.reportMinStage === '关注' ? 'selected' : ''}>关注（较敏感）</option>
          <option value="迫切" ${cfg.reportMinStage === '迫切' || !cfg.reportMinStage ? 'selected' : ''}>迫切（推荐）</option>
          <option value="应急" ${cfg.reportMinStage === '应急' ? 'selected' : ''}>应急（很少打扰）</option>
        </select>
      </div>
      <div class="btns"><button type="button" class="btn" data-act="save-needs">保存</button></div>`;
    } else if (view === 'api') {
      const modelOptions = cachedModels.length
        ? cachedModels.map(id => `<option value="${esc(id)}" ${cfg.model === id ? 'selected' : ''}>${esc(id)}</option>`).join('')
        : `<option value="${esc(cfg.model)}">${esc(cfg.model || '拉取列表')}</option>`;
      panel.innerHTML = head('独立 API', 'menu') + `
        <label class="field">Base URL<input type="text" data-k="baseUrl" value="${esc(cfg.baseUrl)}"></label>
        <label class="field">API Key<input type="password" data-k="apiKey" value="${esc(cfg.apiKey)}"></label>
        <label class="field">模型<select class="rpe-model-select" data-k="model">${modelOptions}</select></label>
        <label class="field">手动模型名<input type="text" data-k="modelManual" value="" placeholder="可选"></label>
        <label class="field">自动读取间隔（轮）<input type="text" data-k="autoEvery" value="${esc(cfg.autoEvery)}"></label>
        <div class="tog-list">
          <label class="tog-row"><span>禁令层</span><input type="checkbox" data-f="rulesEnabled" ${cfg.rulesEnabled !== false ? 'checked' : ''}></label>
          <label class="field">禁令扫描间隔（轮）<input type="text" data-k="rulesEvery" value="${esc(cfg.rulesEvery != null ? cfg.rulesEvery : 2)}"></label>
          <div class="field" style="font-size:11px;opacity:.85">禁令经验库：<span data-learned-count>0</span> 条</div>
          <div class="btns">
            <button type="button" class="btn ghost" data-act="export-learned">导出经验库</button>
            <button type="button" class="btn ghost" data-act="import-learned">导入经验库</button>
            <button type="button" class="btn ghost" data-act="clear-learned">清空</button>
          </div>
          <input type="file" accept="application/json,.json" data-act="import-learned-file" style="display:none" />
          <label class="tog-row"><span>独立 API</span><input type="checkbox" data-f="sideApiEnabled" ${cfg.sideApiEnabled ? 'checked' : ''}></label>
        </div>
        <div class="btns">
          <button type="button" class="btn ghost" data-act="fetch-models">拉取模型</button>
          <button type="button" class="btn" data-act="save-api">保存</button>
        </div>
        <div class="log">${esc(lastLog || '')}</div>`;
    }

    bindChrome();
    requestAnimationFrame(clampPanel);
  }

  function bindChrome() {
    if (!panel) return;
    panel.querySelectorAll('[data-act=close]').forEach(b => { b.onclick = unmountPanel; });
    panel.querySelectorAll('[data-nav]').forEach(b => {
      b.onclick = () => { view = b.getAttribute('data-nav'); render(); };
    });
    panel.querySelectorAll('[data-act=read]').forEach(b => { b.onclick = () => readFromChat(true); });
    panel.querySelectorAll('[data-act=submit]').forEach(b => {
      b.onclick = () => {
        try { forceSubmitCurrentState(); }
        catch (e) {
          addLog('error', '手动提交异常: ' + (e && e.message ? e.message : e));
          lastLog = '提交失败';
          view = 'log';
          if (panel) render();
        }
      };
    });

    const reset = panel.querySelector('[data-act=reset]');
    if (reset) {
      reset.onclick = () => {
        if (!confirm('确认清空全部生理状态？')) return;
        snapshot = emptySnap();
        saveSnap();
        addLog('system', '状态已清空');
        lastLog = '已清空';
        view = 'home';
        render();
      };
    }

    const clearLog = panel.querySelector('[data-act=clear-log]');
    if (clearLog) {
      clearLog.onclick = () => {
        logs = [];
        saveLogs();
        lastLog = '日志已清空';
        render();
      };
    }

    const learnedEl = panel.querySelector('[data-learned-count]');
    if (learnedEl) {
      try { learnedEl.textContent = String(loadLearnedRules().length); } catch (_) { learnedEl.textContent = '0'; }
    }
    const clearLearned = panel.querySelector('[data-act=clear-learned]');
    if (clearLearned) {
      clearLearned.onclick = () => {
        try { localStorage.removeItem(LEARNED_KEY); } catch (_) {}
        lastLog = '禁令经验库已清空';
        addLog('rules', '禁令经验库已清空');
        render();
      };
    }
    const exportLearned = panel.querySelector('[data-act=export-learned]');
    if (exportLearned) {
      exportLearned.onclick = () => {
        try {
          const list = loadLearnedRules();
          const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: list }, null, 2);
          const blob = new Blob([payload], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'rpe-rule-memory-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          setTimeout(function() { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {} }, 800);
          lastLog = '已导出禁令经验库 ' + list.length + ' 条';
          addLog('rules', lastLog);
        } catch (e) {
          addLog('error', '导出失败: ' + (e && e.message ? e.message : e));
        }
      };
    }
    const importBtn = panel.querySelector('[data-act=import-learned]');
    const importFile = panel.querySelector('[data-act=import-learned-file]');
    if (importBtn && importFile) {
      importBtn.onclick = function() { importFile.click(); };
      importFile.onchange = async function() {
        const f = importFile.files && importFile.files[0];
        importFile.value = '';
        if (!f) return;
        try {
          const text = await f.text();
          const data = JSON.parse(text);
          const incoming = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
          if (!incoming.length) throw new Error('文件里没有条目');
          let list = loadLearnedRules();
          const map = new Map();
          for (const x of list) {
            const s = x.sig || ((Array.isArray(x.ids) ? x.ids.join(',') : '') + '|' + (x.reason || ''));
            map.set(s, x);
          }
          let added = 0;
          for (const it of incoming) {
            if (!it || typeof it !== 'object') continue;
            const sig = it.sig || ((Array.isArray(it.ids) ? it.ids.join(',') : '') + '|' + (it.reason || ''));
            if (!sig || sig === '|') continue;
            if (map.has(sig)) {
              const old = map.get(sig);
              old.count = Math.max(old.count || 1, it.count || 1);
              if ((it.at || 0) > (old.at || 0)) {
                old.excerpt = it.excerpt || old.excerpt;
                old.at = it.at;
                old.reason = it.reason || old.reason;
                old.ids = it.ids || old.ids;
              }
            } else {
              map.set(sig, {
                sig: sig,
                ids: Array.isArray(it.ids) ? it.ids : [],
                reason: String(it.reason || ''),
                excerpt: String(it.excerpt || ''),
                count: it.count || 1,
                at: it.at || Date.now()
              });
              added++;
            }
          }
          list = Array.from(map.values());
          list.sort(function(a, b) { return (b.count || 0) - (a.count || 0) || (b.at || 0) - (a.at || 0); });
          saveLearnedRules(list);
          lastLog = '已导入禁令经验库 +' + added + ' 新条，合计 ' + list.length;
          addLog('rules', lastLog);
          render();
        } catch (e) {
          addLog('error', '导入失败: ' + (e && e.message ? e.message : e));
        }
      };
    }

    const sn = panel.querySelector('[data-act=save-needs]');
    if (sn) {
      sn.onclick = () => {
        cfg.enabledNeeds = NEED_KEYS.filter(k => panel.querySelector(`[data-need="${k}"]`)?.checked);
        panel.querySelectorAll('[data-f]').forEach(el => {
          cfg[el.getAttribute('data-f')] = !!el.checked;
        });
        const sel = panel.querySelector('[data-k=reportMinStage]');
        if (sel) cfg.reportMinStage = sel.value;
        saveCfg();
        addLog('system', '观察项与阈值已保存');
        lastLog = '已保存';
        view = 'menu';
        render();
      };
    }

    const sa = panel.querySelector('[data-act=save-api]');
    if (sa) {
      sa.onclick = () => {
        panel.querySelectorAll('[data-k]').forEach(el => {
          const k = el.getAttribute('data-k');
          if (k === 'modelManual') return;
          cfg[k] = (k === 'autoEvery' || k === 'rulesEvery') ? (parseInt(el.value, 10) || (k === 'rulesEvery' ? 2 : 3)) : el.value;
        });
        const manual = panel.querySelector('[data-k=modelManual]')?.value?.trim();
        if (manual) cfg.model = manual;
        panel.querySelectorAll('[data-f]').forEach(el => {
          cfg[el.getAttribute('data-f')] = !!el.checked;
        });
        saveCfg();
        addLog('system', 'API 设置已保存');
        lastLog = 'API 已保存';
        render();
      };
    }

    const fm = panel.querySelector('[data-act=fetch-models]');
    if (fm) {
      fm.onclick = async () => {
        panel.querySelectorAll('[data-k]').forEach(el => {
          const k = el.getAttribute('data-k');
          if (k === 'model' || k === 'modelManual') return;
          if (k === 'autoEvery') cfg[k] = parseInt(el.value, 10) || 3;
          if (k === 'rulesEvery') cfg[k] = parseInt(el.value, 10) || 2;
          else if (k) cfg[k] = el.value;
        });
        saveCfg();
        lastLog = '拉取中…';
        render();
        try {
          const ids = await fetchModelList();
          if (cfg.model && !ids.includes(cfg.model)) ids.unshift(cfg.model);
          cachedModels = ids;
          lastLog = '已拉取 ' + ids.length + ' 个模型';
          addLog('system', lastLog);
        } catch (e) {
          lastLog = '拉取失败: ' + (e.message || e);
          addLog('error', lastLog);
        }
        view = 'api';
        render();
      };
    }
  }

  function boot() {
    currentChatKey = getChatKey();
    snapshot = load('snap', emptySnap, true);
    logs = load('logs', () => [], true);
    if (!Array.isArray(logs)) logs = [];
    if (!snapshot.version || snapshot.version < 6) {
      snapshot = emptySnap();
      saveSnap();
    }
    // 清理不应追踪的角色
    for (const k of Object.keys(snapshot.characters || {})) {
      const ch = snapshot.characters[k];
      if (!shouldTrackCharacter(k, ch?.sex) || ch?.sex === 'male') delete snapshot.characters[k];
    }
    if (!Object.keys(snapshot.characters).length) snapshot.primed = false;

    mountFab();
    let tries = 0;
    const t = setInterval(() => {
      ensureChatScope();
      if (tryBindEvents() || ++tries > 40) clearInterval(t);
    }, 500);
    // 定期检查是否换聊天（兼容无事件的前端）
    setInterval(() => { try { ensureChatScope(); } catch (_) {} }, 2000);
    addEventListener('resize', () => { if (panel) clampPanel(); });
    addLog('system', 'v0.6.49 已启动（禁令侧脑勾选）');
    console.info('[RPE] v0.6.49 rule side-api select');

    // 向统一 Core 注册：只暴露稳定接口，内部实现与存储命名空间不变
    try {
      window.PyramidBio = {
        loaded: true,
        version: '0.6.49',
        forceSubmit: () => forceSubmitCurrentState(),
        readFromChat: (manual) => readFromChat(manual !== false),
        getSnapshot: () => snapshot,
        getConfig: () => cfg,
        getLogs: () => logs.slice(-200),
        getLastSignal: () => lastInjectText || '',
        // 供 Core 第二层设置/API 页读写真实配置与状态
        saveConfig: () => saveCfg(),
        resetState: () => { snapshot = emptySnap(); saveSnap(); addLog('system', '状态已清空'); },
        clearLogs: () => { logs = []; saveLogs(); addLog('system', '日志已清空'); },
        getLearnedRules: () => loadLearnedRules(),
        saveLearnedRules: (arr) => saveLearnedRules(arr),
        fetchModels: () => fetchModelList(),
        // 已收编进 Core：不暴露旧窗/悬浮球入口
        openPanel: () => {},
        togglePanel: () => {},
        setFabVisible: () => {},
      };
      window.PyramidCore?.registerEngine?.('bio', window.PyramidBio);
    } catch (e) { console.warn('[RPE] Core 注册失败', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
