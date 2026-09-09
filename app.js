/**
 * app.js — wires together wallet connection, ABI retrieval (verified or
 * decoded-from-bytecode), and dynamic per-function form rendering.
 */

let provider = null;
let signer = null;
let currentAbi = [];
let currentAddress = null;
let currentNetworkKey = null;

const $ = (id) => document.getElementById(id);

function cfg() {
  return window.ZOMBIE_CONFIG;
}

function setStatus(elId, msg, kind) {
  const el = $(elId);
  el.textContent = msg;
  el.className = "status-bar" + (kind ? " " + kind : "");
}

function populateNetworkSelect() {
  const select = $("network-select");
  select.innerHTML = "";
  Object.entries(cfg().NETWORKS).forEach(([key, net]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = net.label;
    if (key === cfg().DEFAULT_NETWORK) opt.selected = true;
    select.appendChild(opt);
  });
}

// ---------- Wallet ----------

async function connectWallet() {
  if (!window.ethereum) {
    setStatus("wallet-status", "No injected wallet found (install MetaMask). Read-only mode still works.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    const addr = await signer.getAddress();
    setStatus("wallet-status", `Connected: ${addr.slice(0, 6)}...${addr.slice(-4)}`, "ok");
  } catch (e) {
    setStatus("wallet-status", "Connection rejected or failed: " + e.message, "error");
  }
}

// ---------- ABI retrieval ----------

async function fetchVerifiedAbi(address, networkKey, apiKey) {
  const net = cfg().NETWORKS[networkKey];
  const url = `${net.explorerApi}?module=contract&action=getabi&address=${address}&apikey=${apiKey || ""}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === "1" && data.result) {
    try {
      return JSON.parse(data.result);
    } catch {
      return null;
    }
  }
  return null; // not verified, or bad key, or rate-limited
}

async function fetchBytecodeAbi(address, networkKey) {
  const net = cfg().NETWORKS[networkKey];
  const rpcProvider = new ethers.JsonRpcProvider(net.rpc);
  const bytecode = await rpcProvider.getCode(address);
  if (!bytecode || bytecode === "0x") {
    throw new Error("No bytecode at this address — is it a contract on the selected network?");
  }
  return await window.ZombieDecoder.buildGuessedAbi(bytecode);
}

function isRescueFunction(name) {
  const lower = name.toLowerCase();
  return cfg().RESCUE_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------- Main decode flow ----------

async function decodeContract() {
  const address = $("contract-address").value.trim();
  const networkKey = $("network-select").value;
  const apiKey = $("etherscan-key").value.trim() || cfg().ETHERSCAN_API_KEY;

  if (!ethers.isAddress(address)) {
    setStatus("load-status", "That doesn't look like a valid address.", "error");
    return;
  }

  currentAddress = address;
  currentNetworkKey = networkKey;

  setStatus("load-status", "Checking explorer for a verified ABI...");
  $("load-btn").disabled = true;

  let abi = null;
  let source = "verified";

  try {
    abi = await fetchVerifiedAbi(address, networkKey, apiKey);
  } catch (e) {
    // network hiccup on explorer call — fall through to bytecode decode
  }

  if (!abi) {
    source = "decoded";
    setStatus("load-status", "Not verified (or no key) — decoding from bytecode instead...");
    try {
      abi = await fetchBytecodeAbi(address, networkKey);
      if (abi.length === 0) {
        setStatus("load-status", "No function selectors found in bytecode — is this a contract address?", "error");
        $("load-btn").disabled = false;
        return;
      }
    } catch (e) {
      setStatus("load-status", "Failed: " + e.message, "error");
      $("load-btn").disabled = false;
      return;
    }
  }

  currentAbi = abi.filter((f) => f.type === "function");
  renderFunctions(currentAbi, source);
  setStatus(
    "load-status",
    source === "verified"
      ? `Loaded verified ABI — ${currentAbi.length} functions.`
      : `Decoded ${currentAbi.length} functions from bytecode (best-effort — verify before signing).`,
    "ok"
  );
  $("load-btn").disabled = false;
}

// ---------- Rendering ----------

function renderFunctions(abi, source) {
  $("empty-panel").style.display = "none";

  const rescueFns = abi.filter((f) => isRescueFunction(f.name));
  const rescueSection = $("rescue-section");
  const rescueList = $("rescue-list");
  rescueList.innerHTML = "";
  if (rescueFns.length > 0) {
    rescueSection.style.display = "block";
    rescueFns.forEach((fn, i) => rescueList.appendChild(buildFunctionCard(fn, source, "rescue-" + i)));
  } else {
    rescueSection.style.display = "none";
  }

  const allSection = $("all-functions-section");
  const allList = $("all-functions-list");
  allList.innerHTML = "";
  allSection.style.display = "block";
  $("fn-source-badge").innerHTML =
    source === "verified"
      ? `<span class="badge verified">verified ABI</span>`
      : `<span class="badge guessed">decoded from bytecode</span>`;

  abi.forEach((fn, i) => allList.appendChild(buildFunctionCard(fn, source, "all-" + i)));
}

function buildFunctionCard(fn, source, uid) {
  const card = document.createElement("div");
  card.className = "fn-card";

  const sigParams = (fn.inputs || []).map((inp) => `${inp.type} ${inp.name || ""}`).join(", ");
  const isView = fn.stateMutability === "view" || fn.stateMutability === "pure";
  const rescueTag = isRescueFunction(fn.name) ? `<span class="badge rescue">rescue?</span>` : "";
  const sourceTag =
    source === "verified"
      ? `<span class="badge verified">verified</span>`
      : `<span class="badge guessed">guessed</span>`;

  const title = document.createElement("div");
  title.className = "fn-title";
  title.innerHTML = `
    <span>${fn.name}<span class="fn-sig">(${sigParams})</span></span>
    <span>${rescueTag}${sourceTag}</span>
  `;
  title.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "fn-body";

  const inputEls = [];
  (fn.inputs || []).forEach((inp, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "fn-input";
    const label = document.createElement("label");
    label.textContent = `${inp.name || "arg" + idx} (${inp.type})`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = inp.type;
    input.dataset.type = inp.type;
    wrap.appendChild(label);
    wrap.appendChild(input);
    body.appendChild(wrap);
    inputEls.push(input);
  });

  const actionRow = document.createElement("div");
  actionRow.className = "row";

  const callBtn = document.createElement("button");
  callBtn.textContent = isView ? "Call (read)" : "Send Transaction";
  if (!isView && !cfg().SEND_TX_ENABLED) {
    callBtn.disabled = true;
    callBtn.title = "SEND_TX_ENABLED is false in config — flip it on to enable writes.";
  }
  actionRow.appendChild(callBtn);
  body.appendChild(actionRow);

  const resultBox = document.createElement("div");
  resultBox.className = "result-box";
  body.appendChild(resultBox);

  callBtn.addEventListener("click", async () => {
    resultBox.style.display = "block";
    resultBox.textContent = "Working...";
    try {
      const args = inputEls.map((el) => coerceArg(el.value, el.dataset.type));
      const result = await callFunction(fn, args, isView);
      resultBox.textContent = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
    } catch (e) {
      resultBox.textContent = "Error: " + (e.reason || e.message || String(e));
    }
  });

  card.appendChild(body);
  return card;
}

function coerceArg(value, type) {
  if (type.startsWith("uint") || type.startsWith("int")) return value.trim();
  if (type === "bool") return value.trim().toLowerCase() === "true";
  if (type.endsWith("[]")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.split(",").map((v) => v.trim());
    }
  }
  return value.trim();
}

async function callFunction(fn, args, isView) {
  const net = cfg().NETWORKS[currentNetworkKey];
  const readProvider = provider || new ethers.JsonRpcProvider(net.rpc);
  const contract = new ethers.Contract(
    currentAddress,
    [fn],
    isView ? readProvider : signer || readProvider
  );

  if (isView) {
    return await contract[fn.name](...args);
  }

  if (!signer) {
    throw new Error("Connect a wallet first to send a transaction.");
  }
  const tx = await contract[fn.name](...args);
  return { txHash: tx.hash, note: "Transaction submitted — waiting for confirmation is up to you / your wallet UI." };
}

// ---------- Init ----------

window.addEventListener("DOMContentLoaded", () => {
  // config.js (if present) loads async after config.example.js; small delay
  // keeps this demo-simple rather than adding a load-order framework.
  setTimeout(() => {
    populateNetworkSelect();
  }, 50);

  $("connect-btn").addEventListener("click", connectWallet);
  $("load-btn").addEventListener("click", decodeContract);
});
