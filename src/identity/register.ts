import { ethers } from 'ethers';
import type {
  AgentMetadata,
  AgentRegistrationConfig,
  AgentRegistrationResult,
  AgentIdentityInfo,
} from './types.js';

// Minimal ABI for ERC-8004 Identity contract
const IDENTITY_ABI = [
  'function register(string metadataURI) external returns (uint256 tokenId)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

/**
 * Agent registration client for ERC-8004 Identity contract
 */
export class AgentRegistration {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly contract: ethers.Contract;

  constructor(config: AgentRegistrationConfig) {
    // Validate all required fields
    if (!config.identityContractAddress) {
      throw new Error('identityContractAddress is required');
    }
    if (!config.reputationContractAddress) {
      throw new Error('reputationContractAddress is required');
    }
    if (!config.chainRpcUrl) {
      throw new Error('chainRpcUrl is required');
    }
    if (!config.privateKey) {
      throw new Error('privateKey is required');
    }

    this.provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
    this.contract = new ethers.Contract(
      config.identityContractAddress,
      IDENTITY_ABI,
      this.signer
    );
  }

  /**
   * Register agent on ERC-8004 Identity contract
   */
  async register(metadata: AgentMetadata): Promise<AgentRegistrationResult> {
    // Create metadata URI
    const metadataUri = createMetadataUri(metadata);

    // Call contract.register
    const tx = await this.contract.register(metadataUri);

    // Wait for transaction receipt
    const receipt = await tx.wait();

    // Extract tokenId from logs (Transfer event topic[3] or indexed tokenId)
    if (!receipt.logs || receipt.logs.length === 0) {
      throw new Error('No logs found in transaction receipt');
    }

    // The second topic in the first log should be the tokenId (indexed parameter)
    const tokenIdHex = receipt.logs[0].topics[1];
    const tokenId = BigInt(tokenIdHex);

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
  async getRegistration(): Promise<AgentIdentityInfo | null> {
    const balance = await this.contract.balanceOf(this.signer.address);

    if (balance === 0n) {
      return null;
    }

    // Find tokenId via Transfer events (contract doesn't have tokenOfOwner)
    const tokenId = await this.findTokenId();
    if (tokenId === null) {
      // Fallback: registered but can't find tokenId
      return {
        tokenId: 0n,
        owner: this.signer.address,
        metadataUri: '',
        isRegistered: true,
      };
    }

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
    const addressPadded = ethers.zeroPadValue(this.signer.address, 32);
    const transferFilter = this.contract.filters.Transfer(null, this.signer.address);

    const currentBlock = await this.provider.getBlockNumber();
    const chunkSize = 9999;

    // Scan backwards in chunks (most recent first)
    for (let toBlock = currentBlock; toBlock > 0; toBlock -= chunkSize) {
      const fromBlock = Math.max(0, toBlock - chunkSize);
      try {
        const events = await this.contract.queryFilter(transferFilter, fromBlock, toBlock);
        if (events.length > 0) {
          // Return the most recent token
          const lastEvent = events[events.length - 1];
          const tokenId = BigInt((lastEvent as ethers.EventLog).args[2]);
          return tokenId;
        }
      } catch {
        // RPC error on this chunk, try next
        continue;
      }

      // Only scan last 50k blocks max to avoid long startup
      if (currentBlock - fromBlock > 50000) break;
    }

    return null;
  }

  /**
   * Update the metadata URI for a registered agent
   * @param tokenId Agent's ERC-721 token ID
   * @param metadata New agent metadata
   * @returns Transaction hash
   */
  async updateMetadata(tokenId: bigint, metadata: AgentMetadata): Promise<string> {
    const metadataUri = createMetadataUri(metadata);
    const tx = await this.contract.setAgentURI(tokenId, metadataUri);
    await tx.wait();
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

  if (metadata.tee !== undefined) {
    json.tee = metadata.tee;
  }

  if (metadata.x402Support !== undefined) {
    json.x402Support = metadata.x402Support;
  }

  if (metadata.services !== undefined) {
    json.services = metadata.services;
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
