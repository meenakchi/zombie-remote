// Copy this file to config.js and fill in your own values.
// config.js is intentionally NOT required to run the app — every value here
// can also be set live in the app's Settings panel. This file just lets you
// skip re-typing your API key every demo run.

window.ZOMBIE_CONFIG = {
  // Free key from https://etherscan.io/myapikey
  ETHERSCAN_API_KEY: "",

  // Etherscan-family explorer API bases you want selectable in the network dropdown.
  // (Etherscan v2 unified API covers all of these off one key as of 2024/2025 —
  // if your key is rejected on a given chain, generate a fresh one.)
  NETWORKS: {
    ethereum: {
      label: "Ethereum Mainnet",
      chainId: 1,
      explorerApi: "https://api.etherscan.io/api",
      rpc: "https://cloudflare-eth.com",
    },
    polygon: {
      label: "Polygon",
      chainId: 137,
      explorerApi: "https://api.polygonscan.com/api",
      rpc: "https://polygon-rpc.com",
    },
    arbitrum: {
      label: "Arbitrum One",
      chainId: 42161,
      explorerApi: "https://api.arbiscan.io/api",
      rpc: "https://arb1.arbitrum.io/rpc",
    },
    bsc: {
      label: "BNB Smart Chain",
      chainId: 56,
      explorerApi: "https://api.bscscan.com/api",
      rpc: "https://bsc-dataseed.binance.org",
    },
    sepolia: {
      label: "Ethereum Sepolia (Testnet)",
      chainId: 11155111,
      explorerApi: "https://api-sepolia.etherscan.io/api",
      rpc: "https://rpc.ankr.com/eth_sepolia",
    },
  },

  DEFAULT_NETWORK: "ethereum",

  // Set this to a real testnet contract you control for the live demo.
  DEMO_CONTRACT: { address: "0x...", network: "sepolia" },

  // Safety switch for live demos — read/simulate always works regardless.
  // Flip to true once you've tested end-to-end and want live tx sending.
  SEND_TX_ENABLED: false,

  // Words that flag a function as a likely "rescue" candidate for the
  // highlighted section at the top of the generated UI.
  RESCUE_KEYWORDS: [
    "withdraw", "claim", "redeem", "sweep", "rescue", "exit",
    "emergencywithdraw", "unstake", "drain", "recover", "refund", "collect",
  ],
};
