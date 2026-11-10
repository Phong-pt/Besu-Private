const fs = require('node:fs');
const path = require('node:path');
const profile = require('./network-profile.cjs');
const { ethers } = require(path.join(profile.modules, 'ethers'));

const CHAIN_ID = profile.chainId;
const STATUSES = ['NONE', 'ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED'];

class Chain {
  constructor() {
    this.deployment = JSON.parse(fs.readFileSync(profile.deploymentFile, 'utf8'));
    this.namespace = ethers.id('besu-business-demo-v1:' + this.deployment.genesis +
      JSON.stringify(Object.values(this.deployment.contracts).map(entry => entry.address)));
    // Older local records have no chainId field; the profile chain ID still applies.
    if (this.deployment.chainId && BigInt(this.deployment.chainId) !== CHAIN_ID) throw new Error('CHAIN_IDENTITY_MISMATCH');
    const request = new ethers.FetchRequest(profile.rpcUrl);
    request.timeout = 5000;
    this.provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
    const artifact = this.deployment.contracts.CredentialRegistry;
    this.address = ethers.getAddress(artifact.address);
    this.contract = new ethers.Contract(this.address, artifact.abi, this.provider);
    this.maxAge = Number(process.env.CHAIN_MAX_AGE_SECONDS || 120);
    if (!Number.isSafeInteger(this.maxAge) || this.maxAge < 1 || this.maxAge > 3600) {
      throw new Error('Invalid CHAIN_MAX_AGE_SECONDS');
    }
  }

  async snapshot() {
    const [chainId, genesis, latest, syncing] = await Promise.all([
      this.provider.send('eth_chainId', []),
      this.provider.getBlock(0),
      this.provider.getBlock('latest'),
      this.provider.send('eth_syncing', []),
    ]);
    if (BigInt(chainId) !== CHAIN_ID || !genesis || genesis.hash !== this.deployment.genesis) {
      throw new Error('CHAIN_IDENTITY_MISMATCH');
    }
    const now = Math.floor(Date.now() / 1000);
    if (syncing !== false || !latest || now - latest.timestamp > this.maxAge || latest.timestamp > now + 15) {
      throw new Error('CHAIN_NOT_FRESH');
    }
    // EIP-1898 pins reads to one canonical block, including across a reorg.
    const block = { blockHash: latest.hash, requireCanonical: true };
    const codes = await Promise.all(Object.values(this.deployment.contracts)
      .map(entry => this.provider.send('eth_getCode', [entry.address, block])));
    if (codes.some(code => !code || code === '0x')) throw new Error('CONTRACT_UNAVAILABLE');
    return { block, chainId: CHAIN_ID.toString(), blockNumber: latest.number,
      blockHash: latest.hash, blockTimestamp: latest.timestamp, finality: 'latest' };
  }

  async assertCanonical(snapshot) {
    const current = await this.provider.getBlock(snapshot.blockNumber);
    if (!current || current.hash !== snapshot.blockHash) throw new Error('CHAIN_REORGANIZED');
  }

  async call(method, args, snapshot) {
    const data = this.contract.interface.encodeFunctionData(method, args);
    const result = await this.provider.send('eth_call', [{ to: this.address, data }, snapshot.block]);
    return this.contract.interface.decodeFunctionResult(method, result);
  }

  async credential(id) {
    const snapshot = await this.snapshot();
    const [rawStatus] = await this.call('getEffectiveStatus', [id], snapshot);
    const lifecycleStatus = STATUSES[Number(rawStatus)];
    if (!lifecycleStatus) throw new Error('UNEXPECTED_CONTRACT_RESULT');
    let record = null;
    if (lifecycleStatus !== 'NONE') {
      const [entry] = await this.call('getCredential', [id], snapshot);
      record = { issuedAt: Number(entry.issuedAt), expiresAt: Number(entry.data.expiresAt),
        replacementId: entry.replacementId === ethers.ZeroHash ? null : entry.replacementId };
    }
    // Also catch a reorg after the last contract read.
    await this.assertCanonical(snapshot);
    const { block, ...observedAt } = snapshot;
    return { lifecycleStatus, record, observedAt };
  }

  close() { this.provider.destroy(); }
}

module.exports = { Chain };
