# 🧟 Zombie Protocol Rescue Tool

**A "universal remote" for abandoned smart contracts.**

Thousands of DeFi contracts still hold withdrawable funds, but their frontends are dead,
their teams vanished, or a UI never existed past a hackathon demo. If you know the
contract address, the funds are still technically yours to pull — you just have no
way to *call* the contract.

This tool takes **any contract address** and:

1. Fetches its verified ABI from Etherscan/block explorers (if verified).
2. If **unverified**, decodes likely functions straight from the deployed **bytecode**
   using 4-byte function-selector analysis (via [WhatsABI](https://github.com/shazow/whatsabi)),
   so you still get a usable interface even with zero source code.
3. Auto-generates a minimal interaction UI — one form per function — so you can
   call **any** function, including `withdraw`, `claim`, `redeem`, `sweep`, etc.
4. Flags likely "rescue" functions (withdraw/claim/redeem/exit/sweep/emergency*) in
   their own highlighted section so you don't have to hunt through 40 functions.
5. Lets you connect your wallet (MetaMask / any injected EIP-1193 provider) and send
   the transaction directly — no custom contract, no backend required.

No build step. No framework. Just open `index.html`.

## Why this is a good hackathon submission

- **It's a tool, not a product.** No fake user growth pitch — it solves a real,
  narrow, technically satisfying problem: bytecode → usable UI.
- **Demoable in under 2 minutes:** paste an old/abandoned/orphaned contract address →
  watch it generate a full call interface live.
- **Actually novel-ish angle:** most "contract explorer" tools (Etherscan's own
  Read/Write Contract tabs) require a *verified* contract. This one still works
  when there's **no ABI at all**, via selector decoding — that's the technical hook.

## Project structure

```
zombie-protocol-rescue/
├── README.md              <- you are here
├── index.html             <- the whole app shell
├── style.css              <- dark "terminal/forensics" themed UI
├── app.js                 <- wallet connect, ABI fetch, bytecode decode, dynamic form generation
├── abi-decoder.js          <- bytecode -> function selector -> best-guess ABI logic
└── config.example.js       <- where to put your free Etherscan API key
```

## Setup (2 minutes)

1. Unzip this folder.
2. Copy `config.example.js` to `config.js` and paste in a free Etherscan API key
   (get one instantly at https://etherscan.io/myapikey — no approval wait).
   You can also just paste the key into the app's settings field at runtime;
   `config.js` is only a convenience default.
3. Open `index.html` in a browser (or run any static server, e.g. `npx serve .`).
4. Make sure MetaMask (or similar) is installed if you want to actually send
   transactions — read-only inspection works without a wallet.

## Demo script for judges

1. Paste in a known dead/abandoned contract address (or a testnet contract you
   deployed and "forgot" on purpose for the demo).
2. Show the app pulling the verified ABI instantly and rendering every function
   as a form — point out the **"Possible Rescue Functions"** section auto-detected
   at the top.
3. Then paste an **unverified** contract address and show the fallback path:
   the app disassembles the bytecode, extracts 4-byte selectors, matches them
   against the public 4byte.directory signature database, and still produces
   a working call UI with best-guess function names/params.
4. Connect a wallet, call a read function live, then (optionally) simulate a
   write call to show the transaction being built.

## How the bytecode decoding actually works

1. Fetch the deployed bytecode via `eth_getCode`.
2. Scan the bytecode for `PUSH4` opcodes immediately followed by comparison
   patterns (`EQ`/`JUMPI`) — this is how Solidity's function dispatcher checks
   `msg.sig` against known selectors. Each one found is a real callable
   4-byte selector on that contract.
3. Look up each selector against a local common-selector table (withdraw,
   claim, redeem, transfer, approve, etc.) and, if not found there, query the
   public [4byte.directory](https://www.4byte.directory/) signature database.
4. Build a best-guess ABI fragment for each match (name + guessed param types
   from the signature text) and feed it into the same dynamic-form renderer
   used for verified ABIs.

This is exactly the same trick tools like WhatsABI / Etherscan's own
"unverified contract" heuristics use — nothing exotic, just genuinely useful
and not built into a friendly UI anywhere.

## Notes / honesty for the pitch

- Selector-guessing is best-effort: on unverified contracts you get function
  **names and rough arg types**, not a guaranteed-correct ABI. The UI clearly
  labels guessed functions as "decoded (unverified)" vs "verified ABI" so
  users aren't misled.
- This tool only calls functions that are already public/external on the
  contract — it can't do anything a direct `cast send` / Etherscan
  "Write Contract" tab couldn't already do. It's an accessibility/UX layer,
  not a security bypass.
- Ship it read-only by default in the demo (`config.js` → `SEND_TX_ENABLED = false`)
  if you don't want to risk a live signed tx during Q&A — flip it on to prove
  it works end-to-end beforehand.
