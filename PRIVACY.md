# Privacy Policy — proveragent.base.eth

**Service:** Prover Agent Telegram Bot (@ProverAgentBot)  
**Operator:** ZKProofport  
**Last updated:** February 21, 2026

---

## Overview

proveragent.base.eth is a zero-knowledge proof generation and verification agent. This service is built on the principle that **privacy is not optional — it is the default**. We use zero-knowledge cryptography to ensure your personal data is never exposed, transmitted, or stored.

## What We Collect

| Data | Purpose | Retention |
|------|---------|-----------|
| Telegram chat ID | Session management | Duration of session only |
| Messages sent to the bot | Real-time processing for proof generation | Not stored permanently |
| Wallet address | Proof generation (only when voluntarily provided) | Not stored after session ends |

## What We Do NOT Collect

- ❌ Personal identity information (name, address, date of birth, etc.)
- ❌ KYC verification details or attestation contents
- ❌ Private keys, seed phrases, or wallet passwords
- ❌ Biometric data
- ❌ Location data
- ❌ Contact lists or device information

## Zero-Knowledge by Design

All proofs are generated using **zero-knowledge cryptography** (Noir circuits + Barretenberg proving system). This means:

- The bot and our servers **never see or store** your underlying credential data
- Only cryptographic proofs are transmitted — these mathematically guarantee **no personal information is leaked**
- Proofs can be verified on-chain without revealing what is being proved
- Nullifiers prevent replay attacks while preserving your anonymity

## Data Retention

- **Chat sessions** expire after 1 hour of inactivity and are deleted from memory
- **No conversation logs** are permanently stored on our servers
- **On-chain records** (nullifiers, proof verifications) are public on Base blockchain but are cryptographically unlinkable to your real-world identity
- **Payment records** (x402 USDC transactions) are recorded on-chain as standard blockchain transactions

## Third-Party Services

This service interacts with the following third-party services:

| Service | Purpose | Their Privacy Policy |
|---------|---------|---------------------|
| Telegram | Bot communication platform | [telegram.org/privacy](https://telegram.org/privacy) |
| Base (Coinbase L2) | On-chain proof verification | [base.org/privacy](https://base.org/privacy-policy) |
| Coinbase EAS | Attestation data queries (read-only) | [coinbase.com/legal/privacy](https://www.coinbase.com/legal/privacy) |
| x402 Protocol | Micropayment processing | [x402.org](https://x402.org) |

## Testnet Notice

> ⚠️ This service currently operates on **Base Sepolia testnet**. No real assets or mainnet funds are involved. Testnet tokens have no monetary value.

## Open Source

The source code for this bot and the entire Prover Agent infrastructure is open source and auditable:

- **GitHub:** [github.com/zkproofport](https://github.com/zkproofport)
- **Circuits:** All ZK circuits are publicly verifiable

## Your Rights

- You can **reset your session** at any time using the `/reset` command
- You can **stop using the bot** at any time — no data persists after session expiry
- You can **audit the code** — our entire stack is open source

## Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be reflected in the "Last updated" date above and committed to this repository.

## Contact

- **Email:** sooyoung@zkdev.net
- **X (Twitter):** [@ZKProofport](https://x.com/ZKProofport)
- **Website:** [zkproofport.com](https://zkproofport.com)
