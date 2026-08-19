// study-helper.js — a small chat widget, opened on demand from the 💬
// button in the top nav bar (see nav.js). There's no floating on-screen
// launcher anymore — the panel only exists while it's open.
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
      <div id="helperPanel" class="helper-panel" hidden>
        <div class="helper-head">
          <span>Study Helper</span>
          <span style="display:flex;gap:10px;align-items:center;">
            <button id="helperShareScreen" aria-label="Share your screen" title="Share your screen with an admin">⛶</button>
            <button id="helperClear" aria-label="Clear chat" title="Clear this conversation">🗑</button>
            <button id="helperRemove" aria-label="Close" title="Close — reopen anytime from the ✨ button in the corner">✕</button>
          </span>
        </div>
        <div class="helper-body" id="helperBody">
          <div class="helper-msg helper-msg-bot">Ask me a math question (e.g. <code>2^10 / 4 + sqrt(9)</code>), or ask about the exercise currently on screen. Reopen this anytime from the ✨ button in the corner.</div>
        </div>
        <div class="helper-input-row">
          <input type="text" id="helperInput" placeholder="Type a question or expression…">
          <button id="helperSend">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.id = 'helperStyle';
    style.textContent = `
      #helperRoot{ position:fixed; right:18px; bottom:18px; z-index:200; font-family:'Inter',sans-serif; }
      .helper-panel{
        position:fixed; right:18px; bottom:18px; width:320px; max-width:calc(100vw - 32px);
        background:var(--panel,#fff); border:1.5px solid var(--grid,#ddd); border-radius:14px;
        box-shadow:0 14px 34px rgba(0,0,0,0.18); display:flex; flex-direction:column; overflow:hidden;
        transform-origin:bottom right; animation:helperPanelIn .16s ease;
      }
      @keyframes helperPanelIn{ from{ opacity:0; transform:scale(.85) translateY(8px); } to{ opacity:1; transform:scale(1) translateY(0); } }
      .helper-head{
        display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
        background:var(--ink,#1E2A4A); color:#fff; font-family:'JetBrains Mono',monospace; font-size:12.5px; letter-spacing:.04em;
      }
      .helper-head button{ background:none; border:none; color:#fff; cursor:pointer; font-size:14px; }
      .helper-head button.sharing{ color:var(--red,#b23a2e); }
      #helperRemove:hover{ color:var(--red,#b23a2e); }
      .helper-body{ padding:12px 14px; max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:8px; }
      .helper-msg{ font-size:13px; line-height:1.5; padding:8px 10px; border-radius:8px; max-width:88%; white-space:pre-wrap; }
      .helper-msg-bot{ background:var(--paper,#f4f4f2); color:var(--ink,#1E2A4A); align-self:flex-start; }
      .helper-msg-user{ background:var(--blue,#3A6FD8); color:#fff; align-self:flex-end; }
      .helper-msg code{ font-family:'JetBrains Mono',monospace; background:rgba(0,0,0,0.06); padding:1px 4px; border-radius:4px; }
      .helper-msg .helper-h1, .helper-msg .helper-h2, .helper-msg .helper-h3{ display:block; margin-top:6px; font-family:'Newsreader',serif; font-style:italic; }
      .helper-msg hr{ border:none; border-top:1px solid rgba(0,0,0,0.12); margin:8px 0; }
      .helper-msg .katex{ font-size:1em; }
      .helper-msg .katex-display{ margin:6px 0; overflow-x:auto; overflow-y:hidden; }
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

    function setOpen(open) {
      document.getElementById('helperPanel').hidden = !open;
      var launcher = document.getElementById('hubHelperLauncher');
      if (launcher) launcher.classList.toggle('is-hidden', open);
      if (open) document.getElementById('helperInput').focus();
    }

    document.getElementById('helperRemove').addEventListener('click', () => setOpen(false));
    document.getElementById('helperClear').addEventListener('click', () => {
      const body = document.getElementById('helperBody');
      body.innerHTML = '';
      appendMsg('Chat cleared. Ask me a math question or about the exercise currently on screen.', 'bot');
    });
    document.getElementById('helperSend').addEventListener('click', sendMessage);
    document.getElementById('helperInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('helperShareScreen').addEventListener('click', toggleScreenShare);

    window._helperSetOpen = setOpen;
  }

  /* ---------------- opening/closing (no more floating circle — the 💬
     button in the top nav, wired up in nav.js, is the only way in) ---------------- */
  function isOpenNow() {
    var panel = document.getElementById('helperPanel');
    return !!panel && !panel.hidden;
  }

  function open() {
    ensureWidget();
    if (window._helperSetOpen) window._helperSetOpen(true);
  }

  function close() {
    if (activeShare) { try { activeShare.stop(); } catch (e) {} activeShare = null; }
    if (window._helperSetOpen) window._helperSetOpen(false);
  }

  function toggle() {
    if (isOpenNow()) close(); else open();
  }

  /* ---------------- screen sharing (with an admin, for support) ---------------- */
  let activeShare = null;

  async function toggleScreenShare() {
    const btn = document.getElementById('helperShareScreen');
    if (activeShare) {
      activeShare.stop();
      activeShare = null;
      btn.classList.remove('sharing');
      appendMsg('Screen share ended.', 'bot');
      return;
    }
    if (!window.ScreenShare || !window.ScreenShare.supported) {
      appendMsg("Screen sharing isn't supported in this browser.", 'bot');
      return;
    }
    try {
      appendMsg('Starting a screen share — pick a screen/window/tab in the browser prompt.', 'bot');
      activeShare = await window.ScreenShare.startHosting((state) => {
        if (state === 'connected') appendMsg('An admin has joined your screen share.', 'bot');
        if (state === 'ended' || state === 'failed' || state === 'disconnected') {
          btn.classList.remove('sharing');
          activeShare = null;
        }
      });
      btn.classList.add('sharing');
      appendMsg('Screen share started — code ' + activeShare.code + '. An admin has been notified and can join from their Admin panel. Tap the share icon again to stop.', 'bot');
    } catch (e) {
      appendMsg("Couldn't start screen sharing: " + e.message, 'bot');
    }
  }

  function appendMsg(text, who) {
    const body = document.getElementById('helperBody');
    const el = document.createElement('div');
    el.className = 'helper-msg helper-msg-' + who;
    if (who === 'bot') renderRichText(el, text);
    else el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  /* ---------------- rendering bot replies: light markdown + LaTeX ----------------
     The AI provider replies with markdown-ish text (**bold**, ### headings,
     `code`) and LaTeX math ($$...$$ / $...$). Previously this was dropped in
     as plain textContent, so people saw literal "$$" and "**" in the chat.
     This escapes the text first (never trusts it as HTML), applies a small
     set of markdown replacements, then hands off to KaTeX (loaded lazily,
     once) to typeset any math delimiters found. */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function markdownToHtml(raw) {
    let s = escapeHtml(raw);
    s = s.replace(/^### (.*)$/gm, '<strong class="helper-h3">$1</strong>')
         .replace(/^## (.*)$/gm, '<strong class="helper-h2">$1</strong>')
         .replace(/^# (.*)$/gm, '<strong class="helper-h1">$1</strong>')
         .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
         .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
         .replace(/`([^`]+)`/g, '<code>$1</code>')
         .replace(/^---+$/gm, '<hr>')
         .replace(/^\s*[-*]\s+(.*)$/gm, '• $1')
         .replace(/\n/g, '<br>');
    return s;
  }

  let katexLoading = null;
  function ensureKatexLoaded() {
    if (window.renderMathInElement) return Promise.resolve();
    if (katexLoading) return katexLoading;
    katexLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css';
      document.head.appendChild(css);
      const core = document.createElement('script');
      core.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js';
      core.onload = () => {
        const auto = document.createElement('script');
        auto.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js';
        auto.onload = resolve;
        auto.onerror = reject;
        document.body.appendChild(auto);
      };
      core.onerror = reject;
      document.body.appendChild(core);
    }).catch((e) => { katexLoading = null; throw e; });
    return katexLoading;
  }

  function renderRichText(el, text) {
    el.innerHTML = markdownToHtml(text);
    if (/\${1,2}[^$]+\${1,2}/.test(text)) {
      ensureKatexLoaded().then(() => {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false
        });
      }).catch(() => { /* math just stays as plain text if KaTeX can't load — still readable */ });
    }
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const token = getToken();
      const res = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: JSON.stringify({ message: msg, screenContext: readScreenContext() }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      let data = {};
      try { data = await res.json(); } catch (e) { /* non-JSON error body, e.g. a bare 502 from the platform */ }
      const replyText = res.ok && data.reply ? data.reply : (data.error || ("Sorry, I couldn't reach the study helper (status " + res.status + "). Try again in a moment."));
      renderRichText(thinking, replyText);
    } catch (e) {
      clearTimeout(timeoutId);
      renderRichText(thinking, e.name === 'AbortError'
        ? "That took too long to answer — try a shorter or simpler question."
        : "Sorry, something went wrong reaching the study helper.");
    }
  }

  window.StudyHelper = { init: ensureWidget, open: open, close: close, toggle: toggle, isOpen: isOpenNow };
})();
