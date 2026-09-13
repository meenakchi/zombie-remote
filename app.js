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

    if (dot) {
      dot.className = `conn-dot ${
        kind === "ok" ? "live" : kind === "error" ? "warn" : ""
      }`.trim();
    }
  }
}

function shortAddress(address) {
  return address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : "n/a";
}

function safeStringify(value) {
  const seen = new WeakSet();

  return JSON.stringify(
    value,
    (_, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }

      if (typeof v === "bigint") {
        return v.toString();
      }

      return v;
    },
    2
  );
}

/* -------------------------------------------------------------------------- */
/* STORAGE                                                                    */
/* -------------------------------------------------------------------------- */

const HISTORY_STORAGE_KEY = "zombie-rescue-call-history";
const BOOKMARK_STORAGE_KEY = "zombie-rescue-function-bookmarks";

function readStorage(key, fallback) {
  try {
    return JSON.parse(
      localStorage.getItem(key) || JSON.stringify(fallback)
    );
  } catch (_) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Private browsing/storage restrictions may block localStorage.
  }
}

/* -------------------------------------------------------------------------- */
/* FUNCTION HELPERS                                                           */
/* -------------------------------------------------------------------------- */

function functionSignature(fn) {
  return `${fn.name}(${(fn.inputs || [])
    .map((input) => input.type)
    .join(",")})`;
}

function functionKey(
  fn,
  address = currentAddress,
  networkKey = currentNetworkKey
) {
  return `${networkKey}:${address}:${fn.selector || functionSignature(fn)}`;
}

function isEmergencyFunction(name = "") {
  return /emergency|drain|rescue|sweep|recover/i.test(name);
}

function isRescueFunction(name = "") {
  const lower = name.toLowerCase();

  return (cfg().RESCUE_KEYWORDS || []).some((keyword) =>
    lower.includes(keyword.toLowerCase())
  );
}

/* -------------------------------------------------------------------------- */
/* HISTORY / BOOKMARKS                                                        */
/* -------------------------------------------------------------------------- */

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

  const index = bookmarks.findIndex(
    (bookmark) => bookmark.key === key
  );

  if (index >= 0) {
    bookmarks.splice(index, 1);
  } else {
    bookmarks.unshift({
      key,
      address: currentAddress,
      networkKey: currentNetworkKey,
      signature: functionSignature(fn),
    });
  }

  writeStorage(
    BOOKMARK_STORAGE_KEY,
    bookmarks.slice(0, 50)
  );

  renderHistory();
}

function renderHistory() {
  const list = $("history-list");
  if (!list) return;

  list.replaceChildren();

  const bookmarks = readStorage(
    BOOKMARK_STORAGE_KEY,
    []
  );

  const history = readStorage(
    HISTORY_STORAGE_KEY,
    []
  );

  [
    ...bookmarks.map((item) => ({
      ...item,
      kind: "bookmark",
    })),
    ...history.map((item) => ({
      ...item,
      kind: "call",
    })),
  ]
    .slice(0, 12)
    .forEach((item) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "history-item";
      button.textContent =
        `${item.kind === "bookmark" ? "[fav]" : "[hit]"} ` +
        `${item.signature} · ${item.networkKey}`;

      button.title = item.address;

      button.addEventListener("click", () => {
        $("contract-address").value = item.address;
        $("network-select").value = item.networkKey;
        decodeContract();
      });

      list.appendChild(button);
    });

  const empty = $("history-empty");

  if (empty) {
    empty.hidden = list.children.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* NETWORK / WALLET                                                           */
/* -------------------------------------------------------------------------- */

function populateNetworkSelect() {
  const select = $("network-select");

  if (!select) return;

  select.replaceChildren();

  Object.entries(cfg().NETWORKS).forEach(
    ([key, net]) => {
      const option = document.createElement("option");

      option.value = key;
      option.textContent = net.label;
      option.selected =
        key === cfg().DEFAULT_NETWORK;

      select.appendChild(option);
    }
  );
}

function getReadProvider(
  networkKey = currentNetworkKey
) {
  const net = cfg().NETWORKS[networkKey];

  if (!net) {
    throw new Error(
      "Select a supported network before reading contract state."
    );
  }

  return new ethers.JsonRpcProvider(net.rpc);
}

async function connectWallet(
  requestAccounts = true,
  accounts = null
) {
  if (!window.ethereum) {
    setStatus(
      "wallet-status",
      "No injected wallet found. Read-only scanning still works.",
      "error"
    );

    return;
  }

  try {
    provider ||= new ethers.BrowserProvider(
      window.ethereum
    );

    if (requestAccounts) {
      await provider.send(
        "eth_requestAccounts",
        []
      );
    }

    if (
      Array.isArray(accounts) &&
      accounts.length === 0
    ) {
      signer = null;

      setStatus(
        "wallet-status",
        "Wallet disconnected. Read-only scanning still works."
      );

      return;
    }

    signer = await provider.getSigner();

    const address = await signer.getAddress();
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    const configured = Object.entries(
      cfg().NETWORKS
    ).find(
      ([, networkConfig]) =>
        Number(networkConfig.chainId) === chainId
    );

    setStatus(
      "wallet-status",
      `Connected ${shortAddress(address)} · ${
        configured
          ? configured[1].label
          : `Chain ${chainId}`
      }`,
      configured ? "ok" : "error"
    );

    await validateWalletNetwork(false);
  } catch (e) {
    setStatus(
      "wallet-status",
      `Connection failed: ${e.message || e}`,
      "error"
    );
  }
}

async function validateWalletNetwork(
  showError = true,
  networkKey = currentNetworkKey
) {
  if (!provider || !networkKey) {
    return false;
  }

  const net = cfg().NETWORKS[networkKey];

  if (!net) {
    return false;
  }

  try {
    const actual = await provider.getNetwork();

    const ok =
      Number(actual.chainId) === Number(net.chainId);

    const banner = $("network-warning");

    if (banner) {
      banner.hidden = ok;

      banner.textContent = ok
        ? ""
        : `Network mismatch: target is ${net.label}, wallet is chain ${actual.chainId}.`;
    }

    if (!ok && showError) {
      setStatus(
        "load-status",
        `Switch wallet to ${net.label} before signing.`,
        "error"
      );
    }

    return ok;
  } catch (e) {
    console.warn(
      "Unable to validate wallet network:",
      e
    );

    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* CONTRACT / ABI                                                              */
/* -------------------------------------------------------------------------- */

function validateAddress(address) {
  return (
    typeof address === "string" &&
    ethers.isAddress(address)
  );
}

async function fetchVerifiedAbi(
  address,
  networkKey,
  apiKey
) {
  const net = cfg().NETWORKS[networkKey];

  if (!net) {
    throw new Error(
      "Unsupported network selected."
    );
  }

  const url =
    `${net.explorerApi}` +
    `?module=contract` +
    `&action=getabi` +
    `&address=${encodeURIComponent(address)}` +
    `&apikey=${encodeURIComponent(apiKey || "")}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Explorer returned HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.status === "1" && data.result) {
    return JSON.parse(data.result);
  }

  return null;
}

async function fetchBytecodeAbi(
  address,
  networkKey
) {
  const net = cfg().NETWORKS[networkKey];

  if (!net) {
    throw new Error(
      "Unsupported network selected."
    );
  }

  const rpc = new ethers.JsonRpcProvider(
    net.rpc
  );

  const bytecode = await rpc.getCode(address);

  if (!bytecode || bytecode === "0x") {
    throw new Error(
      "No contract bytecode found at this address on the selected network."
    );
  }

  if (
    !window.ZombieDecoder ||
    typeof window.ZombieDecoder.buildGuessedAbi !==
      "function"
  ) {
    throw new Error(
      "ZombieDecoder is not loaded. Make sure decoder.js is included before app.js."
    );
  }

  return window.ZombieDecoder.buildGuessedAbi(
    bytecode
  );
}

/* -------------------------------------------------------------------------- */
/* PROXY DETECTION                                                            */
/* -------------------------------------------------------------------------- */

const EIP1967_SLOTS = {
  implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",

  admin:
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",

  beacon:
    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaeea7f1b2f6a4e5f2a7d50",
};

const IMPLEMENTATION_SLOT =
  EIP1967_SLOTS.implementation;

function addressFromStorage(value) {
  if (!value || value === "0x") {
    return null;
  }

  try {
    const hex = `0x${value.slice(-40)}`;

    if (/^0x0{40}$/i.test(hex)) {
      return null;
    }

    return ethers.getAddress(hex);
  } catch (_) {
    return null;
  }
}

async function detectProxy(
  address,
  networkKey
) {
  const readProvider =
    getReadProvider(networkKey);

  const [
    implementationSlot,
    adminSlot,
    beaconSlot,
  ] = await Promise.all(
    Object.values(EIP1967_SLOTS).map(
      (slot) =>
        readProvider.getStorage(
          address,
          slot
        )
    )
  );

  const implementation =
    addressFromStorage(
      implementationSlot
    );

  const admin =
    addressFromStorage(adminSlot);

  const beacon =
    addressFromStorage(beaconSlot);

  let uups = false;

  if (implementation) {
    try {
      const implementationContract =
        new ethers.Contract(
          implementation,
          [
            "function proxiableUUID() view returns (bytes32)",
          ],
          readProvider
        );

      const uuid =
        await implementationContract.proxiableUUID();

      uups =
        uuid.toLowerCase() ===
        IMPLEMENTATION_SLOT.toLowerCase();
    } catch (_) {
      uups = false;
    }
  }

  let beaconImplementation = null;

  if (beacon) {
    try {
      const beaconContract =
        new ethers.Contract(
          beacon,
          [
            "function implementation() view returns (address)",
          ],
          readProvider
        );

      beaconImplementation =
        await beaconContract.implementation();
    } catch (_) {
      beaconImplementation = null;
    }
  }

  return {
    implementation:
      implementation ||
      beaconImplementation,

    admin,

    beacon,

    kind: implementation
      ? uups
        ? "UUPS proxy"
        : "EIP-1967 proxy"
      : beaconImplementation
      ? "Beacon proxy"
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* CONTRACT ANALYSIS                                                          */
/* -------------------------------------------------------------------------- */

async function getContractBalance(
  address,
  networkKey
) {
  if (
    !address ||
    !ethers.isAddress(address)
  ) {
    return {
      raw: 0n,
      formatted: "0.0",
    };
  }

  const balance =
    await getReadProvider(
      networkKey
    ).getBalance(address);

  return {
    raw: balance,
    formatted: ethers.formatEther(balance),
  };
}

function getOwnerFunction(abi) {
  return abi.find(
    (f) =>
      f.type === "function" &&
      f.name === "owner" &&
      (!f.inputs ||
        f.inputs.length === 0)
  );
}

async function detectOwner(abi) {
  const ownerFn =
    getOwnerFunction(abi);

  if (!ownerFn || !currentAddress) {
    return null;
  }

  try {
    const readProvider =
      getReadProvider(
        currentNetworkKey
      );

    const contract =
      new ethers.Contract(
        currentAddress,
        [ownerFn],
        readProvider
      );

    return await contract.owner();
  } catch (_) {
    return null;
  }
}

function calculateRecoveryScore({
  fn,
  source,
  hasNativeBalance,
  ownerMatches,
}) {
  let score = 25;

  if (source === "verified") {
    score += 25;
  } else if (
    fn._source === "known-table"
  ) {
    score += 18;
  } else if (
    fn._source === "4byte.directory"
  ) {
    score += 10;
  } else {
    score -= 8;
  }

  if (hasNativeBalance) {
    score += 15;
  }

  if (ownerMatches === true) {
    score += 15;
  }

  if (ownerMatches === false) {
    score -= 20;
  }

  if (fn.stateMutability === "payable") {
    score -= 2;
  }

  return Math.max(
    0,
    Math.min(100, score)
  );
}

function scoreLabel(score) {
  if (score >= 80) {
    return "HIGH CONFIDENCE";
  }

  if (score >= 55) {
    return "MEDIUM CONFIDENCE";
  }

  return "LOW CONFIDENCE";
}

async function analyzeContract(
  abi,
  source
) {
  const native =
    await getContractBalance(
      currentAddress,
      currentNetworkKey
    );

  const owner =
    await detectOwner(abi);

  let ownerMatches = null;

  if (owner && signer) {
    const signerAddress =
      await signer.getAddress();

    ownerMatches =
      owner.toLowerCase() ===
      signerAddress.toLowerCase();
  }

  const rescueFns =
    abi.filter((fn) =>
      isRescueFunction(fn.name)
    );

  rescueFns.forEach((fn) => {
    /*
     * Preserve decoder metadata if it exists.
     * This is used by the recovery score.
     */
    fn._source =
      fn._source || source;

    fn._recoveryScore =
      calculateRecoveryScore({
        fn,
        source,
        hasNativeBalance:
          native.raw > 0n,
        ownerMatches,
      });
  });

  return {
    native,
    owner,
    ownerMatches,
    rescueFns,
  };
}

/* -------------------------------------------------------------------------- */
/* LOADING UI                                                                 */
/* -------------------------------------------------------------------------- */

function showLoading(message) {
  const spinner = $("load-status");

  if (!spinner) return;

  spinner.innerHTML =
    `<span class="spinner"></span> ${message}`;

  spinner.classList.add("loading");
}

function hideLoading() {
  const spinner = $("load-status");

  if (!spinner) return;

  spinner.classList.remove("loading");
}

/* -------------------------------------------------------------------------- */
/* SCAN SUMMARY                                                               */
/* -------------------------------------------------------------------------- */

function renderScanSummary() {
  const panel = $("scan-summary");

  if (!panel) return;

  if (!currentScan) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const nativeBalance =
    $("native-balance");

  const recoveryCount =
    $("recovery-count");

  const recoveryScore =
    $("recovery-score");

  const ownerStatus =
    $("owner-status");

  const proxyStatus =
    $("proxy-status");

  const contractStatus =
    $("contract-status");

  if (nativeBalance) {
    nativeBalance.textContent =
      `${currentScan.native.formatted} ETH`;
  }

  if (recoveryCount) {
    recoveryCount.textContent =
      String(
        currentScan.rescueFns.length
      );
  }

  const scores =
    currentScan.rescueFns
      .map(
        (f) => f._recoveryScore
      )
      .filter(
        (score) =>
          typeof score === "number"
      );

  const best =
    scores.length
      ? Math.max(...scores)
      : 0;

  if (recoveryScore) {
    recoveryScore.textContent =
      scores.length
        ? `${best}/100`
        : "n/a";
  }

  if (ownerStatus) {
    ownerStatus.textContent =
      currentScan.owner
        ? `${shortAddress(
            currentScan.owner
          )}${
            currentScan.ownerMatches ===
            true
              ? " · caller matches"
              : currentScan.ownerMatches ===
                false
              ? " · caller does not match"
              : ""
          }`
        : "Not detected";
  }

  if (proxyStatus) {
    proxyStatus.textContent =
      currentScan.proxy?.implementation
        ? `${currentScan.proxy.kind} · ${shortAddress(
            currentScan.proxy.implementation
          )}${
            currentScan.proxy.admin
              ? ` · admin ${shortAddress(
                  currentScan.proxy.admin
                )}`
              : ""
          }`
        : "Not detected";
  }

  if (contractStatus) {
    contractStatus.textContent =
      currentScan.native.raw > 0n ||
      currentScan.rescueFns.length
        ? "Recoverable signals found"
        : "No obvious rescue signal";
  }
}

/* -------------------------------------------------------------------------- */
/* DECODE CONTRACT                                                            */
/* -------------------------------------------------------------------------- */

async function decodeContract() {
  const address =
    $("contract-address")
      ?.value.trim();

  const networkKey =
    $("network-select")?.value;

  const apiKey =
    $("etherscan-key")
      ?.value.trim() ||
    cfg().ETHERSCAN_API_KEY;

  if (!validateAddress(address)) {
    setStatus(
      "load-status",
      "Enter a valid EVM contract address.",
      "error"
    );

    return;
  }

  if (!cfg().NETWORKS[networkKey]) {
    setStatus(
      "load-status",
      "Select a supported network.",
      "error"
    );

    return;
  }

  currentAddress =
    ethers.getAddress(address);

  currentNetworkKey =
    networkKey;

  currentSource = null;
  currentScan = null;
  currentProxy = null;
  currentAbi = [];

  showLoading(
    "Scanning contract…"
  );

  const loadButton =
    $("load-btn");

  if (loadButton) {
    loadButton.disabled = true;
    loadButton.textContent =
      "scanning…";
  }

  try {
    /* ---------------------------------------------------------------------- */
    /* Proxy detection                                                        */
    /* ---------------------------------------------------------------------- */

    showLoading(
      "Detecting proxy…"
    );

    try {
      currentProxy =
        await detectProxy(
          currentAddress,
          networkKey
        );
    } catch (e) {
      console.warn(
        "Proxy detection unavailable:",
        e
      );

      currentProxy = {
        implementation: null,
        admin: null,
        beacon: null,
        kind: null,
      };
    }

    /* ---------------------------------------------------------------------- */
    /* ABI                                                                     */
    /* ---------------------------------------------------------------------- */

    showLoading(
      "Fetching ABI…"
    );

    let abi = null;

    try {
      abi =
        await fetchVerifiedAbi(
          currentAddress,
          networkKey,
          apiKey
        );
    } catch (e) {
      console.warn(
        "Primary ABI lookup failed:",
        e
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Proxy implementation ABI                                               */
    /* ---------------------------------------------------------------------- */

    if (
      !abi &&
      currentProxy?.implementation
    ) {
      try {
        abi =
          await fetchVerifiedAbi(
            currentProxy.implementation,
            networkKey,
            apiKey
          );
      } catch (e) {
        console.warn(
          "Implementation ABI lookup failed:",
          e
        );
      }

      if (abi) {
        setStatus(
          "load-status",
          `Proxy detected (${currentProxy.kind}). Implementation ABI found; calls will target the proxy address.`,
          "ok"
        );
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Bytecode fallback                                                       */
    /* ---------------------------------------------------------------------- */

    if (abi) {
      currentSource =
        "verified";

      showLoading(
        "Analyzing verified contract…"
      );
    } else {
      currentSource =
        "decoded";

      showLoading(
        "Scanning bytecode…"
      );

      abi =
        await fetchBytecodeAbi(
          currentProxy?.implementation ||
            currentAddress,
          networkKey
        );
    }

    /* ---------------------------------------------------------------------- */
    /* Filter functions                                                        */
    /* ---------------------------------------------------------------------- */

    currentAbi =
      abi.filter(
        (f) =>
          f.type === "function"
      );

    if (!currentAbi.length) {
      throw new Error(
        "No callable functions were discovered."
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Analysis                                                                */
    /* ---------------------------------------------------------------------- */

    showLoading(
      "Analyzing recovery paths…"
    );

    currentScan =
      await analyzeContract(
        currentAbi,
        currentSource
      );

    currentScan.proxy =
      currentProxy;

    renderScanSummary();

    renderFunctions(
      currentAbi,
      currentSource
    );

    setStatus(
      "load-status",
      currentSource === "verified"
        ? `Verified ABI loaded · ${currentAbi.length} functions analyzed.`
        : `Bytecode analysis found ${currentAbi.length} candidate functions. Guesses require review before signing.`,
      "ok"
    );
  } catch (e) {
    console.error(
      "Contract scan failed:",
      e
    );

    setStatus(
      "load-status",
      `Scan failed: ${
        e.reason ||
        e.shortMessage ||
        e.message ||
        e
      }`,
      "error"
    );

    const summary =
      $("scan-summary");

    if (summary) {
      summary.hidden = true;
    }
  } finally {
    hideLoading();

    if (loadButton) {
      loadButton.disabled = false;
      loadButton.textContent =
        "scan contract";
    }
  }
}

/* -------------------------------------------------------------------------- */
/* FUNCTION UI                                                                */
/* -------------------------------------------------------------------------- */

function makeBadge(
  text,
  className
) {
  const span =
    document.createElement(
      "span"
    );

  span.className =
    `badge ${className || ""}`;

  span.textContent = text;

  return span;
}

function renderFunctions(
  abi,
  source
) {
  const emptyPanel =
    $("empty-panel");

  if (emptyPanel) {
    emptyPanel.hidden = true;
  }

  const rescueFns =
    abi.filter((fn) =>
      isRescueFunction(fn.name)
    );

  const rescueSection =
    $("rescue-section");

  const rescueList =
    $("rescue-list");

  if (rescueList) {
    rescueList.replaceChildren();

    rescueFns.sort(
      (a, b) =>
        (b._recoveryScore || 0) -
        (a._recoveryScore || 0)
    );

    rescueFns.forEach(
      (fn, i) => {
        rescueList.appendChild(
          buildFunctionCard(
            fn,
            source,
            `rescue-${i}`
          )
        );
      }
    );
  }

  if (rescueSection) {
    rescueSection.hidden =
      rescueFns.length === 0;
  }

  const allSection =
    $("all-functions-section");

  const allList =
    $("all-functions-list");

  if (allList) {
    allList.replaceChildren();

    abi.forEach(
      (fn, i) => {
        allList.appendChild(
          buildFunctionCard(
            fn,
            source,
            `all-${i}`
          )
        );
      }
    );
  }

  if (allSection) {
    allSection.hidden = false;
  }

  const sourceBadge =
    $("fn-source-badge");

  if (sourceBadge) {
    sourceBadge.replaceChildren(
      makeBadge(
        source === "verified"
          ? "verified ABI"
          : "bytecode decoded",
        source === "verified"
          ? "verified"
          : "guessed"
      )
    );
  }
}

function getArgName(
  type,
  index
) {
  const typeNames = {
    address: [
      "recipient",
      "token",
      "account",
      "owner",
      "user",
      "vault",
    ],

    uint256: [
      "amount",
      "balance",
      "value",
      "count",
      "fee",
      "price",
    ],

    uint128: [
      "amount",
      "balance",
      "value",
      "count",
    ],

    uint64: [
      "amount",
      "timestamp",
      "nonce",
      "id",
    ],

    uint32: [
      "amount",
      "duration",
      "nonce",
      "id",
    ],

    uint8: [
      "percent",
      "level",
      "status",
      "flag",
    ],

    bytes32: [
      "id",
      "hash",
      "key",
      "proof",
      "digest",
      "salt",
    ],

    bytes: [
      "data",
      "signature",
      "payload",
      "encoded",
      "serialized",
    ],

    bytes4: [
      "selector",
      "code",
      "id",
    ],

    bool: [
      "enabled",
      "approved",
      "success",
      "flag",
      "allowed",
      "active",
    ],

    string: [
      "name",
      "symbol",
      "uri",
      "message",
    ],
  };

  const candidates =
    typeNames[type];

  if (
    candidates &&
    index < candidates.length
  ) {
    return candidates[index];
  }

  if (
    candidates &&
    candidates.length > 0
  ) {
    return candidates[
      index % candidates.length
    ];
  }

  return `arg${index}`;
}

/* -------------------------------------------------------------------------- */
/* COPY BUTTON                                                                */
/* -------------------------------------------------------------------------- */

function addCopyButton(
  text,
  label = "copy"
) {
  const btn =
    document.createElement(
      "button"
    );

  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent =
    `📋 ${label}`;
  btn.title =
    "Copy to clipboard";

  btn.addEventListener(
    "click",
    async (e) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(
          text
        );

        const original =
          btn.textContent;

        btn.textContent =
          "✓ Copied!";

        btn.disabled = true;

        setTimeout(() => {
          btn.textContent =
            original;

          btn.disabled = false;
        }, 2000);
      } catch (err) {
        console.error(
          "Clipboard copy failed:",
          err
        );

        alert(
          "Failed to copy"
        );
      }
    }
  );

  return btn;
}

/* -------------------------------------------------------------------------- */
/* SCORE BREAKDOWN                                                            */
/* -------------------------------------------------------------------------- */

function showScoreBreakdown(fn) {
  const modal =
    document.createElement(
      "div"
    );

  modal.className =
    "modal-overlay";

  const content =
    document.createElement(
      "div"
    );

  content.className =
    "modal-content";

  const breakdown = [];

  breakdown.push(
    "Base: +25"
  );

  if (
    currentSource ===
    "verified"
  ) {
    breakdown.push(
      "Source verified: +25"
    );
  } else if (
    fn._source ===
    "known-table"
  ) {
    breakdown.push(
      "Known function: +18"
    );
  } else if (
    fn._source ===
    "4byte.directory"
  ) {
    breakdown.push(
      "4byte match: +10"
    );
  } else {
    breakdown.push(
      "Unresolved selector: -8"
    );
  }

  if (
    currentScan?.native?.raw > 0n
  ) {
    breakdown.push(
      "Contract has ETH: +15"
    );
  }

  if (
    currentScan?.ownerMatches ===
    true
  ) {
    breakdown.push(
      "You own contract: +15"
    );
  }

  if (
    currentScan?.ownerMatches ===
    false
  ) {
    breakdown.push(
      "You don't own: -20"
    );
  }

  if (
    fn.stateMutability ===
    "payable"
  ) {
    breakdown.push(
      "Payable (risky): -2"
    );
  }

  content.innerHTML = `
    <div class="modal-header">
      <h3>Recovery Score Breakdown</h3>
      <button class="modal-close" type="button">×</button>
    </div>

    <div class="modal-body">
      <pre>${breakdown.join("\n")}</pre>

      <p style="margin-top: 1rem; font-size: 0.9rem; opacity: 0.7;">
        Higher scores indicate stronger signals that the function may be relevant to asset recovery. They do not guarantee that a function is safe or capable of recovering funds.
      </p>
    </div>
  `;

  const closeButton =
    content.querySelector(
      ".modal-close"
    );

  if (closeButton) {
    closeButton.addEventListener(
      "click",
      () => modal.remove()
    );
  }

  modal.appendChild(
    content
  );

  modal.addEventListener(
    "click",
    (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    }
  );

  document.body.appendChild(
    modal
  );
}

/* -------------------------------------------------------------------------- */
/* FUNCTION CARD                                                              */
/* -------------------------------------------------------------------------- */

function buildFunctionCard(
  fn,
  source,
  uid
) {
  const card =
    document.createElement(
      "article"
    );

  card.className =
    "fn-card";

  card.dataset.uid = uid;

  const isView =
    fn.stateMutability ===
      "view" ||
    fn.stateMutability ===
      "pure";

  const isGuessed =
    source !== "verified";

  const mutabilityUnknown =
    fn._mutabilityConfidence ===
    "unknown";

  /* ------------------------------------------------------------------------ */
  /* Title                                                                    */
  /* ------------------------------------------------------------------------ */

  const title =
    document.createElement(
      "button"
    );

  title.className =
    "fn-title";

  title.type = "button";

  const left =
    document.createElement(
      "span"
    );

  const name =
    document.createElement(
      "strong"
    );

  name.textContent =
    fn.name;

  const sig =
    document.createElement(
      "span"
    );

  sig.className =
    "fn-sig";

  sig.textContent =
    `(${(fn.inputs || [])
      .map(
        (i) =>
          `${i.type} ${i.name || ""}`
      )
      .join(", ")})`;

  left.append(
    name,
    sig
  );

  const badges =
    document.createElement(
      "span"
    );

  if (
    isRescueFunction(
      fn.name
    )
  ) {
    badges.appendChild(
      makeBadge(
        "rescue candidate",
        "rescue"
      )
    );
  }

  badges.appendChild(
    makeBadge(
      mutabilityUnknown
        ? "mutability unknown"
        : fn.stateMutability,
      mutabilityUnknown
        ? "guessed"
        : "verified"
    )
  );

  badges.appendChild(
    makeBadge(
      isGuessed
        ? "guessed"
        : "verified",
      isGuessed
        ? "guessed"
        : "verified"
    )
  );

  title.append(
    left,
    badges
  );

  title.setAttribute(
    "aria-expanded",
    "false"
  );

  title.addEventListener(
    "click",
    () => {
      const open =
        card.classList.toggle(
          "open"
        );

      title.setAttribute(
        "aria-expanded",
        String(open)
      );
    }
  );

  card.appendChild(
    title
  );

  /* ------------------------------------------------------------------------ */
  /* Body                                                                     */
  /* ------------------------------------------------------------------------ */

  const body =
    document.createElement(
      "div"
    );

  body.className =
    "fn-body";

  /* ------------------------------------------------------------------------ */
  /* Evidence                                                                 */
  /* ------------------------------------------------------------------------ */

  const evidence =
    document.createElement(
      "div"
    );

  evidence.className =
    "evidence";

  if (
    fn._recoveryScore != null
  ) {
    const scoreBtn =
      document.createElement(
        "button"
      );

    scoreBtn.type =
      "button";

    scoreBtn.className =
      "score-info";

    scoreBtn.innerHTML =
      `${scoreLabel(
        fn._recoveryScore
      )} · recovery score <strong>${
        fn._recoveryScore
      }/100</strong>`;

    scoreBtn.title =
      "Click for breakdown";

    scoreBtn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();

        showScoreBreakdown(
          fn
        );
      }
    );

    evidence.appendChild(
      scoreBtn
    );
  } else {
    evidence.textContent =
      isGuessed
        ? "Reconstructed from bytecode. Signature and mutability may be incomplete."
        : "Source ABI verified by explorer.";
  }

  evidence.appendChild(
    addCopyButton(
      currentAddress,
      "address"
    )
  );

  body.appendChild(
    evidence
  );

  /* ------------------------------------------------------------------------ */
  /* Emergency warning                                                        */
  /* ------------------------------------------------------------------------ */

  if (
    isEmergencyFunction(
      fn.name
    )
  ) {
    const warning =
      document.createElement(
        "div"
      );

    warning.className =
      "warning function-warning";

    warning.textContent =
      "High-risk function name. Review access control, destination, and asset effects before simulating or signing.";

    body.appendChild(
      warning
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Function inputs                                                          */
  /* ------------------------------------------------------------------------ */

  const inputEls = [];

  (fn.inputs || []).forEach(
    (inp, idx) => {
      const wrap =
        document.createElement(
          "label"
        );

      wrap.className =
        "fn-input";

      const label =
        document.createElement(
          "span"
        );

      label.textContent =
        `${inp.name || getArgName(
          inp.type,
          idx
        )} · ${inp.type}`;

      const input =
        document.createElement(
          "input"
        );

      input.type = "text";
      input.placeholder =
        inp.type;
      input.dataset.type =
        inp.type;

      wrap.append(
        label,
        input
      );

      body.appendChild(
        wrap
      );

      inputEls.push(
        input
      );
    }
  );

  /* ------------------------------------------------------------------------ */
  /* Payable ETH input                                                        */
  /* ------------------------------------------------------------------------ */

  if (
    !isView &&
    fn.stateMutability ===
      "payable"
  ) {
    const wrap =
      document.createElement(
        "label"
      );

    wrap.className =
      "fn-input";

    const label =
      document.createElement(
        "span"
      );

    label.textContent =
      "ETH value to send";

    const input =
      document.createElement(
        "input"
      );

    input.type = "text";
    input.placeholder =
      "0.0";

    input.dataset.ethValue =
      "true";

    wrap.append(
      label,
      input
    );

    body.appendChild(
      wrap
    );

    inputEls.push(
      input
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Actions                                                                  */
  /* ------------------------------------------------------------------------ */

  const actions =
    document.createElement(
      "div"
    );

  actions.className =
    "row actions";

  /* Bookmark */

  const bookmarkBtn =
    document.createElement(
      "button"
    );

  bookmarkBtn.type =
    "button";

  bookmarkBtn.className =
    "secondary bookmark-btn";

  const bookmarks =
    readStorage(
      BOOKMARK_STORAGE_KEY,
      []
    );

  const bookmarked =
    bookmarks.some(
      (bookmark) =>
        bookmark.key ===
        functionKey(fn)
    );

  bookmarkBtn.textContent =
    bookmarked
      ? "★ Bookmarked"
      : "☆ Bookmark";

  bookmarkBtn.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      toggleBookmark(fn);

      const updated =
        readStorage(
          BOOKMARK_STORAGE_KEY,
          []
        );

      bookmarkBtn.textContent =
        updated.some(
          (bookmark) =>
            bookmark.key ===
            functionKey(fn)
        )
          ? "★ Bookmarked"
          : "☆ Bookmark";
    }
  );

  actions.appendChild(
    bookmarkBtn
  );

  /* Simulation */

  const simulateBtn =
    document.createElement(
      "button"
    );

  simulateBtn.type =
    "button";

  simulateBtn.textContent =
    isView
      ? "Call read-only"
      : "Simulate first";

  actions.appendChild(
    simulateBtn
  );

  /* Result box */

  const resultBox =
    document.createElement(
      "pre"
    );

  resultBox.className =
    "result-box";

  resultBox.hidden = true;

  /* Send transaction */

  if (!isView) {
    const sendBtn =
      document.createElement(
        "button"
      );

    sendBtn.type =
      "button";

    sendBtn.className =
      "secondary";

    sendBtn.textContent =
      "Send transaction";

    sendBtn.disabled =
      isGuessed ||
      !cfg().SEND_TX_ENABLED;

    sendBtn.title =
      isGuessed
        ? "Guessed ABIs are simulation-only for safety."
        : !cfg().SEND_TX_ENABLED
        ? "Live writes disabled in config."
        : "";

    actions.appendChild(
      sendBtn
    );

    sendBtn.addEventListener(
      "click",
      async (e) => {
        e.stopPropagation();

        try {
          const args =
            inputEls
              .filter(
                (input) =>
                  !input.dataset
                    .ethValue
              )
              .map(
                (input) =>
                  coerceArg(
                    input.value,
                    input.dataset.type
                  )
              );

          const valueInput =
            inputEls.find(
              (input) =>
                input.dataset
                  .ethValue
            );

          const value =
            valueInput &&
            valueInput.value.trim()
              ? valueInput.value.trim()
              : "0";

          await executeTransaction(
            fn,
            args,
            value,
            resultBox
          );
        } catch (e) {
          resultBox.hidden =
            false;

          resultBox.textContent =
            `Transaction blocked: ${
              e.message || e
            }`;
        }
      }
    );
  }

  body.appendChild(
    actions
  );

  body.appendChild(
    resultBox
  );

  /* ------------------------------------------------------------------------ */
  /* Simulation event                                                         */
  /* ------------------------------------------------------------------------ */

  simulateBtn.addEventListener(
    "click",
    async (e) => {
      e.stopPropagation();

      resultBox.hidden = false;
      resultBox.textContent =
        "Simulating…";

      try {
        const args =
          inputEls
            .filter(
              (input) =>
                !input.dataset
                  .ethValue
            )
            .map(
              (input) =>
                coerceArg(
                  input.value,
                  input.dataset.type
                )
            );

        const valueInput =
          inputEls.find(
            (input) =>
              input.dataset
                .ethValue
          );

        const value =
          valueInput &&
          valueInput.value.trim()
            ? valueInput.value.trim()
            : "0";

        const result =
          await simulateFunction(
            fn,
            args,
            value
          );

        resultBox.textContent =
          result;

        recordCall(
          fn,
          "simulation succeeded"
        );
      } catch (e) {
        const errorMsg =
          e.reason ||
          e.shortMessage ||
          e.message ||
          String(e);

        let userMessage =
          `Simulation failed: ${errorMsg}`;

        if (
          /revert/i.test(
            errorMsg
          )
        ) {
          userMessage +=
            "\n\n💡 The contract rejected this call. Check the function parameters and contract state.";
        } else if (
          /out of gas/i.test(
            errorMsg
          )
        ) {
          userMessage +=
            "\n\n💡 Estimated gas exceeds limits. This might fail on-chain.";
        } else if (
          /network/i.test(
            errorMsg
          )
        ) {
          userMessage +=
            "\n\n💡 Network issue. Check your connection and try again.";
        }

        resultBox.textContent =
          userMessage;

        recordCall(
          fn,
          `simulation failed: ${errorMsg.split("\n")[0]}`
        );
      }
    }
  );

  card.appendChild(
    body
  );

  return card;
}

/* -------------------------------------------------------------------------- */
/* ARGUMENT COERCION                                                          */
/* -------------------------------------------------------------------------- */

function coerceArg(
  value,
  type
) {
  const trimmed =
    String(value ?? "").trim();

  if (!trimmed) {
    if (
      type === "string" ||
      type === "bytes"
    ) {
      return trimmed;
    }

    throw new Error(
      `${type} is required`
    );
  }

  /* Address */

  if (type === "address") {
    if (
      !ethers.isAddress(
        trimmed
      )
    ) {
      throw new Error(
        `"${trimmed}" is not a valid Ethereum address`
      );
    }

    return ethers.getAddress(
      trimmed
    );
  }

  /* Integers */

  if (
    /^u?int\d*$/.test(type)
  ) {
    try {
      BigInt(trimmed);

      return trimmed;
    } catch (_) {
      throw new Error(
        `"${trimmed}" is not a valid integer for type ${type}`
      );
    }
  }

  /* Boolean */

  if (type === "bool") {
    if (
      !/^(true|false|0|1)$/i.test(
        trimmed
      )
    ) {
      throw new Error(
        `${type} must be "true", "false", "0", or "1"`
      );
    }

    return (
      trimmed.toLowerCase() ===
        "true" ||
      trimmed === "1"
    );
  }

  /* Arrays */

  if (type.endsWith("]")) {
    try {
      return JSON.parse(
        trimmed
      );
    } catch (_) {
      return trimmed
        .split(",")
        .map((v) =>
          v.trim()
        );
    }
  }

  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* ETHERS INTERFACE                                                           */
/* -------------------------------------------------------------------------- */

function getInterface(fn) {
  return new ethers.Interface([
    fn,
  ]);
}

/* -------------------------------------------------------------------------- */
/* SIMULATION                                                                 */
/* -------------------------------------------------------------------------- */

async function simulateFunction(
  fn,
  args,
  ethValue = "0"
) {
  if (
    signer &&
    !(await validateWalletNetwork(
      false
    ))
  ) {
    throw new Error(
      "Switch your wallet to the selected network before simulating."
    );
  }

  const readProvider =
    getReadProvider(
      currentNetworkKey
    );

  let from = null;

  if (signer) {
    from =
      await signer.getAddress();
  }

  const iface =
    getInterface(fn);

  const data =
    iface.encodeFunctionData(
      fn.name,
      args
    );

  const parsedValue =
    ethers.parseEther(
      ethValue || "0"
    );

  const tx = {
    to: currentAddress,
    data,
    value: parsedValue,
  };

  if (from) {
    tx.from = from;
  }

  /* Read-only */

  if (
    fn.stateMutability ===
      "view" ||
    fn.stateMutability ===
      "pure"
  ) {
    const result =
      await readProvider.call(
        tx
      );

    const decoded =
      iface.decodeFunctionResult(
        fn.name,
        result
      );

    return (
      `✓ Read succeeded\n\n` +
      safeStringify(
        decoded.length === 1
          ? decoded[0]
          : decoded
      )
    );
  }

  /* Gas estimation */

  let gas = null;
  let gasNote = "";

  try {
    gas =
      await readProvider.estimateGas(
        tx
      );
  } catch (e) {
    gasNote =
      "\n⚠️ Gas estimation unavailable. The transaction may still fail on-chain.";

    console.warn(
      "Gas estimation failed:",
      e
    );
  }

  /* Actual eth_call simulation */

  try {
    await readProvider.call(
      tx
    );
  } catch (e) {
    throw new Error(
      `Contract execution failed during simulation: ${
        e.reason ||
        e.shortMessage ||
        e.message ||
        e
      }`
    );
  }

  /* Gas pricing */

  let gasPriceGwei =
    "unavailable";

  let estimatedCostEth =
    "unavailable";

  if (gas) {
    try {
      const feeData =
        await readProvider.getFeeData();

      const maxFeePerGas =
        feeData.maxFeePerGas ||
        feeData.gasPrice;

      if (maxFeePerGas) {
        gasPriceGwei =
          ethers.formatUnits(
            maxFeePerGas,
            "gwei"
          );

        estimatedCostEth =
          ethers.formatEther(
            gas * maxFeePerGas
          );
      }
    } catch (e) {
      console.warn(
        "Unable to retrieve gas price:",
        e
      );
    }
  }

  return (
    `✓ eth_call simulation succeeded${gasNote}` +
    `\n\n` +
    `╔════════════════════════════╗\n` +
    `║  SIMULATION DETAILS        ║\n` +
    `╠════════════════════════════╣\n` +
    `║ Target:        ${shortAddress(currentAddress)}\n` +
    `║ Function:      ${functionSignature(fn)}\n` +
    `║ From:          ${
      from
        ? shortAddress(from)
        : "not connected"
    }\n` +
    `║ Value:         ${
      ethValue || "0"
    } ETH\n` +
    `╠════════════════════════════╣\n` +
    `║ Estimated Gas: ${
      gas
        ? gas.toString()
        : "unavailable"
    } units\n` +
    `║ Gas Price:     ${gasPriceGwei} Gwei\n` +
    `║ Estimated Fee: ~${
      estimatedCostEth
    } ETH\n` +
    `╚════════════════════════════╝\n\n` +
    `→ No transaction has been sent. Review above before confirming.`
  );
}

/* -------------------------------------------------------------------------- */
/* TRANSACTIONS                                                               */
/* -------------------------------------------------------------------------- */

async function executeTransaction(
  fn,
  args,
  ethValue,
  resultBox
) {
  resultBox.hidden = false;

  try {
    if (!signer) {
      throw new Error(
        "Connect a wallet before sending."
      );
    }

    if (
      !(await validateWalletNetwork(
        true
      ))
    ) {
      return;
    }

    if (
      currentSource !==
      "verified"
    ) {
      throw new Error(
        "Safety lock: guessed bytecode signatures cannot send transactions."
      );
    }

    const simulation =
      await simulateFunction(
        fn,
        args,
        ethValue
      );

    const ok =
      window.confirm(
        `${simulation}\n\nSend this transaction from your wallet?`
      );

    if (!ok) {
      resultBox.textContent =
        "Cancelled. No transaction sent.";

      return;
    }

    const iface =
      getInterface(fn);

    const data =
      iface.encodeFunctionData(
        fn.name,
        args
      );

    const tx =
      await signer.sendTransaction({
        to: currentAddress,
        data,
        value:
          ethers.parseEther(
            ethValue || "0"
          ),
      });

    resultBox.textContent =
      `Transaction submitted\n\n` +
      `Hash: ${tx.hash}\n\n` +
      `Waiting for confirmation…`;

    const receipt =
      await tx.wait();

    resultBox.textContent +=
      `\nConfirmed in block ${receipt.blockNumber}.`;

    recordCall(
      fn,
      "transaction confirmed"
    );
  } catch (e) {
    resultBox.textContent =
      `Transaction blocked/failed: ${
        e.reason ||
        e.shortMessage ||
        e.message ||
        e
      }`;

    recordCall(
      fn,
      "transaction failed"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ABI EXPORT                                                                 */
/* -------------------------------------------------------------------------- */

function exportAbi() {
  if (!currentAbi.length) {
    return;
  }

  const functionsOnly =
    currentAbi.filter(
      (item) =>
        item.type ===
        "function"
    );

  if (!functionsOnly.length) {
    alert(
      "No functions to export"
    );

    return;
  }

  const cleanAbi =
    functionsOnly.map(
      (fn) => ({
        type: fn.type,
        name: fn.name,
        inputs:
          fn.inputs || [],
        outputs:
          fn.outputs || [],
        stateMutability:
          fn.stateMutability ||
          "nonpayable",
      })
    );

  const blob =
    new Blob(
      [
        safeStringify(
          cleanAbi
        ),
      ],
      {
        type:
          "application/json",
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  const a =
    document.createElement(
      "a"
    );

  a.href = url;

  const addressPrefix =
    currentAddress
      ? currentAddress.slice(
          2,
          8
        )
      : "unknown";

  a.download =
    `contract-${addressPrefix}-abi.json`;

  a.click();

  URL.revokeObjectURL(
    url
  );
}

/* -------------------------------------------------------------------------- */
/* DEMO CONTRACT                                                              */
/* -------------------------------------------------------------------------- */

function loadDemoContract() {
  const demo =
    cfg().DEMO_CONTRACT;

  if (
    !demo ||
    !demo.address
  ) {
    setStatus(
      "load-status",
      "Set DEMO_CONTRACT.address in config.js before using the demo loader.",
      "error"
    );

    return;
  }

  const address =
    demo.address.trim();

  if (
    !ethers.isAddress(
      address
    )
  ) {
    setStatus(
      "load-status",
      `Demo address in config.js is invalid: ${address}`,
      "error"
    );

    return;
  }

  const addressInput =
    $("contract-address");

  const networkSelect =
    $("network-select");

  if (addressInput) {
    addressInput.value =
      ethers.getAddress(
        address
      );
  }

  if (networkSelect) {
    networkSelect.value =
      demo.network ||
      cfg().DEFAULT_NETWORK;
  }

  decodeContract();
}

/* -------------------------------------------------------------------------- */
/* INITIALIZATION                                                             */
/* -------------------------------------------------------------------------- */

window.addEventListener(
  "DOMContentLoaded",
  () => {
    /* Config guard */

    if (!window.ZOMBIE_CONFIG) {
      console.error(
        "ZOMBIE_CONFIG is missing. Make sure config.js loads before app.js."
      );

      setStatus(
        "load-status",
        "Configuration failed to load. Check that config.js is loaded before app.js.",
        "error"
      );

      return;
    }

    /* Initial UI */

    populateNetworkSelect();
    renderHistory();

    /* Button handlers */

    const connectBtn =
      $("connect-btn");

    const loadBtn =
      $("load-btn");

    const demoBtn =
      $("demo-btn");

    const exportBtn =
      $("export-btn");

    const networkSelect =
      $("network-select");

    if (connectBtn) {
      connectBtn.addEventListener(
        "click",
        connectWallet
      );
    }

    if (loadBtn) {
      loadBtn.addEventListener(
        "click",
        decodeContract
      );
    }

    if (demoBtn) {
      demoBtn.addEventListener(
        "click",
        loadDemoContract
      );
    }

    if (exportBtn) {
      exportBtn.addEventListener(
        "click",
        exportAbi
      );
    }

    if (networkSelect) {
      networkSelect.addEventListener(
        "change",
        () =>
          validateWalletNetwork(
            false,
            networkSelect.value
          )
      );
    }

    /* Wallet events */

    if (
      window.ethereum?.on
    ) {
      window.ethereum.on(
        "accountsChanged",
        (accounts) =>
          connectWallet(
            false,
            accounts
          )
      );

      window.ethereum.on(
        "chainChanged",
        () =>
          validateWalletNetwork(
            false
          )
      );
    }

    /* Keyboard shortcuts */

    document.addEventListener(
      "keydown",
      (e) => {
        if (
          !e.ctrlKey &&
          !e.metaKey
        ) {
          return;
        }

        switch (
          e.key.toLowerCase()
        ) {
          case "k":
            e.preventDefault();

            $(
              "contract-address"
            )?.focus();

            break;

          case "enter":
            e.preventDefault();

            decodeContract();

            break;

          case "m":
            e.preventDefault();

            connectWallet();

            break;

          case "e":
            e.preventDefault();

            exportAbi();

            break;
        }
      }
    );
  }
);