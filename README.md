# zombie-remote
A "universal remote" for abandoned smart contracts.

Thousands of DeFi contracts still hold withdrawable funds, but their frontends are dead, their teams vanished, or a UI never existed past a hackathon demo. If you know the contract address, the funds are still technically yours to pull — you just have no way to call the contract.

This tool takes any contract address and:

Fetches its verified ABI from Etherscan/block explorers (if verified).
If unverified, decodes likely functions straight from the deployed bytecode using 4-byte function-selector analysis (via WhatsABI), so you still get a usable interface even with zero source code.
Auto-generates a minimal interaction UI — one form per function — so you can call any function, including withdraw, claim, redeem, sweep, etc.
Flags likely "rescue" functions (withdraw/claim/redeem/exit/sweep/emergency*) in their own highlighted section so you don't have to hunt through 40 functions.
Lets you connect your wallet (MetaMask / any injected EIP-1193 provider) and send the transaction directly — no custom contract, no backend required.
No build step. No framework. Just open index.html.

Why this is a good hackathon submission
It's a tool, not a product. No fake user growth pitch — it solves a real, narrow, technically satisfying problem: bytecode → usable UI.
Demoable in under 2 minutes: paste an old/abandoned/orphaned contract address → watch it generate a full call interface live.
Actually novel-ish angle: most "contract explorer" tools (Etherscan's own Read/Write Contract tabs) require a verified contract. This one still works when there's no ABI at all, via selector decoding — that's the technical hook.
Project structure
zombie-protocol-rescue/
├── README.md              <- you are here
├── index.html             <- the whole app shell
├── style.css              <- dark "terminal/forensics" themed UI
├── app.js                 <- wallet connect, ABI fetch, bytecode decode, dynamic form generation
├── abi-decoder.js          <- bytecode -> function selector -> best-guess ABI logic
└── config.example.js       <- where to put your free Etherscan API key
Setup (2 minutes)
Unzip this folder.
Copy config.example.js to config.js and paste in a free Etherscan API key (get one instantly at https://etherscan.io/myapikey — no approval wait). You can also just paste the key into the app's settings field at runtime; config.js is only a convenience default.
Open index.html in a browser (or run any static server, e.g. npx serve .).
Make sure MetaMask (or similar) is installed if you want to actually send transactions — read-only inspection works without a wallet.
Demo script for judges
Paste in a known dead/abandoned contract address (or a testnet contract you deployed and "forgot" on purpose for the demo).
Show the app pulling the verified ABI instantly and rendering every function as a form — point out the "Possible Rescue Functions" section auto-detected at the top.
Then paste an unverified contract address and show the fallback path: the app disassembles the bytecode, extracts 4-byte selectors, matches them against the public 4byte.directory signature database, and still produces a working call UI with best-guess function names/params.
Connect a wallet, call a read function live, then (optionally) simulate a write call to show the transaction being built.
How the bytecode decoding actually works
Fetch the deployed bytecode via eth_getCode.
Scan the bytecode for PUSH4 opcodes immediately followed by comparison patterns (EQ/JUMPI) — this is how Solidity's function dispatcher checks msg.sig against known selectors. Each one found is a real callable 4-byte selector on that contract.
Look up each selector against a local common-selector table (withdraw, claim, redeem, transfer, approve, etc.) and, if not found there, query the public 4byte.directory signature database.
Build a best-guess ABI fragment for each match (name + guessed param types from the signature text) and feed it into the same dynamic-form renderer used for verified ABIs.
This is exactly the same trick tools like WhatsABI / Etherscan's own "unverified contract" heuristics use — nothing exotic, just genuinely useful and not built into a friendly UI anywhere.
