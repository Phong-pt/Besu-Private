// Submit the exact compiler settings and source graph used by deploy-contracts.cjs.
// Works with any Blockscout API (local or e.g. https://eth-sepolia.blockscout.com via VERIFIER_URL).
const fs = require('fs');
const path = require('path');
const root = __dirname;
const profile = require('../../backend/network-profile.cjs');
const modules = profile.modules;
const solc = require(path.join(modules, 'solc'));
const sourceDir = path.resolve(root, '../../contracts/src');
const deployment = JSON.parse(fs.readFileSync(profile.deploymentFile));
if (!profile.verifierUrl) throw Error('VERIFIER_URL_REQUIRED');
const sources = {};
function add(name) {
  if (sources[name]) return;
  const filename = name.startsWith('@') ? path.join(modules, name) : path.join(sourceDir, name);
  const content = fs.readFileSync(filename, 'utf8');
  sources[name] = {content};
  const imports = content.matchAll(/import\s+(?:[^"']*?from\s*)?["']([^"']+)["']\s*;/g);
  for (const match of imports) {
    const child = match[1].startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])) : match[1];
    add(child);
  }
}
for (const name of Object.keys(deployment.contracts)) add(name + '.sol');
const input = {language:'Solidity', sources, settings:{optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:'cancun', outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
async function main() {
  const compiler = 'v' + solc.version().split('.Emscripten')[0];
  for (const [name, item] of Object.entries(deployment.contracts)) {
    const form = new FormData();
    form.append('compiler_version', compiler);
    form.append('contract_name', name+'.sol:'+name);
    form.append('files[0]', new Blob([JSON.stringify(input)], {type:'application/json'}), 'input.json');
    const response = await fetch(`${profile.verifierUrl.replace(/\/$/, '')}/api/v2/smart-contracts/${item.address}/verification/via/standard-input`, {method:'POST', body:form});
    console.log(name, response.status, await response.text());
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
