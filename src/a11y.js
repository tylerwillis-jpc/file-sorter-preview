/* JPC File Sorter · a11y.js
 * Small accessibility helpers shared by the app shell and the tour: focus trap, focus return,
 * and the live-region announcer. No app state in here.
 */

// ---------- Input modality ----------
// Focus is only handed back to the opening control after keyboard use. After a mouse click the app
// deliberately leaves focus on the page, so Enter goes back to "accept the suggestion" (see app.js).
let modality = 'pointer';
export function initA11y() {
  document.addEventListener('keydown', () => { modality = 'key'; }, true);
  document.addEventListener('pointerdown', () => { modality = 'pointer'; }, true);
  // A click with detail 0 came from the keyboard or assistive technology, not a mouse.
  document.addEventListener('click', (e) => { modality = e.detail === 0 ? 'key' : 'pointer'; }, true);
}

// ---------- Focus ----------
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
/** Tabbable, visible, enabled controls inside root, in DOM order. */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getAttribute('aria-disabled') !== 'true' && visible(el));
}

/** Keep Tab / Shift+Tab inside root. Call from a keydown handler. Returns true if it handled the key. */
export function trapTab(e, root) {
  if (e.key !== 'Tab' || !root) return false;
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); return true; }
  const first = list[0], last = list[list.length - 1];
  const a = document.activeElement;
  if (!root.contains(a)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  return true;
}

/** If focus has escaped root (e.g. a click on the page behind), pull it back in. */
export function keepFocusIn(root) {
  if (root && document.activeElement && document.activeElement !== document.body && !root.contains(document.activeElement)) {
    (focusables(root)[0] || root).focus({ preventScroll: true });
  }
}

const attr = (v) => String(v).replace(/["\\]/g, '\\$&');
/** A selector that finds the same control again after the page has been redrawn. */
function selectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const d = el.dataset || {};
  if (!d.act) return null;
  return `[data-act="${attr(d.act)}"]` + (d.val !== undefined ? `[data-val="${attr(d.val)}"]` : '') + (d.key !== undefined ? `[data-key="${attr(d.key)}"]` : '');
}

/** Remember the control that opened a dialog or menu (keyboard use only). Pass the result to restoreFocus later. */
export function captureOpener() {
  if (modality !== 'key') return null;
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { el, sel: selectorFor(el) };
}

/** Put focus back on the opener, but only if nothing else has taken focus in the meantime. Deferred so a redraw can finish first.
 *  If the opener was redrawn away and can't be found again, falls back to the `fallback` selector (e.g. the decision panel heading). */
export function restoreFocus(op, fallback) {
  if (!op) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body) return;
    let el = op.el.isConnected ? op.el : (op.sel && document.querySelector(op.sel));
    if (!el || !visible(el)) el = fallback && document.querySelector(fallback);
    if (el && visible(el)) el.focus({ preventScroll: true });
  }, 0);
}

// ---------- Live region ----------
// Two regions live in index.html outside #app (so redraws never remove them): polite for normal
// announcements, assertive for save errors only. Keep messages short.
function say(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  // Clearing first means the same sentence twice in a row is still spoken.
  setTimeout(() => { el.textContent = text; }, 40);
}
/** announce('Sorted to X.') is polite; announce(text, { assertive: true }) goes to the alert region (save errors only). */
export function announce(text, { assertive = false } = {}) { say(assertive ? 'sr-alert' : 'sr-live', text); }
