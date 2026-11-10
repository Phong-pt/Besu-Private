const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Demo, ACTORS, dir, json, canonical, requireThat } = require('./runtime.cjs');
const { Indexer } = require('./indexer.cjs');
const { TEMPORARY, safeError, errorResponse, jobResult } = require('./policy.cjs');
const ui = path.resolve(__dirname, '../web');
const mode = process.argv[2] || 'serve';

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' }); res.end(json(body));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; requireThat(size <= 16384, 'REQUEST_TOO_LARGE'); chunks.push(chunk); }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireThat(parsed && !Array.isArray(parsed) && typeof parsed === 'object', 'INVALID_JSON'); return parsed; }
  catch { throw new Error('INVALID_JSON'); }
}
async function serve(demo, indexer) {
  requireThat(demo.state.setup, 'RUN_SETUP_FIRST');
  const tokenFile = path.join(dir, 'operator-token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const tokenHash = crypto.createHash('sha256').update(fs.readFileSync(tokenFile, 'utf8').trim()).digest();
  const sessions = new Map();
  const jobs = demo.state.jobs ||= {};
  const running = new Set();
  const loginAttempts = new Map();
  let stopping = false;
  // Release the single writer queue periodically while a transaction is pending.
  demo.waitTimeout = 10000;
  const port = Number(process.env.DEMO_PORT || 3002);
  requireThat(Number.isInteger(port) && port > 0 && port < 65536, 'INVALID_PORT');
  const handlers = {
    issue: (actor, data, key) => demo.issue(actor, data, key),
    grant: (actor, data, key) => demo.grant(actor, data, key),
    revoke: (actor, data) => demo.revoke(actor, data),
    challenge: (actor, data) => demo.challenge(actor, data),
    sign: (actor, data) => demo.signChallenge(actor, data.challengeId),
    verify: (actor, data) => demo.verify(actor, data),
  };
  function launch(key) {
    if (stopping || running.has(key)) return;
    const job = jobs[key];
    running.add(key);
    return demo.serial(async () => {
      job.status = 'RUNNING'; job.attempts = (job.attempts || 0) + 1;
      delete job.error; delete job.outcome; demo.persist();
      try {
        const data = demo.decrypt('job:' + key, job.encrypted);
        const result = await handlers[job.action](job.actor, data, job.idempotencyKey);
        job.output = demo.seal('output:' + key, result); job.status = 'SUCCEEDED';
      } catch (error) {
        job.error = safeError(error);
        const retry = ['issue', 'grant', 'revoke'].includes(job.action) &&
          ['BROADCAST_PENDING_RETRY', 'CHAIN_NOT_FRESH', 'CHAIN_REORGANIZED', 'TRANSACTION_PENDING'].includes(job.error);
        job.status = retry ? 'WAITING' : 'FAILED';
        if (retry) job.nextAttemptAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(job.attempts - 1, 6));
        if (TEMPORARY.has(job.error)) job.outcome = { result: 'INDETERMINATE', reason: job.error };
      }
      job.updatedAt = new Date().toISOString();
      demo.persist();
    }).catch(() => { stopping = true; console.error('STATE_PERSIST_FAILED'); })
      .finally(() => running.delete(key));
  }
  await demo.recover();
  // Chain operations can be resumed from persisted signed transactions.
  // Challenges/verification are one-use; never automatically replay a possibly consumed proof.
  for (const [key, job] of Object.entries(jobs)) if (['QUEUED', 'RUNNING', 'WAITING'].includes(job.status)) {
    if (['issue', 'grant', 'revoke'].includes(job.action)) launch(key);
    else { job.status = 'FAILED'; job.error = 'INTERRUPTED_REQUEST_NEW_CHALLENGE'; }
  }
  demo.persist();
  let inFlight = 0;
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    if (inFlight >= 16) return reply(res, 503, { error: 'BUSY' });
    inFlight++;
    try {
      requireThat([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host), 'INVALID_HOST');
      if (req.headers.origin) requireThat([`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin), 'INVALID_ORIGIN');
      const route = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/app.css': ['app.css', 'text/css'] };
      if (req.method === 'GET' && staticFiles[route]) {
        const [file, mime] = staticFiles[route];
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'X-Content-Type-Options': 'nosniff' }); res.end(fs.readFileSync(path.join(ui, file))); return;
      }
      if (route === '/api/session' && req.method === 'POST') {
        const now = Date.now();
        for (const [key, entry] of loginAttempts) if (entry.until <= now) loginAttempts.delete(key);
        const address = req.socket.remoteAddress;
        const attempt = loginAttempts.get(address) || { count: 0, until: now + 60000 };
        requireThat(attempt.count++ < 30, 'RATE_LIMITED'); loginAttempts.set(address, attempt);
        const input = await body(req);
        const hash = crypto.createHash('sha256').update(String(input.operatorToken || '')).digest();
        requireThat(crypto.timingSafeEqual(hash, tokenHash), 'UNAUTHORIZED');
        const actor = demo.actor(input.actor);
        for (const [key, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(key);
        requireThat(sessions.size < 200, 'TOO_MANY_SESSIONS');
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { actor: actor.key, expiresAt: Date.now() + 3600000 });
        return reply(res, 200, { token, actor, actors: ACTORS });
      }
      const session = sessions.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      requireThat(session && session.expiresAt > Date.now(), 'UNAUTHORIZED');
      if (route === '/api/session' && req.method === 'DELETE') {
        sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
        return reply(res, 200, { loggedOut: true });
      }
      if (route === '/api/health' && req.method === 'GET') {
        const head = await demo.guard();
        const waiting = Object.values(jobs).filter(job => job.status === 'WAITING').length;
        return reply(res, demo.indexStatus.ready ? 200 : 503, {
          ready: demo.indexStatus.ready, chain: { blockNumber: head.blockNumber, finality: head.finality },
          indexer: demo.indexStatus, jobs: { running: running.size, waiting }, runtime: process.version,
        });
      }
      if (route === '/api/state' && req.method === 'GET') return reply(res, 200, await demo.snapshot(session.actor));
      if (route.startsWith('/api/jobs/') && req.method === 'GET') {
        const key = route.slice('/api/jobs/'.length); const job = jobs[key];
        requireThat(job && job.actor === session.actor, 'ACCESS_DENIED');
        return reply(res, 200, { id: key, status: job.status, error: job.error,
          attempts: job.attempts || 0, nextAttemptAt: job.status === 'WAITING' ? job.nextAttemptAt : undefined,
          outcome: job.outcome, result: await jobResult(demo, session.actor, key, job) });
      }
      if (route.startsWith('/api/actions/') && req.method === 'POST') {
        requireThat(!stopping, 'SERVER_SHUTTING_DOWN');
        const action = route.slice('/api/actions/'.length); requireThat(Object.hasOwn(handlers, action), 'UNKNOWN_ACTION');
        const data = await body(req); const suppliedKey = req.headers['idempotency-key'];
        requireThat(typeof suppliedKey === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(suppliedKey), 'IDEMPOTENCY_KEY_REQUIRED');
        const key = crypto.createHash('sha256').update(session.actor + ':' + suppliedKey).digest('hex');
        const fingerprint = crypto.createHash('sha256').update(canonical({ action, data })).digest('hex');
        if (jobs[key]) {
          requireThat(jobs[key].fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
          // A failed RPC/broadcast request can be retried without generating new signed bytes.
          if (['FAILED', 'WAITING'].includes(jobs[key].status) && ['issue', 'grant', 'revoke'].includes(action) &&
            ['BROADCAST_PENDING_RETRY', 'CHAIN_NOT_FRESH', 'TRANSACTION_PENDING', 'OPERATION_FAILED'].includes(jobs[key].error)) {
            jobs[key].status = 'QUEUED'; delete jobs[key].error; demo.persist(); launch(key);
          }
          return reply(res, 202, { jobId: key });
        }
        requireThat(Object.values(jobs).filter(j => ['QUEUED', 'RUNNING', 'WAITING'].includes(j.status)).length < 20, 'QUEUE_FULL');
        jobs[key] = { actor: session.actor, action, fingerprint, idempotencyKey: suppliedKey,
          encrypted: demo.seal('job:' + key, data), status: 'QUEUED', createdAt: new Date().toISOString() };
        demo.persist(); launch(key); return reply(res, 202, { jobId: key });
      }
      reply(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const response = errorResponse(error);
      reply(res, response.status, response.body);
    } finally { inFlight--; }
  });
  server.on('error', error => { stopping = true; console.error(error.code === 'EADDRINUSE' ? 'DEMO_PORT_IN_USE' : 'SERVER_ERROR'); clearInterval(timer); clearInterval(retryTimer); demo.chain.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Demo: http://127.0.0.1:${port}`);
    console.log(`Operator token file (local only): ${tokenFile}`);
  });
  const sync = () => indexer.sync().catch(error => console.error('Indexer:', safeError(error)));
  sync(); const timer = setInterval(sync, 15000);
  const retryTimer = setInterval(() => {
    for (const [key, job] of Object.entries(jobs)) if (job.status === 'WAITING' && job.nextAttemptAt <= Date.now()) launch(key);
  }, 5000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopping = true; clearInterval(timer); clearInterval(retryTimer); server.close(); server.closeIdleConnections();
    Promise.allSettled([demo.queue, indexer.running]).finally(() => { demo.chain.close(); server.closeAllConnections(); });
  });
}
async function main() {
  if (!process.env.BESU_DEMO_LOCKED) {
    // --no-fork makes the child become Node while retaining the lock descriptor;
    // forwarding SIGTERM therefore reaches the server, not just a flock wrapper.
    const child = spawn('flock', ['-n', '--no-fork', path.join(dir, 'process.lock'), process.execPath, __filename, mode],
      { stdio: 'inherit', env: { ...process.env, BESU_DEMO_LOCKED: '1' } });
    child.on('error', () => { console.error('FLOCK_REQUIRED'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    return;
  }
  const demo = new Demo(); const indexer = new Indexer(demo);
  if (mode === 'serve') return serve(demo, indexer);
  try {
    if (mode === 'setup') { console.log('Initializing governance and 12 demo identities...'); await demo.setup(); console.log('Issuing 9 synthetic credentials...'); await demo.seed(); }
    else requireThat(mode === 'index', 'USAGE_SETUP_INDEX_SERVE');
    await indexer.sync(); console.log(json({ setup: demo.state.setup, documents: Object.keys(demo.state.documents).length, indexer: demo.indexStatus }));
  } finally { demo.chain.close(); }
}
if (require.main === module) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
module.exports = { serve, body };
