# 🧟‍♂️ zombie-remote

### The universal remote for abandoned smart contracts.

Thousands of DeFi and Web3 contracts still hold withdrawable funds long after their frontends have disappeared, their teams have vanished, or their projects were abandoned after a hackathon.

The blockchain doesn't care if the website is dead.

**If you know the contract address, the contract may still be callable.**

`zombie-remote` gives you a simple interface for interacting with those "zombie" contracts — even when there is no frontend and, in many cases, no verified source code.

> **Contract address → ABI / bytecode analysis → generated interface → direct wallet interaction**

No backend.
No custom contract.
No framework.
No build step.

Just open `index.html`.

---

## ⚡ What It Does

Give `zombie-remote` a contract address and it will:

* 🔎 Fetch the contract's verified ABI from an Etherscan-compatible explorer API
* 🧟 Fall back to deployed bytecode analysis when the contract is unverified
* 🧩 Extract `PUSH4` function selectors from the contract dispatcher
* 🔤 Resolve selectors using a local signature database and [4byte.directory](https://www.4byte.directory/)
* 🖥️ Automatically generate a minimal UI for interacting with discovered functions
* 🚨 Highlight likely recovery-related functions such as `withdraw`, `claim`, `redeem`, `exit`, `sweep`, and `emergency*`
* 👛 Connect directly to an injected EIP-1193 wallet such as MetaMask
* ⛓️ Read from and write to the contract directly from the browser
* 🧬 Detect common EIP-1967 and beacon proxies before recovering an ABI
* ⚠️ Show mutability uncertainty and emergency-function warnings
* 🧾 Keep local function-call history and bookmarks in the browser
* 💰 Detect selected ERC-20 balances held by the target contract
* 📈 Analyze recent event activity and calculate a contract risk score

The goal is simple:

> **Turn abandoned contract bytecode back into a usable interface.**

---

# 🧠 The Problem

Smart-contract projects often die before their contracts do.

A project might have:

* A broken or deleted frontend
* An abandoned GitHub repository
* A team that disappeared
* A hackathon demo that was never maintained
* An unverified contract with no published ABI
* Funds still sitting inside the contract

Normally, interacting with the contract requires manually reconstructing the ABI or writing custom scripts.

For a technically capable user, the contract may still be perfectly usable.

For everyone else:

**the frontend is gone, so the contract might as well be gone too.**

`zombie-remote` attacks this exact gap.

---

# 💡 The Solution

`zombie-remote` treats the blockchain itself as the source of truth.

Instead of asking:

> "Does this project still have a website?"

It asks:

> **"What can this contract actually do?"**

The application analyzes the contract and builds an interaction interface dynamically.

### Verified contract

```text
Contract Address
       ↓
Explorer API
       ↓
Verified ABI
       ↓
Function Parser
       ↓
Generated UI
```

### Unverified contract

```text
Contract Address
       ↓
eth_getCode
       ↓
Deployed Bytecode
       ↓
PUSH4 Selector Scanner
       ↓
4-byte Function Selector
       ↓
Signature Lookup
       ↓
Best-Guess ABI
       ↓
Generated UI
```

Both paths ultimately feed the same interface generator.

---

## 🚨 Possible Recovery Functions

This means a rightful owner or authorized operator does not have to scroll through dozens of unrelated functions while investigating their own contract or recovering their own assets. Finding a selector does **not** grant permission to call it: access control such as `onlyOwner`, role checks, pausability, and other contract rules still apply. An unauthorized call should revert, and users must verify ownership, authorization, destination, parameters, and expected effects before signing anything.

> **Important:** These are heuristic matches, not guarantees that a function can safely recover funds or that the connected wallet is authorized.

Always inspect the function, parameters, contract behavior, authorization rules, and transaction before signing.

---

# 🧬 How Unverified Contract Detection Works

This is the technical hook of the project.

When a contract isn't verified, there may be no ABI available.

But the deployed bytecode still contains the contract's function dispatcher.

Solidity contracts commonly compare `msg.sig` against known 4-byte function selectors.

For example:

```text
PUSH4 0xa9059cbb
   ↓
EQ
   ↓
JUMPI
```

The `PUSH4` value represents a function selector.

`zombie-remote` scans deployed bytecode for these dispatcher patterns and extracts likely selectors.

Conceptually:

```text
Bytecode
   ↓
Scan PUSH4 instructions
   ↓
Identify dispatcher comparisons
   ↓
Extract 4-byte selectors
   ↓
Lookup selector signatures
   ↓
Generate ABI fragments
```

A selector such as:

```text
0xa9059cbb
```

can be resolved to a known signature such as:

```text
transfer(address,uint256)
```

The resulting signature is then converted into a best-guess ABI fragment that can be consumed by the same dynamic UI renderer used for verified contracts.

---

# 🔬 Signature Resolution

Function selectors are resolved using multiple sources.

### 1. Local selector knowledge

Common functions are recognized immediately:

```text
withdraw
claim
redeem
transfer
approve
deposit
stake
unstake
...
```

### 2. 4byte.directory

Unknown selectors can be queried against the public:

[4byte.directory](https://www.4byte.directory/)

signature database.

This allows the application to go from:

```text
0x2e1a7d4d
```

to a likely function signature such as:

```text
withdraw(uint256)
```

The result is treated as a **best guess**, not guaranteed ground truth.

---

# 🖥️ Dynamic Interface Generation

Once function information has been recovered, `zombie-remote` automatically creates an interaction form.

For example:

```text
withdraw(uint256)

Amount
[________________]

[ Execute ]
```

Or:

```text
balanceOf(address)

Address
[________________]

[ Read ]
```

The interface is generated from the discovered ABI fragments rather than being hardcoded for a specific protocol.

This is what makes the tool "universal."

---

# 👛 Wallet Interaction

The application uses the standard **EIP-1193** wallet interface.

Compatible injected wallets can provide the browser provider, including wallets such as MetaMask.

The application can:

* Detect an injected wallet
* Connect the user's account
* Read contract state
* Build contract calls
* Request transaction signatures
* Submit transactions directly to the blockchain

There is no custom backend sitting between the user and the contract.

---

# 🔐 Security Model

`zombie-remote` does **not** take custody of funds.

Transactions are signed by the user's wallet.

The application does not deploy an intermediary rescue contract.

The interaction path is:

```text
User
 ↓
Browser
 ↓
Wallet
 ↓
Blockchain
 ↓
Target Contract
```

That keeps the architecture simple and transparent.

### ⚠️ Important

A discovered function is **not automatically safe**.

Bytecode analysis and signature databases are heuristic.

A function named `withdraw` could mean many different things depending on the contract.

Users should verify:

* Contract address
* Network
* Function signature
* Parameters
* Token approvals
* Transaction destination
* Expected state changes
* Gas costs

before signing any transaction.

---

# 🛠️ Tech Stack

| Layer              | Technology                        |
| ------------------ | --------------------------------- |
| Frontend           | Vanilla JavaScript (ES6+)         |
| Blockchain         | ethers.js v6                      |
| Wallet             | EIP-1193                          |
| RPC                | Cloudflare Ethereum + public RPCs |
| Explorer APIs      | Etherscan-compatible APIs         |
| Signature Database | 4byte.directory                   |
| Bytecode Analysis  | Custom PUSH4 opcode scanner       |
| Styling            | Vanilla CSS                       |
| Build System       | None                              |

### Philosophy

**No framework. No build system. No backend.**

The entire application can run as a static website.

---

# 📁 Project Structure

```text
zombie-protocol-rescue/
│
├── README.md
├── index.html
├── style.css
├── app.js
├── abi-decoder.js
└── config.example.js
```

### `index.html`

The application shell and UI structure.

### `style.css`

Dark, terminal-inspired "forensics" interface.

### `app.js`

Handles:

* Wallet connection
* Network selection
* Explorer API requests
* Contract inspection
* ABI retrieval
* Bytecode retrieval
* Dynamic form generation
* Read/write interactions

### `abi-decoder.js`

Handles:

* Bytecode scanning
* `PUSH4` detection
* Function selector extraction
* Signature lookup
* Best-guess ABI generation

### `config.example.js`

Optional configuration template for explorer API keys.

---

# 🚀 Setup

## 1. Clone / unzip the project

```bash
git clone <your-repository>
cd zombie-protocol-rescue
```

Or simply unzip the project folder.

---

## 2. Configure an explorer API key

Copy:

```text
config.example.js
```

to:

```text
config.js
```

Then add your Etherscan API key.

You can get one from:

https://etherscan.io/myapikey

The application can also allow the key to be entered at runtime, so `config.js` is only a convenience default.

> **MVP limitation:** this is a browser-only demo, so any explorer API key entered in `config.js` or the form is visible to the user and should be treated as public. Use a restricted, rate-limited demo key only. A production deployment should proxy explorer requests through a backend or serverless function and keep the key there.

---

## 3. Run the application

Because this is a static application, there is no build process.

You can use any static server.

For example:

```bash
npx serve .
```

Then open the displayed local URL in your browser.

You can also host the project on any static hosting provider.

---

# ⚠️ Limitations

Bytecode-based ABI recovery is inherently heuristic.

The tool is intended for owners and authorized operators investigating or recovering assets from contracts they control. Discovering a function selector is not an authorization mechanism. Contract-level rules such as `onlyOwner`, role checks, pausability, and custom validation still decide whether a call succeeds; unauthorized calls should revert.

`zombie-remote` cannot guarantee that:

* A selector corresponds to exactly one human-readable signature
* A resolved signature represents the original source-level function
* Parameter types are correct in every case
* A function is safe to call
* A function will successfully execute
* A function named `withdraw` actually allows the current user to withdraw funds

Proxy contracts can also complicate analysis because the executable logic may live in an implementation contract rather than directly in the proxy's bytecode.

Therefore:

> **Recovered interfaces should be treated as best-effort forensic information, not authoritative ABI definitions.**

---

# 🔮 Future Improvements

Potential extensions include:

* 🧬 Automatic proxy / implementation detection
* 🪙 ERC-20 / ERC-721 / ERC-1155 balance detection
* 💰 Automatic detection of valuable assets held by a contract
* 🧠 More advanced ABI inference
* 🔍 Better selector disambiguation
* 🧾 Transaction simulation before signing
* 📊 Contract activity timeline
* 🧩 Event signature recovery
* 🕵️ Contract behavior / opcode analysis
* 🌐 Additional EVM networks
* 📦 Local signature database for offline operation
* 🛡️ Risk warnings for suspicious functions
* 🧪 Testnet "safe mode" for hackathon demonstrations

---

# 🧟 Final Pitch

**The frontend died.**

**The contract didn't.**

`zombie-remote` is a universal remote for abandoned smart contracts — turning contract addresses and raw bytecode into a usable interface for inspection and interaction.

```text
             DEAD FRONTEND
                   💀
                    │
                    ▼
             CONTRACT ADDRESS
                    │
                    ▼
          ┌───────────────────┐
          │   ZOMBIE-REMOTE   │
          └───────────────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
     Verified ABI        Raw Bytecode
          │                   │
          │              PUSH4 Scan
          │                   │
          │             Selector Lookup
          │                   │
          └─────────┬─────────┘
                    ▼
              GENERATED UI
                    │
                    ▼
             👛 USER WALLET
                    │
                    ▼
              ⛓️ CONTRACT
```

**The website is dead. The blockchain isn't.**
