# Final step

Local: `npm start` (Node 18+, no dependencies) → http://localhost:3301. Without Upstash variables it uses `data/state.json`.
Tests: `npm test` (file store + mock IP-intelligence provider). `npm run test:redis` (needs a local `redis-server`; real Lua/atomicity).
Add a round: new `<section>` in `index.html`, register it in `stages` in `app.js`, change `NEXT` in `server.js`.

## Deploy on Render Free + Upstash Redis Free
1. **Upstash:** console.upstash.com → Create Database (Redis, free) → copy the **REST** URL and **REST** token (not the `redis://` URL).
2. Generate secrets locally: `npm run setup -- UNITY` → prints `SESSION_SECRET`, `ANSWER_SALT`, `ANSWER_DIGEST`. Keep them; they are not in the repo.
3. Put the project on GitHub (`.env` and `data/` are git-ignored).
4. **Render:** New → Web Service → connect the repo. Runtime Node, Build `npm install`, Start `npm start`, Instance type Free, Health Check Path `/health`.
5. **Environment** tab, add: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SESSION_SECRET`, `ANSWER_SALT`, `ANSWER_DIGEST`, `TRUSTED_PROXIES` (see below), optional `IP_INTELLIGENCE_PROVIDER` / `IP_INTELLIGENCE_API_KEY`.
6. Deploy, open the Render URL.
**Never change `SESSION_SECRET` after launch**: network keys are HMAC(SESSION_SECRET, ip), so changing it orphans every lock.

### Choose `TRUSTED_PROXIES` correctly (do this before launch)
It must equal the number of proxies in front of Node. Too high lets clients choose their IP (lock bypass); too low makes every visitor share one address (one player's 10 failures lock everyone).
I could not verify Render's exact chain, so measure it: set `DIAG_TOKEN=<random>` and `TRUSTED_PROXIES=1`, deploy, then run
`curl -H "x-diag-token: <random>" https://YOUR-APP.onrender.com/debug/ip` from your own machine. Compare `xForwardedFor` to your real public IP (search "what is my ip"):
if your IP is the LAST entry use `1`; if it is second from last use `2`. Also test with a spoofed header: `curl -H "X-Forwarded-For: 1.2.3.4" ...` must not change `chosen`.
Then delete `DIAG_TOKEN` (the endpoint disappears).

### Test the deployed site
`/health` returns `{"status":"ok"}`. Submit wrong answers and watch `ATTEMPTS REMAINING` fall; after 10, reload, open a private window, and open it from your phone on the same Wi-Fi: all show ACCESS TERMINATED.
Force a restart (Render → Manual Deploy) or wait for the free instance to spin down (15 min idle; the next request takes ~1 min to wake): the lock must still hold.

## Persistence and failure behaviour
Redis keys: `cicada:n:<networkHash>` (failures, lockedAt) and `cicada:s:<sessionId>` (failures, solved). No raw IPs. Unlocked counters and sessions expire after 30 days; locks never expire.
Every attempt is ONE Lua script executed atomically inside Redis: it counts a wrong answer only while the network is unlocked, locks the network on the 10th, and accepts a correct answer only while unlocked. Concurrent requests cannot produce attempt 11, and UNITY after a lock is always refused.
If Redis is unreachable, `/api/*` returns `503` (the page shows ACCESS UNAVAILABLE / TRY AGAIN LATER). It never creates fresh state, resets attempts or lets anyone through. Locks already seen by the running process are still enforced from memory.
`/health` does not touch Redis, so frequent platform pings cost no Redis commands. Redis usage is about 2 commands per API call (lock check + one script).

## Security architecture (order for `/api/*` and `/plates/*`)
Trusted client IP → HMAC network key → permanent network lock (`423`) → IP reputation (`403 unavailable`, cached, rate-limited, fails open) → session → answer → count failure → 10th failure locks session and network.
Reputation env: `IP_INTELLIGENCE_PROVIDER` (`none`|`ipapiis`|`ipinfo`), `IP_INTELLIGENCE_API_KEY`, `REPUTATION_TTL_HOURS` (6), `REPUTATION_TIMEOUT_MS` (2000), `REPUTATION_LOOKUPS_PER_MIN` (30). Verify adapter field names against provider docs.

## Limitations
- A new public IP (unknown private VPN, residential proxy, mobile data) is a different network with its own 10 attempts. No IP-based system can identify every such route or a person. Reputation data is imperfect (misses and false positives, e.g. corporate VPNs, iCloud Private Relay) and fails open on timeout/budget exhaustion.
- Shared public IPs share one lock; dynamic IPs can be reassigned. No ISP/range banning, no fingerprinting.
- The reputation provider sees each new public IP once per cache period. Raw IPs are never stored or logged by this app.
- If Upstash's free quota is exhausted, the API returns 503 until it resets (fails closed).
