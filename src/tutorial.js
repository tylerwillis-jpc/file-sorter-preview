/* JPC File Sorter · v0.2.2-beta · tutorial.js
 * First-run tour with coach marks: dims the page, spotlights the element being explained
 * with a blue ring, and places a step card beside it. Keys: → / Enter next, ← back, Esc skip.
 */
import { esc } from './util.js';

const kc = (k, wide) => `<span class="kc ${wide ? 'wide' : ''}">${k}</span>`;
let active = null;
let endedAt = 0;
// Treat the tour as still active for a moment after it closes, so a double-pressed Enter can't record a decision.
export const tourActive = () => !!active || Date.now() - endedAt < 400;

function steps(ctx) {
  return [
    { center: true, eyebrow: 'Welcome', title: 'Welcome to File Sorter', body: `
      <p>The goal: one copy of every file, sorted into the right top-level folder of ${esc(ctx.propertyName)}.</p>
      <p>This is the beta. <b>Test mode is on</b>, so nothing on SharePoint is moved or deleted. Every decision goes to a test spreadsheet.</p>
      <p>This 2-minute tour walks through each part of the screen, in the order you'll use it. You can replay it any time with the <b>?</b> button in the top bar.</p>
      <div class="ver">Version ${esc(ctx.version)}</div>`, next: 'Start the tour' },
    { target: '[data-tour="view"]', title: 'Sort, Review and Issues', body: `
      <ul><li><b>Sort</b> is where you decide, one file at a time.</li><li><b>Review</b> shows what the cleanup would do with everyone's decisions. Nothing is performed.</li><li><b>Issues</b> lists the problems and ideas reported during testing.</li></ul>` },
    { target: '[data-tour="source"]', title: 'Remaining and Unsure', body: `
      <p><b>Remaining</b> is the shared pile of unsorted files. Everyone pulls the next one at their own pace.</p>
      <p><b>Unsure</b> holds the hard ones anyone has parked. Switch here to work through them.</p>` },
    { target: '[data-tour="file"]', title: 'The file and preview', body: `
      <p>The file name, size and a small preview. The next files are pre-loaded so each one appears instantly.</p>
      <p>Need a closer look? <b>Open full file</b> opens it in a new tab.</p>` },
    { target: '[data-tour="copies"]', title: 'Copies and the kept copy', body: `
      <p>Every place a copy of this file lives. <b>One decision covers all of them.</b></p>
      <p>One copy is kept. The others go to <b>Duplicate Hold</b>, not deleted, with a shortcut left behind.</p>
      <p>The kept copy is picked automatically, so checking it is optional.</p>` },
    { target: '[data-tour="mode"]', title: 'Pick a selection mode', body: `
      <ul><li><b>Suggestion:</b> Claude's pick plus two alternatives. Best while you're learning.</li>
      <li><b>Keypad:</b> the 9 most likely folders on a number pad. Each folder keeps its number, so you get faster with practice.</li></ul>
      <p>You can switch any time. Your choice is remembered.</p>` },
    { target: '[data-tour="decision"]', title: 'Sort by click or key', body: `
      <div class="keys">${kc('Enter', 1)}<span>Accept Claude's suggestion</span>${kc('1')}<span>${kc('2')} pick an alternative (Keypad: ${kc('1')}–${kc('9')})</span>${kc('/')}<span>Open all folders, then type to filter</span></div>
      <p>Every button shows its key, so you can click or type, whichever is faster.</p>` },
    { target: '[data-tour="unsure-undo"]', title: 'Unsure and Undo', body: `
      <div class="keys">${kc('.')}<span>Send the file to the Unsure pile</span>${kc('0')}<span>Undo your last decision. It only undoes your own, and the file comes back on screen.</span></div>` },
    { target: '[data-tour="keyboard"]', title: 'Keyboard and number pad', body: `
      <p>Keys work anywhere on the page as soon as the app opens. No need to click first. The number pad works too.</p>
      <p>While you're typing in a box (like a note with ${kc('N')}), keys pause and the light turns amber.</p>` },
    { target: '[data-tour="report"]', title: 'Report issue', body: `
      <p>Something odd, confusing, or a good idea? Click <b>Report issue</b>, pick Bug, Confusing or Idea, and say what happened.</p>
      <p>Issues are saved on the <b>Issues</b> tab. To send them to TW, click <b>Export issues</b> there and email the file to TW.</p>` },
    { center: true, eyebrow: 'Your workflow', title: 'Ready to sort', body: `
      <ol class="workflow"><li>Check your profile (top right)</li><li>Pick a selection mode</li><li>Sort from Remaining</li><li>Send hard files to Unsure</li><li>TW or KB check Review and sign off</li></ol>`, next: 'Start sorting' },
  ];
}

export function startTour(ctx) {
  endTour(null);
  const list = steps(ctx);
  active = { ctx, list, i: ctx.startAt || 0 };
  const blocker = document.createElement('div');
  blocker.className = 'tour-dim spot';
  const ring = document.createElement('div');
  ring.className = 'tour-ring';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  document.body.append(blocker, ring, card);
  Object.assign(active, { blocker, ring, card });
  card.addEventListener('click', onCardClick);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  show();
}

function show() {
  const { list, i, card, ctx } = active;
  const st = list[i];
  const total = list.length;
  const tourSteps = total - 2; // welcome + summary aren't numbered
  const eyebrow = st.eyebrow || `Step ${i} of ${tourSteps}`;
  card.innerHTML = `
    <div class="eyebrow"><span>${esc(eyebrow)}</span><button class="skip" data-t="skip">Skip tour</button></div>
    <h2>${esc(st.title)}</h2>${st.body}
    <div class="foot"><div class="dots">${list.map((_, k) => `<i class="${k === i ? 'cur' : k < i ? 'done' : ''}"></i>`).join('')}</div>
      ${i > 0 ? '<button class="btn" data-t="back">Back</button>' : ''}
      <button class="btn primary" data-t="next">${esc(st.next || 'Next')}</button></div>`;
  place();
  card.querySelector('[data-t="next"]')?.focus({ preventScroll: true });
}

function place() {
  if (!active) return;
  const { list, i, card, ring, blocker } = active;
  const st = list[i];
  document.querySelectorAll('.tour-lift').forEach((n) => n.classList.remove('tour-lift'));
  const target = st.target && document.querySelector(st.target);
  if (!target) {
    ring.style.display = 'none';
    blocker.classList.remove('spot');
    card.className = 'tour-card center';
    card.style.left = card.style.top = '';
    return;
  }
  target.scrollIntoView({ block: 'nearest' });
  target.classList.add('tour-lift');
  blocker.classList.add('spot');
  const r = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(ring.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  card.className = 'tour-card';
  const cw = card.offsetWidth, ch = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 18;
  // Prefer the side with the most room, so the card never covers the target.
  const room = { below: vh - r.bottom, above: r.top, right: vw - r.right, left: r.left };
  let x, y;
  if (room.below >= ch + gap) { y = r.bottom + gap; x = r.left + r.width / 2 - cw / 2; }
  else if (room.right >= cw + gap) { x = r.right + gap; y = r.top; }
  else if (room.left >= cw + gap) { x = r.left - cw - gap; y = r.top; }
  else if (room.above >= ch + gap) { y = r.top - ch - gap; x = r.left + r.width / 2 - cw / 2; }
  else { x = 16; y = vh - ch - 16; }
  x = Math.max(16, Math.min(vw - cw - 16, x));
  y = Math.max(16, Math.min(vh - ch - 16, y));
  card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.transform = 'none';
}

function go(delta) {
  const { list } = active;
  const next = active.i + delta;
  if (next >= list.length) return endTour('finished');
  if (next < 0) return;
  active.i = next;
  show();
}

function onCardClick(e) {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  const t = b.dataset.t;
  if (t === 'next') go(1);
  else if (t === 'back') go(-1);
  else if (t === 'skip') endTour('skipped');
}

function onKey(e) {
  if (!active) return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'Enter') { e.preventDefault(); e.stopPropagation(); go(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
  else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour('skipped'); }
  else if (k !== 'Tab') { e.stopPropagation(); }
}

function endTour(how) {
  if (!active) return;
  const { blocker, ring, card, ctx } = active;
  blocker.remove(); ring.remove(); card.remove();
  document.querySelectorAll('.tour-lift').forEach((n) => n.classList.remove('tour-lift'));
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  active = null;
  endedAt = Date.now();
  if (how) ctx.finish(how);
}

/** One-card mini-tip the first time someone switches to Keypad mode. */
export function maybeKeypadTip(learningFiles) {
  const target = document.querySelector('#keypad');
  if (!target || active) return;
  const ctx = { version: '', propertyName: '', finish() {} };
  active = null;
  startTour({ ...ctx, startAt: 0 });
  active.list = [{ target: '#keypad', eyebrow: 'Keypad tip', title: 'Numbers that stay put', body: `
    <p>Each folder gets a <b>home number</b> the first time it appears, and goes back to it every time. That's how you build muscle memory.</p>
    <p>If a folder's own key is busy, it sits on a <b>spare key</b> for that file only.</p>
    <p>For your first ${learningFiles} files the numbers are still learning. Then your 9 most-used folders lock to their keys.</p>`, next: 'Got it' }];
  active.i = 0;
  show();
  active.card.querySelector('.dots').innerHTML = '';
  active.card.querySelector('[data-t="back"]')?.remove();
}
