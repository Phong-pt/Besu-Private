// Deploys to the chain selected by NETWORK_PROFILE (default: local PoS testnet).
// Private keys and deployment records stay in .local (public profiles: .local/networks/<name>).
const fs = require('fs');
const path = require('path');
const root = __dirname;
const profile = require('../../backend/network-profile.cjs');
const modules = profile.modules;
const solc = require(path.join(modules, 'solc'));
const { ethers } = require(path.join(modules, 'ethers'));
const sourceDir = path.resolve(root, '../../contracts/src');
const deploymentFile = profile.deploymentFile;
const councilFile = profile.councilFile;

async function main() {
  const provider = new ethers.JsonRpcProvider(profile.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== profile.chainId) throw Error('Unexpected chain ID');
  const genesis = await provider.getBlock(0);
  const fresh = profile.isLocal ? { genesis: genesis.hash, contracts: {} }
    : { network: profile.name, chainId: profile.chainId.toString(), genesis: genesis.hash, contracts: {} };
  const existing = fs.existsSync(deploymentFile) ? JSON.parse(fs.readFileSync(deploymentFile)) : fresh;
  if (existing.genesis !== genesis.hash) throw Error('Deployment belongs to another chain');
  let council;
  if (fs.existsSync(councilFile)) council = JSON.parse(fs.readFileSync(councilFile));
  else {
    council = Array.from({length: 5}, () => ethers.Wallet.createRandom().privateKey);
    fs.writeFileSync(councilFile, JSON.stringify(council), {mode: 0o600, flag: 'wx'});
  }
  const deployer = new ethers.Wallet(profile.deployerKey(), provider);
  console.log('Network:', profile.name, 'chain', profile.chainId.toString(), 'deployer', deployer.address,
    'balance', ethers.formatEther(await provider.getBalance(deployer.address)), 'ETH');
  const ownerAddresses = council.map(key => new ethers.Wallet(key).address);
  const funding = ethers.parseEther(profile.fundAmount('council'));
  // The five independent test council accounts need gas to submit/confirm proposals.
  for (const address of ownerAddresses) {
    if (await provider.getBalance(address) === 0n) {
      const tx = await deployer.sendTransaction({to: address, value: funding});
      await tx.wait();
    }
  }
  const sources = {};
  for (const name of fs.readdirSync(sourceDir).filter(n => n.endsWith('.sol'))) sources[name] = {content: fs.readFileSync(path.join(sourceDir, name), 'utf8')};
  sources['base/Governed.sol'] = {content: fs.readFileSync(path.join(sourceDir, 'base/Governed.sol'), 'utf8')};
  const input = {language:'Solidity', sources, settings:{optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:'cancun', outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const output = JSON.parse(solc.compile(JSON.stringify(input), {import: name => {
    const file = path.join(modules, name);
    return fs.existsSync(file) ? {contents: fs.readFileSync(file, 'utf8')} : {error:'Missing import '+name};
  }}));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  const save = () => fs.writeFileSync(deploymentFile, JSON.stringify(existing, null, 2) + '\n', {mode:0o600});
  async function deploy(name, args) {
    if (existing.contracts[name]) {
      if (await provider.getCode(existing.contracts[name].address) === '0x') throw Error('Missing deployed contract: '+name);
      return existing.contracts[name].address;
    }
    const artifact = output.contracts[name+'.sol'][name];
    const factory = new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, deployer);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    existing.contracts[name] = {address, transactionHash: contract.deploymentTransaction().hash, abi: artifact.abi};
    save();
    console.log(name, address);
    return address;
  }
  const governance = await deploy('ConsortiumGovernance', [ownerAddresses]);
  const schemas = await deploy('SchemaRegistry', [governance]);
  const organizations = await deploy('OrganizationRegistry', [governance, schemas]);
  const subjects = await deploy('SubjectRegistry', [governance]);
  const credentials = await deploy('CredentialRegistry', [governance, organizations, subjects]);
  await deploy('ConsentRegistry', [governance, credentials]);
  console.log('Council addresses:', ownerAddresses.join(', '));
  console.log('Council keys:', councilFile);
  console.log('Deployment:', deploymentFile);
}
main().catch(e => { console.error(profile.redact(e.message)); process.exitCode = 1; });
