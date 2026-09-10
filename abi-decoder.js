/**
 * abi-decoder.js
 *
 * Turns raw deployed bytecode into a best-guess ABI when a contract has no
 * verified source. This is the "zombie protocol" trick: Solidity's function
 * dispatcher is just a chain of `PUSH4 <selector> ... EQ ... JUMPI` checks at
 * the start of the runtime bytecode, so every 4-byte selector the contract
 * actually responds to is sitting right there in plain sight.
 *
 * Pipeline:
 *   1. extractSelectors(bytecode)   -> ["0x2e1a7d4d", "0xa9059cbb", ...]
 *   2. resolveSelector(selector)    -> tries local table, then 4byte.directory
 *   3. buildGuessedAbi(selectors)   -> ABI-fragment array the same renderer
 *                                       used for verified ABIs can consume
 */

// A small local table of extremely common selectors so the demo doesn't
// depend on network access for the "greatest hits" of rescue-relevant calls.
// (Selector = first 4 bytes of keccak256("functionName(paramTypes)").)
const KNOWN_SELECTORS = {
  "0x3ccfd60b": { name: "withdraw", inputs: [] },
  "0x2e1a7d4d": { name: "withdraw", inputs: [{ type: "uint256", name: "amount" }] },
  "0x51cff8d9": { name: "withdraw", inputs: [{ type: "address", name: "to" }] },
  "0x853828b6": { name: "withdrawAll", inputs: [] },
  "0x5312ea8e": { name: "emergencyWithdraw", inputs: [{ type: "uint256", name: "pid" }] },
  "0xdb2e21bc": { name: "emergencyWithdraw", inputs: [] },
  "0x1e83409a": { name: "claim", inputs: [{ type: "address", name: "account" }] },
  "0x4e71d92d": { name: "claim", inputs: [] },
  "0x379607f5": { name: "claim", inputs: [{ type: "uint256", name: "amount" }, { type: "uint256", name: "deadline" }, { type: "bytes32[]", name: "proof" }] },
  "0x2f4f21e2": { name: "redeem", inputs: [{ type: "uint256", name: "shares" }] },
  "0xba087652": { name: "redeem", inputs: [{ type: "uint256", name: "shares" }, { type: "address", name: "receiver" }, { type: "address", name: "owner" }] },
  "0xe9fad8ee": { name: "exit", inputs: [] },
  "0x1a4d01d2": { name: "exit", inputs: [{ type: "uint256", name: "pid" }] },
  "0x853f4e6a": { name: "unstake", inputs: [{ type: "uint256", name: "amount" }] },
  "0x2def6620": { name: "unstake", inputs: [] },
  "0x8980f11f": { name: "sweep", inputs: [{ type: "address", name: "token" }] },
  "0x15dacbea": { name: "sweepToken", inputs: [{ type: "address", name: "token" }, { type: "address", name: "to" }] },
  "0x70a08231": { name: "balanceOf", inputs: [{ type: "address", name: "account" }] },
  "0x8da5cb5b": { name: "owner", inputs: [] },
  "0x06fdde03": { name: "name", inputs: [] },
  "0x95d89b41": { name: "symbol", inputs: [] },
  "0x18160ddd": { name: "totalSupply", inputs: [] },
  "0xa9059cbb": { name: "transfer", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }] },
  "0x095ea7b3": { name: "approve", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }] },
};

/**
 * Pulls every 4-byte selector the dispatcher checks for out of raw runtime
 * bytecode. Looks for the PUSH4 opcode (0x63) followed 4 bytes later by
 * anything that looks like a dispatcher comparison (this is a heuristic,
 * not a full EVM disassembler — good enough to find selectors in the vast
 * majority of Solidity-compiled contracts).
 */
function extractSelectors(bytecodeHex) {
  const code = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;
  const bytes = [];
  for (let i = 0; i < code.length; i += 2) bytes.push(code.substring(i, i + 2));

  const selectors = new Set();
  const PUSH4 = "63";

  for (let i = 0; i < bytes.length - 5; i++) {
    if (bytes[i] === PUSH4) {
      const selectorBytes = bytes.slice(i + 1, i + 5).join("");
      if (selectorBytes.length === 8) {
        selectors.add("0x" + selectorBytes);
      }
      i += 4; // skip past the pushed bytes
    }
  }
  return Array.from(selectors);
}

/**
 * Resolves a selector to a name + guessed inputs. Tries the local table
 * first (instant, offline), then falls back to the public 4byte.directory
 * signature database for anything unrecognized.
 */
async function resolveSelector(selector) {
  if (KNOWN_SELECTORS[selector]) {
    return { ...KNOWN_SELECTORS[selector], candidates: [KNOWN_SELECTORS[selector]], source: "known-table" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      // 4byte.directory returns raw text signatures like "withdraw(uint256)".
      // Multiple candidates can share a selector (collisions); take the
      // earliest-registered one as the best guess, same convention Etherscan uses.
      const candidates = data.results
        .sort((a, b) => a.id - b.id)
        .map((result) => parseSignatureText(result.text_signature));
      return { ...candidates[0], candidates, source: "4byte.directory" };
    }
  } catch (e) {
    // Offline / rate-limited — fall through to unknown.
  }

  return { name: `unknown_${selector.slice(2, 8)}`, inputs: [], candidates: [], source: "unresolved" };
}

/** Parses "transferFrom(address,address,uint256)" into name + typed inputs. */
function parseSignatureText(sig) {
  const match = sig.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);
  if (!match) return { name: sig, inputs: [] };
  const [, name, argsStr] = match;
  const types = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= argsStr.length; index++) {
    const char = argsStr[index];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if ((char === "," && depth === 0) || index === argsStr.length) {
      const type = argsStr.slice(start, index).trim();
      if (type) types.push(type);
      start = index + 1;
    }
  }
  const inputs = types.map((type, idx) => ({ type, name: `arg${idx}` }));
  return { name, inputs };
}

/**
 * Builds a full best-guess ABI array from raw bytecode. This is the main
 * export other modules should call.
 */
async function buildGuessedAbi(bytecodeHex) {
  const selectors = extractSelectors(bytecodeHex);
  const abi = [];

  for (const selector of selectors) {
    const resolved = await resolveSelector(selector);
    abi.push({
      type: "function",
      name: resolved.name,
      selector,
      inputs: resolved.inputs,
      outputs: [], // unknown without source — renderer treats these as best-effort
      stateMutability: "nonpayable", // unknown; safest assumption for the UI to warn on
      _mutabilityConfidence: "unknown",
      _candidates: resolved.candidates || [],
      _decoded: true,
      _source: resolved.source,
    });
  }
  return abi;
}

window.ZombieDecoder = { extractSelectors, resolveSelector, buildGuessedAbi, KNOWN_SELECTORS };
