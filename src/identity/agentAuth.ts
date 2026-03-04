/**
 * ERC-8128 Agent Authentication Middleware
 *
 * Verifies agent identity by checking request signatures against the ERC-8004 registry.
 * This is OPTIONAL — if no signature header is present, the request proceeds normally.
 * Payment-based access control still applies regardless.
 *
 * Flow:
 * 1. Agent signs a challenge (request body hash or timestamp) with their private key
 * 2. Includes signature in X-Agent-Signature header and address in X-Agent-Address header
 * 3. Server recovers address from signature, checks against ERC-8004 registry
 * 4. If verified, adds agent info to req.agentIdentity
 */

import { ethers } from 'ethers';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config/index.js';
import { ERC8004_ADDRESSES } from '../config/contracts.js';
import { createLogger } from '../logger.js';

const log = createLogger('AgentAuth');

// Minimal ERC-8004 Identity ABI — only what we need for lookup
const IDENTITY_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];

export interface AgentIdentity {
  address: string;
  tokenId: bigint;
  verified: boolean;
  registeredOnChain: boolean;
}

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      agentIdentity?: AgentIdentity;
    }
  }
}

/**
 * Create ERC-8128 agent verification middleware.
 *
 * Behavior:
 * - If X-Agent-Signature and X-Agent-Address headers are present:
 *   1. Verify signature over the request body hash (keccak256 of JSON body)
 *   2. Check if recovered address matches X-Agent-Address
 *   3. Look up address in ERC-8004 registry
 *   4. If registered, set req.agentIdentity with verified=true
 *   5. If not registered, set req.agentIdentity with registeredOnChain=false
 * - If headers are absent: proceed without authentication (pay-per-use model)
 * - NEVER blocks requests — verification failure logs a warning but continues
 */
export function createAgentAuthMiddleware(config: Config) {
  const isProduction = config.nodeEnv === 'production';
  const identityAddress = isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;
  const rpcUrl = config.chainRpcUrl;

  // Cache verified agents (address → tokenId) for 5 minutes
  const verifiedCache = new Map<string, { tokenId: bigint; expiry: number }>();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  return async (req: Request, _res: Response, next: NextFunction) => {
    const agentSignature = req.headers['x-agent-signature'] as string | undefined;
    const agentAddress = req.headers['x-agent-address'] as string | undefined;

    // No auth headers — proceed without verification (pay-per-use still applies)
    if (!agentSignature || !agentAddress) {
      return next();
    }

    try {
      // Step 1: Verify signature over request body hash
      const bodyHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(req.body || {})),
      );
      const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(bodyHash),
        agentSignature,
      );

      // Step 2: Check recovered address matches claimed address
      if (recoveredAddress.toLowerCase() !== agentAddress.toLowerCase()) {
        log.warn(
          { action: 'agent_auth.address_mismatch', claimed: agentAddress, recovered: recoveredAddress },
          'Agent signature does not match claimed address',
        );
        req.agentIdentity = {
          address: agentAddress,
          tokenId: 0n,
          verified: false,
          registeredOnChain: false,
        };
        return next();
      }

      // Step 3: Check cache first
      const normalizedAddress = agentAddress.toLowerCase();
      const cached = verifiedCache.get(normalizedAddress);
      if (cached && cached.expiry > Date.now()) {
        req.agentIdentity = {
          address: agentAddress,
          tokenId: cached.tokenId,
          verified: true,
          registeredOnChain: true,
        };
        log.info(
          { action: 'agent_auth.verified_cached', agent: agentAddress, tokenId: cached.tokenId.toString() },
          'Agent verified (cached)',
        );
        return next();
      }

      // Step 4: Look up in ERC-8004 registry
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const identity = new ethers.Contract(identityAddress, IDENTITY_ABI, provider);

      const balance = await identity.balanceOf(agentAddress);
      if (balance > 0n) {
        // Agent is registered
        const tokenId = await identity.tokenOfOwnerByIndex(agentAddress, 0n);

        // Cache the result
        verifiedCache.set(normalizedAddress, {
          tokenId,
          expiry: Date.now() + CACHE_TTL_MS,
        });

        req.agentIdentity = {
          address: agentAddress,
          tokenId,
          verified: true,
          registeredOnChain: true,
        };

        log.info(
          { action: 'agent_auth.verified', agent: agentAddress, tokenId: tokenId.toString() },
          'Agent verified via ERC-8004 registry',
        );
      } else {
        // Signature valid but not registered
        req.agentIdentity = {
          address: agentAddress,
          tokenId: 0n,
          verified: true,
          registeredOnChain: false,
        };

        log.info(
          { action: 'agent_auth.not_registered', agent: agentAddress },
          'Agent signature valid but not registered in ERC-8004',
        );
      }
    } catch (error) {
      // NEVER block on verification failure
      log.warn(
        { action: 'agent_auth.error', err: error, agent: agentAddress },
        'Agent verification failed — proceeding without authentication',
      );
      req.agentIdentity = {
        address: agentAddress || 'unknown',
        tokenId: 0n,
        verified: false,
        registeredOnChain: false,
      };
    }

    return next();
  };
}
