/* ============================================================
   app.js — 经典条文背诵 v3.6
   挖空：精确挖去 50% 非标点字
   ============================================================ */
(function () {
  'use strict';

  /* ================= 工具 ================= */
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

    // partial：精确挖去 50% 的非标点字
    const candidates = [];
    for (let i = 0; i < chars.length; i++) {
      if (!isPunct(chars[i])) candidates.push(i);
    }
    const total = candidates.length;
    const blankCount = Math.max(1, Math.round(total * 0.5));

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

  /* ================= 选择题 ================= */
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

  /* ================= 状态 ================= */
  const STORAGE_KEY = 'jingdian-v3';

  function getAllSubjectIds() {
    const ids = [];
    DATA.levels.forEach(lv => {
      if (lv.available === false) return;
      (lv.subjects || []).forEach(s => ids.push(s.id));
    });
    return ids;
  }

  const state = {
    screen: 'home',
    dailyGoal: 10,
    progress: {},
    selectedSubjects: [],
    queue: [],
    currentId: null,
    step: 'overview',
    choice: null,
    choiceSeed: 0,
    feedback: null,
    pickedOption: null,
    locking: false,
    hintOn: false,
    viewLevelId: 'L1',
    viewSubjectId: null,
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.dailyGoal) state.dailyGoal = raw.dailyGoal;
      if (raw.progress) state.progress = raw.progress;
      if (Array.isArray(raw.selectedSubjects)) {
        state.selectedSubjects = raw.selectedSubjects;
      } else {
        state.selectedSubjects = getAllSubjectIds();
      }
    } catch (e) {
      state.selectedSubjects = getAllSubjectIds();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dailyGoal: state.dailyGoal,
        progress: state.progress,
        selectedSubjects: state.selectedSubjects
      }));
    } catch (e) {}
  }

  /* ================= 进度 ================= */
  function getProg(id) { return state.progress[id] || (state.progress[id] = { stage: 'new' }); }
  function isMastered(id) { const pr = state.progress[id]; return pr && pr.stage === 'mastered'; }
  function isDueReview(id) {
    const pr = state.progress[id];
    return pr && pr.stage === 'mastered' && pr.nextReviewAt && pr.nextReviewAt <= Date.now();
  }
  function masteredCount() { return ALL_PASSAGES.filter(p => isMastered(p.id)).length; }
  function dueReviewList() { return ALL_PASSAGES.filter(p => isDueReview(p.id)); }
  function remainingCount() { return ALL_PASSAGES.length - masteredCount(); }

  /* ================= 队列 ================= */
  function buildQueue() {
    const selected = new Set(state.selectedSubjects);
    const inSel = p => selected.has(p.subjectId);

    const due = dueReviewList().filter(inSel).map(p => p.id);
    const fresh = ALL_PASSAGES
      .filter(p => !isMastered(p.id) && inSel(p))
      .slice(0, state.dailyGoal)
      .map(p => p.id);

    const set = new Set();
    const q = [];
    [...due, ...fresh].forEach(id => { if (!set.has(id)) { set.add(id); q.push(id); } });
    return q;
  }

  function startLearn() {
    state.queue = buildQueue();
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    state.pickedOption = null;
    state.locking = false;
    state.hintOn = false;
    state.screen = 'learn';
    render();
  }

  function skipCurrent() {
    if (!state.queue.length) return;
    const id = state.queue.shift();
    state.queue.push(id);
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    state.pickedOption = null;
    state.locking = false;
    state.hintOn = false;
    render();
  }

  function completeCurrent() {
    const id = state.currentId;
    const pr = getProg(id);
    pr.stage = 'mastered';
    pr.masteredAt = Date.now();
    pr.reviewCount = (pr.reviewCount || 0) + 1;
    pr.nextReviewAt = Date.now() + 2 * 24 * 3600 * 1000;
    save();
    state.queue = state.queue.filter(x => x !== id);
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    state.pickedOption = null;
    state.locking = false;
    state.hintOn = false;
    render();
  }

  /* ================= 渲染 ================= */
  function render() {
    const root = document.getElementById('app');
    if (state.screen === 'home') root.innerHTML = viewHome();
    else if (state.screen === 'select-subjects') root.innerHTML = viewSelectSubjects();
    else if (state.screen === 'learn') root.innerHTML = viewLearn();
    else if (state.screen === 'library') root.innerHTML = viewLibrary();
    window.scrollTo(0, 0);
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

  /* ---------- 首页 ---------- */
  function viewHome() {
    const total = ALL_PASSAGES.length;
    const mastered = masteredCount();
    const remain = total - mastered;
    const days = Math.ceil(remain / state.dailyGoal) || 1;
    const due = dueReviewList().length;

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
          </div>

          <div class="card">
            <div class="card-title">每日学习量</div>
            <div class="goal-row">
              <input type="range" id="goalRange" min="5" max="50" step="5"
                     value="${state.dailyGoal}">
              <div class="goal-value"><b id="goalNum">${state.dailyGoal}</b> 条 / 天</div>
            </div>
            <div class="days-tip">按此进度，约 <b id="daysNum">${days}</b> 天完成全部条文</div>
          </div>

          <button class="btn-main" data-action="goto-select">开始今日任务</button>
          <button class="btn-sub" data-action="goto-library">浏览条文库</button>
        </main>
      </div>`;
  }

  /* ---------- 科目选择页 ---------- */
  function viewSelectSubjects() {
    const allSubjects = [];
    DATA.levels.forEach(level => {
      if (level.available === false) return;
      (level.subjects || []).forEach(s => {
        allSubjects.push({ levelName: level.name, subject: s });
      });
    });

    const cards = allSubjects.map(({ subject }) => {
      const total = subject.passages.length;
      const mastered = subject.passages.filter(p => isMastered(p.id)).length;
      const due = subject.passages.filter(p => isDueReview(p.id)).length;
      const checked = state.selectedSubjects.includes(subject.id);
      return `
        <label class="subject-select ${checked ? 'checked' : ''}">
          <input type="checkbox" data-subject="${subject.id}" ${checked ? 'checked' : ''}>
          <span class="sc-check"></span>
          <span class="sc-icon">${subject.icon || '📖'}</span>
          <span class="sc-body">
            <span class="sc-name">${esc(subject.name)}</span>
            <span class="sc-meta">
              ${mastered}/${total} 已掌握
              ${due > 0 ? `<b class="due-num"> · ${due} 条待复习</b>` : ''}
            </span>
          </span>
        </label>`;
    }).join('');

    const selectedSet = new Set(state.selectedSubjects);
    let totalRemain = 0, totalDue = 0;
    allSubjects.forEach(({ subject }) => {
      if (!selectedSet.has(subject.id)) return;
      totalRemain += subject.passages.filter(p => !isMastered(p.id)).length;
      totalDue += subject.passages.filter(p => isDueReview(p.id)).length;
    });
    const todayCount = Math.min(totalRemain, state.dailyGoal) + totalDue;
    const canStart = state.selectedSubjects.length > 0;

    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="goto-home">‹</button>
          <div class="topbar-title">
            <div class="tt-kicker">今日任务</div>
            <div class="tt-name">选择经典</div>
          </div>
          <button class="btn-all" data-action="toggle-all">
            ${state.selectedSubjects.length === allSubjects.length ? '全不选' : '全选'}
          </button>
        </header>

        <main class="list-main">
          <div class="select-hint">可多选，同时复习多本经典</div>
          <div class="subject-select-list">${cards}</div>
        </main>

        <footer class="select-foot">
          <div class="select-summary">
            已选 <b>${state.selectedSubjects.length}</b> 本 ·
            今日约 <b>${todayCount}</b> 条
            ${totalDue > 0 ? `<span class="due-tag">含 ${totalDue} 条复习</span>` : ''}
          </div>
          <button class="btn-main" data-action="confirm-start" ${canStart ? '' : 'disabled'}>
            ${canStart ? '开始学习' : '请至少选一本'}
          </button>
        </footer>
      </div>`;
  }

  /* ---------- 学习页 ---------- */
  function viewLearn() {
    if (!state.currentId) {
      const hasSel = state.selectedSubjects.length > 0;
      return `
        <div class="page">
          <header class="topbar">
            <button class="icon-btn" data-action="goto-home">‹</button>
            <div class="topbar-title"><div class="tt-name">今日任务</div></div>
            <div class="icon-btn ghost"></div>
          </header>
          <main class="learn-main">
            <div class="done-box">
              <div class="done-icon">✓</div>
              <div class="done-title">${hasSel ? '今日任务已完成' : '未选择经典'}</div>
              <div class="done-sub">${hasSel ? '明天再来，或去条文库继续学习' : '请返回选择至少一本经典'}</div>
              <button class="btn-main" data-action="goto-home">返回首页</button>
            </div>
          </main>
        </div>`;
    }

    const p = PASSAGE_MAP[state.currentId];
    const idx = state.queue.length;

    let body = '';
    if (state.step === 'overview') body = renderOverview(p);
    else if (state.step === 'choice') body = renderChoice(p);
    else if (state.step === 'cloze') body = renderClozeStep(p);
    else if (state.step === 'full') body = renderFullStep(p);

    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="goto-home">‹</button>
          <div class="topbar-title">
            <div class="tt-kicker">${esc(p.subjectName)} · ${esc(p.part || '')}</div>
            <div class="tt-name">${esc(p.article)}</div>
          </div>
          <div class="queue-badge">${idx}</div>
        </header>

        <div class="step-bar">
          ${['overview','choice','cloze','full'].map(s => `
            <div class="step-dot ${state.step === s ? 'active' : ''} ${stepDone(s) ? 'done' : ''}">
              ${({overview:'览',choice:'选',cloze:'空',full:'默'})[s]}
            </div>`).join('')}
        </div>

        <main class="learn-body">${body}</main>

        <footer class="learn-foot" id="learnFoot">${renderFoot()}</footer>
      </div>`;
  }

  function stepDone(s) {
    const order = ['overview', 'choice', 'cloze', 'full'];
    return order.indexOf(state.step) > order.indexOf(s);
  }

  function renderOverview(p) {
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="classic passage-text">${esc(p.text)}</div>
      <div class="hint-row">先默读一遍，凭印象判断是否记住了</div>
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
      <div class="passage-title">${esc(p.title)}</div>
      <div class="classic quote">${esc(q.before)}<span class="quote-blank">____</span>${esc(q.after)}</div>
      <div class="options">${opts}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}" id="feedbackMsg">${esc(state.feedback.text)}</div>` : ''}
    `;
  }

  function renderClozeStep(p) {
    const mask = buildMask(p.text, 'partial', p.id);
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="hint-row">补全空缺处（挖去 50% 的字）。可连续输入，系统按字自动填入</div>
      <div class="classic cloze-text" id="clozeBox">${renderCloze(p.text, mask)}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}" id="feedbackMsg">${esc(state.feedback.text)}</div>` : ''}
    `;
  }
  function renderFullStep(p) {
    const mask = buildMask(p.text, 'full', p.id);
    return `
      <div class="passage-title">${esc(p.title)}</div>
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
      if (fb && fb.type === 'bad') {
        return `
          <button class="btn-ghost" data-action="skip">跳过</button>
          <button class="btn-main" data-action="retry-cloze">重试</button>`;
      }
      const hintLabel = state.hintOn ? '关闭提示' : '提示';
      return `
        <button class="btn-ghost" data-action="toggle-hint">${hintLabel}</button>
        <button class="btn-main" data-action="check-cloze">检查</button>`;
    }
    return '';
  }

  /* ================= 核心：按字分发输入 ================= */
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

  function distributeInput(inp) {
    const inputs = getClozeInputs();
    const startIdx = inputs.indexOf(inp);
    if (startIdx < 0) return;

    let raw = inp.value || '';
    raw = raw.replace(/\s+/g, '');
    if (!raw) return;

    const chars = Array.from(raw);

    let cursor = startIdx;
    for (const ch of chars) {
      if (cursor >= inputs.length) break;
      inputs[cursor].value = ch;
      inputs[cursor].classList.remove('correct', 'wrong', 'revealed', 'hint-wrong');
      cursor++;
    }

    focusFirstEmpty(cursor);
  }

  document.addEventListener('input', function (e) {
    const inp = e.target;
    if (!isClozeInput(inp)) return;
    if (state.hintOn) return;
    if (e.isComposing || inp.dataset.composing === '1') return;
    distributeInput(inp);
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
    distributeInput(inp);
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

  /* ================= 提示开关 ================= */
  function clearHint() {
    if (!state.hintOn) return;
    const inputs = getClozeInputs();
    inputs.forEach(inp => {
      const uv = inp.dataset.userValue;
      if (uv !== undefined) inp.value = uv;
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
        if (uv !== undefined) inp.value = uv;
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

  /* ================= 事件 ================= */
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {

      case 'goto-home':
        state.screen = 'home';
        state.locking = false;
        render();
        break;

      case 'goto-select':
        state.screen = 'select-subjects';
        render();
        break;

      case 'goto-library':
        state.screen = 'library';
        state.viewSubjectId = null;
        render();
        break;

      case 'toggle-all': {
        const allIds = getAllSubjectIds();
        if (state.selectedSubjects.length === allIds.length) {
          state.selectedSubjects = [];
        } else {
          state.selectedSubjects = allIds.slice();
        }
        save();
        render();
        break;
      }

      case 'confirm-start':
        if (!state.selectedSubjects.length) break;
        startLearn();
        break;

      case 'know':
        state.step = 'choice';
        state.choice = null;
        state.choiceSeed = 0;
        state.feedback = null;
        state.pickedOption = null;
        state.hintOn = false;
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
          state.locking = true;
          state.feedback = { type: 'ok', text: '答对了，进入挖空填空' };
          updateFeedback('ok', '答对了，进入挖空填空');
          updateFoot();
          setTimeout(() => {
            state.step = 'cloze';
            state.feedback = null;
            state.pickedOption = null;
            state.locking = false;
            state.hintOn = false;
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
        state.choice = null;
        state.feedback = null;
        state.pickedOption = null;
        render();
        break;

      case 'toggle-hint':
        if (state.locking) break;
        toggleHint();
        break;

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
            state.feedback = { type: 'ok', text: '全对！进入默写' };
            updateFeedback('ok', '全对！进入默写');
            updateFoot();
            setTimeout(() => {
              state.step = 'full';
              state.feedback = null;
              state.locking = false;
              state.hintOn = false;
              render();
            }, 700);
          } else {
            state.feedback = { type: 'ok', text: '全对！本条已掌握' };
            updateFeedback('ok', '全对！本条已掌握');
            updateFoot();
            setTimeout(() => {
              state.locking = false;
              completeCurrent();
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
        if (state.hintOn) { clearHint(); }
        document.querySelectorAll('#clozeBox input.blank').forEach(inp => {
          inp.value = '';
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
        state.viewSubjectId = el.dataset.subject;
        render();
        break;
      case 'view-back':
        if (state.viewSubjectId) { state.viewSubjectId = null; render(); }
        else { state.screen = 'home'; render(); }
        break;
      case 'view-passage':
        state.currentId = el.dataset.passage;
        state.queue = [state.currentId];
        state.step = 'overview';
        state.choice = null;
        state.feedback = null;
        state.pickedOption = null;
        state.locking = false;
        state.hintOn = false;
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

  document.addEventListener('change', function (e) {
    const cb = e.target;
    if (cb && cb.matches && cb.matches('input[data-subject]')) {
      const id = cb.dataset.subject;
      const idx = state.selectedSubjects.indexOf(id);
      if (cb.checked && idx < 0) state.selectedSubjects.push(id);
      else if (!cb.checked && idx >= 0) state.selectedSubjects.splice(idx, 1);
      save();
      render();
    }
  });

  /* ================= 条文库 ================= */
  function viewLibrary() {
    const lv = DATA.levels.find(l => l.id === state.viewLevelId);
    if (!lv || !lv.available) return viewHome();

    if (!state.viewSubjectId) {
      const cards = lv.subjects.map(s => {
        const total = s.passages.length;
        const done = s.passages.filter(p => isMastered(p.id)).length;
        return `<button class="subject-card" data-action="view-subject" data-subject="${s.id}">
          <span class="sc-icon">${s.icon || '📖'}</span>
          <span class="sc-body">
            <span class="sc-name">${esc(s.name)}</span>
            <span class="sc-meta">${done} / ${total} 已掌握</span>
          </span>
          <span class="sc-arrow">›</span>
        </button>`;
      }).join('');
      return `
        <div class="page">
          <header class="topbar">
            <button class="icon-btn" data-action="view-back">‹</button>
            <div class="topbar-title"><div class="tt-name">条文库</div></div>
            <div class="icon-btn ghost"></div>
          </header>
          <main class="list-main">
            <div class="subject-list">${cards}</div>
          </main>
        </div>`;
    }

    const subject = lv.subjects.find(s => s.id === state.viewSubjectId);
    if (!subject) return viewHome();
    const items = subject.passages.map(p => {
      const pr = state.progress[p.id];
      const status = pr && pr.stage === 'mastered'
        ? (isDueReview(p.id) ? '<span class="tag due">待复习</span>' : '<span class="tag done">已掌握</span>')
        : '<span class="tag">未学</span>';
      return `<button class="passage-item" data-action="view-passage" data-passage="${p.id}">
        <span class="pi-main">
          <span class="pi-title">${esc(p.title)}</span>
          <span class="pi-article">${esc(p.article)}</span>
        </span>
        ${status}
      </button>`;
    }).join('');
    return `
      <div class="page">
        <header class="topbar">
          <button class="icon-btn" data-action="view-back">‹</button>
          <div class="topbar-title"><div class="tt-name">${esc(subject.name)}</div></div>
          <div class="icon-btn ghost"></div>
        </header>
        <main class="list-main">
          <div class="passage-list">${items}</div>
        </main>
      </div>`;
  }

  /* ================= 启动 ================= */
  load();
  render();
})();