/* ============================================================
   app.js — 经典条文背诵 v6.1
   修复音频播放 + 四步都有朗读按钮
   ============================================================ */
(function () {
  'use strict';

  // 全局错误可视化：任何未被捕获的错误都显示在页面上，避免「白屏无提示」（便于在 VIA 等浏览器定位问题）
  function showFatal(msg) {
    try {
      var box = document.getElementById('fatalBox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'fatalBox';
        box.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:99999;background:#fff3f2;' +
          'color:#b34;font:13px/1.6 -apple-system,system-ui,sans-serif;padding:14px 16px;border:1px solid #e0b4b0;' +
          'border-radius:10px;white-space:pre-wrap;max-height:70vh;overflow:auto;box-shadow:0 6px 20px rgba(0,0,0,.15)';
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent = '⚠️ 页面脚本出错（请把这段发给我）：\n' + msg;
    } catch (e) {}
  }
  window.onerror = function (message, src, line, col, err) {
    showFatal((err && err.stack) ? err.stack : (message + ' @ ' + (src || '') + ':' + (line || 0) + ':' + (col || 0)));
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    showFatal('Promise 未处理: ' + ((e && e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });

  const PUNCT_RE = /[，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}<>\/\\|_\-～~`@#$%^&*+= \u3000]/;
  const isPunct = ch => PUNCT_RE.test(ch);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const NORM_RE = /[\s，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}<>\/\\|_\-～~`@#$%^&*+=]/g;
  const normalize = s => String(s == null ? '' : s).replace(NORM_RE, '');
  const splitSegments = t => String(t).split(/[，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}]+/).filter(Boolean);

  /* ================= 挖空 ================= */
  function buildMask(text, mode, seed) {
    const chars = Array.from(text);
    const mask = new Array(chars.length).fill(-1);
    let gid = 0;
    if (mode === 'full') {
      for (let i = 0; i < chars.length; i++) {
        if (isPunct(chars[i])) continue;
        mask[i] = ++gid;
      }
      return mask;
    }
    const candidates = [];
    for (let i = 0; i < chars.length; i++) {
      if (!isPunct(chars[i])) candidates.push(i);
    }
    const blankCount = Math.max(1, Math.round(candidates.length * 0.5));
    const rng = mulberry32(hashStr(seed + '::partial'));
    const shuffled = shuffle(candidates.slice(), rng);
    const chosen = shuffled.slice(0, blankCount);
    chosen.sort((a, b) => a - b);
    chosen.forEach(idx => { mask[idx] = ++gid; });
    return mask;
  }

  function renderCloze(text, mask) {
    const chars = Array.from(text);
    let html = '', i = 0;
    while (i < chars.length) {
      if (mask[i] === -1) {
        html += `<span class="c">${esc(chars[i])}</span>`;
        i++;
      } else {
        const ans = chars[i];
        html += `<input class="blank" type="text" data-answer="${esc(ans)}"
                   style="width:1.4em" autocomplete="off" autocorrect="off"
                   autocapitalize="off" spellcheck="false" inputmode="text">`;
        i++;
      }
    }
    return html;
  }

  function generateChoice(passage, seedOffset) {
    const rng = mulberry32(hashStr(passage.id + '::choice::' + (seedOffset || 0)));
    const segs = splitSegments(passage.text).filter(s => s.length >= 3 && s.length <= 16);
    if (!segs.length) return null;
    const correct = segs[Math.floor(rng() * segs.length)];
    const pool = [];
    ALL_PASSAGES.forEach(p => {
      if (p.id === passage.id) return;
      splitSegments(p.text).forEach(s => {
        if (s.length >= 2 && s.length <= 24 && s !== correct) pool.push(s);
      });
    });
    shuffle(pool, rng);
    const options = [correct];
    for (const c of pool) {
      if (options.length >= 4) break;
      if (Math.abs(c.length - correct.length) <= 4 && !options.includes(c)) options.push(c);
    }
    for (const c of pool) {
      if (options.length >= 4) break;
      if (!options.includes(c)) options.push(c);
    }
    if (options.length < 4) return null;
    const idx = passage.text.indexOf(correct);
    if (idx < 0) return null;
    return {
      before: passage.text.slice(0, idx),
      after: passage.text.slice(idx + correct.length),
      correct,
      options: shuffle(options.slice(0, 4), rng)
    };
  }

  const STORAGE_KEY = 'jingdian-v4';
  const SESSION_KEY = 'jingdian-session-v1';

  const state = {
    screen: 'home',
    dailyGoal: 10,
    progress: {},
    examType: 'national',
    subjectId: null,
    queue: [],
    queueTotal: 0,
    currentId: null,
    currentMode: 'learn',
    step: 'overview',
    maskSeed: '',
    choice: null,
    choiceSeed: 0,
    feedback: null,
    pickedOption: null,
    locking: false,
    hintOn: false,
    speakingId: null,
    viewLevelId: 'L1',
    viewSubjectId: null,
  };


  function getExamLevels() {
    if (state.examType === 'school') {
      return DATA.levels.filter(l => l.id === 'school' && l.available !== false);
    }
    return DATA.levels.filter(l => l.id !== 'school' && l.available !== false);
  }
  function getAllSubjects() {
    const out = [];
    getExamLevels().forEach(lv => {
      (lv.subjects || []).forEach(s => out.push(s));
    });
    return out;
  }
  function findSubject(id) {
    let found = null;
    DATA.levels.forEach(lv => {
      (lv.subjects || []).forEach(s => { if (s.id === id) found = s; });
    });
    return found;
  }
  function newMaskSeed() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.dailyGoal) state.dailyGoal = raw.dailyGoal;
      if (raw.progress) state.progress = raw.progress;
      if (raw.examType) state.examType = raw.examType;
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dailyGoal: state.dailyGoal,
        progress: state.progress,
        examType: state.examType
      }));
    } catch (e) {}
  }
  function saveSession() {
    try {
      if (!state.subjectId || !state.queueTotal) return;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        date: todayKey(), subjectId: state.subjectId,
        queue: state.queue, total: state.queueTotal
      }));
    } catch (e) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function showToast(text, type) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.className = 'toast show ' + (type || 'ok');
    el.textContent = text;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      const el2 = document.getElementById('toast');
      if (el2) el2.className = 'toast';
    }, 2200);
  }

  function getProg(id) { return state.progress[id] || (state.progress[id] = { stage: 'new' }); }
  function isMastered(id) { const pr = state.progress[id]; return pr && pr.stage === 'mastered'; }
  function isDueReview(id) {
    const pr = state.progress[id];
    return pr && pr.stage === 'mastered' && pr.nextReviewAt && pr.nextReviewAt <= Date.now();
  }
  function masteredCount() { return ALL_PASSAGES.filter(p => isMastered(p.id)).length; }
  function dueReviewList() { return ALL_PASSAGES.filter(p => isDueReview(p.id)); }
  function remainingCount() { return ALL_PASSAGES.length - masteredCount(); }
  function setStage(id, stage) { const pr = getProg(id); pr.stage = stage; save(); }
  function markMastered(id) {
    const pr = getProg(id);
    pr.stage = 'mastered';
    pr.masteredAt = Date.now();
    pr.reviewCount = (pr.reviewCount || 0) + 1;
    pr.nextReviewAt = Date.now() + 2 * 24 * 3600 * 1000;
    save();
  }

  function getSubjectStats(s) {
    let unfinished = 0, fresh = 0, due = 0, mastered = 0;
    s.passages.forEach(p => {
      const pr = state.progress[p.id];
      const stage = pr ? pr.stage : 'new';
      if (stage === 'mastered') {
        mastered++;
        if (pr.nextReviewAt && pr.nextReviewAt <= Date.now()) due++;
      } else if (stage === 'new' || !stage) fresh++;
      else unfinished++;
    });
    const freshPlanned = Math.min(fresh, state.dailyGoal);
    return { unfinished, fresh, due, mastered, total: s.passages.length,
             freshPlanned, today: unfinished + freshPlanned + due };
  }

  function buildQueueForSubject(subjectId) {
    const subject = findSubject(subjectId);
    if (!subject) return [];
    const unfinished = [], fresh = [], due = [];
    subject.passages.forEach(p => {
      const pr = state.progress[p.id];
      const stage = pr ? pr.stage : 'new';
      if (stage === 'mastered') {
        if (pr.nextReviewAt && pr.nextReviewAt <= Date.now()) due.push({ id: p.id, mode: 'review' });
      } else if (stage === 'new' || !stage) fresh.push({ id: p.id, mode: 'learn' });
      else unfinished.push({ id: p.id, mode: 'learn' });
    });
    return [...unfinished, ...fresh.slice(0, state.dailyGoal), ...due];
  }

  function restoreStep() {
    const pr = state.progress[state.currentId];
    const stage = pr ? pr.stage : 'new';
    if (state.currentMode === 'review') {
      state.step = (stage === 'full') ? 'full' : 'cloze';
    } else {
      state.step = (stage === 'choice' || stage === 'cloze' || stage === 'full') ? stage : 'overview';
    }
    state.maskSeed = newMaskSeed();
  }

  function startSubject(subjectId) {
    stopSpeaking();
    state.subjectId = subjectId;
    state.choice = null; state.feedback = null; state.pickedOption = null;
    state.locking = false; state.hintOn = false;
    const today = todayKey();
    const saved = loadSession();
    let restored = false;
    if (saved && saved.date === today && saved.subjectId === subjectId
        && Array.isArray(saved.queue) && saved.queue.length > 0) {
      const validQueue = saved.queue.filter(x => {
        if (!PASSAGE_MAP[x.id]) return false;
        if (x.mode === 'learn') return !isMastered(x.id);
        return true;
      });
      if (validQueue.length > 0) {
        state.queue = validQueue;
        state.queueTotal = Math.max(saved.total || validQueue.length, validQueue.length);
        restored = true;
      }
    }
    if (!restored) {
      state.queue = buildQueueForSubject(subjectId);
      state.queueTotal = state.queue.length;
    }
    if (!state.queue.length) {
      state.currentId = null; state.currentMode = 'learn';
      clearSession();
      state.screen = 'learn';
      render();
      return;
    }
    state.currentId = state.queue[0].id;
    state.currentMode = state.queue[0].mode;
    restoreStep();
    state.screen = 'learn';
    saveSession();
    render();
  }

  function skipCurrent() {
    if (state.queue.length <= 1) return;
    stopSpeaking();
    const item = state.queue.shift();
    state.queue.push(item);
    state.currentId = state.queue[0].id;
    state.currentMode = state.queue[0].mode;
    state.choice = null; state.feedback = null; state.pickedOption = null;
    state.locking = false; state.hintOn = false;
    restoreStep();
    saveSession();
    render();
  }

  function advanceQueue() {
    stopSpeaking();
    state.queue = state.queue.filter(x => x.id !== state.currentId);
    if (state.queue.length) {
      state.currentId = state.queue[0].id;
      state.currentMode = state.queue[0].mode;
    } else {
      state.currentId = null; state.currentMode = 'learn'; state.step = 'overview';
    }
    state.choice = null; state.feedback = null; state.pickedOption = null;
    state.locking = false; state.hintOn = false;
    if (state.currentId) { restoreStep(); saveSession(); }
    else clearSession();
    render();
  }

 /* ================= 朗读 ================= */
function splitForSpeech(text) {
    // 不使用后行断言(?<...)，以兼容旧版 iOS Safari（<16.4），避免整段脚本解析失败白屏
    const matched = String(text || '')
      .replace(/\s+/g, '')
      .match(/.+?[，。、；：？！]|.+$/g);
    const parts = (matched || []).map(x => x.trim()).filter(Boolean);
    return parts.length ? parts : [String(text || '')];
  }

  const SPEECH_KEY = 'jingdian-speech-v1';
  const speechState = {
    token: 0,
    loopTimer: null,
    safetyTimer: null,
    audio: null,
    mode: null,
    rate: 1,
    pitch: 1,
    loop: true,
    voiceURI: '',
    clauses: [],
    activeIdx: -1,
  };

  let _voices = [];
  function refreshVoices() {
    if (!('speechSynthesis' in window)) return;
    try { _voices = window.speechSynthesis.getVoices() || []; } catch (e) { _voices = []; }
  }
  function synthSupported() {
    return 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
  }
  if (synthSupported()) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }
  function getChineseVoices() {
    if (!_voices.length) refreshVoices();
    return _voices.filter(v => /^(zh|cmn|yue)/i.test(v.lang) || /(chinese|中文|普通话|国语)/i.test(v.name));
  }
  function pickVoice() {
    const zh = getChineseVoices();
    if (!zh.length) return null;
    if (speechState.voiceURI) {
      const f = zh.find(v => v.voiceURI === speechState.voiceURI);
      if (f) return f;
    }
    const cn = zh.find(v => /^zh[-_]?cn/i.test(v.lang));
    return cn || zh[0];
  }

  function loadSpeechSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPEECH_KEY) || '{}');
      if (typeof raw.rate === 'number') speechState.rate = raw.rate;
      if (typeof raw.pitch === 'number') speechState.pitch = raw.pitch;
      if (typeof raw.loop === 'boolean') speechState.loop = raw.loop;
      if (typeof raw.voiceURI === 'string') speechState.voiceURI = raw.voiceURI;
    } catch (e) {}
  }
  function saveSpeechSettings() {
    try {
      localStorage.setItem(SPEECH_KEY, JSON.stringify({
        rate: speechState.rate, pitch: speechState.pitch,
        loop: speechState.loop, voiceURI: speechState.voiceURI
      }));
    } catch (e) {}
  }

  function ensureAudio() {
    if (speechState.audio) return speechState.audio;
    const a = document.createElement('audio');
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', '');
    a.preload = 'auto';
    a.style.display = 'none';
    document.body.appendChild(a);
    speechState.audio = a;
    return a;
  }

  function updateSpeakButtons() {
    document.querySelectorAll('.speak-btn').forEach(btn => {
      const id = btn.dataset.speakId;
      if (id && id === state.speakingId) {
        btn.classList.add('playing');
        btn.textContent = '停';
      } else {
        btn.classList.remove('playing');
        btn.textContent = '读';
      }
    });
  }

  function clearClauseHighlight() {
    document.querySelectorAll('.cl.speaking').forEach(el => el.classList.remove('speaking'));
    speechState.activeIdx = -1;
  }
  function highlightClause(i) {
    document.querySelectorAll('.cl.speaking').forEach(el => el.classList.remove('speaking'));
    const el = document.querySelector('.cl[data-ci="' + i + '"]');
    if (el) { el.classList.add('speaking'); speechState.activeIdx = i; }
  }

  function stopSpeaking() {
    speechState.token++;
    hideResumeBar();
    if (speechState.loopTimer) { clearTimeout(speechState.loopTimer); speechState.loopTimer = null; }
    if (speechState.safetyTimer) { clearTimeout(speechState.safetyTimer); speechState.safetyTimer = null; }
    if (speechState.audio) {
      try {
        speechState.audio.onloadedmetadata = null;
        speechState.audio.onended = null;
        speechState.audio.onerror = null;
        speechState.audio.pause();
        speechState.audio.currentTime = 0;
      } catch (e) {}
    }
    if (synthSupported()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    state.speakingId = null;
    clearClauseHighlight();
    updateSpeakButtons();
  }

  function speakText(id, text) {
    stopSpeaking();
    state.speakingId = id;
    updateSpeakButtons();

    const token = ++speechState.token;
    speechState.speakingToken = token;
    const local = (window.AUDIO_INDEX && window.AUDIO_INDEX[id]) || null;
    if (!local || !local.length) {
      // 本地音频缺失：回退到系统语音合成（桌面端可用，手机端多数不支持）
      if (synthSupported()) { speakWithSynth(id, text); return; }
      state.speakingId = null; updateSpeakButtons();
      showToast('该条文暂无本地音频', 'bad');
      return;
    }
    const files = local;
    speechState.clauses = files.map(x => x.t);
    speechState.mode = 'local';
    const audio = ensureAudio();
    audio.loop = false;

    // 依据刚播完分句的末尾标点决定停顿时长（逗号短、句末长）
    function clauseGap(playedIdx) {
      const lastChar = (files[playedIdx] && files[playedIdx].t || '').slice(-1);
      if (lastChar === '，' || lastChar === '、') return 220;
      if (lastChar === '。' || lastChar === '！' || lastChar === '？' || lastChar === '；' || lastChar === '：') return 460;
      return 320;
    }

    function clearTimers() {
      if (speechState.loopTimer) { clearTimeout(speechState.loopTimer); speechState.loopTimer = null; }
      if (speechState.safetyTimer) { clearTimeout(speechState.safetyTimer); speechState.safetyTimer = null; }
      audio.onloadedmetadata = null; audio.onended = null; audio.onerror = null;
    }

    function playClause(i) {
      if (token !== speechState.token) return;
      highlightClause(i);
      const seg = files[i].t;
      // 以「真实音频时长 + 标点停顿」驱动下一句；onended 仅作兜底，避免依赖其可靠性
      let settled = false;
      const goNext = () => {
        if (settled) return; settled = true;
        advance();
      };
      audio.onloadedmetadata = function () {
        hideResumeBar();
        const dur = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration * 1000 : 0;
        const wait = dur > 0 ? dur + clauseGap(i) : (seg.length * 300 + 400 + clauseGap(i));
        speechState.loopTimer = setTimeout(goNext, wait);
      };
      audio.onended = function () {
        hideResumeBar();
        // 仅当拿不到时长时用「播完 + 停顿」兜底，保证标点停顿不丢失
        if (isFinite(audio.duration) && audio.duration > 0) return;
        speechState.loopTimer = setTimeout(goNext, clauseGap(i));
      };
      audio.onerror = function () {
        showToast('第' + (i + 1) + '句加载失败，已跳过', 'bad');
        goNext();
      };
      // 兜底：极端情况下 metadata 与 ended 都不触发时，强制推进，避免整段卡死
      speechState.safetyTimer = setTimeout(goNext, Math.min(9000, seg.length * 400 + 1800));
      audio.src = files[i].f;
      const p = audio.play();
      if (p && p.catch) p.catch(function () {
        // 自动播放被浏览器拦截（小米浏览器等 file:// 场景常见）：
        // 显示「点击继续」条，用户轻触屏幕任意处即可在真实手势内解锁并从当前句续读
        showResumeBar(i);
      });
    }

    function advance() {
      if (token !== speechState.token) return;
      clearTimers();
      const idx = speechState.activeIdx + 1;
      if (idx >= files.length) {
        if (speechState.loop) {
          speechState.loopTimer = setTimeout(function () {
            if (token !== speechState.token) return;
            clearClauseHighlight();
            playClause(0);
          }, 700);
        } else {
          finishSpeaking();
        }
        return;
      }
      playClause(idx);
    }

    function finishSpeaking() {
      speechState.token++;
      hideResumeBar();
      state.speakingId = null;
      clearClauseHighlight();
      updateSpeakButtons();
    }

    // 暴露当前朗读实例的播放/清定时器函数，供「点击继续」重试时调用
    speechState.currentPlayClause = playClause;
    speechState.currentClearTimers = clearTimers;
    // 首句在用户点击手势内触发，解锁移动端媒体播放并朗读
    playClause(0);
  }

  // 系统语音合成兜底（仅当本地音频缺失时用于桌面端）
  function speakWithSynth(id, text) {
    try { if (synthSupported()) window.speechSynthesis.cancel(); } catch (e) {}
    state.speakingId = id; updateSpeakButtons();
    const token = ++speechState.token;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = speechState.rate; u.pitch = speechState.pitch;
    const v = pickVoice(); if (v) u.voice = v;
    u.onend = function () { if (token === speechState.token) finishSpeakingSynth(); };
    u.onerror = function () { if (token === speechState.token) finishSpeakingSynth(); };
    speechState.mode = 'synth';
    try { window.speechSynthesis.speak(u); } catch (e) {}
  }
  function finishSpeakingSynth() {
    speechState.token++;
    state.speakingId = null;
    clearClauseHighlight();
    updateSpeakButtons();
  }

  // ===== 自动播放被拦截时的「点击继续」机制（小米浏览器等 file:// 场景）=====
  // 小米/部分浏览器禁止在用户手势之外连续自动播放音频：点「读」后第一句若在手势内被放行，
  // 后续分句可能被拦。这里在被拦时提示用户轻触屏幕任意处，在真实手势内重播当前分句以解锁，
  // 解锁后同一音频元素的后续分句通常可连续自动播放。
  function hideResumeBar() {
    const bar = document.getElementById('resumeBar');
    if (bar) bar.classList.remove('show');
    if (hideResumeBar._armed) {
      document.removeEventListener('touchstart', hideResumeBar._armed, true);
      document.removeEventListener('click', hideResumeBar._armed, true);
      hideResumeBar._armed = null;
    }
  }
  function showResumeBar(idx) {
    let bar = document.getElementById('resumeBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'resumeBar';
      bar.className = 'resume-bar';
      bar.innerHTML = '<span class="rb-ico">🔊</span><span class="rb-text">浏览器拦截了自动播放，点一下屏幕任意处继续朗读</span>';
      document.body.appendChild(bar);
    }
    bar.classList.add('show');
    // 挂一次性全局手势：用户轻触页面任意处即解锁并从当前分句续读（保证在真实手势内 play）
    if (hideResumeBar._armed) {
      document.removeEventListener('touchstart', hideResumeBar._armed, true);
      document.removeEventListener('click', hideResumeBar._armed, true);
    }
    const handler = function (e) {
      // 若点到的是控件（读/停按钮等），交给控件自身处理，本监听仅解除、不续播
      if (e.target && e.target.closest && (e.target.closest('.speak-btn') || e.target.closest('[data-action]') || e.target.closest('.learn-foot'))) {
        document.removeEventListener('touchstart', handler, true);
        document.removeEventListener('click', handler, true);
        hideResumeBar._armed = null;
        return;
      }
      hideResumeBar();
      retryClause(idx);
    };
    document.addEventListener('touchstart', handler, { capture: true, once: true });
    document.addEventListener('click', handler, { capture: true, once: true });
    hideResumeBar._armed = handler;
  }
  function retryClause(idx) {
    hideResumeBar();
    if (speechState.token !== speechState.speakingToken) return; // 已停止/切换，不再续播
    // 清掉被拦截那句遗留的定时器，避免它稍后自动跳到下一句造成跳读
    if (speechState.currentClearTimers) speechState.currentClearTimers();
    speechState.activeIdx = idx - 1; // 让下一轮 advance 仍指向 idx+1
    if (speechState.currentPlayClause) speechState.currentPlayClause(idx);
  }

  function toggleSpeak(id, text) {
    if (state.speakingId === id) stopSpeaking();
    else speakText(id, text);
  }

  function renderClauseSpans(text) {
    const parts = splitForSpeech(text);
    if (parts.length <= 1) return esc(text);
    return parts.map((seg, i) => '<span class="cl" data-ci="' + i + '">' + esc(seg) + '</span>').join('');
  }

  function openSpeechSheet() {
    let mask = document.getElementById('speechSheet');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'speechSheet';
      mask.className = 'sheet-mask';
      mask.innerHTML = `
        <div class="sheet">
          <div class="sheet-title">朗读设置</div>
          <div class="sheet-tip">已生成离线中文语音（edge-tts），点「读」即可朗读，无需联网或下载语音包</div>
          <div class="sheet-row">
            <span class="sheet-label">语速</span>
            <input type="range" id="speechRate" min="0.5" max="1.6" step="0.1" disabled>
            <span class="sheet-val" id="speechRateVal">固定</span>
          </div>
          <div class="sheet-row">
            <span class="sheet-label">循环朗读</span>
            <input type="checkbox" id="speechLoop">
          </div>
          <button class="btn-main" data-action="speech-test" type="button" style="margin-top:14px">试听示例</button>
          <button class="btn-sub" data-action="close-speech-sheet" type="button" style="margin-top:10px">完成</button>
        </div>`;
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) closeSpeechSheet(); });
    }
    const rateEl = mask.querySelector('#speechRate');
    const rateVal = mask.querySelector('#speechRateVal');
    const loopEl = mask.querySelector('#speechLoop');
    rateEl.value = speechState.rate;
    rateVal.textContent = speechState.rate.toFixed(1) + 'x';
    loopEl.checked = speechState.loop;
    mask.classList.add('show');
  }
  function closeSpeechSheet() {
    const mask = document.getElementById('speechSheet');
    if (mask) mask.classList.remove('show');
  }

  document.addEventListener('input', function (e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'speechRate') {
      speechState.rate = parseFloat(t.value) || 1;
      const v = document.getElementById('speechRateVal');
      if (v) v.textContent = speechState.rate.toFixed(1) + 'x';
      saveSpeechSettings();
    } else if (t.id === 'speechLoop') {
      speechState.loop = t.checked;
      saveSpeechSettings();
    } else if (t.id === 'speechVoice') {
      speechState.voiceURI = t.value;
      saveSpeechSettings();
    }
  });
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'speechLoop') { speechState.loop = t.checked; saveSpeechSettings(); }
    else if (t.id === 'speechVoice') { speechState.voiceURI = t.value; saveSpeechSettings(); }
  });
  /* ================= 导出 / 导入 ================= */
  function exportData() {
    const payload = {
      app: 'jingdian', version: 4, exportedAt: new Date().toISOString(),
      dailyGoal: state.dailyGoal, progress: state.progress, examType: state.examType
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fname = `经典条文存档_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出：' + fname, 'ok');
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const raw = JSON.parse(ev.target.result);
        if (!raw || typeof raw !== 'object') throw new Error('格式不对');
        if (!raw.progress || typeof raw.progress !== 'object') throw new Error('缺少 progress');
        const valid = {}; let skipped = 0;
        Object.keys(raw.progress).forEach(k => {
          if (PASSAGE_MAP[k]) valid[k] = raw.progress[k]; else skipped++;
        });
        if (!Object.keys(valid).length) throw new Error('没有可用的进度数据');
        Object.assign(state.progress, valid);
        if (raw.dailyGoal) state.dailyGoal = raw.dailyGoal;
        if (raw.examType) state.examType = raw.examType;
        save(); state.screen = 'home'; render();
        showToast(`导入成功，共 ${Object.keys(valid).length} 条` + (skipped ? `（${skipped} 条无法匹配）` : ''), 'ok');
      } catch (err) {
        showToast('导入失败：' + (err.message || '文件损坏'), 'bad');
      }
    };
    reader.onerror = function () { showToast('读取文件失败', 'bad'); };
    reader.readAsText(file, 'utf-8');
  }
  function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      if (f) importData(f);
      document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* ================= 渲染 ================= */
  function render() {
    const root = document.getElementById('app');
    if (state.screen === 'home') root.innerHTML = viewHome();
    else if (state.screen === 'subjects') root.innerHTML = viewSubjects();
    else if (state.screen === 'learn') root.innerHTML = viewLearn();
    else if (state.screen === 'library') root.innerHTML = viewLibrary();
    if (!document.getElementById('toast')) {
      const t = document.createElement('div');
      t.id = 'toast'; t.className = 'toast';
      document.body.appendChild(t);
    }
    window.scrollTo(0, 0);
    updateSpeakButtons();
    if (state.screen === 'learn' && (state.step === 'cloze' || state.step === 'full')) {
      setTimeout(() => {
        const b = document.querySelector('#clozeBox input.blank');
        if (b && !state.hintOn) try { b.focus(); } catch(e){}
      }, 80);
    }
  }

  function updateFeedback(type, text) {
    let fb = document.getElementById('feedbackMsg');
    if (!fb) {
      fb = document.createElement('div');
      fb.id = 'feedbackMsg';
      const body = document.querySelector('.learn-body');
      if (body) body.appendChild(fb);
    }
    fb.className = 'feedback ' + (type || '');
    fb.textContent = text || '';
    if (!text) fb.remove();
  }
  function updateFoot() {
    const foot = document.getElementById('learnFoot');
    if (!foot) return;
    foot.innerHTML = renderFoot();
  }

  function renderExamTabs() {
    return `
      <div class="exam-tabs">
        <button class="exam-tab ${state.examType === 'national' ? 'active' : ''}"
                data-action="switch-exam" data-exam="national">全国经典考核</button>
        <button class="exam-tab ${state.examType === 'school' ? 'active' : ''}"
                data-action="switch-exam" data-exam="school">学校经典考核</button>
      </div>`;
  }

  function viewHome() {
    const total = ALL_PASSAGES.length;
    const mastered = masteredCount();
    const remain = total - mastered;
    const days = Math.ceil(remain / state.dailyGoal) || 1;
    const due = dueReviewList().length;
    let inProgress = 0;
    ALL_PASSAGES.forEach(p => {
      const pr = state.progress[p.id];
      if (pr && (pr.stage === 'choice' || pr.stage === 'cloze' || pr.stage === 'full')) inProgress++;
    });
    let sessionTip = '';
    const saved = loadSession();
    if (saved && saved.date === todayKey() && Array.isArray(saved.queue) && saved.queue.length > 0) {
      const subj = findSubject(saved.subjectId);
      if (subj) {
        sessionTip = `<div class="due-tip" style="background:var(--green-soft);color:var(--green)">今日「${esc(subj.name)}」还有 <b>${saved.queue.length}</b> 条未完成</div>`;
      }
    }
    return `
      <div class="page">
        <header class="home-head">
          <div class="brand">
            <span class="brand-mark">經</span>
            <div>
              <div class="brand-title">经典条文</div>
              <div class="brand-sub">全国中医药经典能力等级考试</div>
            </div>
          </div>
        </header>
        <main class="home-main">
          <div class="hero">
            <div class="hero-row">
              <div class="hero-item">
                <div class="hero-num">${mastered}<span>/${total}</span></div>
                <div class="hero-label">已掌握</div>
              </div>
              <div class="hero-divider"></div>
              <div class="hero-item">
                <div class="hero-num">${remain}</div>
                <div class="hero-label">待学习</div>
              </div>
            </div>
            ${due > 0 ? `<div class="due-tip">有 <b>${due}</b> 条待复习</div>` : ''}
            ${sessionTip}
            ${inProgress > 0 && !sessionTip ? `<div class="due-tip" style="background:var(--accent-soft);color:var(--accent)">有 <b>${inProgress}</b> 条进行中，进入后会先继续</div>` : ''}
          </div>
          <div class="card">
            <div class="card-title">每日学习量</div>
            <div class="goal-row">
              <input type="range" id="goalRange" min="5" max="50" step="5" value="${state.dailyGoal}">
              <div class="goal-value"><b id="goalNum">${state.dailyGoal}</b> 条 / 天</div>
            </div>
            <div class="days-tip">按此进度，约 <b id="daysNum">${days}</b> 天完成全部条文</div>
          </div>
          <button class="btn-main" data-action="goto-subjects">开始今日任务</button>
          <button class="btn-sub" data-action="goto-library">浏览条文库</button>
          <button class="btn-sub" data-action="open-speech-sheet">🔊 朗读设置</button>
          <div class="backup-block">
            <div class="backup-title">存档</div>
            <div class="backup-row">
              <button class="backup-btn" data-action="export-data">导出存档</button>
              <button class="backup-btn" data-action="import-data">导入存档</button>
            </div>
            <div class="backup-hint">换设备、换浏览器时导出 JSON，在新设备导入即可恢复</div>
          </div>
        </main>
      </div>`;
  }

  function viewSubjects() {
    const subjects = getAllSubjects();
    const saved = loadSession();
    const today = todayKey();
    const cards = subjects.map(s => {
      const st = getSubjectStats(s);
      const pct = st.total ? Math.round(st.mastered / st.total * 100) : 0;
      let todayCount = st.today;
      let breakdown;
      const parts = [];
      if (st.unfinished > 0) parts.push(`${st.unfinished} 未完成`);
      if (st.freshPlanned > 0) parts.push(`${st.freshPlanned} 新学`);
      if (st.due > 0) parts.push(`${st.due} 复习`);
      breakdown = parts.length ? parts.join(' · ') : '今日无任务';
      if (saved && saved.date === today && saved.subjectId === s.id
          && Array.isArray(saved.queue) && saved.queue.length > 0) {
        todayCount = saved.queue.length;
        breakdown = '今日未完成，进入继续';
      }
      return `
        <button class="subject-card" data-action="start-subject" data-subject="${s.id}" style="padding:16px">
          <span class="sc-icon">${s.icon || '📖'}</span>
          <span class="sc-body">
            <span class="sc-name">${esc(s.name)}</span>
            <span class="sc-meta">${st.mastered} / ${st.total} 已掌握</span>
            <span class="sc-today">今日 <b>${todayCount}</b> 条 · ${breakdown}</span>
            <span class="sc-bar"><i style="width:${pct}%"></i></span>
          </span>
          <span class="sc-arrow">›</span>
        </button>`;
    }).join('');
    const totalDue = dueReviewList().length;
    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="goto-home">‹</button>
          <div class="topbar-title">
            <div class="tt-kicker">今日任务</div>
            <div class="tt-name">选择经典</div>
          </div>
          <button class="icon-btn" data-action="open-speech-sheet" title="朗读设置" aria-label="朗读设置">🔊</button>
        </header>
        <main class="list-main">
          ${renderExamTabs()}
          <div class="select-hint">
            未完成的优先继续，新学每科最多 ${state.dailyGoal} 条，到期复习自动接在最后
            ${totalDue > 0 ? `（今日共 ${totalDue} 条待复习）` : ''}
          </div>
          <div class="subject-list">${cards || '<div class="empty-tip">该考核暂无科目</div>'}</div>
        </main>
      </div>`;
  }

  function viewLearn() {
    if (!state.currentId) {
      return `
        <div class="page">
          <header class="topbar">
            <button class="icon-btn" data-action="goto-subjects">‹</button>
            <div class="topbar-title"><div class="tt-name">任务完成</div></div>
            <button class="icon-btn" data-action="open-speech-sheet" title="朗读设置" aria-label="朗读设置">🔊</button>
          </header>
          <main class="learn-main">
            <div class="done-box">
              <div class="done-icon">✓</div>
              <div class="done-title">本次任务已完成</div>
              <div class="done-sub">返回选其他经典，或明天再来</div>
              <button class="btn-main" data-action="goto-subjects">返回经典列表</button>
              <button class="btn-sub" data-action="goto-home">回到首页</button>
            </div>
          </main>
        </div>`;
    }
    const p = PASSAGE_MAP[state.currentId];
    const doneCount = state.queueTotal - state.queue.length + 1;
    const posLabel = `${doneCount}/${state.queueTotal}`;
    const isReview = state.currentMode === 'review';

    let body = '';
    if (state.step === 'overview') body = renderOverview(p);
    else if (state.step === 'choice') body = renderChoice(p);
    else if (state.step === 'cloze') body = renderClozeStep(p);
    else if (state.step === 'full') body = renderFullStep(p);

    const steps = isReview
      ? [{ k: 'cloze', label: '空' }, { k: 'full', label: '默' }]
      : [{ k: 'overview', label: '览' }, { k: 'choice', label: '选' },
         { k: 'cloze', label: '空' }, { k: 'full', label: '默' }];
    const stepBar = steps.map(s => {
      const active = state.step === s.k ? 'active' : '';
      const done = stepDone(s.k) ? 'done' : '';
      return `<div class="step-dot ${active} ${done}">${s.label}</div>`;
    }).join('');
    const reviewTag = isReview ? '<span class="review-tag">复习</span>' : '';

    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="goto-subjects">‹</button>
          <div class="topbar-title">
            <div class="tt-kicker">${esc(p.subjectName)} · ${esc(p.part || '')}${reviewTag}</div>
            <div class="tt-name">${esc(p.article)}</div>
          </div>
          <div class="queue-badge">${posLabel}</div>
        </header>
        <div class="step-bar">${stepBar}</div>
        <main class="learn-body">${body}</main>
        <footer class="learn-foot" id="learnFoot">${renderFoot()}</footer>
      </div>`;
  }

  function stepDone(s) {
    if (state.currentMode === 'review') {
      const order = ['cloze', 'full'];
      return order.indexOf(state.step) > order.indexOf(s);
    }
    const order = ['overview', 'choice', 'cloze', 'full'];
    return order.indexOf(state.step) > order.indexOf(s);
  }

  // 每个步骤都带朗读按钮
  function titleRow(p) {
    const tag = p.tag ? `<span class="passage-tag">${esc(p.tag)}</span>` : '';
    const isSpeaking = state.speakingId === p.id;
    return `
      <div class="passage-title-row">
        <div class="passage-title">${tag}${esc(p.title)}</div>
        <button class="speak-btn ${isSpeaking ? 'playing' : ''}"
                data-action="toggle-speak" data-speak-id="${esc(p.id)}"
                type="button">${isSpeaking ? '停' : '读'}</button>
      </div>`;
  }

  function renderOverview(p) {
    return `
      ${titleRow(p)}
      <div class="classic passage-text">${renderClauseSpans(p.text)}</div>
      <div class="hint-row">先默读一遍，点「读」听标准朗读，凭印象判断是否记住了</div>
    `;
  }
  function renderChoice(p) {
    if (!state.choice) state.choice = generateChoice(p, state.choiceSeed);
    const q = state.choice;
    if (!q) return `<div class="empty-tip">无法生成选择题，请直接进入挖空。</div>`;
    const letters = ['A', 'B', 'C', 'D'];
    const picked = state.pickedOption;
    const showResult = state.feedback && state.feedback.type;
    const opts = q.options.map((o, i) => {
      let cls = 'option';
      if (picked === o) cls += ' picked';
      if (showResult === 'ok' && o === q.correct) cls += ' correct';
      if (showResult === 'bad' && o === picked && o !== q.correct) cls += ' wrong';
      return `<button class="${cls}" data-action="pick-option" data-value="${esc(o)}">
        <span class="opt-letter">${letters[i]}</span>
        <span class="opt-text classic">${esc(o)}</span>
      </button>`;
    }).join('');
    return `
      ${titleRow(p)}
      <div class="classic quote">${esc(q.before)}<span class="quote-blank">____</span>${esc(q.after)}</div>
      <div class="options">${opts}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}" id="feedbackMsg">${esc(state.feedback.text)}</div>` : ''}
    `;
  }
  function renderClozeStep(p) {
    const mask = buildMask(p.text, 'partial', state.maskSeed || String(Date.now()));
    return `
      ${titleRow(p)}
      <div class="hint-row">补全空缺处（挖去 50% 的字）。可连续输入，系统按字自动填入</div>
      <div class="classic cloze-text" id="clozeBox">${renderCloze(p.text, mask)}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}" id="feedbackMsg">${esc(state.feedback.text)}</div>` : ''}
    `;
  }
  function renderFullStep(p) {
    const mask = buildMask(p.text, 'full', p.id);
    return `
      ${titleRow(p)}
      <div class="hint-row">默写全文。可连续输入，标点已给出</div>
      <div class="classic cloze-text" id="clozeBox">${renderCloze(p.text, mask)}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}" id="feedbackMsg">${esc(state.feedback.text)}</div>` : ''}
    `;
  }

  function renderFoot() {
    const fb = state.feedback;
    if (state.step === 'overview') {
      return `
        <button class="btn-ghost" data-action="skip">模糊，先跳过</button>
        <button class="btn-main" data-action="know">记住了</button>`;
    }
    if (state.step === 'choice') {
      if (fb && fb.type === 'bad') {
        return `
          <button class="btn-ghost" data-action="skip">跳过</button>
          <button class="btn-main" data-action="retry-choice">重试</button>`;
      }
      return `<button class="btn-main" data-action="check-choice">检查</button>`;
    }
    if (state.step === 'cloze' || state.step === 'full') {
      const hintLabel = state.hintOn ? '关闭提示' : '提示';
      if (fb && fb.type === 'bad') {
        return `
          <button class="btn-ghost" data-action="skip">跳过</button>
          <button class="btn-ghost" data-action="refresh-cloze">刷新</button>
          <button class="btn-main" data-action="retry-cloze">重试</button>`;
      }
      return `
        <button class="btn-ghost" data-action="refresh-cloze">刷新</button>
        <button class="btn-ghost" data-action="toggle-hint">${hintLabel}</button>
        <button class="btn-main" data-action="check-cloze">检查</button>`;
    }
    return '';
  }

  function isClozeInput(el) {
    return el && el.tagName === 'INPUT' && el.classList.contains('blank')
           && el.closest('#clozeBox');
  }
  function getClozeInputs() {
    const box = document.getElementById('clozeBox');
    if (!box) return [];
    return Array.from(box.querySelectorAll('input.blank'));
  }
  function focusFirstEmpty(fromIdx) {
    const inputs = getClozeInputs();
    for (let i = fromIdx; i < inputs.length; i++) {
      if (!inputs[i].value) { try { inputs[i].focus(); } catch (e) {} return; }
    }
    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].value) { try { inputs[i].focus(); } catch (e) {} return; }
    }
    if (inputs.length) try { inputs[inputs.length - 1].focus(); } catch (e) {}
  }
  function setInputValue(inp, val) {
    inp.value = val;
    inp.dataset.prevValue = val;
  }
  function handleInput(inp) {
    if (!isClozeInput(inp)) return;
    if (state.hintOn) return;
    const raw = (inp.value || '').replace(/\s+/g, '');
    const prev = inp.dataset.prevValue || '';
    if (raw === prev) return;
    if (!raw) { inp.dataset.prevValue = ''; return; }
    let incoming = '';
    if (!prev) incoming = raw;
    else if (raw.length > prev.length) {
      if (raw.startsWith(prev)) incoming = raw.slice(prev.length);
      else if (raw.endsWith(prev)) incoming = raw.slice(0, raw.length - prev.length);
      else incoming = raw;
    } else if (raw.length < prev.length) {
      if (prev.indexOf(raw) >= 0) { inp.dataset.prevValue = raw; return; }
      incoming = raw;
    } else incoming = raw;
    if (!incoming) { inp.dataset.prevValue = raw; return; }
    const incomingChars = Array.from(incoming).filter(c => c.trim() !== '');
    if (!incomingChars.length) { inp.dataset.prevValue = raw; return; }
    const inputs = getClozeInputs();
    const startIdx = inputs.indexOf(inp);
    if (startIdx < 0) return;
    const first = incomingChars[0];
    setInputValue(inp, first);
    inp.classList.remove('correct', 'wrong', 'revealed', 'hint-wrong');
    if (incomingChars.length > 1) {
      let cursor = startIdx + 1;
      for (let i = 1; i < incomingChars.length; i++) {
        if (cursor >= inputs.length) break;
        const t = inputs[cursor];
        setInputValue(t, incomingChars[i]);
        t.classList.remove('correct', 'wrong', 'revealed', 'hint-wrong');
        cursor++;
      }
      focusFirstEmpty(cursor);
    } else focusFirstEmpty(startIdx + 1);
  }
  document.addEventListener('input', function (e) {
    const inp = e.target;
    if (!isClozeInput(inp)) return;
    if (state.hintOn) return;
    if (e.isComposing) return;
    setTimeout(() => {
      if (state.hintOn) return;
      if (!isClozeInput(inp)) return;
      if (inp.dataset.composing === '1') return;
      handleInput(inp);
    }, 0);
  }, true);
  document.addEventListener('compositionstart', function (e) {
    const inp = e.target;
    if (isClozeInput(inp)) inp.dataset.composing = '1';
  }, true);
  document.addEventListener('compositionend', function (e) {
    const inp = e.target;
    if (!isClozeInput(inp)) return;
    inp.dataset.composing = '';
    if (state.hintOn) return;
    handleInput(inp);
  }, true);
  document.addEventListener('keydown', function (e) {
    const inp = e.target;
    if (!isClozeInput(inp)) return;
    if (state.hintOn) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const inputs = getClozeInputs();
      const idx = inputs.indexOf(inp);
      focusFirstEmpty(idx + 1);
    }
    if (e.key === 'Backspace' && inp.value === '') {
      const inputs = getClozeInputs();
      const idx = inputs.indexOf(inp);
      if (idx > 0) { try { inputs[idx - 1].focus(); } catch (err) {} }
    }
  }, true);

  function clearHint() {
    if (!state.hintOn) return;
    const inputs = getClozeInputs();
    inputs.forEach(inp => {
      const uv = inp.dataset.userValue;
      if (uv !== undefined) setInputValue(inp, uv);
      inp.classList.remove('hint-wrong');
      inp.removeAttribute('readonly');
      delete inp.dataset.userValue;
    });
    state.hintOn = false;
  }
  function toggleHint() {
    const inputs = getClozeInputs();
    if (state.hintOn) {
      inputs.forEach(inp => {
        const uv = inp.dataset.userValue;
        if (uv !== undefined) setInputValue(inp, uv);
        inp.classList.remove('hint-wrong');
        inp.removeAttribute('readonly');
        delete inp.dataset.userValue;
      });
      state.hintOn = false;
    } else {
      inputs.forEach(inp => {
        inp.dataset.userValue = inp.value;
        const ans = normalize(inp.dataset.answer);
        const val = normalize(inp.value);
        if (val !== ans) {
          inp.value = inp.dataset.answer;
          inp.dataset.prevValue = inp.dataset.answer;
          inp.classList.add('hint-wrong');
        }
        inp.setAttribute('readonly', 'readonly');
      });
      state.hintOn = true;
    }
    updateFoot();
    if (state.hintOn) {
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    }
  }

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {

      case 'goto-home':
        stopSpeaking();
        state.screen = 'home'; state.locking = false; render();
        break;
      case 'goto-subjects':
        stopSpeaking();
        state.screen = 'subjects'; state.locking = false; render();
        break;
      case 'goto-library':
        stopSpeaking();
        state.screen = 'library'; state.viewSubjectId = null; render();
        break;

      case 'switch-exam': {
        stopSpeaking();
        state.examType = el.dataset.exam;
        state.viewSubjectId = null;
        save(); render();
        break;
      }

      case 'start-subject':
        startSubject(el.dataset.subject);
        break;

      case 'export-data': exportData(); break;
      case 'import-data': triggerImport(); break;

      case 'toggle-speak':
      case 'speak-item': {
        const pid = el.dataset.speakId;
        const psg = PASSAGE_MAP[pid];
        if (psg) toggleSpeak(pid, psg.text);
        break;
      }
      case 'open-speech-sheet':
        openSpeechSheet();
        break;
      case 'close-speech-sheet':
        closeSpeechSheet();
        break;
      case 'speech-test':
        toggleSpeak('__speech_test__', '阴阳者，天地之道也，万物之纲纪，变化之父母。');
        break;

      case 'know':
        stopSpeaking();
        setStage(state.currentId, 'choice');
        state.step = 'choice';
        state.choice = null; state.choiceSeed = 0;
        state.feedback = null; state.pickedOption = null;
        saveSession();
        render();
        break;

      case 'skip': skipCurrent(); break;

      case 'pick-option': {
        state.pickedOption = el.dataset.value;
        state.feedback = null;
        document.querySelectorAll('.option').forEach(o => o.classList.remove('picked', 'correct', 'wrong'));
        el.classList.add('picked');
        updateFeedback('', '');
        updateFoot();
        break;
      }

      case 'check-choice': {
        if (state.locking) break;
        if (!state.pickedOption) {
          state.feedback = { type: 'bad', text: '请先选择一个选项' };
          updateFeedback('bad', '请先选择一个选项');
          updateFoot();
          break;
        }
        const q = state.choice;
        const ok = state.pickedOption === q.correct;
        document.querySelectorAll('.option').forEach(o => {
          if (o.dataset.value === q.correct) o.classList.add('correct');
          if (!ok && o.dataset.value === state.pickedOption) o.classList.add('wrong');
        });
        if (ok) {
          stopSpeaking();
          state.locking = true;
          setStage(state.currentId, 'cloze');
          saveSession();
          state.feedback = { type: 'ok', text: '答对了，进入挖空填空' };
          updateFeedback('ok', '答对了，进入挖空填空');
          updateFoot();
          setTimeout(() => {
            state.step = 'cloze';
            state.feedback = null; state.pickedOption = null;
            state.locking = false; state.hintOn = false;
            state.maskSeed = newMaskSeed();
            render();
          }, 700);
        } else {
          state.feedback = { type: 'bad', text: '答错了，可以重试或跳过' };
          updateFeedback('bad', '答错了，可以重试或跳过');
          updateFoot();
        }
        break;
      }

      case 'retry-choice':
        if (state.locking) break;
        state.choiceSeed = Math.floor(Math.random() * 1e9);
        state.choice = null; state.feedback = null; state.pickedOption = null;
        render();
        break;

      case 'toggle-hint':
        if (state.locking) break;
        toggleHint();
        break;

      case 'refresh-cloze': {
        if (state.locking) break;
        stopSpeaking();
        if (state.hintOn) clearHint();
        state.maskSeed = newMaskSeed();
        state.feedback = null;
        const fb = document.getElementById('feedbackMsg');
        if (fb) fb.remove();
        render();
        break;
      }

      case 'check-cloze': {
        if (state.locking) break;
        if (state.hintOn) { clearHint(); updateFoot(); }
        const box = document.getElementById('clozeBox');
        if (!box) break;
        const inputs = Array.from(box.querySelectorAll('input.blank'));
        let wrong = 0;
        inputs.forEach(inp => {
          const ans = normalize(inp.dataset.answer);
          const val = normalize(inp.value);
          inp.classList.remove('correct', 'wrong', 'revealed', 'hint-wrong');
          if (val && val === ans) inp.classList.add('correct');
          else { inp.classList.add('wrong'); wrong++; }
        });
        if (wrong === 0) {
          state.locking = true;
          if (state.step === 'cloze') {
            if (state.currentMode === 'learn') { setStage(state.currentId, 'full'); saveSession(); }
            state.feedback = { type: 'ok', text: '全对！进入默写' };
            updateFeedback('ok', '全对！进入默写');
            updateFoot();
            setTimeout(() => {
              state.step = 'full';
              state.feedback = null; state.locking = false; state.hintOn = false;
              render();
            }, 700);
          } else {
            stopSpeaking();
            markMastered(state.currentId);
            state.feedback = { type: 'ok', text: state.currentMode === 'review' ? '复习完成！' : '全对！本条已掌握' };
            updateFeedback('ok', state.feedback.text);
            updateFoot();
            setTimeout(() => {
              state.locking = false;
              advanceQueue();
            }, 800);
          }
        } else {
          state.feedback = { type: 'bad', text: `还有 ${wrong} 处不正确，可以重试或跳过` };
          updateFeedback('bad', `还有 ${wrong} 处不正确，可以重试或跳过`);
          updateFoot();
        }
        break;
      }

      case 'retry-cloze': {
        if (state.locking) break;
        if (state.hintOn) clearHint();
        document.querySelectorAll('#clozeBox input.blank').forEach(inp => {
          inp.value = '';
          inp.dataset.prevValue = '';
          inp.classList.remove('correct', 'wrong', 'revealed', 'hint-wrong');
          inp.removeAttribute('readonly');
          delete inp.dataset.userValue;
        });
        state.feedback = null;
        const fb = document.getElementById('feedbackMsg');
        if (fb) fb.remove();
        updateFoot();
        const first = document.querySelector('#clozeBox input.blank');
        if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 60);
        break;
      }

      case 'view-subject':
        stopSpeaking();
        state.viewSubjectId = el.dataset.subject;
        render();
        break;
      case 'view-back':
        stopSpeaking();
        if (state.viewSubjectId) { state.viewSubjectId = null; render(); }
        else { state.screen = 'home'; render(); }
        break;
      case 'view-passage':
        stopSpeaking();
        state.subjectId = PASSAGE_MAP[el.dataset.passage].subjectId;
        state.queue = [{ id: el.dataset.passage, mode: 'learn' }];
        state.queueTotal = 1;
        state.currentId = el.dataset.passage;
        state.currentMode = 'learn';
        restoreStep();
        state.choice = null; state.feedback = null; state.pickedOption = null;
        state.locking = false; state.hintOn = false;
        state.screen = 'learn';
        render();
        break;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'goalRange') {
      state.dailyGoal = parseInt(e.target.value, 10);
      save();
      const num = document.getElementById('goalNum');
      const days = document.getElementById('daysNum');
      if (num) num.textContent = state.dailyGoal;
      if (days) days.textContent = Math.ceil(remainingCount() / state.dailyGoal) || 1;
    }
  });

  function viewLibrary() {
    const lvId = state.examType === 'school' ? 'school' : 'L1';
    const lv = DATA.levels.find(l => l.id === lvId);
    if (!lv || !lv.available) return viewHome();

    if (!state.viewSubjectId) {
      const cards = lv.subjects.map(s => {
        const st = getSubjectStats(s);
        return `<button class="subject-card" data-action="view-subject" data-subject="${s.id}">
          <span class="sc-icon">${s.icon || '📖'}</span>
          <span class="sc-body">
            <span class="sc-name">${esc(s.name)}</span>
            <span class="sc-meta">${st.mastered} / ${st.total} 已掌握</span>
          </span>
          <span class="sc-arrow">›</span>
        </button>`;
      }).join('');
      return `
        <div class="page">
          <header class="topbar">
            <button class="icon-btn" data-action="view-back">‹</button>
            <div class="topbar-title"><div class="tt-name">条文库</div></div>
            <button class="icon-btn" data-action="open-speech-sheet" title="朗读设置" aria-label="朗读设置">🔊</button>
          </header>
          <main class="list-main">
            ${renderExamTabs()}
            <div class="subject-list">${cards || '<div class="empty-tip">暂无科目</div>'}</div>
          </main>
        </div>`;
    }

    const subject = lv.subjects.find(s => s.id === state.viewSubjectId);
    if (!subject) return viewHome();
    const items = subject.passages.map(p => {
      const pr = state.progress[p.id];
      let tag = '<span class="tag">未学</span>';
      if (pr && pr.stage === 'mastered') {
        tag = isDueReview(p.id)
          ? '<span class="tag due">待复习</span>'
          : '<span class="tag done">已掌握</span>';
      } else if (pr && (pr.stage === 'choice' || pr.stage === 'cloze' || pr.stage === 'full')) {
        tag = '<span class="tag due">进行中</span>';
      }
      const star = p.tag ? `<span class="passage-tag" style="margin-right:6px">${esc(p.tag)}</span>` : '';
      const isSpeaking = state.speakingId === p.id;
      return `<button class="passage-item" data-action="view-passage" data-passage="${p.id}">
        <span class="pi-main">
          <span class="pi-title">${star}${esc(p.title)}</span>
          <span class="pi-article">${esc(p.article)}</span>
        </span>
        <span class="speak-btn small ${isSpeaking ? 'playing' : ''}"
              data-action="speak-item" data-speak-id="${esc(p.id)}">${isSpeaking ? '停' : '读'}</span>
        ${tag}
      </button>`;
    }).join('');
    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="view-back">‹</button>
          <div class="topbar-title"><div class="tt-name">${esc(subject.name)}</div></div>
          <button class="icon-btn" data-action="open-speech-sheet" title="朗读设置" aria-label="朗读设置">🔊</button>
        </header>
        <main class="list-main">
          <div class="passage-list">${items}</div>
        </main>
      </div>`;
  }

  try {
    load();
    loadSpeechSettings();
    setTimeout(render, 0);
  } catch (e) {
    showFatal((e && e.stack) ? e.stack : String(e));
  }
})();