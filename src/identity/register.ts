import { ethers } from 'ethers';
import type {
  AgentMetadata,
  AgentRegistrationConfig,
  AgentRegistrationResult,
  AgentIdentityInfo,
} from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('Identity');

// Minimal ABI for ERC-8004 Identity contract (includes ERC-721 Enumerable)
const IDENTITY_ABI = [
  'function register(string metadataURI) external returns (uint256 tokenId)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

/**
 * Agent registration client for ERC-8004 Identity contract
 */
export class AgentRegistration {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly contract: ethers.Contract;
  private lastTxNonce: number = -1;
  private confirmedWriteBlock: number | undefined;
  private readonly identityAddress: string;

  constructor(config: AgentRegistrationConfig) {
    // Validate all required fields
    if (!config.identityContractAddress) {
      throw new Error('identityContractAddress is required');
    }
    if (!config.chainRpcUrl) {
      throw new Error('chainRpcUrl is required');
    }
    if (!config.privateKey) {
      throw new Error('privateKey is required');
    }

    this.identityAddress = config.identityContractAddress;
    this.provider = new ethers.JsonRpcProvider(config.chainRpcUrl, undefined, { cacheTimeout: -1 });
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
    this.contract = new ethers.Contract(
      config.identityContractAddress,
      IDENTITY_ABI,
      this.signer
    );
  }

  /** Read our own writes at the mined block, never at a lagging RPC "latest". */
  private confirmWrite(receipt: ethers.TransactionReceipt | null): void {
    if (!receipt || receipt.status !== 1 || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
      throw new Error('Expected a successful confirmed registration transaction receipt');
    }
    this.confirmedWriteBlock = Math.max(this.confirmedWriteBlock ?? 0, receipt.blockNumber);
  }

  private readOverrides(): { blockTag: number | 'latest' } {
    return { blockTag: this.confirmedWriteBlock ?? 'latest' };
  }

  /**
   * Get next nonce, tracking locally to prevent provider cache staleness
   * between sequential transactions in the same session
   */
  private async getNextNonce(): Promise<number> {
    const providerNonce = await this.provider.getTransactionCount(this.signer.address, 'latest');
    const nextNonce = Math.max(providerNonce, this.lastTxNonce + 1);
    this.lastTxNonce = nextNonce;
    return nextNonce;
  }

  /**
   * Build gas overrides for the current chain.
   * Ethereum mainnet needs explicit gasLimit to avoid slow eth_estimateGas on large calldata.
   */
  private async getGasOverrides(dataSize: number): Promise<Record<string, unknown>> {
    const nonce = await this.getNextNonce();
    const network = await this.provider.getNetwork();
    const chainId = Number(network.chainId);

    // Arc stores the complete metadata URI; use real gas estimation rather
    // than the Ethereum workaround, whose fixed limit can underprice storage.
    if (chainId === 8453 || chainId === 84532 || chainId === 5042002) {
      return { nonce };
    }

    // Ethereum mainnet/sepolia: set explicit gas to avoid slow estimation
    const feeData = await this.provider.getFeeData();
    log.info({ action: 'identity.gas.feeData', chainId, maxFeePerGas: feeData.maxFeePerGas?.toString(), maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(), gasPrice: feeData.gasPrice?.toString(), dataSize }, 'Fee data for TX');

    // Estimate gasLimit: base cost (21K) + calldata (16 gas per non-zero byte) + execution (~160K)
    const estimatedGas = 21000 + (dataSize * 16) + 2200000;

    const overrides: Record<string, unknown> = { nonce, gasLimit: estimatedGas };

    if (feeData.maxFeePerGas) {
      // EIP-1559: boost priority fee by 20% for faster inclusion
      const basePriority = feeData.maxPriorityFeePerGas ?? 1000000000n;
      overrides.maxPriorityFeePerGas = basePriority * 120n / 100n;
      overrides.maxFeePerGas = feeData.maxFeePerGas * 120n / 100n;
    }

    log.info({ action: 'identity.gas.overrides', chainId, gasLimit: estimatedGas, ...overrides }, 'Gas overrides for TX');
    return overrides;
  }

  /**
   * Register agent on ERC-8004 Identity contract
   */
  async register(metadata: AgentMetadata): Promise<AgentRegistrationResult> {
    // Create metadata URI
    const metadataUri = createMetadataUri(metadata);

    log.info({ action: 'identity.register.step', step: 'gas_overrides', uriLength: metadataUri.length }, 'Building gas overrides');
    const overrides = await this.getGasOverrides(metadataUri.length);

    log.info({ action: 'identity.register.step', step: 'sending_tx' }, 'Sending register TX');
    const tx = await this.contract.register(metadataUri, overrides);

    log.info({ action: 'identity.register.step', step: 'waiting_receipt', txHash: tx.hash }, 'Waiting for TX receipt');
    const receipt = await tx.wait();
    this.confirmWrite(receipt);

    // Extract tokenId from logs (Transfer event topic[3] or indexed tokenId)
    if (!receipt.logs || receipt.logs.length === 0) {
      throw new Error('No logs found in transaction receipt');
    }

    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const mint = receipt.logs.find((entry: ethers.Log) =>
      entry.address.toLowerCase() === this.identityAddress.toLowerCase() &&
      entry.topics[0] === transferTopic && entry.topics.length === 4 &&
      BigInt(entry.topics[1]) === 0n &&
      entry.topics[2].slice(-40).toLowerCase() === this.signer.address.slice(2).toLowerCase());
    if (!mint) throw new Error('No identity mint Transfer to the configured prover in receipt');
    const tokenId = BigInt(mint.topics[3]);

    return {
      tokenId,
      transactionHash: receipt.hash,
      agentAddress: this.signer.address,
    };
  }

  /**
   * Check if agent is registered
   */
  async isRegistered(): Promise<boolean> {
    const balance = await this.contract.balanceOf(this.signer.address);
    return balance > 0n;
  }

  /**
   * Get agent registration info by scanning Transfer events
   */
  async getRegistration(cachedTokenId?: bigint): Promise<AgentIdentityInfo | null> {
    if (cachedTokenId !== undefined) {
      await this.assertTokenOwner(cachedTokenId);
      return { tokenId: cachedTokenId, owner: this.signer.address, metadataUri: await this.contract.tokenURI(cachedTokenId), isRegistered: true };
    }
    const balance = await this.contract.balanceOf(this.signer.address);

    if (balance === 0n) {
      return null;
    }

    // Find tokenId — try multiple strategies in order of efficiency
    // 1. ERC-721 Enumerable (single RPC call — fastest)
    // 2. Transfer event scan (indexed eth_getLogs — fast even on large collections)
    let tokenId = await this.findTokenIdByEnumerable();
    if (tokenId === null) {
      tokenId = await this.findTokenId();
    }
    if (tokenId === null) {
      throw new Error('Registered agent tokenId could not be resolved; configure an owned AGENT_TOKEN_ID (ARC_AGENT_TOKEN_ID for Arc)');
    }
    await this.assertTokenOwner(tokenId);
    log.info({ action: 'identity.token.resolved', tokenId: tokenId.toString() }, 'Resolved tokenId');

    const metadataUri = await this.contract.tokenURI(tokenId);

    return {
      tokenId,
      owner: this.signer.address,
      metadataUri,
      isRegistered: true,
    };
  }

  /**
   * Find tokenId by scanning Transfer events in chunks
   */
  private async findTokenId(): Promise<bigint | null> {
    const transferFilter = this.contract.filters.Transfer(null, this.signer.address);

    const currentBlock = await this.provider.getBlockNumber();
    const chunkSize = 10000;
    const oldestBlock = Math.max(0, currentBlock - 2000000);

    // Inclusive ranges, with no gaps or overlaps. An unread range is an error,
    // never evidence that the owner has no token in that range.
    for (let toBlock = currentBlock; toBlock >= oldestBlock;) {
      const fromBlock = Math.max(oldestBlock, toBlock - chunkSize + 1);
      let events;
      try {
        events = await this.contract.queryFilter(transferFilter, fromBlock, toBlock);
      } catch {
        // Retry the SAME range once; a persistent RPC failure remains visible.
        events = await this.contract.queryFilter(transferFilter, fromBlock, toBlock);
      }
      for (const event of [...events].reverse()) {
        const tokenId = BigInt((event as ethers.EventLog).args[2]);
        const owner = await this.contract.ownerOf(tokenId);
        if (owner.toLowerCase() === this.signer.address.toLowerCase()) return tokenId;
      }
      toBlock = fromBlock - 1;
    }

    return null;
  }

  /**
   * Find tokenId using ERC-721 Enumerable tokenOfOwnerByIndex
   */
  private async findTokenIdByEnumerable(): Promise<bigint | null> {
    try {
      const tokenId = await this.contract.tokenOfOwnerByIndex(this.signer.address, 0);
      log.debug({ action: 'identity.token.found_by_index', tokenId: tokenId.toString() }, 'Found tokenId via tokenOfOwnerByIndex');
      return BigInt(tokenId);
    } catch {
      return null;
    }
  }

  /** A cached id or historical Transfer is not proof of current ownership. */
  async assertTokenOwner(tokenId: bigint): Promise<void> {
    if (tokenId < 0n || tokenId > (1n << 256n) - 1n) throw new Error(`Invalid agent tokenId: ${tokenId}`);
    const owner: string = await this.contract.ownerOf(tokenId, this.readOverrides());
    if (owner.toLowerCase() !== this.signer.address.toLowerCase()) {
      throw new Error(`Agent token ${tokenId} is owned by ${owner}, not configured prover ${this.signer.address}`);
    }
  }

  /**
   * Get metadata URI for a known tokenId (single RPC call)
   */
  async getTokenMetadata(tokenId: bigint): Promise<string> {
    return this.contract.tokenURI(tokenId, this.readOverrides());
  }

  /**
   * Get on-chain key-value metadata (returns decoded UTF-8 string)
   */
  async getOnchainMetadata(tokenId: bigint, key: string): Promise<string> {
    const raw: string = await this.contract.getMetadata(tokenId, key, this.readOverrides());
    return ethers.toUtf8String(raw);
  }

  /**
   * Set on-chain key-value metadata (e.g., active status)
   * Value is encoded as UTF-8 bytes per ERC-8004 spec
   */
  async setOnchainMetadata(tokenId: bigint, key: string, value: string): Promise<string> {
    const valueBytes = ethers.toUtf8Bytes(value);
    const overrides = await this.getGasOverrides(value.length + 100);
    log.info({ action: 'identity.setMetadata.sending', key, tokenId: tokenId.toString() }, `Sending setMetadata(${key})`);
    const tx = await this.contract.setMetadata(tokenId, key, valueBytes, overrides);
    log.info({ action: 'identity.setMetadata.waiting', txHash: tx.hash }, 'Waiting for setMetadata receipt');
    this.confirmWrite(await tx.wait());
    return tx.hash;
  }

  /**
   * Update the metadata URI for a registered agent
   * @param tokenId Agent's ERC-721 token ID
   * @param metadata New agent metadata
   * @returns Transaction hash
   */
  async updateMetadata(tokenId: bigint, metadata: AgentMetadata): Promise<string> {
    const metadataUri = createMetadataUri(metadata);
    const overrides = await this.getGasOverrides(metadataUri.length);
    log.info({ action: 'identity.updateMetadata.sending', tokenId: tokenId.toString(), uriLength: metadataUri.length }, 'Sending setAgentURI');
    const tx = await this.contract.setAgentURI(tokenId, metadataUri, overrides);
    log.info({ action: 'identity.updateMetadata.waiting', txHash: tx.hash }, 'Waiting for setAgentURI receipt');
    this.confirmWrite(await tx.wait());
    return tx.hash;
  }

  /**
   * Get agent address
   */
  get agentAddress(): string {
    return this.signer.address;
  }
}

/**
 * Create data URI for agent metadata
 */
export function createMetadataUri(metadata: AgentMetadata): string {
  // Create JSON object (omit optional fields if undefined)
  const json: any = {
    name: metadata.name,
    description: metadata.description,
    agentUrl: metadata.agentUrl,
    capabilities: metadata.capabilities,
    protocols: metadata.protocols,
    circuits: metadata.circuits,
  };

  if (metadata.agentType !== undefined) {
    json.agentType = metadata.agentType;
  }

  if (metadata.tee !== undefined) {
    json.tee = metadata.tee;
  }

  if (metadata.x402Support !== undefined) {
    json.x402Support = metadata.x402Support;
  }

  if (metadata.services !== undefined) {
    json.services = metadata.services;
  }

  if (metadata.type !== undefined) {
    json.type = metadata.type;
  }

  if (metadata.image !== undefined) {
    json.image = metadata.image;
  }

  if (metadata.registrations !== undefined) {
    json.registrations = metadata.registrations;
  }

  if (metadata.supportedTrust !== undefined) {
    json.supportedTrust = metadata.supportedTrust;
  }

  if (metadata.active !== undefined) {
    json.active = metadata.active;
  }

  if (metadata.tags !== undefined && metadata.tags.length > 0) {
    json.tags = metadata.tags;
  }

  if (metadata.categories !== undefined && metadata.categories.length > 0) {
    json.categories = metadata.categories;
  }

  if (metadata.domains !== undefined && metadata.domains.length > 0) {
    json.domains = metadata.domains;
  }

  if (metadata.skills !== undefined && metadata.skills.length > 0) {
    json.skills = metadata.skills;
  }

  if (metadata.protocolVersions !== undefined && metadata.protocolVersions.length > 0) {
    json.protocolVersions = metadata.protocolVersions;
  }

  if (metadata.securitySchemes !== undefined) {
    json.securitySchemes = metadata.securitySchemes;
  }

  if (metadata.security !== undefined && metadata.security.length > 0) {
    json.security = metadata.security;
  }

  // Convert to base64
  const jsonString = JSON.stringify(json);
  const base64 = Buffer.from(jsonString, 'utf-8').toString('base64');

  return `data:application/json;base64,${base64}`;
}

/**
 * Parse metadata URI back to AgentMetadata object
 */
export function parseMetadataUri(uri: string): AgentMetadata | null {
  try {
    if (uri.startsWith('data:application/json;base64,')) {
      const base64 = uri.slice('data:application/json;base64,'.length);
      const json = Buffer.from(base64, 'base64').toString('utf-8');
      return JSON.parse(json);
    }
    return null;
  } catch {
    return null;
  }
}
