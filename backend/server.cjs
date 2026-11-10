// Read-only local API. Lifecycle status alone never proves a credential valid.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const profile = require('./network-profile.cjs');
const { Chain } = require('./chain.cjs');
const database = require('./database.cjs');

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function createServer(chain, token) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('API_TOKEN must contain at least 32 characters');
  const expected = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  let inFlight = 0;
  return http.createServer({ requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    const supplied = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
    if (!crypto.timingSafeEqual(expected, supplied)) return send(res, 401, { error: 'UNAUTHORIZED' });
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (inFlight >= 8) return send(res, 503, { error: 'BUSY' });
    inFlight++;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') {
        const [chainHealth, dbHealth] = await Promise.allSettled([chain.snapshot(), database.health()]);
        const ready = chainHealth.status === 'fulfilled' && dbHealth.status === 'fulfilled';
        return send(res, ready ? 200 : 503, { ready,
          chain: chainHealth.status === 'fulfilled' ? 'available' : 'unavailable',
          database: dbHealth.status === 'fulfilled' ? 'available' : 'unavailable' });
      }
      const match = /^\/credentials\/([^/]+)\/status$/.exec(url.pathname);
      if (!match) return send(res, 404, { error: 'NOT_FOUND' });
      const id = decodeURIComponent(match[1]);
      // The seed's demo-* identifiers deliberately have no invented chain mapping.
      const onChainId = /^0x[0-9a-fA-F]{64}$/.test(id);
      if (!onChainId && !/^demo-[a-z0-9-]{1,100}$/.test(id)) {
        return send(res, 400, { error: 'INVALID_CREDENTIAL_ID' });
      }
      const [indexed, live] = await Promise.allSettled([
        database.credential(onChainId ? id.toLowerCase() : id, chain.namespace),
        onChainId ? chain.credential(id) : Promise.resolve(null),
      ]);
      const index = { available: indexed.status === 'fulfilled', authoritative: false,
        record: indexed.status === 'fulfilled' ? indexed.value : null };
      if (!onChainId) return send(res, 200, { credentialId: id, result: 'INDETERMINATE',
        reason: 'DEMO_RECORD_NOT_LINKED_TO_CHAIN', lifecycleStatus: null, index });
      if (live.status !== 'fulfilled') return send(res, 503, { credentialId: id,
        result: 'INDETERMINATE', reason: 'CHAIN_UNAVAILABLE_OR_UNTRUSTED', lifecycleStatus: null, index });
      const { lifecycleStatus, record, observedAt } = live.value;
      // Verification needs payload integrity, subject proof, consent and issuer policy.
      const reasons = { NONE: 'CREDENTIAL_NOT_FOUND_ON_CHAIN', ISSUED: 'FULL_VERIFICATION_REQUIRED',
        REVOKED: 'CREDENTIAL_REVOKED', EXPIRED: 'CREDENTIAL_EXPIRED', SUPERSEDED: 'CREDENTIAL_SUPERSEDED' };
      const result = ['REVOKED', 'EXPIRED', 'SUPERSEDED'].includes(lifecycleStatus)
        ? lifecycleStatus : 'INDETERMINATE';
      return send(res, 200, { credentialId: id, result, reason: reasons[lifecycleStatus],
        lifecycleStatus, record, observedAt, index });
    } catch (error) {
      send(res, error instanceof URIError ? 400 : 500,
        { error: error instanceof URIError ? 'INVALID_PATH' : 'INTERNAL_ERROR' });
    } finally { inFlight--; }
  });
}

if (require.main === module) {
  let chain;
  try {
    const port = Number(process.env.API_PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
    chain = new Chain();
    const tokenFile = process.env.API_TOKEN_FILE || path.join(profile.stateDir, 'status-api-token');
    const token = process.env.API_TOKEN || fs.readFileSync(tokenFile, 'utf8').trim();
    const server = createServer(chain, token);
    server.on('error', () => { console.error('API could not listen on the configured local port'); chain.close(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Besu status API: http://127.0.0.1:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(() => chain.close());
      setTimeout(() => { server.closeAllConnections(); chain.close(); }, 6000).unref();
    });
  } catch {
    if (chain) chain.close();
    console.error('API startup failed. Check API_TOKEN or API_TOKEN_FILE (32+ characters), deployment, ethers and numeric settings.');
    process.exitCode = 1;
  }
}

module.exports = { createServer };
