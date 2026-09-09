/* Zombie Rescue — contract recovery intelligence UI (ethers v6) */
let provider = null;
let signer = null;
let currentAbi = [];
let currentAddress = null;
let currentNetworkKey = null;
let currentSource = null;
let currentScan = null;

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

async function connectWallet() {
  if (!window.ethereum) {
    setStatus("wallet-status", "No injected wallet found. Read-only scanning still works.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
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

async function validateWalletNetwork(showError = true) {
  if (!provider || !currentNetworkKey) return false;
  const net = cfg().NETWORKS[currentNetworkKey];
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

async function getContractBalance(address, networkKey) {
  const net = cfg().NETWORKS[networkKey];
  const rpc = provider || new ethers.JsonRpcProvider(net.rpc);
  const balance = await rpc.getBalance(address);
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
    const net = cfg().NETWORKS[currentNetworkKey];
    const readProvider = provider || new ethers.JsonRpcProvider(net.rpc);
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
  $("recovery-score").textContent = scores.length ? `${best}/100` : "—";
  $("owner-status").textContent = currentScan.owner
    ? `${shortAddress(currentScan.owner)}${currentScan.ownerMatches === true ? " · caller matches" : currentScan.ownerMatches === false ? " · caller does not match" : ""}`
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
  setStatus("load-status", "Scanning contract…");
  $("load-btn").disabled = true;
  $("load-btn").textContent = "Scanning…";

  try {
    let abi = null;
    try { abi = await fetchVerifiedAbi(currentAddress, networkKey, apiKey); } catch (e) { console.warn(e); }
    if (abi) {
      currentSource = "verified";
      setStatus("load-status", "Verified ABI found. Analyzing assets and recovery paths…");
    } else {
      currentSource = "decoded";
      setStatus("load-status", "No verified ABI. Inspecting deployed bytecode and resolving selectors…");
      abi = await fetchBytecodeAbi(currentAddress, networkKey);
    }
    currentAbi = abi.filter((f) => f.type === "function");
    if (!currentAbi.length) throw new Error("No callable functions were discovered.");
    currentScan = await analyzeContract(currentAbi, currentSource);
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
  if (isGuessed) badges.appendChild(makeBadge("guessed", "guessed")); else badges.appendChild(makeBadge("verified", "verified"));
  title.append(left, badges);
  title.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "fn-body";
  const evidence = document.createElement("div");
  evidence.className = "evidence";
  if (fn._recoveryScore != null) evidence.textContent = `${scoreLabel(fn._recoveryScore)} · recovery score ${fn._recoveryScore}/100`;
  else evidence.textContent = isGuessed ? "Reconstructed from bytecode. Signature and mutability may be incomplete." : "Source ABI verified by explorer.";
  body.appendChild(evidence);

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
    } catch (e) {
      resultBox.textContent = `Simulation failed: ${e.reason || e.shortMessage || e.message || e}`;
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
  const net = cfg().NETWORKS[currentNetworkKey];
  const readProvider = provider || new ethers.JsonRpcProvider(net.rpc);
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
  return `${executionResult}\n✓ Estimated gas: ${gas.toString()}\n✓ From: ${from ? shortAddress(from) : "not connected"}\n✓ Value: ${ethValue || "0"} ETH\n\nNo transaction has been sent.`;
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
  } catch (e) {
    resultBox.textContent = `Transaction blocked/failed: ${e.reason || e.shortMessage || e.message || e}`;
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
  $("connect-btn").addEventListener("click", connectWallet);
  $("load-btn").addEventListener("click", decodeContract);
  $("demo-btn").addEventListener("click", loadDemoContract);
  $("export-btn").addEventListener("click", exportAbi);
  $("network-select").addEventListener("change", () => validateWalletNetwork(false));
  window.addEventListener("ethereum#accountsChanged", connectWallet);
  window.addEventListener("ethereum#chainChanged", () => validateWalletNetwork(false));
});
