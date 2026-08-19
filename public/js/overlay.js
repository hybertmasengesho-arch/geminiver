// overlay.js — a small, reusable full-screen animated overlay used for
// moments that deserve a bit of ceremony: generating/scanning a QR code
// ("Cortex Authentication") and creating a team ("Build Your Team"). Pure
// visual flourish — never blocks on anything longer than the caller's own
// await, and always has a safety-net auto-hide so it can never get stuck
// covering the screen if something throws.
(function () {
  var AUTO_HIDE_MS = 6000; // safety net only — callers should call hide() themselves
  var hideTimer = null;

  function ensure() {
    if (document.getElementById('hubOverlayRoot')) return;

    var style = document.createElement('style');
    style.id = 'hubOverlayStyle';
    style.textContent = `
      #hubOverlayRoot{
        position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center;
        background:rgba(8,10,16,0.72); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
        opacity:0; pointer-events:none; transition:opacity .22s ease;
        font-family:'Inter',sans-serif;
      }
      #hubOverlayRoot.open{ opacity:1; pointer-events:all; }
      .hub-overlay-box{ text-align:center; padding:0 20px; }
      .hub-overlay-rings{ position:relative; width:104px; height:104px; margin:0 auto 22px; }
      .hub-overlay-rings .ring{
        position:absolute; inset:0; border-radius:50%;
        border:1.5px solid rgba(120,170,255,0.55);
        animation:hubRingPulse 1.8s cubic-bezier(.4,0,.2,1) infinite;
      }
      .hub-overlay-rings .ring:nth-child(2){ animation-delay:.5s; }
      .hub-overlay-rings .ring:nth-child(3){ animation-delay:1s; }
      .hub-overlay-core{
        position:absolute; inset:38px; border-radius:50%;
        background:radial-gradient(circle at 35% 30%, #9fc2ff, #4c8df6 60%, #2a5dc4);
        box-shadow:0 0 26px rgba(76,141,246,0.75);
        animation:hubCoreSpin 2.4s linear infinite;
      }
      .hub-overlay-core::before{
        content:''; position:absolute; inset:5px; border-radius:50%;
        border:1.5px dashed rgba(255,255,255,0.55);
      }
      @keyframes hubRingPulse{
        0%{ transform:scale(.55); opacity:0; }
        35%{ opacity:.9; }
        100%{ transform:scale(1); opacity:0; }
      }
      @keyframes hubCoreSpin{ from{ transform:rotate(0deg); } to{ transform:rotate(360deg); } }
      .hub-overlay-title{
        font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:700; letter-spacing:.16em;
        text-transform:uppercase; color:#eaf1ff; margin-bottom:6px;
      }
      .hub-overlay-title::after{
        content:''; display:inline-block; width:6px; height:6px; margin-left:3px; border-radius:50%;
        background:#4c8df6; animation:hubDotBlink 1.1s ease-in-out infinite;
      }
      @keyframes hubDotBlink{ 0%,100%{ opacity:.2; } 50%{ opacity:1; } }
      .hub-overlay-sub{ font-size:12.5px; color:rgba(234,241,255,0.65); max-width:280px; margin:0 auto; }
    `;
    document.head.appendChild(style);

    var root = document.createElement('div');
    root.id = 'hubOverlayRoot';
    root.innerHTML =
      '<div class="hub-overlay-box">' +
        '<div class="hub-overlay-rings">' +
          '<div class="ring"></div><div class="ring"></div><div class="ring"></div>' +
          '<div class="hub-overlay-core"></div>' +
        '</div>' +
        '<div class="hub-overlay-title" id="hubOverlayTitle"></div>' +
        '<div class="hub-overlay-sub" id="hubOverlaySub"></div>' +
      '</div>';
    document.body.appendChild(root);
  }

  function show(title, sub) {
    ensure();
    document.getElementById('hubOverlayTitle').textContent = title || '';
    document.getElementById('hubOverlaySub').textContent = sub || '';
    document.getElementById('hubOverlayRoot').classList.add('open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, AUTO_HIDE_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    var root = document.getElementById('hubOverlayRoot');
    if (root) root.classList.remove('open');
  }

  // Convenience: show the overlay for at least minMs even if the promise
  // resolves faster, so it doesn't flash by unreadably; always hides
  // afterward (success or failure) and re-throws any error to the caller.
  function during(title, sub, promise, minMs) {
    var started = Date.now();
    show(title, sub);
    return Promise.resolve(promise).then(
      function (val) {
        var wait = Math.max(0, (minMs || 500) - (Date.now() - started));
        return new Promise(function (resolve) { setTimeout(function () { hide(); resolve(val); }, wait); });
      },
      function (err) {
        var wait = Math.max(0, (minMs || 300) - (Date.now() - started));
        return new Promise(function (resolve, reject) { setTimeout(function () { hide(); reject(err); }, wait); });
      }
    );
  }

  window.HubOverlay = { show: show, hide: hide, during: during };
})();
