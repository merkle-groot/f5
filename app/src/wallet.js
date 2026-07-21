/**
 * The wallet connection, on top of `@wagmi/core`.
 *
 * `window.ethereum` is a single slot that whichever extension loaded last wins,
 * so with two wallets installed the user had no way to reach the other one.
 * wagmi discovers them all over EIP-6963 and exposes one connector per wallet.
 *
 * What it buys beyond discovery is the state that is easy to get wrong by hand:
 * a connection that is persisted only once it actually succeeds, so a wallet
 * that is installed but never set up cannot become a permanently remembered
 * choice; a `reconnect` that restores the last working wallet on load; and a
 * single connection subscription in place of per-provider event listeners that
 * would otherwise stay bound to the wallet the user just left.
 *
 * The pool's chain is not known until `/api/config` answers, so the config is
 * built at init rather than at import. `connectors` is injectable for tests.
 */
import {
  connect,
  createConfig,
  createStorage,
  disconnect,
  getAccount,
  getConnectors,
  getPublicClient,
  getWalletClient,
  reconnect,
  switchChain,
  watchAccount,
  watchConnectors,
} from "@wagmi/core";
import { http } from "viem";

export function createWallet({ chain, storage, connectors, onChange }) {
  const config = createConfig({
    chains: [chain],
    // Left on: this is the EIP-6963 discovery that produces one connector per
    // installed wallet. Passing explicit connectors is only for tests.
    multiInjectedProviderDiscovery: !connectors,
    connectors,
    transports: { [chain.id]: http(chain.rpcUrls.default.http[0]) },
    storage: storage ? createStorage({ storage }) : null,
  });

  /** Every installed wallet, as `{ uid, name, icon }` for the picker. */
  function available() {
    return getConnectors(config).map((connector) => ({
      uid: connector.uid,
      name: connector.name,
      icon: connector.icon,
    }));
  }

  function connection() {
    return getAccount(config);
  }

  /** The connected address, or "" — the shape the rest of the app already uses. */
  function account() {
    return connection().address ?? "";
  }

  /** The chain the wallet is on, or null when it has not answered. */
  function chainId() {
    return connection().chainId ?? null;
  }

  function connectorFor(uid) {
    return getConnectors(config).find((candidate) => candidate.uid === uid);
  }

  /**
   * Connect to one specific wallet.
   *
   * wagmi records the connection only on success, so a wallet that fails here
   * is not remembered and the next attempt starts from a clean choice.
   */
  async function connectTo(uid) {
    const connector = connectorFor(uid);
    if (!connector) throw new Error("That wallet is no longer available.");
    const { accounts } = await connect(config, { connector });
    if (!accounts?.[0]) throw new Error(`${connector.name} returned no account — it may not be set up yet.`);
    return accounts[0];
  }

  /** Drop the connection, so the next connect asks which wallet again. */
  async function release() {
    await disconnect(config);
  }

  /** Restore the last working wallet, if there was one. Never throws. */
  async function restore() {
    try {
      await reconnect(config);
    } catch {
      // A wallet that will not reconnect is not an error the user asked to see:
      // they are simply still disconnected, and the picker says so.
    }
    return account();
  }

  /** A viem public client for reads, on the pool's chain. */
  function publicClient() {
    return getPublicClient(config);
  }

  /** A viem wallet client for signing. Throws when nothing is connected. */
  function signingClient() {
    return getWalletClient(config);
  }

  /**
   * Ask the wallet to move to the pool's chain.
   *
   * `addEthereumChainParameter` is what wagmi falls back to when the wallet has
   * never heard of the chain, replacing the hand-rolled 4902 retry.
   */
  async function switchToChain(explorerUrl) {
    await switchChain(config, {
      chainId: chain.id,
      addEthereumChainParameter: {
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http.filter(Boolean),
        blockExplorerUrls: explorerUrl ? [explorerUrl] : undefined,
      },
    });
  }

  // One subscription covers what used to be `accountsChanged` and
  // `chainChanged` on a provider that could go stale underneath us. The
  // connector list is watched too, so a wallet installed mid-session shows up.
  const stopConnection = onChange ? watchAccount(config, { onChange: () => onChange() }) : () => {};
  const stopConnectors = onChange ? watchConnectors(config, { onChange: () => onChange() }) : () => {};

  return {
    config,
    available,
    account,
    chainId,
    connection,
    connectTo,
    release,
    restore,
    publicClient,
    signingClient,
    switchToChain,
    destroy: () => { stopConnection(); stopConnectors(); },
  };
}
