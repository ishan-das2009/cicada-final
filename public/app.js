// Client is presentation only. The server owns attempts, validation and lockout.
const $ = s => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, reduce ? 0 : ms));

// ---- Stage registry: add a new round by adding a section + entry here ----
const stages = ['intro', 'round', 'granted', 'dead', 'unavail'];
function show(name) {
  for (const s of stages) $('#' + s).hidden = s !== name;
  document.body.classList.toggle('dead', name === 'dead');
  const el = $('#' + name);
  el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
}

// ---- Opening sequence ----
async function intro() {
  show('intro');
  const el = $('#intro');
  const lines = [['CONGRATULATIONS.', 'big hot'], ['You have completed the previous 6 steps.', ''], ['This is the final step.', '']];
  el.innerHTML = '';
  let skip = false;
  const skipper = () => (skip = true);
  addEventListener('keydown', skipper, { once: true });
  addEventListener('pointerdown', skipper, { once: true });
  await wait(1400);
  for (const [t, c] of lines) {
    if (skip) break;
    const p = document.createElement('p');
    p.className = c; p.textContent = t; el.append(p);
    await wait(60); p.classList.add('on');
    await wait(2600);
  }
  await wait(900);
}

// ---- Gallery: order is fixed here, not by filename sorting ----
const PLATE_ORDER = [21, 14, 9, 20, 25];
function gallery() {
  const ul = $('#plates');
  ul.innerHTML = '';
  for (const n of PLATE_ORDER) {
    const li = document.createElement('li');
    const img = new Image();
    img.src = `plates/ishihara-plate-${n}.png`;
    img.alt = 'A field of coloured dots';
    img.decoding = 'async';
    li.append(img); ul.append(li);
  }
  // rare one-frame interference on a random plate
  if (!reduce) setInterval(() => {
    if ($('#round').hidden || Math.random() > .3) return;
    const li = ul.children[Math.floor(Math.random() * ul.children.length)];
    li.classList.add('jit'); setTimeout(() => li.classList.remove('jit'), 70);
  }, 6000);
}

// ---- API ----
const api = {
  state: () => fetch('/api/state').then(r => r.json()),
  submit: response => fetch('/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response })
  }).then(r => r.json()),
};

const setLeft = n => ($('#n').textContent = n);
function say(t, err) { const m = $('#msg'); m.textContent = t; m.className = err ? 'err' : ''; }

async function grant(next) {
  const input = $('#resp'); input.disabled = true;
  document.body.classList.add('freeze');
  await wait(900);
  document.body.classList.remove('freeze');
  document.body.classList.add('static');
  await wait(600);
  document.body.classList.remove('static');
  $('#g-title').textContent = next.title;
  $('#g-body').textContent = next.body;
  show('granted');
}
const terminate = () => show('dead');

function round(state) {
  show('round');
  setLeft(state.remaining);
  const form = $('#form'), input = $('#resp');
  input.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v || input.disabled) return;
    input.disabled = true;
    let r;
    try { r = await api.submit(v); } catch { say('NO SIGNAL', true); input.disabled = false; return; }
    if (r.result === 'unavailable' || r.result === 'error') return show('unavail');
    if (r.result === 'throttled') { say('...', true); input.disabled = false; return; }
    setLeft(r.remaining);
    if (r.result === 'correct') return grant(r.next);
    if (r.result === 'locked') { $('#plates').classList.add('fade'); say('RESPONSE REJECTED', true); await wait(1500); return terminate(); }
    say('RESPONSE REJECTED', true);
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    input.value = ''; input.disabled = false; input.focus();
  };
}

// ---- Optional audio: user-initiated, off by default ----
let ac, master;
$('#snd').onclick = e => {
  const b = e.currentTarget;
  if (!ac) {
    ac = new AudioContext(); master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
    const hum = ac.createOscillator(); hum.frequency.value = 50; const hg = ac.createGain(); hg.gain.value = .05;
    hum.connect(hg).connect(master); hum.start();
    const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * .5;
    const noise = ac.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = .5;
    const ng = ac.createGain(); ng.gain.value = .015;
    noise.connect(f).connect(ng).connect(master); noise.start();
  }
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on); b.textContent = on ? 'SND ON' : 'SND OFF';
  ac.resume(); master.gain.setTargetAtTime(on ? .6 : 0, ac.currentTime, .3);
};

// ---- Boot ----
(async () => {
  const st = await api.state();
  if (st.status === 'unavailable' || st.status === 'error') return show('unavail');
  if (st.status === 'locked') return terminate();
  gallery();
  if (st.status === 'solved') { $('#g-title').textContent = st.next.title; $('#g-body').textContent = st.next.body; return show('granted'); }
  await intro();
  round(st);
})();
