// qr-scan.js — opens the device camera in a small modal, decodes any QR
// code pointed at it (using jsQR, loaded lazily so pages that never scan
// don't pay for it), and hands the decoded text back to the caller. No
// server round-trip — decoding happens entirely in the browser.
(function () {
  let jsQRLoaded = false;
  // Two CDN mirrors, tried in order — cdnjs curated its library list a
  // while back and no longer carries jsQR, so jsDelivr (which mirrors npm
  // directly) is primary; unpkg is the fallback if jsDelivr is ever
  // unreachable on someone's network.
  const JSQR_SOURCES = [
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
    'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'
  ];
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed: ' + src));
      document.head.appendChild(s);
    });
  }
  async function loadJsQR() {
    if (jsQRLoaded || window.jsQR) { jsQRLoaded = true; return; }
    let lastErr;
    for (const src of JSQR_SOURCES) {
      try { await loadScript(src); jsQRLoaded = true; return; }
      catch (e) { lastErr = e; }
    }
    throw new Error('Could not load the QR scanner library.');
  }

  function ensureStyle() {
    if (document.getElementById('qrScanStyle')) return;
    const style = document.createElement('style');
    style.id = 'qrScanStyle';
    style.textContent = `
      #qrScanOverlay{
        position:fixed; inset:0; z-index:500; background:rgba(0,0,0,0.72);
        display:flex; align-items:center; justify-content:center; padding:20px;
      }
      #qrScanBox{
        background:var(--panel,#fff); border-radius:14px; overflow:hidden; width:100%;
        max-width:360px; box-shadow:0 20px 50px rgba(0,0,0,0.35);
      }
      #qrScanHead{
        display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
        font-family:'JetBrains Mono',monospace; font-size:12.5px; color:var(--ink,#1E2A4A);
        border-bottom:1px solid var(--grid,#ddd);
      }
      #qrScanHead button{ background:none; border:none; font-size:16px; cursor:pointer; color:var(--muted,#8A8880); }
      #qrScanVideoWrap{ position:relative; background:#000; aspect-ratio:1/1; }
      #qrScanVideoWrap video{ width:100%; height:100%; object-fit:cover; display:block; }
      #qrScanReticle{
        position:absolute; inset:14%; border:2.5px solid rgba(255,255,255,0.85); border-radius:14px;
        box-shadow:0 0 0 999px rgba(0,0,0,0.28); pointer-events:none;
      }
      #qrScanStatus{ padding:10px 14px; font-size:12.5px; color:var(--muted,#8A8880); font-family:'Inter',sans-serif; text-align:center; }
      #qrScanStatus.err{ color:var(--red,#B23A2E); }
    `;
    document.head.appendChild(style);
  }

  // Pulls a share code out of either a bare code ("ABCD1234") or a full
  // redeem URL (".../redeem.html?code=ABCD1234") — whichever the QR
  // happened to encode.
  function extractCode(text) {
    try {
      const u = new URL(text);
      const c = u.searchParams.get('code');
      if (c) return c.toUpperCase();
    } catch (e) { /* not a URL — fall through to treating it as a raw code */ }
    return text.trim().toUpperCase();
  }

  let stream = null;

  function stop() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const overlay = document.getElementById('qrScanOverlay');
    if (overlay) overlay.remove();
  }

  // open({ onResult, onCancel }) — shows the camera modal. onResult(code)
  // fires once with the decoded text (already run through extractCode);
  // onCancel() fires if the user closes the modal without a match.
  async function open(opts) {
    opts = opts || {};
    ensureStyle();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (opts.onError) opts.onError(new Error('Camera access is not supported in this browser.'));
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'qrScanOverlay';
    overlay.innerHTML = `
      <div id="qrScanBox">
        <div id="qrScanHead"><span>Scan a QR code</span><button id="qrScanClose" aria-label="Cancel">✕</button></div>
        <div id="qrScanVideoWrap"><video id="qrScanVideo" playsinline muted></video><div id="qrScanReticle"></div></div>
        <div id="qrScanStatus">Point your camera at a QR code…</div>
      </div>
    `;
    document.body.appendChild(overlay);
    const statusEl = document.getElementById('qrScanStatus');
    document.getElementById('qrScanClose').addEventListener('click', () => { stop(); if (opts.onCancel) opts.onCancel(); });

    try {
      await loadJsQR();
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.classList.add('err');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    } catch (e) {
      statusEl.textContent = "Couldn't access the camera — check permissions and that the site is loaded over HTTPS.";
      statusEl.classList.add('err');
      return;
    }

    const video = document.getElementById('qrScanVideo');
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let done = false;

    function tick() {
      if (done || !document.getElementById('qrScanOverlay')) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const match = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (match && match.data) {
          done = true;
          const code = extractCode(match.data);
          stop();
          if (opts.onResult) opts.onResult(code);
          return;
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  window.QRScan = { open, stop };
})();
