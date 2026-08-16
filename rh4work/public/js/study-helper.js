// study-helper.js — a small floating chat widget.
//
// Two capabilities work everywhere, with no server/API key needed:
//  1. Math calculation — a hand-written, safe expression evaluator (no
//     eval()/Function() on user input) supporting + - * / ^ % () and
//     sqrt/sin/cos/tan/log/ln.
//  2. "Reads the screen" — grabs the currently visible exercise question
//     and its options (see readScreenContext below) so any question you ask
//     has that context, without you having to retype the question.
//
// A third capability — free-form Q&A — only works if the site owner has set
// ANTHROPIC_API_KEY on the server (see routes/assistant.js). If they
// haven't, the widget says so plainly instead of pretending to answer.
(function () {
  function getToken() { return localStorage.getItem('rh_token'); }

  /* ---------------- safe math evaluator ---------------- */
  // Recursive-descent parser over a small grammar — no eval/Function, so
  // there's no way user input becomes executable JS.
  function evaluateMath(expr) {
    const tokens = expr.match(/(\d+\.?\d*|\.\d+|[+\-*/^%()]|sqrt|sin|cos|tan|log|ln|pi|e)/gi);
    if (!tokens) throw new Error('no expression found');
    let pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function parseExpr() {
      let v = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = next();
        const rhs = parseTerm();
        v = op === '+' ? v + rhs : v - rhs;
      }
      return v;
    }
    function parseTerm() {
      let v = parseFactor();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        const op = next();
        const rhs = parseFactor();
        if (op === '*') v = v * rhs;
        else if (op === '/') { if (rhs === 0) throw new Error('division by zero'); v = v / rhs; }
        else v = v % rhs;
      }
      return v;
    }
    function parseFactor() {
      let v = parsePower();
      return v;
    }
    function parsePower() {
      let v = parseUnary();
      if (peek() === '^') { next(); const rhs = parsePower(); v = Math.pow(v, rhs); }
      return v;
    }
    function parseUnary() {
      if (peek() === '-') { next(); return -parseUnary(); }
      if (peek() === '+') { next(); return parseUnary(); }
      return parseAtom();
    }
    function parseAtom() {
      const t = peek();
      if (t === undefined) throw new Error('unexpected end of expression');
      if (t === '(') { next(); const v = parseExpr(); if (next() !== ')') throw new Error('missing )'); return v; }
      const fnMap = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log };
      if (fnMap[t.toLowerCase()]) {
        next();
        if (next() !== '(') throw new Error(t + ' expects (...)');
        const arg = parseExpr();
        if (next() !== ')') throw new Error('missing )');
        return fnMap[t.toLowerCase()](arg);
      }
      if (t.toLowerCase() === 'pi') { next(); return Math.PI; }
      if (t.toLowerCase() === 'e') { next(); return Math.E; }
      if (/^\d/.test(t) || t.startsWith('.')) { next(); return parseFloat(t); }
      throw new Error('unexpected token: ' + t);
    }

    const result = parseExpr();
    if (pos !== tokens.length) throw new Error('unexpected trailing input');
    if (!isFinite(result)) throw new Error('result is not a finite number');
    return result;
  }

  // A message "looks like math" if, once you strip known math tokens, only
  // whitespace is left — this avoids misfiring on ordinary sentences that
  // happen to contain a number.
  function looksLikeMath(msg) {
    const stripped = msg.replace(/(\d+\.?\d*|\.\d+|[+\-*/^%()]|sqrt|sin|cos|tan|log|ln|pi|e|\s)/gi, '');
    return stripped.length === 0 && /[0-9]/.test(msg) && /[+\-*/^%]/.test(msg);
  }

  /* ---------------- reading the current screen ---------------- */
  // Pulls whatever exercise question is currently visible, if any — used so
  // the learner doesn't have to retype the question into the chat. Looks
  // for the known hooks exercises.html renders; harmless no-op elsewhere.
  function readScreenContext() {
    const qEl = document.querySelector('[data-helper-question]');
    if (!qEl) return '';
    const questionText = qEl.textContent.trim();
    const optionEls = document.querySelectorAll('[data-helper-option]');
    const options = Array.from(optionEls).map((el, i) => String.fromCharCode(65 + i) + '. ' + el.textContent.trim());
    return questionText + (options.length ? '\nOptions:\n' + options.join('\n') : '');
  }

  /* ---------------- widget UI ---------------- */
  let assistantEnabled = null; // null = unknown yet, checked lazily on first open

  function ensureWidget() {
    if (document.getElementById('helperRoot')) return;
    const root = document.createElement('div');
    root.id = 'helperRoot';
    root.innerHTML = `
      <button id="helperToggle" aria-label="Open study helper">✦</button>
      <div id="helperPanel" class="helper-panel" hidden>
        <div class="helper-head">
          <span>Study Helper</span>
          <button id="helperClose" aria-label="Close">✕</button>
        </div>
        <div class="helper-body" id="helperBody">
          <div class="helper-msg helper-msg-bot">Ask me a math question (e.g. <code>2^10 / 4 + sqrt(9)</code>), or ask about the exercise currently on screen.</div>
        </div>
        <div class="helper-input-row">
          <input type="text" id="helperInput" placeholder="Type a question or expression…">
          <button id="helperSend">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      #helperRoot{ position:fixed; right:18px; bottom:18px; z-index:200; font-family:'Inter',sans-serif; }
      #helperToggle{
        width:52px; height:52px; border-radius:50%; border:none; cursor:pointer;
        background:var(--ink,#1E2A4A); color:#fff; font-size:20px; box-shadow:0 8px 20px rgba(0,0,0,0.18);
      }
      .helper-panel{
        position:absolute; right:0; bottom:64px; width:320px; max-width:calc(100vw - 32px);
        background:var(--panel,#fff); border:1.5px solid var(--grid,#ddd); border-radius:14px;
        box-shadow:0 14px 34px rgba(0,0,0,0.18); display:flex; flex-direction:column; overflow:hidden;
      }
      .helper-head{
        display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
        background:var(--ink,#1E2A4A); color:#fff; font-family:'JetBrains Mono',monospace; font-size:12.5px; letter-spacing:.04em;
      }
      .helper-head button{ background:none; border:none; color:#fff; cursor:pointer; font-size:14px; }
      .helper-body{ padding:12px 14px; max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:8px; }
      .helper-msg{ font-size:13px; line-height:1.5; padding:8px 10px; border-radius:8px; max-width:88%; white-space:pre-wrap; }
      .helper-msg-bot{ background:var(--paper,#f4f4f2); color:var(--ink,#1E2A4A); align-self:flex-start; }
      .helper-msg-user{ background:var(--blue,#3A6FD8); color:#fff; align-self:flex-end; }
      .helper-msg code{ font-family:'JetBrains Mono',monospace; background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:4px; }
      .helper-input-row{ display:flex; gap:6px; padding:10px 12px; border-top:1px solid var(--grid,#ddd); }
      .helper-input-row input{
        flex:1; padding:8px 10px; border:1.5px solid var(--line,#ddd); border-radius:8px; font-size:13px;
        background:var(--paper,#fff); color:var(--ink,#1E2A4A);
      }
      .helper-input-row button{
        background:var(--ink,#1E2A4A); color:#fff; border:none; border-radius:8px; padding:8px 14px;
        font-size:12.5px; font-weight:600; cursor:pointer;
      }
      @media (max-width:480px){ .helper-panel{ right:-8px; width:calc(100vw - 24px); } }
    `;
    document.head.appendChild(style);

    document.getElementById('helperToggle').addEventListener('click', () => {
      const panel = document.getElementById('helperPanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById('helperInput').focus();
    });
    document.getElementById('helperClose').addEventListener('click', () => {
      document.getElementById('helperPanel').hidden = true;
    });
    document.getElementById('helperSend').addEventListener('click', sendMessage);
    document.getElementById('helperInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  }

  function appendMsg(text, who) {
    const body = document.getElementById('helperBody');
    const el = document.createElement('div');
    el.className = 'helper-msg helper-msg-' + who;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  async function sendMessage() {
    const input = document.getElementById('helperInput');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    appendMsg(msg, 'user');

    if (looksLikeMath(msg)) {
      try {
        const result = evaluateMath(msg);
        appendMsg('= ' + result, 'bot');
      } catch (e) {
        appendMsg("I couldn't parse that as math (" + e.message + "). Try something like 3*(4+2)^2.", 'bot');
      }
      return;
    }

    if (assistantEnabled === null) {
      try {
        const token = getToken();
        const res = await fetch('/api/assistant/status', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
        const data = await res.json();
        assistantEnabled = !!data.enabled;
      } catch (e) { assistantEnabled = false; }
    }

    if (!assistantEnabled) {
      appendMsg("I can calculate math right now (try an expression like 12/4+3). Free-form Q&A isn't turned on for this site yet — the site owner can enable it for free with a Google Gemini API key (GEMINI_API_KEY).", 'bot');
      return;
    }

    const thinking = appendMsg('…', 'bot');
    try {
      const token = getToken();
      const res = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: JSON.stringify({ message: msg, screenContext: readScreenContext() })
      });
      const data = await res.json();
      thinking.textContent = res.ok && data.reply ? data.reply : (data.error || "Sorry, I couldn't answer that.");
    } catch (e) {
      thinking.textContent = "Sorry, something went wrong reaching the study helper.";
    }
  }

  window.StudyHelper = { init: ensureWidget };
})();
