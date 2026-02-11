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
  'function tokenOfOwner(address owner) external view returns (uint256)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
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
   * Get agent registration info
   */
  async getRegistration(): Promise<AgentIdentityInfo | null> {
    const balance = await this.contract.balanceOf(this.signer.address);

    if (balance === 0n) {
      return null;
    }

    const tokenId = await this.contract.tokenOfOwner(this.signer.address);
    const metadataUri = await this.contract.tokenURI(tokenId);
    const owner = await this.contract.ownerOf(tokenId);

    return {
      tokenId,
      owner,
      metadataUri,
      isRegistered: true,
    };
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
  // Create JSON object (omit tee if undefined)
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

  // Convert to base64
  const jsonString = JSON.stringify(json);
  const base64 = Buffer.from(jsonString, 'utf-8').toString('base64');

  return `data:application/json;base64,${base64}`;
}
