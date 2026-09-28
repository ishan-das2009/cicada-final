// npm test — spawns the real server against a mock IP-intelligence provider. Simulated source IPs use the
// documentation range 203.0.113.x via X-Forwarded-For with TRUSTED_PROXIES set (the "proxy" is this script).
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), PORT = 3611, MOCK = 3612, B = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv, mock, calls = 0, fails = 0;
const ok = (name, cond, note = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${note ? '  [' + note + ']' : ''}`); };

// Mock provider (ipapi.is shape). Last octet: 10 vpn, 11 proxy, 12 tor, 13 datacenter, 14 hangs, others clean.
const startMock = () => new Promise(r => { mock = http.createServer((q, s) => {
  calls++; const n = +new URL(q.url, 'http://x').searchParams.get('q').split('.').pop();
  if (n === 14) return setTimeout(() => s.end('{}'), 3000);
  s.end(JSON.stringify({ is_vpn: n === 10, is_proxy: n === 11, is_tor: n === 12, is_datacenter: n === 13 }));
}).listen(MOCK, r); });
const stopMock = async () => { mock.closeAllConnections?.(); await new Promise(r => mock.close(r)); };
async function start(env = {}, fresh = false) {
  if (fresh) fs.rmSync(path.join(ROOT, 'data/state.json'), { force: true });
  srv = spawn('node', ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, THROTTLE_MS: '0', TRUSTED_PROXIES: '1',
    IP_INTELLIGENCE_PROVIDER: 'ipapiis', IP_INTELLIGENCE_URL: `http://localhost:${MOCK}`, REPUTATION_TIMEOUT_MS: '500', ...env } });
  await sleep(800);
}
const stop = async () => { srv.kill(); await sleep(400); };
// A "device": own cookie jar, optionally behind a simulated source IP.
const device = (ip, extra = {}) => { let cookie = ''; return async (p, body) => {
  const h = { ...(ip ? { 'x-forwarded-for': ip } : {}), ...extra, ...(cookie ? { cookie } : {}) }; if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: h, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { code: r.status, setCookie: !!sc, ...(await r.json().catch(() => ({}))) }; }; };
const sub = (d, v, extra = {}) => d('/api/submit', { response: v, ...extra });
const wrong10 = async d => { const rem = []; let last; for (let i = 1; i <= 10; i++) { last = await sub(d, 'wrong' + i); rem.push(last.remaining); } return { rem, last }; };

// ---- Post-solve secret helpers (server-side test: the literal is allowed here, never in public/) ----
const SECRET_TEXT = 'CITSCPA-FYITNLE';
const forms = s => [s, s.replace(/-/g, ''), [...s].reverse().join(''), Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64')];   // plain, hyphenless, reversed, hex, base64
const leaks = data => { const t = (Buffer.isBuffer(data) ? data.toString('latin1') : String(data)).toLowerCase(); return forms(SECRET_TEXT).some(f => t.includes(f.toLowerCase())); };
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
// Raw HTTP exchange (status + headers + body as text), fresh session, no cookie jar.
const raw = async (ip, p, body) => { const h = { 'x-forwarded-for': ip }; if (body) h['content-type'] = 'application/json';
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: h, body: body && JSON.stringify(body) });
  return { code: r.status, text: [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + await r.text() }; };

(async () => {
  await startMock();

  console.log('\n# Run 1: TRUSTED_PROXIES=0 (direct): client-controlled values ignored');
  await start({ TRUSTED_PROXIES: '0' }, true);
  let d = device('203.0.113.10');   // header claims a VPN address; must be ignored, real peer is loopback
  let r = await d('/api/state'); ok('spoofed X-Forwarded-For ignored when no trusted proxy', r.status === 'open', `status=${r.status}`);
  const l = device(); const w = await wrong10(l);
  ok('10 wrong answers -> remaining 9..0, last is locked', w.rem.join() === '9,8,7,6,5,4,3,2,1,0' && w.last.result === 'locked' && w.last.code === 423, w.rem.join());
  r = await sub(device('8.8.8.8'), 'UNITY', { ip: '8.8.8.8', vpn: false }); ok('spoofed body ip/vpn + spoofed XFF after lock -> locked', r.result === 'locked', `code=${r.code}`);
  await stop();

  console.log('\n# Run 2: TRUSTED_PROXIES=1, simulated public IPs, mock provider');
  await start({}, true);
  const A = '203.0.113.15', a1 = device(A);
  const w2 = await wrong10(a1); ok('1  IP A: 10 wrong answers -> network locked', w2.last.result === 'locked' && w2.last.code === 423);
  r = await sub(a1, 'UNITY'); ok('2  same session after lock, UNITY -> locked (never correct)', r.result === 'locked');
  const a2 = device(A); r = await sub(a2, 'UNITY'); ok('3  new session, UNITY -> locked, no cookie issued', r.result === 'locked' && !r.setCookie);
  r = await device(A)('/api/state'); ok('4  cookie deleted (fresh jar) -> locked', r.status === 'locked');
  r = await sub(device(A, { 'user-agent': 'Phone/1.0' }), 'UNITY'); ok('5  different device, same IP -> locked', r.result === 'locked');
  r = await sub(device(A), 'UNITY').then(() => device(A)('/api/answer', { response: 'UNITY' })); ok('7  direct POST /api/answer -> locked', r.result === 'locked');
  r = await sub(device('9.9.9.9, ' + A), 'UNITY', { ip: '127.0.0.1', vpn: false }); ok('8/9 spoofed body + spoofed left XFF entry -> locked', r.result === 'locked');
  r = await sub(device('203.0.113.16'), 'UNITY'); ok('   a different clean IP is unaffected and can solve', r.result === 'correct');

  for (const [name, ip] of [['VPN', 10], ['proxy', 11], ['Tor', 12], ['datacenter', 13]]) {
    const v = device('203.0.113.' + ip), s = await v('/api/state'), u = await sub(v, 'UNITY');
    ok(`${name} IP rejected: state and UNITY submit`, s.status === 'unavailable' && u.result === 'unavailable' && u.code === 403 && !s.setCookie && !u.setCookie,
      `keys=${Object.keys(u).filter(k => !['code', 'setCookie'].includes(k))}`);
  }
  const t0 = Date.now(); r = await device('203.0.113.14')('/api/state');
  ok('14 provider timeout -> user not rejected, answered quickly', r.status === 'open' && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  const c0 = calls; await device('203.0.113.14')('/api/state'); ok('   failed lookup not retried within 60 s', calls === c0);
  const e = device('203.0.113.14'); await wrong10(e);
  await stopMock(); await stop(); await start({});
  r = await sub(device('203.0.113.14'), 'UNITY'); ok('6/14 restart + provider DOWN: locked network stays locked', r.result === 'locked');
  r = await device(A)('/api/state'); ok('6  restart: network A still locked', r.status === 'locked');
  const t1 = Date.now(); r = await device('203.0.113.30')('/api/state'); ok('14 provider DOWN: new clean user not globally locked out', r.status === 'open', `${Date.now() - t1}ms`);
  await stop(); await startMock();

  console.log('\n# Run 3: cache + lookup rate limit (limit 5/min)');
  await start({ REPUTATION_LOOKUPS_PER_MIN: '5' }, true); calls = 0;
  const cd = device('203.0.113.20'); for (let i = 0; i < 4; i++) await cd('/api/state');
  ok('15 cache: 4 requests from one IP -> 1 provider call', calls === 1, `calls=${calls}`);
  const codes = []; for (let i = 101; i <= 112; i++) codes.push((await device('203.0.113.' + i)('/api/state')).status);
  ok('16 rate limit: 13 distinct IPs -> at most 5 outbound lookups, users still served', calls === 5 && codes.every(s => s === 'open'), `calls=${calls}`);
  await stop();

  console.log('\n# Run 4: TRUSTED_PROXIES=2');
  await start({ TRUSTED_PROXIES: '2' }, true);
  r = await device('9.9.9.9, 203.0.113.10, 10.1.1.1')('/api/state'); ok('2 proxies: client = 2nd from right (VPN IP) -> unavailable', r.status === 'unavailable');
  await stop();

  console.log('\n# Run 5: post-solve secret exists only server-side, only in a validated-correct submit response');
  await start({}, true);
  const pubDir = path.join(ROOT, 'public'), disk = f => fs.readFileSync(path.join(pubDir, f));
  let x = await raw('203.0.113.50', '/api/state');
  ok('S1 GET /api/state before solving: no secret (body + headers)', x.code === 200 && JSON.parse(x.text.split('\n\n').pop()).status === 'open' && !leaks(x.text));
  const html = await raw('203.0.113.50', '/'), js = await raw('203.0.113.50', '/app.js'), css = await raw('203.0.113.50', '/style.css');
  ok('S2 index.html (served + on disk): no secret, no popup markup', html.code === 200 && !leaks(html.text) && !leaks(disk('index.html')) && !/veil/i.test(html.text));
  ok('S3 app.js (served + on disk): no secret', js.code === 200 && !leaks(js.text) && !leaks(disk('app.js')));
  ok('S4 style.css (served + on disk): no secret', css.code === 200 && !leaks(css.text) && !leaks(disk('style.css')));
  const pubFiles = walk(pubDir);
  ok('S4b every file under public/ (incl. images, binary-safe; plain/hyphenless/reversed/hex/base64): no secret', pubFiles.length >= 8 && !pubFiles.some(f => leaks(fs.readFileSync(f))), `${pubFiles.length} files`);
  ok('S4c popup is built by JS from the response: uses textContent, no innerHTML on the secret path', /p\.textContent = text/.test(disk('app.js').toString()) && !/innerHTML\s*=\s*(text|secret|r\.reveal)/.test(disk('app.js').toString()));

  x = await raw('203.0.113.51', '/api/submit', { response: 'definitely-wrong' });
  ok('S5 wrong answer response: no secret', x.code === 200 && JSON.parse(x.text.split('\n\n').pop()).result === 'incorrect' && !leaks(x.text));
  x = await raw('203.0.113.51', '/api/submit', { response: 'still-wrong', reveal: true, solved: true, result: 'correct' });
  ok('S5b client-supplied reveal/solved/result fields are ignored: no secret', !leaks(x.text) && JSON.parse(x.text.split('\n\n').pop()).result === 'incorrect');

  const L = '203.0.113.52', ld = device(L), lw = await wrong10(ld);
  ok('S6 10th wrong answer (locking response): no secret', lw.last.result === 'locked' && lw.last.code === 423 && !leaks(JSON.stringify(lw.last)));
  x = await raw(L, '/api/submit', { response: 'UNITY' });
  ok('S6b correct answer AFTER lock: 423, no secret', x.code === 423 && !leaks(x.text) && JSON.parse(x.text.split('\n\n').pop()).result === 'locked');
  x = await raw(L, '/api/state'); ok('S6c /api/state on a locked network: no secret', x.code === 423 && !leaks(x.text));
  x = await raw('203.0.113.10', '/api/submit', { response: 'UNITY' });
  ok('S6d correct answer from a VPN address: 403 unavailable, no secret', x.code === 403 && !leaks(x.text));

  const P = device('203.0.113.53');
  r = await sub(P, 'UnItY');
  ok('S7 correct UNITY (any case): 200, result correct, status solved, secret present', r.code === 200 && r.result === 'correct' && r.status === 'solved' && r.reveal === SECRET_TEXT);
  ok('S7b successful response keeps existing fields and adds only `reveal`', r.next?.title === 'ACCESS GRANTED' && r.next?.body === 'PROCEED TO NEXT SEQUENCE' && !leaks(JSON.stringify(r.next))
    && Object.keys(r).filter(k => !['code', 'setCookie'].includes(k)).sort().join() === 'next,remaining,result,reveal,status', Object.keys(r).join());
  r = await P('/api/state');
  ok('S8 /api/state after solving: still solved with NEXT, secret NOT exposed', r.status === 'solved' && r.next?.title === 'ACCESS GRANTED' && !leaks(JSON.stringify(r)));
  r = await sub(P, 'not-unity');
  ok('S8b solved session submitting a WRONG answer: no secret (reveal requires this submission to be correct)', !leaks(JSON.stringify(r)) && r.reveal === undefined);
  r = await sub(P, 'unity'); ok('S8c solved session re-submitting UNITY: server re-validates and re-sends it', r.result === 'correct' && r.reveal === SECRET_TEXT);
  r = await sub(device('203.0.113.54'), 'unity'); ok('S8d a different clean session solving gets it too', r.reveal === SECRET_TEXT);

  await stop(); await start({});
  r = await P('/api/state');
  ok('S9 restart: existing solved state intact (same cookie), still no secret in /api/state', r.status === 'solved' && r.next?.title === 'ACCESS GRANTED' && !leaks(JSON.stringify(r)));
  r = await device(L)('/api/state'); ok('S9b restart: locked network still locked, no secret', r.status === 'locked' && !leaks(JSON.stringify(r)));
  x = await raw('203.0.113.55', '/api/state'); ok('S9c restart: unsolved visitor still gets no secret', !leaks(x.text));
  r = await sub(P, 'UNITY'); ok('S9d restart: solved session + UNITY -> secret from the server again', r.result === 'correct' && r.reveal === SECRET_TEXT);
  await stopMock(); await stop(); fs.rmSync(path.join(ROOT, 'data/state.json'), { force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
