/* Zombie Rescue — contract recovery intelligence UI (ethers v6) */
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
  el.className = `status-bar ${kind}`.trim();
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
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
      button.textContent = `${item.kind === "bookmark" ? "★" : "↗"} ${item.signature} · ${item.networkKey}`;
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

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const COMMON_TOKENS = {
  ethereum: [
    ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
    ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F"],
  ],
  polygon: [["USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"]],
};

async function detectTokenBalances(address, networkKey) {
  const readProvider = getReadProvider(networkKey);
  const balances = [];
  for (const [knownSymbol, tokenAddress] of COMMON_TOKENS[networkKey] || []) {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, readProvider);
      const balance = await contract.balanceOf(address);
      if (balance > 0n) {
        const [decimals, symbol] = await Promise.all([contract.decimals(), contract.symbol().catch(() => knownSymbol)]);
        balances.push({ token: tokenAddress, balance, symbol: symbol || knownSymbol, decimals: Number(decimals) });
      }
    } catch (_) {
      // A missing token or restricted RPC should not abort the contract scan.
    }
  }
  return balances;
}

async function analyzeRecentActivity(address, networkKey) {
  try {
    const readProvider = getReadProvider(networkKey);
    const latest = await readProvider.getBlockNumber();
    const from = Math.max(0, latest - 5000);
    const logs = await readProvider.getLogs({ address, fromBlock: from, toBlock: latest });
    const transferTopic = ethers.id("Transfer(address,address,uint256)").toLowerCase();
    const transfers = logs.filter((log) => log.topics[0]?.toLowerCase() === transferTopic);
    return { recentActivityBlocks: latest - from, eventCount: logs.length, transfers: transfers.length, lastActive: transfers.length ? "Recently" : "Dormant" };
  } catch (_) {
    return { recentActivityBlocks: 0, eventCount: null, transfers: null, lastActive: "Unavailable" };
  }
}

function calculateContractRisk({ source, rescueFns, proxy, activity }) {
  let score = 20;
  if (source !== "verified") score += 30;
  if (rescueFns.length) score += Math.min(20, rescueFns.length * 4);
  if (proxy?.implementation) score += 15;
  if (activity.lastActive === "Recently") score += 10;
  if (rescueFns.some((fn) => isEmergencyFunction(fn.name))) score += 15;
  return Math.min(100, score);
}

async function analyzeContract(abi, source) {
  const [native, owner, tokens, activity] = await Promise.all([
    getContractBalance(currentAddress, currentNetworkKey),
    detectOwner(abi),
    detectTokenBalances(currentAddress, currentNetworkKey),
    analyzeRecentActivity(currentAddress, currentNetworkKey),
  ]);
  let ownerMatches = null;
  if (owner && signer) ownerMatches = owner.toLowerCase() === (await signer.getAddress()).toLowerCase();
  const rescueFns = abi.filter((fn) => isRescueFunction(fn.name));
  rescueFns.forEach((fn) => {
    fn._recoveryScore = calculateRecoveryScore({ fn, source, hasNativeBalance: native.raw > 0n, ownerMatches });
  });
  const riskScore = calculateContractRisk({ source, rescueFns, proxy: currentProxy, activity });
  return { native, owner, ownerMatches, rescueFns, tokens, activity, riskScore };
}

function renderScanSummary() {
  const panel = $("scan-summary");
  if (!currentScan) { panel.hidden = true; return; }
  panel.hidden = false;
  $("native-balance").textContent = `${currentScan.native.formatted} ETH`;
  $("recovery-count").textContent = String(currentScan.rescueFns.length);
  const scores = currentScan.rescueFns.map((f) => f._recoveryScore);
  const best = scores.length ? Math.max(...scores) : 0;
  $("recovery-score").textContent = scores.length ? `${best}/100` : "—";
  $("owner-status").textContent = currentScan.owner
    ? `${shortAddress(currentScan.owner)}${currentScan.ownerMatches === true ? " · caller matches" : currentScan.ownerMatches === false ? " · caller does not match" : ""}`
    : "Not detected";
  $("proxy-status").textContent = currentScan.proxy?.implementation
    ? `${currentScan.proxy.kind} · ${shortAddress(currentScan.proxy.implementation)}${currentScan.proxy.admin ? ` · admin ${shortAddress(currentScan.proxy.admin)}` : ""}`
    : "Not detected";
  $("token-status").textContent = currentScan.tokens.length ? currentScan.tokens.map((token) => `${token.symbol} ${ethers.formatUnits(token.balance, token.decimals)}`).join(" · ") : "None detected";
  $("activity-status").textContent = currentScan.activity.eventCount == null
    ? "Unavailable"
    : `${currentScan.activity.lastActive} · ${currentScan.activity.eventCount} events · ${currentScan.activity.transfers} transfers`;
  $("risk-status").textContent = `${currentScan.riskScore}/100 · ${currentScan.riskScore >= 70 ? "high" : currentScan.riskScore >= 40 ? "medium" : "low"}`;
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
  $("load-btn").textContent = "Scanning…";

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
    $("load-btn").textContent = "Scan Contract";
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

  if (isGuessed && fn._candidates?.length > 1) {
    const ambiguity = document.createElement("div");
    ambiguity.className = "notice function-warning";
    ambiguity.textContent = `${fn._candidates.length} possible signatures found for this selector. Showing the earliest indexed candidate; verify the signature before using it.`;
    body.appendChild(ambiguity);
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

async function enhancedSimulation(fn, args, ethValue = "0") {
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
  let gas = null;
  let gasError = null;
  try { gas = await readProvider.estimateGas(tx); } catch (e) { gasError = e.reason || e.shortMessage || e.message || "Gas estimation failed"; }
  let revertReason = null;
  let returnData = null;
  try {
    const result = await readProvider.call(tx);
    if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
      const decoded = iface.decodeFunctionResult(fn.name, result);
      returnData = safeStringify(decoded.length === 1 ? decoded[0] : decoded);
    }
  } catch (e) {
    revertReason = e.reason || e.shortMessage || e.message || "Execution failed";
  }
  const estimatedStateChange = fn.stateMutability === "view" || fn.stateMutability === "pure"
    ? "read-only; no state change expected"
    : fn.stateMutability === "payable"
      ? "may modify state and transfer native currency"
      : fn._mutabilityConfidence === "unknown"
        ? "unknown; recovered signature may have incomplete mutability"
        : "likely state modification";
  return {
    success: !revertReason && !gasError,
    gas: gas?.toString() || null,
    gasError,
    revertReason,
    estimatedStateChange,
    returnData,
    target: currentAddress,
    function: functionSignature(fn),
    from,
    value: ethValue || "0",
  };
}

async function simulateFunction(fn, args, ethValue = "0") {
  const simulation = await enhancedSimulation(fn, args, ethValue);
  if (simulation.returnData != null) {
    return `${simulation.success ? "✓ Read succeeded" : "✕ Read failed"}\n\n${simulation.returnData}`;
  }
  return `${simulation.success ? "✓ eth_call simulation succeeded" : "✕ eth_call simulation failed"}\n✓ Estimated gas: ${simulation.gas || "unavailable"}${simulation.gasError ? `\n✕ Gas estimation: ${simulation.gasError}` : ""}\n✓ Target: ${shortAddress(simulation.target)}\n✓ Function: ${simulation.function}\n✓ From: ${simulation.from ? shortAddress(simulation.from) : "not connected"}\n✓ Value: ${simulation.value} ETH\n✓ Expected state effect: ${simulation.estimatedStateChange}${simulation.revertReason ? `\n✕ Revert reason: ${simulation.revertReason}` : ""}\n\nNo transaction has been sent.`;
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
  if (!demo || !demo.address || demo.address.includes("...")) {
    setStatus("load-status", "Set DEMO_CONTRACT.address in config.js before using the demo loader.", "error");
    return;
  }
  $("contract-address").value = demo.address;
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
