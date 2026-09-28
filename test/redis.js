// npm run test:redis — needs a local `redis-server` binary. Runs the REAL server against a REAL Redis (real Lua, real atomicity)
// through a tiny proxy that speaks Upstash's REST shape (POST [command...] -> {"result":...}, Bearer auth).
const { spawn, spawnSync } = require('child_process'), http = require('http'), net = require('net'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..'), PORT = 3622, UP = 3621, RP = 6391, B = `http://localhost:${PORT}`, TOKEN = 'test-token';
const SALT = 'test-salt', DIG = crypto.scryptSync('unity', SALT, 32).toString('hex'), SECRET = crypto.randomBytes(32).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, proxy, srv, rproc;
const ok = (n, c, note = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${note ? '  [' + note + ']' : ''}`); };

// --- minimal RESP client + Upstash-shaped proxy ---
const enc = a => Buffer.concat([Buffer.from(`*${a.length}\r\n`), ...a.map(x => { x = String(x); return Buffer.from(`$${Buffer.byteLength(x)}\r\n${x}\r\n`); })]);
function parse(b, i = 0) {
  const e = b.indexOf('\r\n', i); if (e < 0) return null; const t = String.fromCharCode(b[i]), line = b.toString('utf8', i + 1, e), n = e + 2;
  if (t === '+') return [line, n]; if (t === '-') return [{ error: line }, n]; if (t === ':') return [+line, n];
  if (t === '$') { const l = +line; if (l < 0) return [null, n]; return b.length < n + l + 2 ? null : [b.toString('utf8', n, n + l), n + l + 2]; }
  if (t === '*') { let p = n; const arr = []; for (let k = 0; k < +line; k++) { const r = parse(b, p); if (!r) return null; arr.push(r[0]); p = r[1]; } return [arr, p]; }
}
const rcmd = cmd => new Promise((res, rej) => { const s = net.connect(RP, '127.0.0.1'); let buf = Buffer.alloc(0);
  s.on('data', d => { buf = Buffer.concat([buf, d]); const r = parse(buf); if (r) { s.end(); res(r[0]); } }); s.on('error', rej); s.write(enc(cmd)); });
const startProxy = () => new Promise(r => { proxy = http.createServer(async (q, s) => {
  if (q.headers.authorization !== 'Bearer ' + TOKEN) { s.statusCode = 401; return s.end('{"error":"unauthorized"}'); }
  let b = ''; for await (const c of q) b += c;
  try { const out = await rcmd(JSON.parse(b)); s.setHeader('content-type', 'application/json');
    if (out && out.error) { s.statusCode = 400; return s.end(JSON.stringify({ error: out.error })); } s.end(JSON.stringify({ result: out })); }
  catch { s.statusCode = 500; s.end('{"error":"x"}'); } }).listen(UP, r); });
const stopProxy = async () => { proxy.closeAllConnections?.(); await new Promise(r => proxy.close(r)); };

const env = { ...process.env, PORT, THROTTLE_MS: '0', TRUSTED_PROXIES: '1', UPSTASH_REDIS_REST_URL: `http://localhost:${UP}`, UPSTASH_REDIS_REST_TOKEN: TOKEN,
  SESSION_SECRET: SECRET, ANSWER_SALT: SALT, ANSWER_DIGEST: DIG, IP_INTELLIGENCE_PROVIDER: 'none' };
async function startSrv() { srv = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { await sleep(100); try { if ((await fetch(B + '/health')).ok) return; } catch {} } }
const stopSrv = async () => { srv.kill(); await sleep(300); };
const restart = async () => { await stopSrv(); await startSrv(); };

const device = (ip, extra = {}) => { let cookie = ''; return async (p, body) => {
  const h = { 'x-forwarded-for': ip, ...extra, ...(cookie ? { cookie } : {}) }; if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: h, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { code: r.status, setCookie: !!sc, ...(await r.json().catch(() => ({}))) }; }; };
const sub = (d, v) => d('/api/submit', { response: v });

(async () => {
  rproc = spawn('redis-server', ['--port', RP, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }); await sleep(700);
  await startProxy(); await rcmd(['FLUSHALL']); fs.rmSync(path.join(ROOT, 'data/state.json'), { force: true });
  await startSrv();
  let r;

  const ip1 = '198.51.100.1', d1 = device(ip1), rem = [];
  for (let i = 1; i <= 10; i++) { r = await sub(d1, 'wrong' + i); rem.push(r.remaining); }
  ok('A  10 wrong answers: 9..1 then locked', rem.join() === '9,8,7,6,5,4,3,2,1,0' && r.result === 'locked' && r.code === 423, rem.join());
  ok('B  UNITY after lock (same session)', (await sub(d1, 'UNITY')).result === 'locked');
  r = await sub(device(ip1), 'UNITY'); ok('C  new session after lock; no cookie issued', r.result === 'locked' && !r.setCookie);
  ok('D  cookie deleted (fresh jar)', (await device(ip1)('/api/state')).status === 'locked');
  ok('F  different device, same IP', (await sub(device(ip1, { 'user-agent': 'Phone' }), 'UNITY')).result === 'locked');

  const d2 = device('198.51.100.2');
  r = await d2('/api/state'); ok('G  fresh clean IP can access the puzzle (empty-Redis start)', r.status === 'open' && r.remaining === 10);
  r = await sub(d2, 'UnItY'); ok('H  correct UNITY before lock -> solved (case-insensitive)', r.result === 'correct' && r.status === 'solved' && r.next?.title === 'ACCESS GRANTED');

  const ip3 = '198.51.100.3', d3 = device(ip3);
  for (let i = 1; i <= 9; i++) await sub(d3, 'w' + i);
  await restart();
  r = await device(ip3)('/api/state'); ok('   9 failures survive restart (new cookie, same IP)', r.status === 'open' && r.remaining === 1, `remaining=${r.remaining}`);
  r = await sub(device(ip3), 'w10'); ok('   10th failure after restart -> locked', r.result === 'locked' && r.code === 423);
  await restart();
  ok('E  restart again: IP3 still locked', (await sub(device(ip3), 'UNITY')).result === 'locked');
  ok('E  restart: IP1 still locked', (await sub(device(ip1), 'UNITY')).result === 'locked');
  r = await d2('/api/state'); ok('I  restart after solving: same session still solved', r.status === 'solved' && r.next?.title === 'ACCESS GRANTED');

  // Atomicity: 25 simultaneous wrong answers from 25 fresh sessions on one IP
  const ip4 = '198.51.100.4', burst = await Promise.all(Array.from({ length: 25 }, (_, i) => sub(device(ip4), 'x' + i)));
  const okc = burst.filter(x => x.code === 200), lk = burst.filter(x => x.code === 423);
  const keys = await rcmd(['KEYS', 'cicada:n:*']);
  const nets = await Promise.all(keys.map(async k => { const a = await rcmd(['HGETALL', k]), o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }));
  ok('   atomic: 25 concurrent wrongs -> exactly 9 counted-and-open, 16 locked', okc.length === 9 && lk.length === 16, `open=${okc.length} locked=${lk.length}`);
  ok('   atomic: remaining values are 9..1, each once', okc.map(x => x.remaining).sort((a, b) => a - b).join() === '1,2,3,4,5,6,7,8,9');
  ok('   atomic: stored failure counter for the burst network is exactly 10 (never 11+)', nets.some(o => o.f === '10' && o.l) && nets.every(o => +o.f <= 10), nets.map(o => o.f).join());
  ok('   atomic: UNITY after the burst is locked', (await sub(device(ip4), 'UNITY')).result === 'locked');

  // J: Redis unavailable -> fail closed
  const ip5 = '198.51.100.5', before = (await rcmd(['KEYS', 'cicada:*'])).length;
  await stopProxy();
  r = await device(ip5)('/api/state'); ok('J  Redis down: state -> 503, no fresh state', r.code === 503 && r.status === 'error');
  r = await sub(device(ip5), 'UNITY'); ok('J  Redis down: UNITY -> 503, never "correct"', r.code === 503 && r.result === 'error');
  ok('J  Redis down: cached lock still 423', (await sub(device(ip4), 'UNITY')).code === 423);
  r = await (await fetch(B + '/health')).json(); ok('   /health works without Redis and exposes only status', Object.keys(r).join() === 'status' && r.status === 'ok');
  await restart();
  r = await sub(device(ip1), 'UNITY'); ok('J  Redis down + cold cache, locked IP1 -> 503, not open/correct', r.code === 503 && r.result === 'error');
  await startProxy();
  ok('J  Redis back: IP1 still locked', (await sub(device(ip1), 'UNITY')).result === 'locked');
  r = await device(ip5)('/api/state'); ok('J  Redis back: IP5 untouched by outage (remaining 10, no keys created)', r.remaining === 10 && (await rcmd(['KEYS', 'cicada:*'])).length === before);

  const g = spawnSync('node', ['server.js'], { cwd: ROOT, timeout: 4000, env: { ...env, PORT: 3699, SESSION_SECRET: '' } });
  ok('   refuses to start in Redis mode without SESSION_SECRET', g.status === 1);
  const leak = fs.readdirSync(path.join(ROOT, 'public')).filter(f => /\.(js|html|css)$/.test(f)).some(f => /UPSTASH|test-token/.test(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')));
  ok('   no Redis credentials in public/; no state.json created', !leak && !fs.existsSync(path.join(ROOT, 'data/state.json')));

  await stopSrv(); await stopProxy(); rproc.kill();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
