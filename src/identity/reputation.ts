/**
 * ERC-8004 Agent Reputation Management
 * Handles on-chain reputation tracking for prover agents
 */

import { ethers } from 'ethers';
import type { AgentReputationConfig, ReputationDetails } from './types.js';

// ERC-8004 Reputation ABI (minimal interface)
const REPUTATION_ABI = [
  'function incrementScore(address agent) external',
  'function getScore(address agent) external view returns (uint256)',
  'function getReputationDetails(address agent) external view returns (uint256 score, uint256 totalTasks, uint256 successfulTasks, uint256 lastUpdated)',
];

export class AgentReputation {
  private contract: ethers.Contract;
  private signer: ethers.Wallet;

  constructor(config: AgentReputationConfig) {
    if (!config.reputationContractAddress) {
      throw new Error('AgentReputation: reputationContractAddress is required');
    }
    if (!config.chainRpcUrl) {
      throw new Error('AgentReputation: chainRpcUrl is required');
    }
    if (!config.privateKey) {
      throw new Error('AgentReputation: privateKey is required');
    }

    const provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, provider);
    this.contract = new ethers.Contract(config.reputationContractAddress, REPUTATION_ABI, this.signer);
  }

  /**
   * Increment reputation score for an agent
   * @param agentAddress Agent address
   * @returns Transaction hash
   */
  async incrementScore(agentAddress: string): Promise<string> {
    try {
      const tx = await this.contract.incrementScore(agentAddress);
      await tx.wait();
      return tx.hash;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to increment reputation score: ${error.message}`);
      }
      throw new Error('Failed to increment reputation score: unknown error');
    }
  }

  /**
   * Get reputation score for an agent
   * @param agentAddress Agent address
   * @returns Reputation score
   */
  async getScore(agentAddress: string): Promise<number> {
    try {
      const score = await this.contract.getScore(agentAddress);
      return Number(score);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get reputation score: ${error.message}`);
      }
      throw new Error('Failed to get reputation score: unknown error');
    }
  }

  /**
   * Get full reputation details for an agent
   * @param agentAddress Agent address
   * @returns Reputation details or null if no reputation exists
   */
  async getReputationDetails(agentAddress: string): Promise<ReputationDetails | null> {
    try {
      const details = await this.contract.getReputationDetails(agentAddress);

      // Return null if agent has no reputation (score = 0, totalTasks = 0)
      if (details.score === 0n && details.totalTasks === 0n) {
        return null;
      }

      return {
        score: Number(details.score),
        totalTasks: Number(details.totalTasks),
        successfulTasks: Number(details.successfulTasks),
        lastUpdated: Number(details.lastUpdated),
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get reputation details: ${error.message}`);
      }
      throw new Error('Failed to get reputation details: unknown error');
    }
  }

  /**
   * Get agent address (signer address)
   */
  get agentAddress(): string {
    return this.signer.address;
  }
}

/**
 * Standalone function to increment reputation after successful proof generation
 *
 * This is called by taskWorker after a proof completes successfully.
 * Does NOT throw or fail the proof flow if reputation update fails.
 *
 * @param config - Application configuration
 * @param agentAddress - Agent address to increment reputation for
 */
export async function handleProofCompleted(
  config: AgentReputationConfig,
  agentAddress: string
): Promise<void> {
  // Check if ERC-8004 is configured
  if (!config.reputationContractAddress) {
    console.log('ERC-8004 Reputation not configured — skipping reputation update');
    return;
  }

  try {
    const reputation = new AgentReputation(config);
    const txHash = await reputation.incrementScore(agentAddress);
    console.log(`Reputation incremented for ${agentAddress} (tx: ${txHash})`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to increment reputation for ${agentAddress}: ${error.message}`);
    } else {
      console.error(`Failed to increment reputation for ${agentAddress}: unknown error`);
    }
  }
}
