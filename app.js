/* ============================================================
   app.js — 经典条文挖空背诵 · 主程序
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     一、工具函数
     ========================================================== */
  const PUNCT_RE = /[，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}<>\/\\|_\-～~`@#$%^&*+= \u3000]/;

  function isPunct(ch) { return PUNCT_RE.test(ch); }

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
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

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  const NORM_RE = /[\s，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}<>\/\\|_\-～~`@#$%^&*+=]/g;
  function normalize(s) { return String(s == null ? '' : s).replace(NORM_RE, ''); }

  function splitSegments(text) {
    return String(text).split(/[，。、；：？！“”‘’（）《》〈〉【】〔〕—…·,.;:?!"'()\[\]{}]+/).filter(Boolean);
  }

  /* ==========================================================
     二、挖空掩码生成
     ========================================================== */

  /**
   * @param {string} text 原文
   * @param {'partial'|'full'} mode
   * @param {string} seed
   * @returns {number[]} mask[i] === -1 表示可见；>=0 表示属于第几号空
   */
  function buildMask(text, mode, seed) {
    const chars = Array.from(text);
    const mask = new Array(chars.length).fill(-1);
    let gid = 0;

    if (mode === 'full') {
      let inGroup = false;
      for (let i = 0; i < chars.length; i++) {
        if (isPunct(chars[i])) { inGroup = false; continue; }
        if (!inGroup) { gid++; inGroup = true; }
        mask[i] = gid;
      }
      return mask;
    }

    // partial：约 50%~70% 挖空
    const rng = mulberry32(hashStr(seed + '::partial'));
    let i = 0;
    while (i < chars.length) {
      if (isPunct(chars[i])) { i++; continue; }
      if (rng() < 0.42) {
        const len = 1 + Math.floor(rng() * 3); // 1~3 字
        let j = i, cnt = 0;
        gid++;
        while (j < chars.length && cnt < len && !isPunct(chars[j])) {
          mask[j] = gid; cnt++; j++;
        }
        i = j;
      } else {
        i++;
      }
    }
    return mask;
  }

  /** 渲染带空白的条文 HTML */
  function renderCloze(text, mask) {
    const chars = Array.from(text);
    let html = '';
    let i = 0;
    while (i < chars.length) {
      if (mask[i] === -1) {
        html += `<span class="c">${esc(chars[i])}</span>`;
        i++;
      } else {
        const gid = mask[i];
        let j = i;
        while (j < chars.length && mask[j] === gid) j++;
        const answer = chars.slice(i, j).join('');
        const w = Math.max(2, (j - i) * 1.12 + 0.4);
        html += `<input class="blank" type="text" data-answer="${esc(answer)}"
                   style="width:${w}em" autocomplete="off" autocorrect="off"
                   autocapitalize="off" spellcheck="false" aria-label="填空">`;
        i = j;
      }
    }
    return html;
  }

  /* ==========================================================
     三、选择题生成
     ========================================================== */
  function generateChoice(passage, seedOffset) {
    const seed = hashStr(passage.id + '::choice::' + (seedOffset || 0));
    const rng = mulberry32(seed);

    const segs = splitSegments(passage.text).filter(s => s.length >= 3 && s.length <= 16);
    if (segs.length === 0) return null;
    const correct = segs[Math.floor(rng() * segs.length)];

    // 干扰项池
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

    const shuffled = shuffle(options.slice(0, 4), rng);

    const idx = passage.text.indexOf(correct);
    if (idx < 0) return null;

    return {
      before: passage.text.slice(0, idx),
      after: passage.text.slice(idx + correct.length),
      correct,
      options: shuffled
    };
  }

  /* ==========================================================
     四、状态与持久化
     ========================================================== */
  const STORAGE_KEY = 'jingdian-progress-v2';

  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); }
    catch (e) { /* ignore */ }
  }

  const state = {
    screen: 'home',
    levelId: null,
    subjectId: null,
    passageId: null,
    mode: 'choice',      // choice | partial | full
    progress: loadProgress(),
    choice: null,        // 当前选择题
    choiceSeed: 0,
    checked: {}          // 当前练习的检查状态
  };

  const MODES = [
    { key: 'choice',  label: '选择题',  short: '选' },
    { key: 'partial', label: '挖空填空', short: '空' },
    { key: 'full',    label: '全部填空', short: '全' }
  ];

  function getPassage(id) { return PASSAGE_MAP[id]; }

  function getLevel(id) { return DATA.levels.find(l => l.id === id); }

  function getSubject(levelId, subjectId) {
    const lv = getLevel(levelId);
    return lv ? (lv.subjects || []).find(s => s.id === subjectId) : null;
  }

  function getProg(pid) {
    return state.progress[pid] || (state.progress[pid] = {});
  }

  function isDone(pid, mode) { return !!getProg(pid)[mode]; }

  function passageDoneCount(p) {
    const pr = state.progress[p.id] || {};
    return MODES.reduce((n, m) => n + (pr[m.key] ? 1 : 0), 0);
  }

  /* ==========================================================
     五、视图渲染
     ========================================================== */

  function viewHome() {
    let total = 0, done = 0;
    ALL_PASSAGES.forEach(p => {
      total++;
      if (passageDoneCount(p) === 3) done++;
    });

    const cards = DATA.levels.map(lv => {
      const cls = lv.available ? 'level-card' : 'level-card disabled';
      let sub = '';
      if (lv.available) {
        let t = 0, d = 0;
        (lv.subjects || []).forEach(s => s.passages.forEach(p => {
          t++;
          if (passageDoneCount(p) === 3) d++;
        }));
        sub = `<span class="lc-sub">${d} / ${t} 条已掌握</span>`;
      } else {
        sub = `<span class="lc-sub">敬请期待</span>`;
      }
      const attr = lv.available ? `data-action="goto-level" data-level="${lv.id}"` : '';
      return `<div class="${cls}" ${attr}>
                <span class="lc-name">${esc(lv.name)}</span>
                ${sub}
              </div>`;
    }).join('');

    return `
      <div class="page">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark">經</span>
            <div class="brand-text">
              <div class="brand-title">经典条文</div>
              <div class="brand-sub">全国中医药经典能力等级考试</div>
            </div>
          </div>
        </header>
        <main class="home-main">
          <div class="hero">
            <div class="hero-num">${done}<span>/${total}</span></div>
            <div class="hero-label">条文已全部掌握</div>
          </div>
          <div class="section-label">选择等级</div>
          <div class="level-grid">${cards}</div>
        </main>
      </div>`;
  }

  function viewSubjects() {
    const lv = getLevel(state.levelId);
    if (!lv) return viewHome();

    const cards = (lv.subjects || []).map(s => {
      let t = 0, d = 0;
      s.passages.forEach(p => { t++; if (passageDoneCount(p) === 3) d++; });
      const pct = t ? Math.round(d / t * 100) : 0;
      return `<button class="subject-card" data-action="goto-subject" data-subject="${s.id}">
                <span class="sc-icon">${s.icon || '📖'}</span>
                <span class="sc-body">
                  <span class="sc-name">${esc(s.name)}</span>
                  <span class="sc-meta">${t} 条 · 已掌握 ${d}</span>
                  <span class="sc-bar"><i style="width:${pct}%"></i></span>
                </span>
                <span class="sc-arrow">›</span>
              </button>`;
    }).join('');

    return `
      <div class="page">
        ${topbar(lv.name, '等级')}
        <main class="list-main">
          <div class="section-label">科目</div>
          <div class="subject-list">${cards}</div>
        </main>
      </div>`;
  }

  function viewPassages() {
    const subject = getSubject(state.levelId, state.subjectId);
    if (!subject) return viewSubjects();

    // 按 part 分组
    const groups = [];
    const seen = {};
    subject.passages.forEach(p => {
      const key = p.part || '';
      if (!seen[key]) { seen[key] = { part: key, items: [] }; groups.push(seen[key]); }
      seen[key].items.push(p);
    });

    const html = groups.map(g => {
      const items = g.items.map(p => {
        const pr = state.progress[p.id] || {};
        const dots = MODES.map(m =>
          `<i class="dot ${pr[m.key] ? 'on' : ''}" title="${m.label}">${m.short}</i>`
        ).join('');
        return `<button class="passage-item" data-action="goto-passage" data-passage="${p.id}">
                  <span class="pi-main">
                    <span class="pi-title">${esc(p.title)}</span>
                    <span class="pi-article">${esc(p.article)}</span>
                  </span>
                  <span class="pi-dots">${dots}</span>
                </button>`;
      }).join('');
      return `<div class="part-group">
                <div class="part-head">${esc(g.part || subject.name)}</div>
                <div class="passage-list">${items}</div>
              </div>`;
    }).join('');

    return `
      <div class="page">
        ${topbar(subject.name, '科目', 'goto-subjects')}
        <main class="list-main">${html}</main>
      </div>`;
  }

  function topbar(title, kicker, backAction) {
    const act = backAction || 'back';
    return `<header class="topbar">
      <button class="icon-btn" data-action="${act}" aria-label="返回">‹</button>
      <div class="topbar-title">
        <div class="tt-kicker">${esc(kicker)}</div>
        <div class="tt-name">${esc(title)}</div>
      </div>
      <div class="icon-btn ghost"></div>
    </header>`;
  }

  /* ---------------- 练习页 ---------------- */
  function viewPractice() {
    const p = getPassage(state.passageId);
    if (!p) return viewPassages();

    const pr = state.progress[p.id] || {};
    const doneCount = MODES.reduce((n, m) => n + (pr[m.key] ? 1 : 0), 0);

    const tabs = MODES.map(m => {
      const active = state.mode === m.key ? 'active' : '';
      const done = pr[m.key] ? 'done' : '';
      return `<button class="mode-tab ${active} ${done}" data-action="set-mode" data-mode="${m.key}">
                ${m.label}${pr[m.key] ? ' ✓' : ''}
              </button>`;
    }).join('');

    let body = '';
    if (state.mode === 'choice') body = renderChoiceBody(p);
    else body = renderClozeBody(p, state.mode);

    return `
      <div class="page practice-page">
        <header class="practice-head">
          <button class="icon-btn" data-action="back" aria-label="返回">‹</button>
          <div class="ph-title">
            <div class="ph-article">${esc(p.part ? p.part + ' · ' : '')}${esc(p.article)}</div>
            <div class="ph-name">${esc(p.title)}</div>
          </div>
          <div class="ph-progress">${doneCount}/3</div>
        </header>

        <div class="mode-tabs">${tabs}</div>

        <main class="practice-body" id="practiceBody">${body}</main>

        <footer class="practice-foot" id="practiceFoot"></footer>
      </div>`;
  }

  function renderClozeBody(p, mode) {
    const mask = buildMask(p.text, mode, p.id);
    const hint = mode === 'partial'
      ? '补全空缺处（约挖去 50%~70%）'
      : '默写全文（标点已给出）';
    return `
      <div class="cloze-hint">${hint}</div>
      <div class="classic cloze-text" id="clozeText">${renderCloze(p.text, mask)}</div>
      <div class="result-bar" id="resultBar"></div>
    `;
  }

  function renderChoiceBody(p) {
    if (!state.choice) {
      state.choice = generateChoice(p, state.choiceSeed);
    }
    const q = state.choice;
    if (!q) {
      return `<div class="empty-tip">该条文暂无法生成选择题，请切换到填空模式。</div>`;
    }

    const letters = ['A', 'B', 'C', 'D'];
    const opts = q.options.map((o, i) => `
      <button class="option" data-action="pick-option" data-value="${esc(o)}" data-correct="${o === q.correct}">
        <span class="opt-letter">${letters[i]}</span>
        <span class="opt-text classic">${esc(o)}</span>
      </button>`).join('');

    return `
      <div class="cloze-hint">选出文中空缺的部分</div>
      <div class="classic choice-quote">${esc(q.before)}<span class="quote-blank">________</span>${esc(q.after)}</div>
      <div class="options" id="options">${opts}</div>
      <div class="result-bar" id="resultBar"></div>
    `;
  }

  function renderFoot() {
    const foot = document.getElementById('practiceFoot');
    if (!foot) return;

    if (state.mode === 'choice') {
      foot.innerHTML = `
        <button class="btn-ghost" data-action="next-choice">换一题</button>
        <button class="btn-primary" data-action="check-choice">检查</button>`;
    } else {
      foot.innerHTML = `
        <button class="btn-ghost" data-action="reveal">显示答案</button>
        <button class="btn-primary" data-action="check-cloze">检查</button>`;
    }
  }

  /* ==========================================================
     六、渲染主循环
     ========================================================== */
  function render() {
    const root = document.getElementById('app');
    let html = '';

    if (state.screen === 'home') html = viewHome();
    else if (state.screen === 'subjects') html = viewSubjects();
    else if (state.screen === 'passages') html = viewPassages();
    else if (state.screen === 'practice') html = viewPractice();

    root.innerHTML = html;

    if (state.screen === 'practice') {
      if (state.mode === 'choice') {
        // 选择题也渲染脚部
        const foot = document.getElementById('practiceFoot');
        if (foot) {
          foot.innerHTML = `
            <button class="btn-ghost" data-action="next-choice">换一题</button>
            <button class="btn-primary" data-action="check-choice">检查</button>`;
        }
      } else {
        renderFoot();
        bindClozeInputs();
      }
      window.scrollTo(0, 0);
    }
  }

  /* ==========================================================
     七、填空交互
     ========================================================== */
  function bindClozeInputs() {
    const inputs = Array.from(document.querySelectorAll('#clozeText input.blank'));
    inputs.forEach((inp, idx) => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const next = inputs[idx + 1];
          if (next) next.focus();
          else doCheckCloze();
        }
      });
      inp.addEventListener('input', () => {
        inp.classList.remove('correct', 'wrong');
      });
    });
    if (inputs[0]) {
      setTimeout(() => { try { inputs[0].focus(); } catch (e) {} }, 60);
    }
  }

  function doCheckCloze() {
    const inputs = Array.from(document.querySelectorAll('#clozeText input.blank'));
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

    const bar = document.getElementById('resultBar');
    if (bar) {
      if (wrong === 0) {
        bar.className = 'result-bar ok';
        bar.textContent = `全部正确！已完成「${MODES.find(m => m.key === state.mode).label}」`;
        markDone(state.passageId, state.mode);
      } else {
        bar.className = 'result-bar bad';
        bar.textContent = `还有 ${wrong} 处不正确，再想想或点「显示答案」。`;
      }
    }
  }

  function doReveal() {
    document.querySelectorAll('#clozeText input.blank').forEach(inp => {
      inp.value = inp.dataset.answer;
      inp.classList.remove('wrong');
      inp.classList.add('revealed');
    });
    const bar = document.getElementById('resultBar');
    if (bar) { bar.className = 'result-bar'; bar.textContent = '已显示答案。'; }
  }

  function doCheckChoice() {
    const opts = Array.from(document.querySelectorAll('#options .option'));
    let picked = opts.find(o => o.classList.contains('picked'));
    const bar = document.getElementById('resultBar');

    if (!picked) {
      if (bar) { bar.className = 'result-bar bad'; bar.textContent = '请先选择一个选项。'; }
      return;
    }

    opts.forEach(o => {
      if (o.dataset.correct === 'true') o.classList.add('correct');
      else if (o === picked) o.classList.add('wrong');
    });

    if (picked.dataset.correct === 'true') {
      if (bar) { bar.className = 'result-bar ok'; bar.textContent = '答对了！'; }
      markDone(state.passageId, 'choice');
    } else {
      if (bar) { bar.className = 'result-bar bad'; bar.textContent = '答错了，正确答案已标出。'; }
    }
  }

  function markDone(pid, mode) {
    const pr = getProg(pid);
    const was = pr[mode];
    pr[mode] = true;
    saveProgress();
    if (!was) {
      // 更新顶部的 1/3
      const ph = document.querySelector('.ph-progress');
      if (ph) {
        const cnt = MODES.reduce((n, m) => n + (pr[m.key] ? 1 : 0), 0);
        ph.textContent = cnt + '/3';
      }
      // 更新标签页
      const tab = document.querySelector(`.mode-tab[data-mode="${mode}"]`);
      if (tab) { tab.classList.add('done'); }
    }
  }

  /* ==========================================================
     八、事件处理
     ========================================================== */
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {

      case 'goto-level': {
        state.levelId = el.dataset.level;
        state.screen = 'subjects';
        render();
        break;
      }

      case 'goto-subject': {
        state.subjectId = el.dataset.subject;
        state.screen = 'passages';
        render();
        break;
      }

      case 'goto-subjects': {
        state.screen = 'subjects';
        render();
        break;
      }

      case 'goto-passage': {
        state.passageId = el.dataset.passage;
        state.mode = 'choice';
        state.choice = null;
        state.choiceSeed = 0;
        state.screen = 'practice';
        render();
        break;
      }

      case 'back': {
        if (state.screen === 'practice') {
          state.screen = 'passages';
        } else if (state.screen === 'passages') {
          state.screen = 'subjects';
        } else if (state.screen === 'subjects') {
          state.screen = 'home';
        } else {
          state.screen = 'home';
        }
        render();
        break;
      }

      case 'set-mode': {
        state.mode = el.dataset.mode;
        if (state.mode === 'choice') {
          state.choice = null;
        }
        render();
        break;
      }

      case 'next-choice': {
        state.choiceSeed = Math.floor(Math.random() * 1e9);
        state.choice = null;
        render();
        break;
      }

      case 'check-choice': {
        doCheckChoice();
        break;
      }

      case 'check-cloze': {
        doCheckCloze();
        break;
      }

      case 'reveal': {
        doReveal();
        break;
      }

      case 'pick-option': {
        const parent = el.closest('#options');
        if (!parent) break;
        parent.querySelectorAll('.option').forEach(o => o.classList.remove('picked'));
        el.classList.add('picked');
        // 清除旧的判定
        parent.querySelectorAll('.option').forEach(o => o.classList.remove('correct', 'wrong'));
        const bar = document.getElementById('resultBar');
        if (bar) { bar.className = 'result-bar'; bar.textContent = ''; }
        break;
      }
    }
  });

  // 键盘快捷键
  document.addEventListener('keydown', function (e) {
    if (state.screen !== 'practice') return;
    if (e.key === 'Escape') {
      state.screen = 'passages';
      render();
    }
  });

  /* ==========================================================
     九、启动
     ========================================================== */
  render();

})();