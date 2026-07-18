/**
 * Provides an interface to interact with the Privacy Pool SDK.
 */

import {
  calculateRelayContext,
  Circuits,
  ContractInteractionsService,
  PrivacyPoolSDK,
  RelayWithdrawal,
  WithdrawalProof,
  SDKError,
  type Hash,
} from "@0xbow/privacy-pools-core-sdk";
import { Address } from "viem";
import {
  CONFIG,
  getSignerPrivateKey
} from "../config/index.js";
import { WithdrawalPayload } from "../interfaces/relayer/request.js";
import { RelayerError, SdkError, ConfigError } from "../exceptions/base.exception.js";
import { SdkProviderInterface } from "../types/sdk.types.js";
import { createChainObject } from "../utils.js";

/**
 * Class representing the SDK provider for interacting with Privacy Pool SDK.
 */
export class SdkProvider implements SdkProviderInterface {
  /** Instance of the PrivacyPoolSDK. */
  private sdk: PrivacyPoolSDK;
  
  /** Map of chain ID to contract interactions service */
  private contractsByChain: Map<number, ContractInteractionsService>;

  /**
   * Initializes a new instance of the SDK provider.
   */
  constructor() {
    this.sdk = new PrivacyPoolSDK(new Circuits({ browser: false }));
    this.contractsByChain = new Map();
    
    // Initialize contract instances for all supported chains
    CONFIG.chains.forEach(chainConfig => {
      try {
        // Create chain object
        const chain = createChainObject(chainConfig);
        
        // Get entrypoint address and signer private key
        const entrypointAddress = chainConfig.entrypoint_address || CONFIG.defaults.entrypoint_address;
        // Resolve through the shared helper, not the config directly: it also honours
        // RELAYER_PRIVATE_KEY. Reading the config here meant this SDK instance and web3Provider's
        // signer could silently be two DIFFERENT accounts whenever the env override was set.
        const signerPrivateKey = getSignerPrivateKey(chainConfig.chain_id) as `0x${string}`;
        
        // Create contract instance
        const contracts = this.sdk.createContractInstance(
          chainConfig.rpc_url,
          chain,
          entrypointAddress,
          signerPrivateKey,
        );
        
        this.contractsByChain.set(chainConfig.chain_id, contracts);
      } catch (error) {
        console.error(`Error initializing chain ${chainConfig.chain_id}: ${error}`);
      }
    });
    
    if (this.contractsByChain.size === 0) {
      throw new Error("No chains were successfully initialized");
    }
  }

  /**
   * Gets the contract interactions service for a specific chain.
   * 
   * @param {number} chainId - The chain ID.
   * @returns {ContractInteractionsService} - The contract interactions service for the specified chain.
   * @throws {RelayerError} - If the chain is not supported.
   */
  private getContractsForChain(chainId: number): ContractInteractionsService {
    const contracts = this.contractsByChain.get(chainId);
    if (!contracts) {
      throw ConfigError.default(`Chain with ID ${chainId} not supported.`);
    }
    return contracts;
  }

  /**
   * Verifies a withdrawal proof.
   *
   * @param {WithdrawalProof} withdrawalPayload - The withdrawal proof payload.
   * @returns {Promise<boolean>} - A promise resolving to a boolean indicating verification success.
   */
  async verifyWithdrawal(withdrawalPayload: WithdrawalProof): Promise<boolean> {
    return await this.sdk.verifyWithdrawal(withdrawalPayload);
  }

  /**
   * Broadcasts a withdrawal transaction.
   *
   * @param {WithdrawalPayload} withdrawalPayload - The withdrawal payload.
   * @param {number} chainId - The chain ID to broadcast on.
   * @returns {Promise<{ hash: string }>} - A promise resolving to an object containing the transaction hash.
   */
  async broadcastWithdrawal(
    withdrawalPayload: WithdrawalPayload,
    chainId: number,
  ): Promise<{ hash: string }> {
    const contracts = this.getContractsForChain(chainId);
    return contracts.relay(
      withdrawalPayload.withdrawal,
      withdrawalPayload.proof,
      withdrawalPayload.scope as Hash,
    );
  }

  /**
   * Calculates the Mode-3 relay context (`{chainId, data}` shape).
   *
   * @param {RelayWithdrawal} withdrawal - The relay withdrawal object.
   * @param {bigint} scope - The scope value.
   * @returns {string} - The calculated context.
   */
  calculateContext(withdrawal: RelayWithdrawal, scope: bigint): string {
    return calculateRelayContext(withdrawal, scope as Hash);
  }

  /**
   * Converts a scope value to an asset address.
   *
   * @param {bigint} scope - The scope value.
   * @param {number} chainId - The chain ID.
   * @returns {Promise<{ poolAddress: Address; assetAddress: Address; }>} - A promise resolving to the asset address.
   */
  async scopeData(
    scope: bigint,
    chainId: number,
  ): Promise<{ poolAddress: Address; assetAddress: Address }> {
    try {
      const contracts = this.getContractsForChain(chainId);
      const data = await contracts.getScopeData(scope);
      return data;
    } catch (error) {
      if (error instanceof SDKError) {
        throw SdkError.scopeDataError(error);
      } else {
        throw RelayerError.unknown(JSON.stringify(error));
      }
    }
  }

  /**
   * The L1->L2 message/gas fee the relayer must front for a `relay()` bound to
   * `destinationChainId` (0 for OP-Stack, non-zero for Arbitrum/Starknet). Read
   * from the on-chain bridge config via the SDK so the pool and quote never drift.
   *
   * @param {number} processingChainId - The chain the relay is submitted on (where the entrypoint lives).
   * @param {Address} assetAddress - The pool asset (native sentinel or ERC20).
   * @param {bigint} destinationChainId - The bridge destination (`withdrawal.chainId`).
   * @returns {Promise<bigint>} - The fronted fee in wei.
   */
  async bridgeMsgValue(
    processingChainId: number,
    assetAddress: Address,
    destinationChainId: bigint,
  ): Promise<bigint> {
    const contracts = this.getContractsForChain(processingChainId);
    return contracts.bridgeMsgValue(assetAddress, destinationChainId);
  }
}
