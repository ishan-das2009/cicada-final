// Zero-dependency server. Owns attempt counting, answer validation and lockout.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const net = require('net');
const PORT = Number(process.env.PORT || 3301), MAX = 10;
const THROTTLE = +(process.env.THROTTLE_MS ?? 500);
// TRUST MODEL. TRUSTED_PROXIES = number of reverse proxies YOU operate in front of Node.
//  0 (default): X-Forwarded-For is ignored; the TCP peer address is the client.
//  N>0: client = the Nth entry from the RIGHT of X-Forwarded-For (what your own outermost proxy appended).
//       Anything a client wrote further left is ignored. Your proxy must overwrite/append, never pass through blindly.
const PROXIES = +(process.env.TRUSTED_PROXIES || 0);
// IP REPUTATION (optional, server-side only). Provider: none | ipapiis | ipinfo. Key comes from the environment, never the repo.
const PROVIDER = process.env.IP_INTELLIGENCE_PROVIDER || 'none', APIKEY = process.env.IP_INTELLIGENCE_API_KEY || '';
const PBASE = process.env.IP_INTELLIGENCE_URL || '';                       // override for self-hosting/tests
const REP_TTL = (+process.env.REPUTATION_TTL_HOURS || 6) * 36e5;            // definitive answers are cached this long
const REP_TIMEOUT = +process.env.REPUTATION_TIMEOUT_MS || 2000;
const REP_PER_MIN = +process.env.REPUTATION_LOOKUPS_PER_MIN || 30;          // global cap on outbound lookups
const UNKNOWN_TTL = 60e3;                                                    // failed/unavailable lookups are retried after 60 s
const PUB = path.join(__dirname, 'public'), DB = path.join(__dirname, 'data', 'state.json');
// Replace this object when the next round exists. Sent only after a verified solve.
const NEXT = { title: 'ACCESS GRANTED', body: 'PROCEED TO NEXT SEQUENCE' };
// SERVER-ONLY. Deliberately NOT part of NEXT: view() puts NEXT into /api/state for every solved session, and this must never travel there.
// It is attached in exactly one place: the /api/submit response to a submission that passed check() AND left the session solved.
const REVEAL = 'CITSCPA-FYITNLE';

// ---- Configuration & secrets. With Redis (production) every secret must come from the environment. ----
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
let S = { secret: crypto.randomBytes(32).toString('hex'), sessions: {}, networks: {} };   // file mode only (local dev)
const save = () => { fs.writeFileSync(DB + '.tmp', JSON.stringify(S)); fs.renameSync(DB + '.tmp', DB); };
if (!USE_REDIS) {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  try { Object.assign(S, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {}
  S.sessions ||= {}; S.networks ||= {}; delete S.ips; save();
} else {
  const miss = ['SESSION_SECRET', 'ANSWER_SALT', 'ANSWER_DIGEST'].filter(k => !process.env[k]);
  if (miss.length || process.env.SESSION_SECRET.length < 32) { console.error('Missing/weak: ' + (miss.join(', ') || 'SESSION_SECRET (min 32 chars)')); process.exit(1); }
}
const SECRET = process.env.SESSION_SECRET || S.secret;   // network keys are HMAC(SECRET, ip): changing it orphans every lock
const SALT = process.env.ANSWER_SALT || 'c3301-r01', DIGEST = process.env.ANSWER_DIGEST || '565a04ea5a0eff5f13b9425954908ac821af66ebc4b3d28d55e163e3c6781af8';
const mac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const check = s => eq(crypto.scryptSync(s.trim().toLowerCase(), SALT, 32).toString('hex'), DIGEST);

// Normalise so one household maps to one key: strip ::ffff:, and collapse IPv6 to its /64 (a single subscriber owns a whole /64).
function normalize(ip) {
  ip = String(ip || '').toLowerCase().replace(/^::ffff:/, '').replace(/%.*/, '');
  if (!net.isIPv6(ip)) return ip;
  const [h, t = ''] = ip.split('::'), a = h ? h.split(':') : [], b = t ? t.split(':') : [];
  const full = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return full.slice(0, 4).map(g => g.padStart(4, '0')).join(':') + '::/64';
}
// The ONLY source of the client address. Never read from request bodies, query strings or arbitrary headers.
function getClientIp(req) {
  let ip = req.socket.remoteAddress;
  if (PROXIES > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const pick = hops.length >= PROXIES ? hops[hops.length - PROXIES].replace(/^::ffff:/i, '') : '';
    if (net.isIP(pick)) ip = pick;   // else: predictable fallback to the TCP peer (i.e. your proxy), never a client-chosen value
  }
  return String(ip || '').toLowerCase().replace(/^::ffff:/, '').replace(/%.*/, '');
}
const networkKey = ip => mac('net:' + normalize(ip)).slice(0, 32);   // HMAC only; raw IP is never stored or sent to the browser
const isPrivate = ip => !net.isIP(ip) || /^(10\.|127\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(::1$|fc|fd|fe80)/.test(ip);

// ---- IP reputation: adapters, cache, rate limit. Provider output never leaves this function as anything but a boolean. ----
const PROVIDERS = {
  ipapiis: { url: (ip) => `${PBASE || 'https://api.ipapi.is'}/?q=${encodeURIComponent(ip)}${APIKEY ? '&key=' + encodeURIComponent(APIKEY) : ''}`,
    valid: j => 'is_vpn' in j, risky: j => !!(j.is_vpn || j.is_proxy || j.is_tor || j.is_datacenter) },
  ipinfo: { url: (ip) => `${PBASE || 'https://ipinfo.io'}/${encodeURIComponent(ip)}/privacy?token=${encodeURIComponent(APIKEY)}`,
    valid: j => 'vpn' in j, risky: j => !!(j.vpn || j.proxy || j.tor || j.hosting || j.relay) },
};
const P = PROVIDERS[PROVIDER];
const rep = new Map(), inflight = new Map(); let bucket = { t: 0, n: 0 };   // rep is in memory only: not part of persisted state
const setRep = (nk, risky, ttl) => { rep.delete(nk); rep.set(nk, { risky, exp: Date.now() + ttl }); if (rep.size > 5000) rep.delete(rep.keys().next().value); };
async function isRisky(ip, nk) {
  if (!P || isPrivate(ip)) return false;
  const c = rep.get(nk); if (c && c.exp > Date.now()) return c.risky;
  if (inflight.has(nk)) return inflight.get(nk);                              // concurrent requests share one lookup
  const now = Date.now(); if (now - bucket.t >= 60e3) bucket = { t: now, n: 0 };
  if (bucket.n >= REP_PER_MIN) return false;                                  // budget spent: fail open, never call out
  bucket.n++;
  const p = (async () => {
    try {
      const r = await fetch(P.url(ip), { signal: AbortSignal.timeout(REP_TIMEOUT), headers: { accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      if (!j || typeof j !== 'object' || !P.valid(j)) throw 0;
      const risky = P.risky(j); setRep(nk, risky, REP_TTL); return risky;
    } catch { setRep(nk, false, UNKNOWN_TTL); return false; }                  // timeout/error/garbage: fail open, retry later
    finally { inflight.delete(nk); }
  })();
  inflight.set(nk, p); return p;
}

function sessionId(req, res) {
  const raw = /(?:^|; )sid=([a-f0-9]+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
  let id = raw && eq(raw[2], mac(raw[1])) ? raw[1] : null;
  if (!id) {
    id = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `sid=${id}.${mac(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  }
  return id;
}

// ---- Store: one interface, two backends. attempt() is ATOMIC: a Lua script inside Redis / single-threaded JS in file mode. ----
// A wrong answer is only counted while the network is unlocked and under MAX; the MAX-th failure locks the network in the same step.
// A correct answer is only accepted while the network is unlocked. So attempt 11 can never be counted and UNITY after a lock never wins.
const LUA = `
local nk,sid,mode,max,now=KEYS[1],KEYS[2],ARGV[1],tonumber(ARGV[2]),ARGV[3]
local nf=tonumber(redis.call('HGET',nk,'f') or '0')
local nl=redis.call('HGET',nk,'l')
local sf=tonumber(redis.call('HGET',sid,'f') or '0')
local ss=redis.call('HGET',sid,'s')
if math.max(sf,nf)>=max and not nl then redis.call('HSET',nk,'l',now); nl=now end
local ap=0
if mode~='state' and not nl and not ss then
  if mode=='right' then redis.call('HSET',sid,'s','1'); ss='1'
  else
    sf=redis.call('HINCRBY',sid,'f',1); nf=redis.call('HINCRBY',nk,'f',1)
    if math.max(sf,nf)>=max then redis.call('HSET',nk,'l',now); nl=now end
  end
  ap=1
  redis.call('EXPIRE',sid,2592000)
  if nl then redis.call('PERSIST',nk) else redis.call('EXPIRE',nk,2592000) end
end
return {sf,nf,nl and 1 or 0,ss and 1 or 0,ap}`;
async function redis(cmd) {   // Upstash REST: POST the command as a JSON array. Credentials never appear in errors or logs.
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd), signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('store');
  return j.result;
}
const lockedCache = new Set();   // locks are permanent, so caching a positive answer is safe (and keeps locks even if Redis is down)
const redisStore = {
  async isLocked(nk) {
    if (lockedCache.has(nk)) return true;
    const l = await redis(['HEXISTS', 'cicada:n:' + nk, 'l']);
    if (l) lockedCache.add(nk);
    return !!l;
  },
  async attempt(nk, sid, mode) {
    const [sf, nf, l, so, ap] = await redis(['EVAL', LUA, '2', 'cicada:n:' + nk, 'cicada:s:' + sid, mode, String(MAX), new Date().toISOString()]);
    if (l) lockedCache.add(nk);
    return { sf, nf, locked: !!l, solved: !!so, applied: !!ap };
  },
};
const fileStore = {   // same semantics and same state.json schema as before
  async isLocked(nk) { return !!S.networks[nk]?.locked; },
  async attempt(nk, sid, mode) {
    const N = (S.networks[nk] ||= { failures: 0, locked: false }), s = (S.sessions[sid] ||= { fails: 0, solved: false });
    const lock = () => { N.locked = true; N.failures = Math.max(N.failures, MAX); N.lockedAt ||= new Date().toISOString(); };
    if (Math.max(s.fails, N.failures) >= MAX && !N.locked) lock();
    let ap = false;
    if (mode !== 'state' && !N.locked && !s.solved) {
      if (mode === 'right') s.solved = true;
      else { s.fails++; N.failures++; if (Math.max(s.fails, N.failures) >= MAX) lock(); }
      ap = true; save();
    }
    return { sf: s.fails, nf: N.failures, locked: N.locked, solved: s.solved, applied: ap };
  },
};
const store = USE_REDIS ? redisStore : fileStore;

const view = o => {
  const remaining = Math.max(0, MAX - Math.max(o.sf, o.nf));
  if (o.solved) return { status: 'solved', remaining, next: NEXT };
  return { status: o.locked || remaining === 0 ? 'locked' : 'open', remaining };
};
const UNAVAILABLE = { result: 'unavailable', status: 'unavailable' };   // deliberately reveals nothing about why
const LOCKED = { result: 'locked', status: 'locked', remaining: 0 };
const FAILED = { result: 'error', status: 'error' };                    // state store unreachable: never fail open
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 1024) req.destroy(); }); req.on('end', () => ok(b)); req.on('close', () => ok(b)); req.on('error', () => ok('')); });
const lastSeen = new Map();

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
function serve(url, res) {
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB)) return json(res, 403, {});
  fs.readFile(file, (e, d) => {
    if (e) return json(res, 404, {});
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(d);
  });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') return json(res, 200, { status: 'ok' });   // no Redis, no state, no config: safe for frequent platform pings
  const ip = getClientIp(req), nk = networkKey(ip);
  // Optional, off unless DIAG_TOKEN is set: shows the caller ONLY its own forwarded-header chain, to choose TRUSTED_PROXIES correctly.
  if (url === '/debug/ip' && process.env.DIAG_TOKEN && eq(String(req.headers['x-diag-token'] || ''), process.env.DIAG_TOKEN))
    return json(res, 200, { xForwardedFor: req.headers['x-forwarded-for'] || null, peer: req.socket.remoteAddress, chosen: ip, trustedProxies: PROXIES });
  if (url.startsWith('/api/') || url.startsWith('/plates/')) {
    try {
      // 1) NETWORK LOCK FIRST. 2) REPUTATION SECOND (cached, fails open). 3) Only then a session and the answer.
      if (await store.isLocked(nk)) return json(res, 423, LOCKED);
      if (await isRisky(ip, nk)) return json(res, 403, UNAVAILABLE);
      if (url === '/api/state' && req.method === 'GET')
        return json(res, 200, view(await store.attempt(nk, sessionId(req, res), 'state')));
      if ((url === '/api/submit' || url === '/api/answer') && req.method === 'POST') {
        const sid = sessionId(req, res);
        if (THROTTLE && Date.now() - (lastSeen.get(sid) || 0) < THROTTLE) return json(res, 429, { result: 'throttled' });
        lastSeen.set(sid, Date.now()); if (lastSeen.size > 5000) lastSeen.delete(lastSeen.keys().next().value);
        let v; try { v = JSON.parse(await readBody(req)).response; } catch {}   // any "ip"/"vpn" field in the body is never read
        const correct = typeof v === 'string' && v.length <= 64 && check(v);
        const out = view(await store.attempt(nk, sid, correct ? 'right' : 'wrong'));
        if (out.status === 'locked') return json(res, 423, LOCKED);
        const body = { result: out.status === 'solved' ? 'correct' : 'incorrect', ...out };
        if (correct && out.status === 'solved') body.reveal = REVEAL;   // `correct` = THIS submission passed check(); `solved` = the store accepted it (network unlocked)
        return json(res, 200, body);
      }
    } catch { return json(res, 503, FAILED); }   // Redis down/timeout: refuse. Never create fresh state, never reset attempts.
    if (url.startsWith('/api/')) return json(res, 404, {});
  }
  serve(url, res);
}).listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT} (${USE_REDIS ? 'redis' : 'state.json'} store)`));
