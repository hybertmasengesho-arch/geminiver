/* file-input-enhance.js
   Auto-wraps every plain <input type="file"> on the page with the shared
   "+" picker button and a filename display to its right (see
   .upload-picker-label / .upload-picked-name in theme.css). Include this
   script once per page (after nav.js is fine) and every file input —
   present now or added later — gets the same look with no per-page markup.

   Skips inputs that are:
   - already wrapped (e.g. files.html's hand-built picker)
   - marked data-no-enhance
   - intentionally hidden (e.g. matrix.html's JSON-import trigger input,
     which a styled button opens programmatically via .click())
*/
(function () {
  function isHidden(input) {
    if (input.hidden) return true;
    if (input.style && input.style.display === 'none') return true;
    var attr = (input.getAttribute('style') || '');
    return /display\s*:\s*none/i.test(attr);
  }

  function labelText(count) {
    if (count === 0) return 'No file chosen';
    if (count === 1) return null; // filled in with the actual filename by the caller
    return count + ' files selected';
  }

  function enhance(input) {
    if (input.dataset.enhanced === '1') return;
    if (input.hasAttribute('data-no-enhance')) return;
    if (input.closest('.upload-picker-label')) return; // already using the shared pattern
    if (isHidden(input)) return;

    var row = document.createElement('div');
    row.className = 'upload-picker-row';

    var label = document.createElement('label');
    label.className = 'upload-picker-label';
    if (input.id) label.setAttribute('for', input.id);
    label.innerHTML = '<span class="upload-plus" aria-hidden="true">+</span>';
    label.title = input.title || 'Choose a file';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'upload-picked-name';
    nameSpan.textContent = 'No file chosen';

    input.parentNode.insertBefore(row, input);
    label.appendChild(input); // moves the input into the label
    row.appendChild(label);
    row.appendChild(nameSpan);

    input.addEventListener('change', function () {
      var files = input.files || [];
      var single = labelText(files.length);
      nameSpan.textContent = single === null ? files[0].name : single;
    });

    input.dataset.enhanced = '1';
  }

  function run() {
    document.querySelectorAll('input[type="file"]').forEach(enhance);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  // Exposed in case a page renders file inputs dynamically after load
  // (e.g. content.html's book detail panel) and wants to (re)scan.
  window.rhEnhanceFileInputs = run;
})();
