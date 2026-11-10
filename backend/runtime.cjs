// Custodial synthetic demo only. Keys never leave the local private directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Chain } = require('./chain.cjs');
const profile = require('./network-profile.cjs');
const { verdict } = require('./policy.cjs');
const base = profile.stateDir;
const { ethers } = require(path.join(profile.modules, 'ethers'));
const dir = path.join(base, 'business-demo');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
function save(name, value) {
  const file = path.join(dir, name);
  const fd = fs.openSync(file + '.tmp', 'w', 0o600);
  try { fs.writeFileSync(fd, json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.tmp', file);
  const directory = fs.openSync(dir, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function requireThat(ok, code) { if (!ok) throw new Error(code); }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_PAYLOAD_VALUE');
}
const id = text => ethers.id('besu-business-demo-v1:' + text);
const SCHEMAS = [
  { key: 'employment', name: 'Xác nhận việc làm', kind: 1 },
  { key: 'degree', name: 'Bằng đại học', kind: 2 },
  { key: 'certificate', name: 'Chứng chỉ chuyên môn', kind: 3 },
].map(s => ({ ...s, id: id(s.key), definition: { format: 'besu-demo-1', type: s.key,
  fields: ['credentialId', 'issuerOrgId', 'subjectRef', 'schemaId', 'schemaVersion', 'expiresAt', 'claims'] } }));
const ORGS = [
  ['ntq', 'NTQ', 1], ['v', 'Công ty V', 1], ['m', 'Công ty M', 1],
  ['university-c', 'Đại học C', 2], ['university-d', 'Đại học D', 2], ['university-e', 'Đại học E', 2],
  ['cert-1', 'Cert-1', 3], ['cert-2', 'Cert-2', 3], ['cert-3', 'Cert-3', 3],
].map(([key, name, kind]) => ({ key, name, kind, id: id(key), role: 'organization' }));
const HOLDERS = ['a', 'b', 'c'].map(key => ({ key: 'holder-' + key, name: 'Cá nhân ' + key.toUpperCase(),
  id: id('holder-' + key), role: 'holder' }));
const ACTORS = [...ORGS, ...HOLDERS];
const grantTypes = { GrantConsent: [
  ['consentId', 'bytes32'], ['subjectRef', 'bytes32'], ['granteeOrgId', 'bytes32'],
  ['credentialScope', 'bytes32[]'], ['expiresAt', 'uint64'], ['subjectEpoch', 'uint64'],
  ['nonce', 'uint256'], ['deadline', 'uint64'],
].map(([name, type]) => ({ name, type })) };
const challengeTypes = { VerificationChallenge: [
  ['challengeId', 'bytes32'], ['nonce', 'bytes32'], ['credentialId', 'bytes32'], ['consentId', 'bytes32'],
  ['subjectRef', 'bytes32'], ['audience', 'bytes32'], ['subjectEpoch', 'uint64'], ['expiresAt', 'uint64'],
].map(([name, type]) => ({ name, type })) };

class Demo {
  constructor() {
    this.chain = new Chain();
    this.provider = this.chain.provider;
    this.provider.pollingInterval = 1000;
    this.deployment = this.chain.deployment;
    this.namespace = this.chain.namespace;
    this.state = read('state.json', { namespace: this.namespace, documents: {}, consents: {}, challenges: {}, results: [], operations: {}, setup: false });
    requireThat(this.state.namespace === this.namespace, 'DEMO_BELONGS_TO_DIFFERENT_DEPLOYMENT');
    this.keys = read('keys.json', null);
    if (!this.keys) {
      requireThat(!this.state.setup && ['documents', 'operations', 'consents', 'challenges', 'jobs'].every(
        key => Object.keys(this.state[key] || {}).length === 0), 'RESTORE_MISSING_KEYS');
      this.keys = { encryption: crypto.randomBytes(32).toString('hex'), actors: {} };
      for (const actor of ACTORS) this.keys.actors[actor.key] = ethers.Wallet.createRandom().privateKey;
      save('keys.json', this.keys);
    }
    this.contracts = Object.fromEntries(Object.entries(this.deployment.contracts).map(([name, entry]) =>
      [name, new ethers.Contract(entry.address, entry.abi, this.provider)]));
    this.queue = Promise.resolve();
    this.indexStatus = { ready: false, error: 'NOT_SYNCED' };
  }
  persist() { save('state.json', this.state); }
  actor(key) { const actor = ACTORS.find(a => a.key === key); requireThat(actor, 'UNKNOWN_ACTOR'); return actor; }
  wallet(key) { return new ethers.Wallet(this.keys.actors[this.actor(key).key], this.provider); }
  serial(work) { const task = this.queue.then(work); this.queue = task.catch(() => {}); return task; }
  async guard() { return this.chain.snapshot(); }
  domain(name, contract) { return { name, version: '1', chainId: Number(profile.chainId),
    verifyingContract: this.deployment.contracts[contract].address }; }
  async call(name, method, args, snap) {
    const contract = this.contracts[name];
    const output = await this.provider.send('eth_call', [{ to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args) }, snap.block]);
    return contract.interface.decodeFunctionResult(method, output);
  }
  commitment(payload, salt) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint32', 'bytes32', 'bytes32', 'bytes32'],
      [id('commitment-v1'), payload.schemaVersion, payload.credentialId, ethers.id(canonical(payload)), salt]));
  }
  seal(credentialId, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.keys.encryption, 'hex'), iv);
    cipher.setAAD(Buffer.from(this.namespace + credentialId));
    const ciphertext = Buffer.concat([cipher.update(canonical(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: ciphertext.toString('hex') };
  }
  unseal(credentialId) {
    const stored = this.state.documents[credentialId];
    requireThat(stored, 'DOCUMENT_UNAVAILABLE');
    return this.decrypt(credentialId, stored.encrypted);
  }
  decrypt(credentialId, encrypted) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.keys.encryption, 'hex'), Buffer.from(encrypted.iv, 'hex'));
    cipher.setAAD(Buffer.from(this.namespace + credentialId));
    cipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted.data, 'hex')), cipher.final()]).toString('utf8'));
  }
  // Persist signed bytes before broadcast. A retry always resends the identical transaction.
  async submit(key, wallet, request) {
    const fingerprint = ethers.id(canonical({ to: request.to.toLowerCase(), data: request.data || '0x', value: String(request.value || 0) }));
    let op = this.state.operations[key];
    if (op) requireThat(op.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
    if (!op) {
      let nonce = await this.provider.getTransactionCount(wallet.address, 'pending');
      for (const previous of Object.values(this.state.operations)) {
        if (!['PREPARED', 'SUBMITTED'].includes(previous.status)) continue;
        const signed = ethers.Transaction.from(previous.raw);
        if (signed.from.toLowerCase() === wallet.address.toLowerCase()) nonce = Math.max(nonce, signed.nonce + 1);
      }
      // The balance must cover gasLimit * maxFeePerGas up front, so public profiles use an estimate.
      // Setup batches transactions that depend on still-pending ones; their estimate reverts and falls back.
      let gasLimit = request.gasLimit || 1800000n;
      if (!profile.isLocal && !request.gasLimit) {
        try { gasLimit = (await wallet.estimateGas({ ...request, from: wallet.address })) * 13n / 10n; } catch { /* keep fallback */ }
      }
      const tx = await wallet.populateTransaction({ ...request, nonce, gasLimit });
      requireThat(BigInt(tx.chainId) === profile.chainId, 'CHAIN_IDENTITY_MISMATCH');
      const raw = await wallet.signTransaction(tx);
      op = { fingerprint, hash: ethers.keccak256(raw), raw, status: 'PREPARED', createdAt: new Date().toISOString() };
      this.state.operations[key] = op; this.persist();
    }
    const receipt = await this.provider.getTransactionReceipt(op.hash);
    if (receipt) {
      const block = await this.provider.getBlock(receipt.blockNumber);
      requireThat(block && block.hash === receipt.blockHash, 'CHAIN_REORGANIZED');
      op.status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
      op.blockNumber = receipt.blockNumber; op.blockHash = receipt.blockHash; this.persist();
      requireThat(receipt.status === 1, 'TRANSACTION_REVERTED');
      return op;
    }
    if (op.status === 'CONFIRMED') { op.status = 'SUBMITTED'; this.persist(); }
    try { await this.provider.broadcastTransaction(op.raw); }
    catch (error) { if (!await this.provider.getTransaction(op.hash)) throw new Error('BROADCAST_PENDING_RETRY'); }
    op.status = 'SUBMITTED'; this.persist();
    return op;
  }
  async settle(op) {
    let receipt;
    try { receipt = await this.provider.waitForTransaction(op.hash, 1, this.waitTimeout || 120000); }
    catch (error) { if (error.code === 'TIMEOUT') throw new Error('TRANSACTION_PENDING'); throw error; }
    requireThat(receipt, 'TRANSACTION_PENDING');
    requireThat((await this.provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, 'CHAIN_REORGANIZED');
    op.status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
    op.blockNumber = receipt.blockNumber; op.blockHash = receipt.blockHash; this.persist();
    requireThat(receipt.status === 1, 'TRANSACTION_REVERTED');
    return receipt;
  }
  async transact(key, wallet, contract, method, args) {
    const request = { to: await contract.getAddress(), data: contract.interface.encodeFunctionData(method, args) };
    const op = await this.submit(key, wallet, request);
    return this.settle(op);
  }
  async recover() {
    await this.guard();
    for (const op of Object.values(this.state.operations)) {
      if (op.status === 'FAILED') continue;
      const receipt = await this.provider.getTransactionReceipt(op.hash);
      if (receipt) {
        op.status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
        op.blockHash = receipt.blockHash; op.blockNumber = receipt.blockNumber;
      } else {
        op.status = 'SUBMITTED';
        try { await this.provider.broadcastTransaction(op.raw); } catch { /* retain for operator/retry */ }
      }
    }
    this.persist();
  }
  async setup() {
    await this.guard();
    await this.recover();
    const deployer = new ethers.Wallet(profile.deployerKey(), this.provider);
    const council = JSON.parse(fs.readFileSync(profile.councilFile, 'utf8')).map(k => new ethers.Wallet(k, this.provider));
    const gov = this.contracts.ConsortiumGovernance;
    requireThat(await gov.isOwner(council[0].address) && await gov.isOwner(council[1].address) && await gov.isOwner(council[2].address), 'COUNCIL_CHANGED');
    const funding = ethers.parseEther(profile.fundAmount('actor'));
    let pending = [];
    for (const actor of ACTORS) {
      const wallet = this.wallet(actor.key);
      // Do not spend scarce faucet ETH on an account that is already funded.
      if (!this.state.operations['fund:' + actor.key] && await this.provider.getBalance(wallet.address) >= funding) continue;
      pending.push(await this.submit('fund:' + actor.key, deployer, { to: wallet.address, value: funding }));
    }
    await Promise.all(pending.map(op => this.settle(op)));
    const specs = [];
    for (const schema of SCHEMAS) specs.push(['schema:' + schema.key, 'SchemaRegistry', 'registerSchema',
      [schema.id, 1, ethers.id(canonical(schema.definition)), schema.kind, true]]);
    for (const org of ORGS) specs.push(['org:' + org.key, 'OrganizationRegistry', 'registerOrganization', [org.id, this.wallet(org.key).address, org.kind]]);
    for (const actor of HOLDERS) specs.push(['subject:' + actor.key, 'SubjectRegistry', 'registerSubject', [actor.id, this.wallet(actor.key).address]]);
    for (const org of ORGS) specs.push(['active:' + org.key, 'OrganizationRegistry', 'activateOrganization', [org.id]]);
    for (const org of ORGS) specs.push(['scope:' + org.key, 'OrganizationRegistry', 'setIssuerScope',
      [org.id, SCHEMAS.find(s => s.kind === org.kind).id, 1, true]]);
    // Submit/confirm in waves; execute registration before activation and scopes.
    const proposals = read('proposals.json', {});
    const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
    for (const [key, name, method, args] of specs) {
      const contract = this.contracts[name];
      if (!proposals[key]) { proposals[key] = { deadline }; save('proposals.json', proposals); }
      const receipt = await this.submit('proposal:' + key, council[0], { to: await gov.getAddress(),
        data: gov.interface.encodeFunctionData('submit', [await contract.getAddress(), contract.interface.encodeFunctionData(method, args), proposals[key].deadline]) });
      proposals[key].hash = receipt.hash;
    }
    await Promise.all(specs.map(async ([key]) => {
      const receipt = await this.settle(this.state.operations['proposal:' + key]);
      const event = receipt.logs.map(log => { try { return gov.interface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'ProposalSubmitted');
      requireThat(event, 'PROPOSAL_EVENT_MISSING'); proposals[key].id = event.args.proposalId.toString();
    }));
    save('proposals.json', proposals);
    pending = [];
    for (let i = 1; i <= 2; i++) for (const [key] of specs) {
      pending.push(await this.submit('confirm:' + i + ':' + key, council[i], { to: await gov.getAddress(),
        data: gov.interface.encodeFunctionData('confirm', [proposals[key].id]) }));
    }
    await Promise.all(pending.map(op => this.settle(op)));
    pending = [];
    for (const [key] of specs) pending.push(await this.submit('execute:' + key, deployer, { to: await gov.getAddress(),
      data: gov.interface.encodeFunctionData('execute', [proposals[key].id]) }));
    await Promise.all(pending.map(op => this.settle(op)));
    pending = [];
    for (const org of ORGS) {
      const wallet = this.wallet(org.key);
      pending.push(await this.submit('authorize:' + org.key, wallet, { to: await this.contracts.OrganizationRegistry.getAddress(),
        data: this.contracts.OrganizationRegistry.interface.encodeFunctionData('authorizeIssuerKey', [org.id, wallet.address]) }));
    }
    await Promise.all(pending.map(op => this.settle(op)));
    this.state.setup = true; this.persist();
  }
  async issue(actorKey, body, key) {
    const actor = this.actor(actorKey); requireThat(actor.role === 'organization', 'ACCESS_DENIED');
    const holder = this.actor(body.holder); requireThat(holder.role === 'holder', 'INVALID_HOLDER');
    const schema = SCHEMAS.find(s => s.kind === actor.kind);
    requireThat(typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 160, 'INVALID_TITLE');
    requireThat(Number.isSafeInteger(body.expiresAt) && body.expiresAt >= 0, 'INVALID_EXPIRY');
    const credentialId = id('credential:' + actorKey + ':' + key);
    const payload = { credentialId, issuerOrgId: actor.id, subjectRef: holder.id,
      schemaId: schema.id, schemaVersion: 1, expiresAt: body.expiresAt,
      claims: { title: body.title.trim(), synthetic: true } };
    const digest = ethers.id(canonical(payload));
    let doc = this.state.documents[credentialId];
    if (doc) requireThat(doc.digest === digest, 'IDEMPOTENCY_CONFLICT');
    else {
      const salt = ethers.hexlify(crypto.randomBytes(32));
      doc = { issuer: actorKey, holder: holder.key, schema: schema.key, digest,
        commitment: this.commitment(payload, salt), encrypted: this.seal(credentialId, { payload, salt }) };
      this.state.documents[credentialId] = doc; this.persist();
    }
    await this.guard();
    const data = { ...payload, commitment: doc.commitment }; delete data.claims;
    const receipt = await this.transact('issue:' + credentialId, this.wallet(actorKey), this.contracts.CredentialRegistry, 'issueCredential', [data]);
    return { credentialId, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
  }
  async seed() {
    requireThat(this.state.setup, 'RUN_SETUP_FIRST');
    for (let i = 0; i < ORGS.length; i++) {
      const org = ORGS[i];
      await this.issue(org.key, { holder: HOLDERS[i % 3].key, title: SCHEMAS.find(s => s.kind === org.kind).name + ' — mẫu ' + org.name, expiresAt: 0 }, 'seed-v1');
    }
  }
  async grant(actorKey, body, key) {
    const actor = this.actor(actorKey); requireThat(actor.role === 'holder', 'ACCESS_DENIED');
    const grantee = this.actor(body.grantee); requireThat(grantee.role === 'organization' && grantee.kind === 1, 'INVALID_GRANTEE');
    requireThat(Array.isArray(body.credentialIds) && body.credentialIds.length > 0 && body.credentialIds.length <= 32, 'INVALID_SCOPE');
    const scope = [...new Set(body.credentialIds)].sort();
    for (const credentialId of scope) requireThat(this.state.documents[credentialId]?.holder === actorKey, 'ACCESS_DENIED');
    requireThat(Number.isSafeInteger(body.expiresAt) && body.expiresAt > 0, 'INVALID_EXPIRY');
    const consentId = id('consent:' + actorKey + ':' + key);
    const fingerprint = ethers.id(canonical({ scope, grantee: grantee.key, expiresAt: body.expiresAt }));
    let saved = this.state.consents[consentId];
    if (saved) requireThat(saved.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
    const snap = await this.guard();
    if (!saved) {
      const [subject] = await this.call('SubjectRegistry', 'getSubject', [actor.id], snap);
      const [nonce] = await this.call('ConsentRegistry', 'nonces', [actor.id], snap);
      const grant = { consentId, subjectRef: actor.id, granteeOrgId: grantee.id, credentialScope: scope,
        expiresAt: body.expiresAt, subjectEpoch: subject.epoch.toString(), nonce: nonce.toString(), deadline: snap.blockTimestamp + 600 };
      const signature = await this.wallet(actorKey).signTypedData(this.domain('BesuConsentRegistry', 'ConsentRegistry'), grantTypes, grant);
      saved = { holder: actorKey, grantee: grantee.key, fingerprint, grant, signature };
      this.state.consents[consentId] = saved; this.persist();
    }
    const receipt = await this.transact('grant:' + consentId, this.wallet(actorKey), this.contracts.ConsentRegistry, 'grantConsent', [saved.grant, saved.signature]);
    return { consentId, transactionHash: receipt.hash };
  }
  async revoke(actorKey, body) {
    await this.guard();
    if (body.credentialId) {
      requireThat(this.state.documents[body.credentialId]?.issuer === actorKey, 'ACCESS_DENIED');
      const r = await this.transact('revoke:' + body.credentialId, this.wallet(actorKey), this.contracts.CredentialRegistry, 'revokeCredential', [body.credentialId]);
      return { transactionHash: r.hash };
    }
    requireThat(this.state.consents[body.consentId]?.holder === actorKey, 'ACCESS_DENIED');
    const r = await this.transact('revoke-consent:' + body.consentId, this.wallet(actorKey), this.contracts.ConsentRegistry, 'revokeConsent', [body.consentId]);
    return { transactionHash: r.hash };
  }
  async access(actorKey, credentialId, consentId, snap, allowInactiveCredential = false) {
    const actor = this.actor(actorKey);
    requireThat(actor.role === 'organization' && actor.kind === 1, 'ACCESS_DENIED');
    const doc = this.state.documents[credentialId]; requireThat(doc, 'DOCUMENT_UNAVAILABLE');
    const holder = this.actor(doc.holder);
    if (allowInactiveCredential) {
      const [consent] = await this.call('ConsentRegistry', 'getConsent', [consentId], snap);
      const [subject] = await this.call('SubjectRegistry', 'getSubject', [holder.id], snap);
      const [included] = await this.call('ConsentRegistry', 'includesCredential', [consentId, credentialId], snap);
      const [active] = await this.call('OrganizationRegistry', 'isActive', [actor.id], snap);
      requireThat(Number(consent.status) === 1 && consent.subjectRef === holder.id && consent.granteeOrgId === actor.id &&
        Number(consent.expiresAt) > snap.blockTimestamp && consent.subjectEpoch === subject.epoch && included && active, 'ACCESS_DENIED');
    } else {
      const [valid] = await this.call('ConsentRegistry', 'isConsentValid', [consentId, holder.id, actor.id, credentialId], snap);
      requireThat(valid, 'ACCESS_DENIED');
    }
    return { doc, holder, actor };
  }
  async challenge(actorKey, body) {
    const snap = await this.guard();
    const { holder, actor } = await this.access(actorKey, body.credentialId, body.consentId, snap);
    const [subject] = await this.call('SubjectRegistry', 'getSubject', [holder.id], snap);
    const challengeId = ethers.hexlify(crypto.randomBytes(32));
    const value = { challengeId, nonce: ethers.hexlify(crypto.randomBytes(32)), credentialId: body.credentialId,
      consentId: body.consentId, subjectRef: holder.id, audience: actor.id,
      subjectEpoch: subject.epoch.toString(), expiresAt: Math.floor(Date.now() / 1000) + 300 };
    this.state.challenges[challengeId] = { value, holder: holder.key, verifier: actorKey, consumed: false };
    this.persist(); return { challengeId, value };
  }
  async signChallenge(actorKey, challengeId) {
    const row = this.state.challenges[challengeId];
    requireThat(row && row.holder === actorKey && !row.consumed, 'ACCESS_DENIED');
    requireThat(row.value.expiresAt > Math.floor(Date.now() / 1000), 'CHALLENGE_EXPIRED');
    const signature = await this.wallet(actorKey).signTypedData(this.domain('BesuDemoVerification', 'CredentialRegistry'), challengeTypes, row.value);
    row.signature = signature; this.persist(); return { challengeId, signed: true };
  }
  async verify(actorKey, body) {
    const row = this.state.challenges[body.challengeId];
    requireThat(row && row.verifier === actorKey, 'ACCESS_DENIED');
    requireThat(!row.consumed, 'CHALLENGE_ALREADY_USED');
    requireThat(row.value.expiresAt > Math.floor(Date.now() / 1000), 'CHALLENGE_EXPIRED');
    requireThat(row.signature, 'HOLDER_SIGNATURE_REQUIRED');
    const snap = await this.guard();
    const { holder } = await this.access(actorKey, row.value.credentialId, row.value.consentId, snap, true);
    const [subject] = await this.call('SubjectRegistry', 'getSubject', [holder.id], snap);
    const signer = ethers.verifyTypedData(this.domain('BesuDemoVerification', 'CredentialRegistry'), challengeTypes, row.value, row.signature);
    requireThat(signer.toLowerCase() === subject.key.toLowerCase() && subject.epoch.toString() === row.value.subjectEpoch, 'SUBJECT_PROOF_INVALID');
    // All mutations run under one process lock and serial queue. Persist consumption before releasing data.
    row.consumed = true; row.consumedAt = new Date().toISOString(); this.persist();
    const recordResult = (result, checks, observed, extra = {}) => {
      const output = { challengeId: body.challengeId, credentialId: row.value.credentialId, verifier: actorKey,
        result, checks, checkedAt: new Date().toISOString(), blockNumber: observed.blockNumber, blockHash: observed.blockHash,
        chainId: observed.chainId, finality: 'latest', simulation: body.simulateTamper === true, ...extra };
      this.state.results.push(output); this.persist(); return output;
    };
    const [effective] = await this.call('CredentialRegistry', 'getEffectiveStatus', [row.value.credentialId], snap);
    const lifecycleStatus = ['NONE', 'ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED'][Number(effective)];
    if (lifecycleStatus !== 'ISSUED') {
      await this.chain.assertCanonical(snap);
      return recordResult(['REVOKED', 'SUPERSEDED', 'EXPIRED'].includes(lifecycleStatus) ? lifecycleStatus : 'INDETERMINATE',
        { subjectProofValid: true, consentValid: true, credentialActive: false }, snap, { lifecycleStatus });
    }
    let { payload, salt } = this.unseal(row.value.credentialId);
    if (body.simulateTamper === true) payload = { ...payload, claims: { ...payload.claims, title: 'Dữ liệu bị sửa trong kịch bản demo' } };
    const [credential] = await this.call('CredentialRegistry', 'getCredential', [row.value.credentialId], snap);
    const [org] = await this.call('OrganizationRegistry', 'getOrganization', [credential.data.issuerOrgId], snap);
    const [period] = await this.call('OrganizationRegistry', 'getKeyPeriod', [credential.data.issuerOrgId, credential.issuerKey, credential.issuerKeyVersion - 1n], snap);
    const schema = SCHEMAS.find(s => s.id === credential.data.schemaId);
    const [schemaOnChain] = await this.call('SchemaRegistry', 'getSchema', [credential.data.schemaId, credential.data.schemaVersion], snap);
    const checks = {
      subjectProofValid: true, consentValid: true,
      commitmentMatches: this.commitment(payload, salt) === credential.data.commitment,
      metadataMatches: payload.issuerOrgId === credential.data.issuerOrgId && payload.subjectRef === credential.data.subjectRef &&
        payload.schemaId === credential.data.schemaId && payload.schemaVersion === Number(credential.data.schemaVersion) && payload.expiresAt === Number(credential.data.expiresAt),
      issuerKeyAtIssuance: period.authorizedBlock <= credential.issuedBlock && (period.revokedBlock === 0n || period.revokedBlock >= credential.issuedBlock),
      schemaDefinitionMatches: schema ? ethers.id(canonical(schema.definition)) === schemaOnChain.definitionHash : null,
      credentialActive: true,
      issuerPolicyAccepted: Number(org.status) === 2,
    };
    // Current canIssue is not used for old credentials: successful issuance enforces historical scope in this deployed contract.
    const current = await this.guard();
    await this.access(actorKey, row.value.credentialId, row.value.consentId, current);
    const [currentSubject] = await this.call('SubjectRegistry', 'getSubject', [holder.id], current);
    requireThat(currentSubject.epoch === subject.epoch, 'SUBJECT_CHANGED_DURING_VERIFICATION');
    const [currentOrg] = await this.call('OrganizationRegistry', 'getOrganization', [credential.data.issuerOrgId], current);
    checks.issuerPolicyAccepted = Number(currentOrg.status) === 2;
    const original = await this.provider.getBlock(snap.blockNumber);
    requireThat(original?.hash === snap.blockHash, 'CHAIN_REORGANIZED');
    await this.chain.assertCanonical(current);
    const result = verdict(checks);
    const output = recordResult(result, checks, current,
      result === 'INDETERMINATE' ? { reason: 'UNSUPPORTED_SCHEMA' } : result === 'REVIEW_REQUIRED' ? { reason: 'ISSUER_NOT_ACTIVE' } : {});
    return result === 'VALID' ? { ...output, payload } : output;
  }
  async snapshot(actorKey) {
    const actor = this.actor(actorKey);
    const snap = await this.guard();
    const documents = [];
    // Capture membership before awaiting RPC; state reads never queue behind a slow transaction.
    const savedDocuments = Object.entries(this.state.documents);
    const savedConsents = Object.entries(this.state.consents);
    const savedChallenges = Object.entries(this.state.challenges).map(([key, value]) => [key, { ...value }]);
    const savedResults = this.state.results.filter(r => r.verifier === actorKey).slice(-30);
    for (const [credentialId, doc] of savedDocuments) {
      if (doc.issuer !== actorKey && doc.holder !== actorKey && !Object.values(this.state.consents).some(c => c.grantee === actorKey && c.grant.credentialScope.includes(credentialId))) continue;
      const [status] = await this.call('CredentialRegistry', 'getEffectiveStatus', [credentialId], snap);
      documents.push({ credentialId, issuer: doc.issuer, holder: doc.holder, schema: doc.schema,
        status: ['NONE', 'ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED'][Number(status)] });
    }
    const consents = [];
    for (const [consentId, c] of savedConsents) {
      if (c.holder !== actorKey && c.grantee !== actorKey) continue;
      const operation = this.state.operations['grant:' + consentId];
      if (operation?.status !== 'CONFIRMED') continue;
      // A confirmed operation may be newer than this pinned read snapshot.
      if (operation.blockNumber > snap.blockNumber) continue;
      const [record] = await this.call('ConsentRegistry', 'getConsent', [consentId], snap);
      const [subject] = await this.call('SubjectRegistry', 'getSubject', [c.grant.subjectRef], snap);
      consents.push({ consentId, holder: c.holder, grantee: c.grantee, credentialIds: c.grant.credentialScope,
        expiresAt: c.grant.expiresAt, status: Number(record.status) === 2 ? 'REVOKED' :
          Number(record.expiresAt) <= snap.blockTimestamp ? 'EXPIRED' : record.subjectEpoch !== subject.epoch ? 'INVALIDATED' : 'GRANTED' });
    }
    await this.chain.assertCanonical(snap);
    return { actor, actors: ACTORS, schemas: SCHEMAS.map(({ definition, ...s }) => s), documents, consents,
      challenges: savedChallenges.filter(([, c]) => c.holder === actorKey || c.verifier === actorKey)
        .map(([challengeId, c]) => ({ challengeId, holder: c.holder, verifier: c.verifier, credentialId: c.value.credentialId,
          expiresAt: c.value.expiresAt, consumed: c.consumed, signed: !!c.signature })),
      results: savedResults.map(result => ({ ...result, historical: true })),
      blockNumber: snap.blockNumber, finality: snap.finality, indexer: this.indexStatus };
  }
}
module.exports = { Demo, ACTORS, SCHEMAS, ORGS, HOLDERS, dir, base, json, canonical, requireThat };
