const $ = (id) => document.getElementById(id);
const statusEl = $('status'), inBtn = $('in'), outBtn = $('out'), sideBtn = $('side');
const sliders = ['hiss', 'wobble', 'warmth', 'volume'].map($);
const reels = [$('reelL'), $('reelR')];

const PRESETS = { A: { hiss: 40, wobble: 35, warmth: 50 }, B: { hiss: 65, wobble: 70, warmth: 75 } };

let tab = null, activeTabId, settings;
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

function note(text, err) { statusEl.textContent = text; statusEl.classList.toggle('status-err', !!err); }

function render() {
  const here = activeTabId !== undefined && activeTabId === tab.id;
  inBtn.setAttribute('aria-checked', here); outBtn.setAttribute('aria-checked', !here);
  if (here) note(playing ? '♪ playing on tape' : 'tape in… waiting for sound');
  else if (activeTabId !== undefined) note('playing in another tab — IN to move here');
  else note('click IN to play this tab on tape');
}

function fill(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); }

function showSettings() {
  sliders.forEach((s) => { s.value = settings[s.id]; fill(s); });
  sideBtn.textContent = settings.side;
}

let saveT;
function push() {
  send({ target: 'offscreen', type: 'set', settings });
  clearTimeout(saveT); saveT = setTimeout(() => chrome.storage.local.set(settings), 200);
}

sliders.forEach((s) => (s.oninput = () => { settings[s.id] = Number(s.value); fill(s); push(); }));

sideBtn.onclick = () => {
  settings.side = settings.side === 'A' ? 'B' : 'A';
  Object.assign(settings, PRESETS[settings.side]);
  sideBtn.classList.add('flip');
  setTimeout(() => { showSettings(); sideBtn.classList.remove('flip'); }, 180);
  push();
};

inBtn.onclick = async () => {
  if (activeTabId === tab.id) return;
  inBtn.disabled = outBtn.disabled = true;
  try {
    note('loading tape…');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await send({ target: 'background', type: 'start', tabId: tab.id, streamId });
    if (!res || !res.ok) throw new Error((res && res.error) || 'could not start');
    activeTabId = tab.id;
    render();
  } catch (e) {
    const m = String(e.message || e);
    if (/chrome:\/\/|Chrome pages|webstore/i.test(m)) note("can't play Chrome's own pages", true);
    else if (/active stream|already being captured/i.test(m)) note('another extension is using this tab', true);
    else note(m.toLowerCase(), true);
  } finally { inBtn.disabled = outBtn.disabled = false; }
};

outBtn.onclick = async () => {
  if (activeTabId !== tab.id) return;
  await send({ target: 'background', type: 'stop' });
  activeTabId = undefined; playing = false; render();
};

// ---- Reels: spin up when sound plays, coast down when it stops ----
let angle = 0, speed = 0, playing = false, last = performance.now(), wob = 0;
const MAX = 150; // degrees per second, roughly a real cassette hub at 1⅞ ips
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const target = playing ? MAX : 0;
  speed += (target - speed) * Math.min(1, dt * (playing ? 3.5 : 1.8));
  wob += dt;
  const flutter = playing ? 1 + Math.sin(wob * 2.1) * 0.03 * (settings ? settings.wobble / 100 : 0) : 1;
  angle = (angle + speed * flutter * dt) % 360;
  reels[0].setAttribute('transform', `rotate(${angle})`);
  reels[1].setAttribute('transform', `rotate(${angle * 0.82 + 17})`); // take-up reel turns at a slightly different rate
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let demo = false;
async function poll() {
  if (demo) return setTimeout(poll, 120);
  if (activeTabId !== undefined && activeTabId === tab.id) {
    const r = await send({ target: 'offscreen', type: 'level' });
    const was = playing;
    playing = !!(r && r.ok && r.level > 1e-4);
    if (was !== playing) render();
  } else playing = false;
  setTimeout(poll, 120);
}

// hooks used only to make README screenshots
window.__demo = (on, a) => { demo = true; playing = on; if (a !== undefined) { angle = a; speed = on ? MAX : 0; } activeTabId = on ? tab.id : undefined; render(); };

(async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await chrome.storage.local.get({ hiss: 40, wobble: 35, warmth: 50, volume: 70, side: 'A' });
  showSettings();
  activeTabId = (await chrome.storage.session.get('tabId')).tabId;
  render(); poll();
})();
