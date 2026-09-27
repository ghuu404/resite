/* ============================================================
   app.js — 经典条文背诵 v3
   流程：总览 → 选择 → 挖空 → 默写 → 掌握（2天后复习）
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
  // partial: 挖去约 50%-70%；full: 逐字挖，仅保留标点
  function buildMask(text, mode, seed) {
    const chars = Array.from(text);
    const mask = new Array(chars.length).fill(-1);
    let gid = 0;

    if (mode === 'full') {
      for (let i = 0; i < chars.length; i++) {
        if (isPunct(chars[i])) continue;
        mask[i] = ++gid;           // 每字独立
      }
      return mask;
    }

    const rng = mulberry32(hashStr(seed + '::partial'));
    let i = 0;
    while (i < chars.length) {
      if (isPunct(chars[i])) { i++; continue; }
      if (rng() < 0.45) {
        const len = 1 + Math.floor(rng() * 3);   // 1~3 字
        let j = i, cnt = 0;
        gid++;
        while (j < chars.length && cnt < len && !isPunct(chars[j])) {
          mask[j] = gid; cnt++; j++;
        }
        i = j;
      } else i++;
    }
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
        const gid = mask[i];
        let j = i;
        while (j < chars.length && mask[j] === gid) j++;
        const ans = chars.slice(i, j).join('');
        const w = Math.max(1.6, ans.length * 1.15 + 0.5);
        html += `<input class="blank" type="text" data-answer="${esc(ans)}"
                   style="width:${w}em" autocomplete="off" autocorrect="off"
                   autocapitalize="off" spellcheck="false">`;
        i = j;
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

  const state = {
    screen: 'home',        // home | learn | library
    dailyGoal: 10,
    progress: {},          // id -> { stage, nextReviewAt, reviewCount, masteredAt }
    queue: [],             // 待学 id 列表
    currentId: null,
    step: 'overview',      // overview | choice | cloze | full
    choice: null,
    choiceSeed: 0,
    feedback: null,        // { type:'ok'|'bad', text }
    // 浏览
    viewLevelId: 'L1',
    viewSubjectId: null,
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.dailyGoal) state.dailyGoal = raw.dailyGoal;
      if (raw.progress) state.progress = raw.progress;
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dailyGoal: state.dailyGoal,
        progress: state.progress
      }));
    } catch (e) {}
  }

  /* ================= 进度 ================= */
  function getProg(id) {
    return state.progress[id] || (state.progress[id] = { stage: 'new' });
  }
  function isMastered(id) {
    const pr = state.progress[id];
    return pr && pr.stage === 'mastered';
  }
  function isDueReview(id) {
    const pr = state.progress[id];
    return pr && pr.stage === 'mastered' && pr.nextReviewAt && pr.nextReviewAt <= Date.now();
  }
  function masteredCount() {
    return ALL_PASSAGES.filter(p => isMastered(p.id)).length;
  }
  function dueReviewList() {
    return ALL_PASSAGES.filter(p => isDueReview(p.id));
  }
  function remainingCount() {
    return ALL_PASSAGES.length - masteredCount();
  }

  /* ================= 队列 ================= */
  function buildQueue() {
    const due = dueReviewList().map(p => p.id);
    const fresh = ALL_PASSAGES
      .filter(p => !isMastered(p.id))
      .slice(0, state.dailyGoal)
      .map(p => p.id);
    // 去重
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
    state.screen = 'learn';
    render();
  }

  function nextInQueue() {
    if (state.queue.length) state.queue.shift();
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    render();
  }

  function skipCurrent() {
    if (!state.queue.length) return;
    const id = state.queue.shift();
    state.queue.push(id);          // 移到队尾
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    render();
  }

  function completeCurrent() {
    const id = state.currentId;
    const pr = getProg(id);
    pr.stage = 'mastered';
    pr.masteredAt = Date.now();
    pr.reviewCount = (pr.reviewCount || 0) + 1;
    pr.nextReviewAt = Date.now() + 2 * 24 * 3600 * 1000;  // 2天后复习
    save();
    // 从队列移除
    state.queue = state.queue.filter(x => x !== id);
    state.currentId = state.queue[0] || null;
    state.step = 'overview';
    state.choice = null;
    state.feedback = null;
    render();
  }

  /* ================= 渲染 ================= */
  function render() {
    const root = document.getElementById('app');
    if (state.screen === 'home') root.innerHTML = viewHome();
    else if (state.screen === 'learn') root.innerHTML = viewLearn();
    else if (state.screen === 'library') root.innerHTML = viewLibrary();
    afterRender();
  }

  function afterRender() {
    if (state.screen === 'learn' && (state.step === 'cloze' || state.step === 'full')) {
      bindAutoAdvance();
    }
    window.scrollTo(0, 0);
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

          <button class="btn-main" data-action="start-learn">
            ${due > 0 ? '开始复习' : '开始学习'}
          </button>

          <button class="btn-sub" data-action="goto-library">浏览条文库</button>
        </main>
      </div>`;
  }

  /* ---------- 学习页 ---------- */
  function viewLearn() {
    if (!state.currentId) {
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
              <div class="done-title">今日任务已完成</div>
              <div class="done-sub">明天再来，或去条文库继续学习</div>
              <button class="btn-main" data-action="goto-home">返回首页</button>
            </div>
          </main>
        </div>`;
    }

    const p = PASSAGE_MAP[state.currentId];
    const pr = getProg(p.id);
    const stepLabel = { overview: '总览', choice: '选择', cloze: '挖空', full: '默写' }[state.step];
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

  /* ---------- 总览 ---------- */
  function renderOverview(p) {
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="classic passage-text">${esc(p.text)}</div>
      <div class="hint-row">先默读一遍，凭印象判断是否记住了</div>
    `;
  }

  /* ---------- 选择题 ---------- */
  function renderChoice(p) {
    if (!state.choice) state.choice = generateChoice(p, state.choiceSeed);
    const q = state.choice;
    if (!q) return `<div class="empty-tip">无法生成选择题，请直接进入挖空。</div>`;
    const letters = ['A', 'B', 'C', 'D'];
    const opts = q.options.map((o, i) => `
      <button class="option ${state.feedback && o === state.feedback.picked ? (o === q.correct ? 'correct' : 'wrong') : ''} ${state.feedback && o === q.correct ? 'correct' : ''}"
              data-action="pick-option" data-value="${esc(o)}">
        <span class="opt-letter">${letters[i]}</span>
        <span class="opt-text classic">${esc(o)}</span>
      </button>`).join('');
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="classic quote">${esc(q.before)}<span class="quote-blank">____</span>${esc(q.after)}</div>
      <div class="options">${opts}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}">${esc(state.feedback.text)}</div>` : ''}
    `;
  }

  /* ---------- 挖空 / 默写 ---------- */
  function renderClozeStep(p) {
    const mask = buildMask(p.text, 'partial', p.id);
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="hint-row">补全空缺处（约挖去一半以上）</div>
      <div class="classic cloze-text" id="clozeBox">${renderCloze(p.text, mask)}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}">${esc(state.feedback.text)}</div>` : ''}
    `;
  }
  function renderFullStep(p) {
    const mask = buildMask(p.text, 'full', p.id);
    return `
      <div class="passage-title">${esc(p.title)}</div>
      <div class="hint-row">默写全文，标点已给出</div>
      <div class="classic cloze-text" id="clozeBox">${renderCloze(p.text, mask)}</div>
      ${state.feedback ? `<div class="feedback ${state.feedback.type}">${esc(state.feedback.text)}</div>` : ''}
    `;
  }

  /* ---------- 底部按钮 ---------- */
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
      return `
        <button class="btn-ghost" data-action="reveal">显示答案</button>
        <button class="btn-main" data-action="check-cloze">检查</button>`;
    }
    return '';
  }

  /* ================= 自动跳空 ================= */
  function bindAutoAdvance() {
    const box = document.getElementById('clozeBox');
    if (!box) return;
    const inputs = Array.from(box.querySelectorAll('input.blank'));
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        const ans = normalize(inp.dataset.answer);
        const val = normalize(inp.value);
        inp.classList.remove('correct', 'wrong');
        if (ans.length > 0 && val.length >= ans.length) {
          // 跳到下一个未填的
          for (let j = i + 1; j < inputs.length; j++) {
            if (!inputs[j].value) { inputs[j].focus(); return; }
          }
          if (i === inputs.length - 1) {
            // 最后一个，自动检查
          }
        }
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && inp.value === '' && i > 0) {
          inputs[i - 1].focus();
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          for (let j = i + 1; j < inputs.length; j++) {
            if (!inputs[j].value) { inputs[j].focus(); return; }
          }
        }
      });
    });
    if (inputs[0]) setTimeout(() => { try { inputs[0].focus(); } catch (e) {} }, 80);
  }

  /* ================= 交互逻辑 ================= */
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {

      case 'start-learn':
        startLearn();
        break;

      case 'goto-home':
        state.screen = 'home';
        render();
        break;

      case 'goto-library':
        state.screen = 'library';
        state.viewSubjectId = null;
        render();
        break;

      /* ---- 总览 ---- */
      case 'know':
        state.step = 'choice';
        state.choice = null;
        state.choiceSeed = 0;
        state.feedback = null;
        render();
        break;

      case 'skip':
        skipCurrent();
        break;

      /* ---- 选择题 ---- */
      case 'pick-option': {
        document.querySelectorAll('.option').forEach(o => o.classList.remove('picked'));
        el.classList.add('picked');
        state.feedback = null;
        // 重新渲染以清除旧反馈
        const p = PASSAGE_MAP[state.currentId];
        state.choice._picked = el.dataset.value;
        render();
        // 恢复高亮
        setTimeout(() => {
          document.querySelectorAll('.option').forEach(o => {
            if (o.dataset.value === el.dataset.value) o.classList.add('picked');
          });
        }, 0);
        break;
      }

      case 'check-choice': {
        const picked = document.querySelector('.option.picked');
        if (!picked) {
          state.feedback = { type: 'bad', text: '请先选择一个选项' };
          render();
          break;
        }
        const q = state.choice;
        const ok = picked.dataset.value === q.correct;
        if (ok) {
          state.feedback = { type: 'ok', text: '答对了，进入挖空填空' };
          render();
          setTimeout(() => {
            state.step = 'cloze';
            state.feedback = null;
            render();
          }, 600);
        } else {
          state.feedback = { type: 'bad', text: '答错了，可以重试或跳过', picked: picked.dataset.value };
          render();
        }
        break;
      }

      case 'retry-choice':
        state.choiceSeed = Math.floor(Math.random() * 1e9);
        state.choice = null;
        state.feedback = null;
        render();
        break;

      /* ---- 挖空 / 默写 ---- */
      case 'check-cloze': {
        const box = document.getElementById('clozeBox');
        if (!box) break;
        const inputs = Array.from(box.querySelectorAll('input.blank'));
        let wrong = 0;
        inputs.forEach(inp => {
          const ans = normalize(inp.dataset.answer);
          const val = normalize(inp.value);
          if (val && val === ans) {
            inp.classList.add('correct'); inp.classList.remove('wrong');
          } else {
            inp.classList.add('wrong'); inp.classList.remove('correct');
            wrong++;
          }
        });
        if (wrong === 0) {
          if (state.step === 'cloze') {
            state.feedback = { type: 'ok', text: '全对！进入默写' };
            render();
            setTimeout(() => {
              state.step = 'full';
              state.feedback = null;
              render();
            }, 600);
          } else {
            state.feedback = { type: 'ok', text: '全对！本条已掌握' };
            render();
            setTimeout(() => completeCurrent(), 700);
          }
        } else {
          state.feedback = { type: 'bad', text: `还有 ${wrong} 处不正确，可以重试或跳过` };
          render();
        }
        break;
      }

      case 'reveal': {
        document.querySelectorAll('#clozeBox input.blank').forEach(inp => {
          inp.value = inp.dataset.answer;
          inp.classList.add('revealed');
        });
        state.feedback = { type: 'bad', text: '已显示答案，请仔细核对后重试' };
        render();
        break;
      }

      case 'retry-cloze': {
        state.feedback = null;
        render();
        break;
      }

      /* ---- 浏览 ---- */
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
        state.screen = 'learn';
        render();
        break;
    }
  });

  /* ---- 每日目标滑块 ---- */
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