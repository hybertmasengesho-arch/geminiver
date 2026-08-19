// toast.js — a small, dependency-free replacement for window.alert().
// Include this on any page and call showToast(message, type) instead of
// alert(message). type is 'success' | 'error' | 'info' (default 'info').
// Stacks bottom-left so it never collides with the top-right message
// notifications nav.js already renders.
(function () {
  function ensureWrap() {
    var wrap = document.getElementById('rhToastWrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'rhToastWrap';
    wrap.className = 'rh-toast-wrap';
    document.body.appendChild(wrap);
    return wrap;
  }

  function showToast(message, type) {
    type = type === 'success' || type === 'error' ? type : 'info';
    var wrap = ensureWrap();
    var el = document.createElement('div');
    el.className = 'rh-toast rh-toast-' + type;
    var icon = type === 'success' ? '✓' : (type === 'error' ? '✕' : 'ℹ');
    el.innerHTML =
      '<span class="rh-toast-icon">' + icon + '</span>' +
      '<span class="rh-toast-msg"></span>' +
      '<button class="rh-toast-close" aria-label="Dismiss">✕</button>';
    el.querySelector('.rh-toast-msg').textContent = message; // textContent, never innerHTML — message text is often server-supplied
    function remove() { el.classList.add('rh-toast-out'); setTimeout(function () { el.remove(); }, 160); }
    el.querySelector('.rh-toast-close').addEventListener('click', remove);
    wrap.appendChild(el);
    // Force a reflow so the enter transition actually plays instead of
    // the toast just appearing already in its final state.
    void el.offsetWidth;
    el.classList.add('rh-toast-in');
    setTimeout(remove, type === 'error' ? 6000 : 4000);
  }

  window.showToast = showToast;
})();
