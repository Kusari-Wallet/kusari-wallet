// A local chain running the real Tornado contracts, the same sources the mainnet pools were built from.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const ganache = require('ganache');
const solc = require('solc');
const genContract = require('circomlib/src/mimcsponge_gencontract.js');

const dir = path.join(__dirname, 'tornado-contracts');
const GUARD = 'pragma solidity ^0.7.0; contract ReentrancyGuard { uint256 private _g = 1; modifier nonReentrant() { _g += 1; uint256 l = _g; _; require(l == _g, "re"); } }';

async function startChain(mnemonic) {
  const sources = { '@openzeppelin/contracts/utils/ReentrancyGuard.sol': { content: GUARD } };
  for (const f of fs.readdirSync(dir)) {
    sources[`c/${f}`] = { content: fs.readFileSync(path.join(dir, f), 'utf8').replace(/import "\.\/(\w+\.sol)"/g, 'import "c/$1"') };
  }
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const bad = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (bad.length) throw new Error(bad[0].formattedMessage);

  const server = ganache.server({ wallet: { mnemonic, totalAccounts: 3, defaultBalance: 1000 }, chain: { chainId: 1, allowUnlimitedContractSize: true }, logging: { quiet: true } });
  await new Promise((res, rej) => server.listen(0, '127.0.0.1', (e) => (e ? rej(e) : res())));
  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true, polling: true, pollingInterval: 100 });
  const deployer = await provider.getSigner(1);
  const relayer = await provider.getSigner(2);
  const deploy = async (abi, code, ...args) => {
    const c = await new ethers.ContractFactory(abi, code, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const hasher = await deploy(genContract.abi, genContract.createCode('mimcsponge', 220));
  const V = out.contracts['c/Verifier.sol'].Verifier;
  const verifier = await deploy(V.abi, V.evm.bytecode.object);
  const T = out.contracts['c/ETHTornado.sol'].ETHTornado;
  const tornado = await deploy(T.abi, T.evm.bytecode.object, await verifier.getAddress(), await hasher.getAddress(), ethers.parseEther('0.1'), 20);
  return { url, provider, deployer, relayer, tornado, address: await tornado.getAddress(), stop: () => { provider.destroy(); return server.close(); } };
}

module.exports = { startChain };
