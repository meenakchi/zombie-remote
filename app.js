/* zombie-remote. contract recovery intelligence shell (ethers v6) */
let provider = null;
let signer = null;
let currentAbi = [];
let currentAddress = null;
let currentNetworkKey = null;
let currentSource = null;
let currentScan = null;
let currentProxy = null;

const $ = (id) => document.getElementById(id);
const cfg = () => window.ZOMBIE_CONFIG;

function setStatus(id, msg, kind = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-line ${kind}`.trim();
  if (id === "wallet-status") {
    const dot = $("conn-dot");
    if (dot) dot.className = `conn-dot ${kind === "ok" ? "live" : kind === "error" ? "warn" : ""}`.trim();
  }
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "n/a";
}

function safeStringify(value) {
  return JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

const HISTORY_STORAGE_KEY = "zombie-rescue-call-history";
const BOOKMARK_STORAGE_KEY = "zombie-rescue-function-bookmarks";

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (_) { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private browsing may block storage */ }
}

function functionSignature(fn) {
  return `${fn.name}(${(fn.inputs || []).map((input) => input.type).join(",")})`;
}

function functionKey(fn, address = currentAddress, networkKey = currentNetworkKey) {
  return `${networkKey}:${address}:${fn.selector || functionSignature(fn)}`;
}

function isEmergencyFunction(name = "") {
  return /emergency|drain|rescue|sweep|recover/i.test(name);
}

function recordCall(fn, status) {
  const history = readStorage(HISTORY_STORAGE_KEY, []);
  history.unshift({
    key: functionKey(fn),
    address: currentAddress,
    networkKey: currentNetworkKey,
    signature: functionSignature(fn),
    status,
    timestamp: new Date().toISOString(),
  });
  writeStorage(HISTORY_STORAGE_KEY, history.slice(0, 30));
  renderHistory();
}

function toggleBookmark(fn) {
  const bookmarks = readStorage(BOOKMARK_STORAGE_KEY, []);
  const key = functionKey(fn);
  const index = bookmarks.findIndex((bookmark) => bookmark.key === key);
  if (index >= 0) bookmarks.splice(index, 1);
  else bookmarks.unshift({ key, address: currentAddress, networkKey: currentNetworkKey, signature: functionSignature(fn) });
  writeStorage(BOOKMARK_STORAGE_KEY, bookmarks.slice(0, 50));
  renderHistory();
}

function renderHistory() {
  const list = $("history-list");
  if (!list) return;
  list.replaceChildren();
  const bookmarks = readStorage(BOOKMARK_STORAGE_KEY, []);
  const history = readStorage(HISTORY_STORAGE_KEY, []);
  [...bookmarks.map((item) => ({ ...item, kind: "bookmark" })), ...history.map((item) => ({ ...item, kind: "call" }))]
    .slice(0, 12)
    .forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";
      button.textContent = `${item.kind === "bookmark" ? "[fav]" : "[hit]"} ${item.signature} · ${item.networkKey}`;
      button.title = item.address;
      button.addEventListener("click", () => {
        $("contract-address").value = item.address;
        $("network-select").value = item.networkKey;
        decodeContract();
      });
      list.appendChild(button);
    });
  $("history-empty").hidden = list.children.length > 0;
}

function populateNetworkSelect() {
  const select = $("network-select");
  select.replaceChildren();
  Object.entries(cfg().NETWORKS).forEach(([key, net]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = net.label;
    option.selected = key === cfg().DEFAULT_NETWORK;
    select.appendChild(option);
  });
}

function getReadProvider(networkKey = currentNetworkKey) {
  const net = cfg().NETWORKS[networkKey];
  if (!net) throw new Error("Select a supported network before reading contract state.");
  return new ethers.JsonRpcProvider(net.rpc);
}

async function connectWallet(requestAccounts = true, accounts = null) {
  if (!window.ethereum) {
    setStatus("wallet-status", "No injected wallet found. Read-only scanning still works.", "error");
    return;
  }
  try {
    provider ||= new ethers.BrowserProvider(window.ethereum);
    if (requestAccounts) await provider.send("eth_requestAccounts", []);
    if (Array.isArray(accounts) && accounts.length === 0) {
      signer = null;
      setStatus("wallet-status", "Wallet disconnected. Read-only scanning still works.");
      return;
    }
    signer = await provider.getSigner();
    const address = await signer.getAddress();
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const configured = Object.entries(cfg().NETWORKS).find(([, n]) => n.chainId === chainId);
    setStatus(
      "wallet-status",
      `Connected ${shortAddress(address)} · ${configured ? configured[1].label : `Chain ${chainId}`}`,
      configured ? "ok" : "error"
    );
    validateWalletNetwork(false);
  } catch (e) {
    setStatus("wallet-status", `Connection failed: ${e.message || e}`, "error");
  }
}

async function validateWalletNetwork(showError = true, networkKey = currentNetworkKey) {
  if (!provider || !networkKey) return false;
  const net = cfg().NETWORKS[networkKey];
  const actual = await provider.getNetwork();
  const ok = Number(actual.chainId) === Number(net.chainId);
  const banner = $("network-warning");
  if (banner) {
    banner.hidden = ok;
    banner.textContent = ok ? "" : `Network mismatch: target is ${net.label}, wallet is chain ${actual.chainId}.`;
  }
  if (!ok && showError) setStatus("load-status", `Switch wallet to ${net.label} before signing.`, "error");
  return ok;
}

function validateAddress(address) {
  return typeof address === "string" && ethers.isAddress(address);
}

async function fetchVerifiedAbi(address, networkKey, apiKey) {
  const net = cfg().NETWORKS[networkKey];
  const url = `${net.explorerApi}?module=contract&action=getabi&address=${encodeURIComponent(address)}&apikey=${encodeURIComponent(apiKey || "")}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Explorer returned HTTP ${response.status}`);
  const data = await response.json();
  if (data.status === "1" && data.result) return JSON.parse(data.result);
  return null;
}

async function fetchBytecodeAbi(address, networkKey) {
  const net = cfg().NETWORKS[networkKey];
  const rpc = new ethers.JsonRpcProvider(net.rpc);
  const bytecode = await rpc.getCode(address);
  if (!bytecode || bytecode === "0x") throw new Error("No contract bytecode found at this address on the selected network.");
  return window.ZombieDecoder.buildGuessedAbi(bytecode);
}

const EIP1967_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaeea7f1b2f6a4e5f2a7d50",
};
const IMPLEMENTATION_SLOT = EIP1967_SLOTS.implementation;

function addressFromStorage(value) {
  const address = ethers.getAddress(`0x${value.slice(-40)}`);
  return /^0x0{40}$/i.test(address) ? null : address;
}

async function detectProxy(address, networkKey) {
  const readProvider = getReadProvider(networkKey);
  const [implementationSlot, adminSlot, beaconSlot] = await Promise.all(
    Object.values(EIP1967_SLOTS).map((slot) => readProvider.getStorage(address, slot))
  );
  const implementation = addressFromStorage(implementationSlot);
  const beacon = addressFromStorage(beaconSlot);
  let uups = false;
  if (implementation) {
    try {
      const implementationContract = new ethers.Contract(implementation, ["function proxiableUUID() view returns (bytes32)"], readProvider);
      uups = (await implementationContract.proxiableUUID()).toLowerCase() === IMPLEMENTATION_SLOT;
    } catch (_) {
      uups = false;
    }
  }
  let beaconImplementation = null;
  if (beacon) {
    try {
      const beaconContract = new ethers.Contract(beacon, ["function implementation() view returns (address)"], readProvider);
      beaconImplementation = await beaconContract.implementation();
    } catch (_) {
      beaconImplementation = null;
    }
  }
  return {
    implementation: implementation || beaconImplementation,
    admin: addressFromStorage(adminSlot),
    beacon,
    kind: implementation ? (uups ? "UUPS proxy" : "EIP-1967 proxy") : beaconImplementation ? "Beacon proxy" : null,
  };
}

async function getContractBalance(address, networkKey) {
  const balance = await getReadProvider(networkKey).getBalance(address);
  return { raw: balance, formatted: ethers.formatEther(balance) };
}

function isRescueFunction(name = "") {
  const lower = name.toLowerCase();
  return cfg().RESCUE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function getOwnerFunction(abi) {
  return abi.find((f) => f.type === "function" && f.name === "owner" && (!f.inputs || f.inputs.length === 0));
}

async function detectOwner(abi) {
  const ownerFn = getOwnerFunction(abi);
  if (!ownerFn || !currentAddress) return null;
  try {
    const readProvider = getReadProvider(currentNetworkKey);
    const contract = new ethers.Contract(currentAddress, [ownerFn], readProvider);
    return await contract.owner();
  } catch (_) {
    return null;
  }
}

function calculateRecoveryScore({ fn, source, hasNativeBalance, ownerMatches }) {
  let score = 25;
  if (source === "verified") score += 25;
  else if (fn._source === "known-table") score += 18;
  else if (fn._source === "4byte.directory") score += 10;
  else score -= 8;
  if (hasNativeBalance) score += 15;
  if (ownerMatches === true) score += 15;
  if (ownerMatches === false) score -= 20;
  if (fn.stateMutability === "payable") score -= 2;
  return Math.max(0, Math.min(100, score));
}

function scoreLabel(score) {
  if (score >= 80) return "HIGH CONFIDENCE";
  if (score >= 55) return "MEDIUM CONFIDENCE";
  return "LOW CONFIDENCE";
}

async function analyzeContract(abi, source) {
  const native = await getContractBalance(currentAddress, currentNetworkKey);
  const owner = await detectOwner(abi);
  let ownerMatches = null;
  if (owner && signer) ownerMatches = owner.toLowerCase() === (await signer.getAddress()).toLowerCase();
  const rescueFns = abi.filter((fn) => isRescueFunction(fn.name));
  rescueFns.forEach((fn) => {
    fn._recoveryScore = calculateRecoveryScore({ fn, source, hasNativeBalance: native.raw > 0n, ownerMatches });
  });
  return { native, owner, ownerMatches, rescueFns };
}

function renderScanSummary() {
  const panel = $("scan-summary");
  if (!currentScan) { panel.hidden = true; return; }
  panel.hidden = false;
  $("native-balance").textContent = `${currentScan.native.formatted} ETH`;
  $("recovery-count").textContent = String(currentScan.rescueFns.length);
  const scores = currentScan.rescueFns.map((f) => f._recoveryScore);
  const best = scores.length ? Math.max(...scores) : 0;
  $("recovery-score").textContent = scores.length ? `${best}/100` : "n/a";
  $("owner-status").textContent = currentScan.owner
    ? `${shortAddress(currentScan.owner)}${currentScan.ownerMatches === true ? " · caller matches" : currentScan.ownerMatches === false ? " · caller does not match" : ""}`
    : "Not detected";
  $("proxy-status").textContent = currentScan.proxy?.implementation
    ? `${currentScan.proxy.kind} · ${shortAddress(currentScan.proxy.implementation)}${currentScan.proxy.admin ? ` · admin ${shortAddress(currentScan.proxy.admin)}` : ""}`
    : "Not detected";
  $("contract-status").textContent = currentScan.native.raw > 0n || currentScan.rescueFns.length ? "Recoverable signals found" : "No obvious rescue signal";
}

async function decodeContract() {
  const address = $("contract-address").value.trim();
  const networkKey = $("network-select").value;
  const apiKey = $("etherscan-key").value.trim() || cfg().ETHERSCAN_API_KEY;
  if (!validateAddress(address)) {
    setStatus("load-status", "Enter a valid EVM contract address.", "error");
    return;
  }

  currentAddress = ethers.getAddress(address);
  currentNetworkKey = networkKey;
  currentSource = null;
  currentScan = null;
  currentProxy = null;
  setStatus("load-status", "Scanning contract…");
  $("load-btn").disabled = true;
  $("load-btn").textContent = "scanning…";

  try {
    try {
      currentProxy = await detectProxy(currentAddress, networkKey);
    } catch (e) {
      console.warn("Proxy detection unavailable", e);
      currentProxy = { implementation: null, admin: null, beacon: null, kind: null };
    }
    let abi = null;
    try { abi = await fetchVerifiedAbi(currentAddress, networkKey, apiKey); } catch (e) { console.warn(e); }
    if (!abi && currentProxy.implementation) {
      try { abi = await fetchVerifiedAbi(currentProxy.implementation, networkKey, apiKey); } catch (e) { console.warn(e); }
      if (abi) setStatus("load-status", "Proxy detected. Implementation ABI found; calls will target the proxy…");
    }
    if (abi) {
      currentSource = "verified";
      setStatus("load-status", "Verified ABI found. Analyzing assets and recovery paths…");
    } else {
      currentSource = "decoded";
      setStatus("load-status", "No verified ABI. Inspecting deployed bytecode and resolving selectors…");
      abi = await fetchBytecodeAbi(currentProxy.implementation || currentAddress, networkKey);
    }
    currentAbi = abi.filter((f) => f.type === "function");
    if (!currentAbi.length) throw new Error("No callable functions were discovered.");
    currentScan = await analyzeContract(currentAbi, currentSource);
    currentScan.proxy = currentProxy;
    renderScanSummary();
    renderFunctions(currentAbi, currentSource);
    setStatus(
      "load-status",
      currentSource === "verified"
        ? `Verified ABI loaded · ${currentAbi.length} functions analyzed.`
        : `Bytecode analysis found ${currentAbi.length} candidate functions. Guesses require review before signing.`,
      "ok"
    );
  } catch (e) {
    setStatus("load-status", `Scan failed: ${e.reason || e.message || e}`, "error");
    $("scan-summary").hidden = true;
  } finally {
    $("load-btn").disabled = false;
    $("load-btn").textContent = "scan contract";
  }
}

function makeBadge(text, className) {
  const span = document.createElement("span");
  span.className = `badge ${className || ""}`;
  span.textContent = text;
  return span;
}

function renderFunctions(abi, source) {
  $("empty-panel").hidden = true;
  const rescueFns = abi.filter((fn) => isRescueFunction(fn.name));
  const rescueSection = $("rescue-section");
  const rescueList = $("rescue-list");
  rescueList.replaceChildren();
  rescueSection.hidden = rescueFns.length === 0;
  rescueFns.sort((a, b) => (b._recoveryScore || 0) - (a._recoveryScore || 0));
  rescueFns.forEach((fn, i) => rescueList.appendChild(buildFunctionCard(fn, source, `rescue-${i}`)));

  const allSection = $("all-functions-section");
  const allList = $("all-functions-list");
  allList.replaceChildren();
  allSection.hidden = false;
  $("fn-source-badge").replaceChildren(makeBadge(source === "verified" ? "verified ABI" : "bytecode decoded", source === "verified" ? "verified" : "guessed"));
  abi.forEach((fn, i) => allList.appendChild(buildFunctionCard(fn, source, `all-${i}`)));
}

function buildFunctionCard(fn, source, uid) {
  const card = document.createElement("article");
  card.className = "fn-card";
  card.dataset.uid = uid;
  const isView = fn.stateMutability === "view" || fn.stateMutability === "pure";
  const isGuessed = source !== "verified";
  const mutabilityUnknown = fn._mutabilityConfidence === "unknown";

  const title = document.createElement("button");
  title.className = "fn-title";
  title.type = "button";
  const left = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = fn.name;
  const sig = document.createElement("span");
  sig.className = "fn-sig";
  sig.textContent = `(${(fn.inputs || []).map((i) => `${i.type} ${i.name || ""}`).join(", ")})`;
  left.append(name, sig);
  const badges = document.createElement("span");
  if (isRescueFunction(fn.name)) badges.appendChild(makeBadge("rescue candidate", "rescue"));
  badges.appendChild(makeBadge(mutabilityUnknown ? "mutability unknown" : fn.stateMutability, mutabilityUnknown ? "guessed" : "verified"));
  if (isGuessed) badges.appendChild(makeBadge("guessed", "guessed")); else badges.appendChild(makeBadge("verified", "verified"));
  title.append(left, badges);
  title.setAttribute("aria-expanded", "false");
  title.addEventListener("click", () => {
    const open = card.classList.toggle("open");
    title.setAttribute("aria-expanded", String(open));
  });
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "fn-body";
  const evidence = document.createElement("div");
  evidence.className = "evidence";
  if (fn._recoveryScore != null) evidence.textContent = `${scoreLabel(fn._recoveryScore)} · recovery score ${fn._recoveryScore}/100`;
  else evidence.textContent = isGuessed ? "Reconstructed from bytecode. Signature and mutability may be incomplete." : "Source ABI verified by explorer.";
  body.appendChild(evidence);

  if (isEmergencyFunction(fn.name)) {
    const warning = document.createElement("div");
    warning.className = "warning function-warning";
    warning.textContent = "High-risk function name. Review access control, destination, and asset effects before simulating or signing.";
    body.appendChild(warning);
  }

  const inputEls = [];
  (fn.inputs || []).forEach((inp, idx) => {
    const wrap = document.createElement("label");
    wrap.className = "fn-input";
    const label = document.createElement("span");
    label.textContent = `${inp.name || `arg${idx}`} · ${inp.type}`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = inp.type;
    input.dataset.type = inp.type;
    wrap.append(label, input);
    body.appendChild(wrap);
    inputEls.push(input);
  });

  if (!isView && fn.stateMutability === "payable") {
    const wrap = document.createElement("label");
    wrap.className = "fn-input";
    const label = document.createElement("span");
    label.textContent = "ETH value to send";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "0.0";
    input.dataset.ethValue = "true";
    wrap.append(label, input);
    body.appendChild(wrap);
    inputEls.push(input);
  }

  const actions = document.createElement("div");
  actions.className = "row actions";
  const bookmarkBtn = document.createElement("button");
  bookmarkBtn.type = "button";
  bookmarkBtn.className = "secondary bookmark-btn";
  const bookmarks = readStorage(BOOKMARK_STORAGE_KEY, []);
  const bookmarked = bookmarks.some((bookmark) => bookmark.key === functionKey(fn));
  bookmarkBtn.textContent = bookmarked ? "★ Bookmarked" : "☆ Bookmark";
  bookmarkBtn.addEventListener("click", () => {
    toggleBookmark(fn);
    bookmarkBtn.textContent = readStorage(BOOKMARK_STORAGE_KEY, []).some((bookmark) => bookmark.key === functionKey(fn)) ? "★ Bookmarked" : "☆ Bookmark";
  });
  actions.appendChild(bookmarkBtn);
  const simulateBtn = document.createElement("button");
  simulateBtn.type = "button";
  simulateBtn.textContent = isView ? "Call read-only" : "Simulate first";
  actions.appendChild(simulateBtn);
  if (!isView) {
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "secondary";
    sendBtn.textContent = "Send transaction";
    sendBtn.disabled = isGuessed || !cfg().SEND_TX_ENABLED;
    sendBtn.title = isGuessed ? "Guessed ABIs are simulation-only for safety." : (!cfg().SEND_TX_ENABLED ? "Live writes disabled in config." : "");
    actions.appendChild(sendBtn);
    sendBtn.addEventListener("click", async () => {
      const args = inputEls.filter((e) => !e.dataset.ethValue).map((e) => coerceArg(e.value, e.dataset.type));
      const valueInput = inputEls.find((e) => e.dataset.ethValue);
      const value = valueInput && valueInput.value.trim() ? valueInput.value.trim() : "0";
      await executeTransaction(fn, args, value, resultBox);
    });
  }
  body.appendChild(actions);

  const resultBox = document.createElement("pre");
  resultBox.className = "result-box";
  body.appendChild(resultBox);

  simulateBtn.addEventListener("click", async () => {
    resultBox.hidden = false;
    resultBox.textContent = "Simulating…";
    try {
      const args = inputEls.filter((e) => !e.dataset.ethValue).map((e) => coerceArg(e.value, e.dataset.type));
      const valueInput = inputEls.find((e) => e.dataset.ethValue);
      const value = valueInput && valueInput.value.trim() ? valueInput.value.trim() : "0";
      const result = await simulateFunction(fn, args, value);
      resultBox.textContent = result;
      recordCall(fn, "simulation succeeded");
    } catch (e) {
      resultBox.textContent = `Simulation failed: ${e.reason || e.shortMessage || e.message || e}`;
      recordCall(fn, "simulation failed");
    }
  });

  card.appendChild(body);
  return card;
}

function coerceArg(value, type) {
  const trimmed = value.trim();
  if (!trimmed && type !== "string") return trimmed;
  if (type === "bool") return trimmed.toLowerCase() === "true";
  if (type.endsWith("]")) {
    try { return JSON.parse(trimmed); } catch { return trimmed.split(",").map((v) => v.trim()); }
  }
  return trimmed;
}

function getInterface(fn) {
  return new ethers.Interface([fn]);
}

async function simulateFunction(fn, args, ethValue = "0") {
  if (signer && !(await validateWalletNetwork(false))) {
    throw new Error("Switch your wallet to the selected network before simulating.");
  }
  const readProvider = getReadProvider(currentNetworkKey);
  let from;
  if (signer) from = await signer.getAddress();
  const iface = getInterface(fn);
  const data = iface.encodeFunctionData(fn.name, args);
  const tx = { to: currentAddress, data, value: ethers.parseEther(ethValue || "0") };
  if (from) tx.from = from;
  if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
    const result = await readProvider.call(tx);
    const decoded = iface.decodeFunctionResult(fn.name, result);
    return `✓ Read succeeded\n\n${safeStringify(decoded.length === 1 ? decoded[0] : decoded)}`;
  }
  const gas = await readProvider.estimateGas(tx);
  let executionResult = "✓ eth_call simulation succeeded";
  try { await readProvider.call(tx); } catch (e) { throw e; }
  return `${executionResult}\n✓ Estimated gas: ${gas.toString()}\n✓ Target: ${shortAddress(currentAddress)}\n✓ Function: ${functionSignature(fn)}\n✓ From: ${from ? shortAddress(from) : "not connected"}\n✓ Value: ${ethValue || "0"} ETH\n\nNo transaction has been sent.`;
}

async function executeTransaction(fn, args, ethValue, resultBox) {
  resultBox.hidden = false;
  try {
    if (!signer) throw new Error("Connect a wallet before sending.");
    if (!(await validateWalletNetwork(true))) return;
    if (currentSource !== "verified") throw new Error("Safety lock: guessed bytecode signatures cannot send transactions.");
    const simulation = await simulateFunction(fn, args, ethValue);
    const ok = window.confirm(`${simulation}\n\nSend this transaction from your wallet?`);
    if (!ok) { resultBox.textContent = "Cancelled. No transaction sent."; return; }
    const iface = getInterface(fn);
    const data = iface.encodeFunctionData(fn.name, args);
    const tx = await signer.sendTransaction({ to: currentAddress, data, value: ethers.parseEther(ethValue || "0") });
    resultBox.textContent = `Transaction submitted\n\nHash: ${tx.hash}\n\nWaiting for confirmation…`;
    const receipt = await tx.wait();
    resultBox.textContent += `\nConfirmed in block ${receipt.blockNumber}.`;
    recordCall(fn, "transaction confirmed");
  } catch (e) {
    resultBox.textContent = `Transaction blocked/failed: ${e.reason || e.shortMessage || e.message || e}`;
    recordCall(fn, "transaction failed");
  }
}

function exportAbi() {
  if (!currentAbi.length) return;
  const blob = new Blob([safeStringify(currentAbi)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentAddress}-abi.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function loadDemoContract() {
  const demo = cfg().DEMO_CONTRACT;

  if (!demo || !demo.address) {
    setStatus(
      "load-status",
      "Set DEMO_CONTRACT.address in config.js before using the demo loader.",
      "error"
    );
    return;
  }

  const address = demo.address.trim();

  if (!ethers.isAddress(address)) {
    setStatus(
      "load-status",
      `Demo address in config.js is invalid: ${address}`,
      "error"
    );
    return;
  }

  $("contract-address").value = ethers.getAddress(address);
  $("network-select").value = demo.network || cfg().DEFAULT_NETWORK;

  decodeContract();
}
window.addEventListener("DOMContentLoaded", () => {
  populateNetworkSelect();
  renderHistory();
  $("connect-btn").addEventListener("click", connectWallet);
  $("load-btn").addEventListener("click", decodeContract);
  $("demo-btn").addEventListener("click", loadDemoContract);
  $("export-btn").addEventListener("click", exportAbi);
  $("network-select").addEventListener("change", () => validateWalletNetwork(false, $("network-select").value));
  if (window.ethereum?.on) {
    window.ethereum.on("accountsChanged", (accounts) => connectWallet(false, accounts));
    window.ethereum.on("chainChanged", () => validateWalletNetwork(false));
  }
});
