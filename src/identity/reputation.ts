/**
 * ERC-8004 Agent Reputation Management
 * Handles on-chain reputation tracking for prover agents
 */

import { ethers } from 'ethers';
import type { AgentReputationConfig, ReputationScore } from './types.js';

// ERC-8004 Reputation ABI (minimal interface)
const REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
  'function getAverageScore(uint256 agentId) external view returns (int128 score, uint8 decimals)',
  'function getFeedbackCount(uint256 agentId) external view returns (uint256)',
];

export class AgentReputation {
  private contract: ethers.Contract;

  constructor(config: AgentReputationConfig) {
    if (!config.reputationContractAddress) {
      throw new Error('AgentReputation: reputationContractAddress is required');
    }
    if (!config.chainRpcUrl) {
      throw new Error('AgentReputation: chainRpcUrl is required');
    }

    const provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
    this.contract = new ethers.Contract(config.reputationContractAddress, REPUTATION_ABI, provider);
  }

  /**
   * Get average reputation score for an agent
   * @param agentId Agent's ERC-721 token ID
   * @returns Reputation score or null if no feedback exists
   */
  async getAverageScore(agentId: bigint): Promise<ReputationScore | null> {
    try {
      const [score, decimals] = await this.contract.getAverageScore(agentId);
      if (score === 0n && decimals === 0) return null;
      return { score: Number(score), decimals: Number(decimals) };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get average score: ${error.message}`);
      }
      throw new Error('Failed to get average score: unknown error');
    }
  }

  /**
   * Get total feedback count for an agent
   * @param agentId Agent's ERC-721 token ID
   * @returns Number of feedback entries
   */
  async getFeedbackCount(agentId: bigint): Promise<number> {
    try {
      const count = await this.contract.getFeedbackCount(agentId);
      return Number(count);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get feedback count: ${error.message}`);
      }
      throw new Error('Failed to get feedback count: unknown error');
    }
  }
}

/**
 * Standalone function to handle reputation after successful proof generation
 *
 * This is called by taskWorker after a proof completes successfully.
 * Does NOT throw or fail the proof flow if reputation update fails.
 *
 * @param _config - Application configuration (unused, kept for backward compatibility)
 * @param _agentAddress - Agent address (unused, kept for backward compatibility)
 */
export async function handleProofCompleted(
  _config: AgentReputationConfig,
  _agentAddress: string
): Promise<void> {
  // Self-feedback is blocked on ERC-8004 Reputation Registry.
  // Reputation scores are managed externally via 8004scan feedback from other agents/users.
  // This function is kept as a no-op placeholder for future integration.
}
