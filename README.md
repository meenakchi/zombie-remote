# 🧟 Zombie Rescue

**Recovery intelligence for abandoned smart contracts.**

Zombie Rescue scans an EVM contract, discovers its callable interface, checks native balance and common ownership signals, highlights potential recovery paths, and simulates state-changing calls before the user is asked to sign.

## What changed

- Redesigned recovery-first UI and judge-friendly scan flow.
- Verified ABI vs bytecode-reconstructed functions are clearly separated.
- Bytecode guesses are **simulation-only** by default.
- Native ETH balance is shown as an immediate asset signal.
- Common `owner()` access control is detected and compared with the connected wallet.
- Recovery candidates receive an explainable confidence score.
- State-changing functions support `eth_call` simulation and gas estimation before execution.
- Network mismatch warnings prevent accidental signing on the wrong chain.
- Payable functions expose an ETH value field.
- BigInt-safe result formatting.
- Export the discovered ABI as JSON.
- Safer DOM rendering avoids injecting external ABI names through `innerHTML`.

## Run locally

This is a static app. Serve the directory with any local HTTP server; opening `index.html` directly may be blocked by browser CORS rules when calling RPC/explorer APIs.

Example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Configuration

Copy `config.example.js` to `config.js` and add your explorer API key if desired. `config.js` is ignored conceptually by the project instructions and should never be committed with a secret.

Configure a real testnet contract for the demo:

```js
window.ZOMBIE_CONFIG.DEMO_CONTRACT = {
  address: "0xYOUR_SEPOLIA_TEST_CONTRACT",
  network: "sepolia"
};
```

Use a contract you control and fund only with testnet assets for judging.

## Safety model

1. **Verified ABI:** normal read calls and, if explicitly enabled, live writes.
2. **Bytecode decoded:** candidate selectors are labeled as guesses; live writes are disabled.
3. **Simulation:** state-changing calls are estimated and simulated before execution.
4. **Network validation:** the connected wallet must be on the selected target chain before signing.
5. **Human confirmation:** the app never silently submits a transaction.

## Limitations

Bytecode selector extraction is heuristic and cannot reconstruct every Solidity type or function signature. A selector can have multiple possible text signatures. Asset discovery in this static build focuses on native balance; arbitrary ERC-20 enumeration requires an indexer/token-address source because an EVM contract does not expose a universal "list all tokens I own" method.

For a production version, add proxy implementation discovery, ERC-20/721/1155 inventories, stronger dispatcher analysis, simulation traces, multisig support, and a backend/indexer for cross-chain asset discovery.

## Hackathon pitch

> **Zombie Rescue turns abandoned smart contracts from black boxes into explainable, simulated, and safely recoverable assets.**
