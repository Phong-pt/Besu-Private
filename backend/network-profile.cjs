// Selects the target chain. NETWORK_PROFILE=local (default) keeps the original
// local PoS paths and behaviour. Any other profile is a public/shared testnet and
// must be configured explicitly through environment variables; mainnets are refused.
const fs = require('node:fs');
const path = require('node:path');

const local = process.env.BESU_STATE_DIR || path.resolve(__dirname, '../network/pos/.local');
const modules = process.env.NODE_MODULES_DIR || path.join(local, 'contract-tools/node_modules');
const LOCAL_CHAIN_ID = 20261104n;
// Ethereum, OP, BNB, Gnosis, Polygon, Base, Arbitrum One, Avalanche C-Chain, Linea, Scroll, zkSync Era.
const MAINNETS = new Set([1n, 10n, 56n, 100n, 137n, 8453n, 42161n, 43114n, 59144n, 534352n, 324n]);

const name = process.env.NETWORK_PROFILE || 'local';
if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('INVALID_NETWORK_PROFILE');
const isLocal = name === 'local';
function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(key + '_REQUIRED');
  return value;
}
const chainId = isLocal ? LOCAL_CHAIN_ID : BigInt(required('CHAIN_ID'));
if (MAINNETS.has(chainId)) throw new Error('MAINNET_NOT_SUPPORTED');
// A blacklist alone cannot identify future or less common mainnets.
const TESTNETS = new Set([LOCAL_CHAIN_ID, 11155111n, 560048n]);
if (!TESTNETS.has(chainId)) throw new Error('UNSUPPORTED_TESTNET');
const rpcUrl = isLocal ? (process.env.BESU_RPC_URL || 'http://127.0.0.1:8545') : required('RPC_URL');
// Public profiles keep their deployment, council keys and demo state apart from the local chain.
const stateDir = isLocal ? local : path.join(local, 'networks', name);
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

function deployerKey() {
  const file = isLocal ? path.join(local, 'accounts/deployer/key') : required('DEPLOYER_KEY_FILE');
  if (!isLocal && (fs.statSync(file).mode & 0o077) !== 0) throw new Error('DEPLOYER_KEY_FILE_MUST_BE_MODE_600');
  return fs.readFileSync(file, 'utf8').trim();
}
// Local genesis has abundant test ETH. Faucet ETH is scarce, so public amounts are explicit.
function fundAmount(kind) {
  if (isLocal) return '1';
  const value = required(kind === 'council' ? 'FUND_COUNCIL_ETH' : 'FUND_ACTOR_ETH');
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('INVALID_FUND_AMOUNT');
  return value;
}
const logBlockRange = Number(process.env.LOG_BLOCK_RANGE || 1000);
if (!Number.isSafeInteger(logBlockRange) || logBlockRange < 1 || logBlockRange > 10000) throw new Error('INVALID_LOG_BLOCK_RANGE');
// RPC URLs of hosted providers usually embed an API key; never print them.
const redact = text => String(text).split(rpcUrl).join('<RPC_URL>');

module.exports = { name, isLocal, chainId, rpcUrl, stateDir, modules, deployerKey, fundAmount, logBlockRange, redact,
  deploymentFile: path.join(stateDir, 'contracts-deployment.json'),
  councilFile: path.join(stateDir, 'council-keys.json'),
  verifierUrl: process.env.VERIFIER_URL || (isLocal ? 'http://127.0.0.1:8081' : null) };
