#!/usr/bin/env node
/**
 * Vsock server for AWS Nitro Enclave — TypeScript rewrite.
 *
 * Listens on AF_VSOCK port 5000 (production) or TCP port 15000 (fallback).
 * Accepts JSON requests from the parent EC2 instance, executes ZK proof
 * operations using bb CLI and noir_js.
 *
 * Request/Response protocol matches EnclaveClient.ts (src/tee/enclaveClient.ts):
 *   VsockRequest  = { type, circuitId?, inputs?, requestId, encryptedPayload? }
 *   VsockResponse = { type, requestId, proof?, publicInputs?, attestationDocument?, error? }
 *
 * Supported request types:
 *   health       → { type: "health", requestId }
 *   prove        → { type: "prove", circuitId, inputs, requestId, encryptedPayload? }
 *   attestation  → { type: "attestation", requestId, proofHash?, metadata? }
 *   getPublicKey → { type: "getPublicKey", requestId }
 *
 * Entry point: node enclave-server.bundle.js (esbuild bundled)
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// noir_js for witness generation
import { Noir } from '@noir-lang/noir_js';
import { formatCoinbaseInputs, formatOidcInputs } from '../prover/inputFormatter.js';
import type { OidcCircuitInputs } from '../prover/inputFormatter.js';
import type { CircuitParams } from '../input/inputBuilder.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const VSOCK_PORT = 5000;
const TCP_FALLBACK_PORT = 15000;
const AF_VSOCK = 40;
const VMADDR_CID_ANY = 0xFFFFFFFF;

const CIRCUIT_BASE_DIR = '/app/circuits';

/** Canonical circuit ID → directory and artifact filenames */
const CIRCUITS: Record<string, { dir: string; bytecode: string; vk: string }> = {
  coinbase_attestation: {
    dir: 'coinbase-attestation',
    bytecode: 'coinbase_attestation.json',
    vk: 'vk/vk',
  },
  coinbase_country_attestation: {
    dir: 'coinbase-country-attestation',
    bytecode: 'coinbase_country_attestation.json',
    vk: 'vk/vk',
  },
  oidc_domain_attestation: {
    dir: 'oidc-domain-attestation',
    bytecode: 'oidc_domain_attestation.json',
    vk: 'vk/vk',
  },
};

const PROVE_TIMEOUT_MS = 120_000;
const NSM_DEVICE = '/dev/nsm';

// E2E encryption key pair (initialized at startup)
let enclavePrivateKey: crypto.KeyObject;
let enclavePublicKeyRaw: Buffer;
let enclaveKeyId: string;

// ─────────────────────────────────────────────────────────────
// Logging (stderr only — no files in enclave)
// ─────────────────────────────────────────────────────────────

function isoNow(): string {
  const now = new Date();
  return now.toISOString().replace(/(\.\d{3})\d*Z/, '$1Z');
}

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const entry = {
    level,
    time: isoNow(),
    service: 'proofport-ai',
    component: 'Enclave',
    msg,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

function logInfo(msg: string, extra: Record<string, unknown> = {}): void {
  log('info', msg, extra);
}

function logError(msg: string, extra: Record<string, unknown> = {}): void {
  log('error', msg, extra);
}

// ─────────────────────────────────────────────────────────────
// X25519 SPKI helper
// ─────────────────────────────────────────────────────────────

const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

function importX25519PublicKey(rawHex: string): crypto.KeyObject {
  const rawBytes = Buffer.from(rawHex, 'hex');
  const der = Buffer.concat([X25519_SPKI_HEADER, rawBytes]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// ─────────────────────────────────────────────────────────────
// NSM attestation (via Python helper for /dev/nsm ioctl)
// ─────────────────────────────────────────────────────────────

async function getNsmAttestation(userData?: Buffer, publicKey?: Buffer): Promise<Buffer | null> {
  if (!fs.existsSync(NSM_DEVICE)) {
    logInfo('NSM device not available — skipping attestation', { action: 'enclave.nsm.skipped' });
    return null;
  }

  try {
    const helperPath = '/app/aws/nsm-helper.py';
    const args = ['--user-data', (userData || Buffer.alloc(0)).toString('hex')];
    if (publicKey && publicKey.length > 0) {
      args.push('--public-key', publicKey.toString('hex'));
    }

    const { stdout, stderr } = await execFileAsync('python3', [helperPath, ...args], {
      timeout: 10_000,
    });

    if (stderr) {
      logError('NSM helper stderr', { action: 'enclave.nsm.stderr', stderr });
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      logError('NSM helper returned empty output', { action: 'enclave.nsm.failed' });
      return null;
    }

    const docBytes = Buffer.from(trimmed, 'base64');
    logInfo('NSM attestation obtained', { action: 'enclave.nsm.obtained', docBytes: docBytes.length });
    return docBytes;
  } catch (err: any) {
    logError('NSM attestation failed', { action: 'enclave.nsm.failed', error: err.message });
    return null;
  }
}

async function getNsmAttestationWithPubkey(publicKeyBytes: Buffer): Promise<Buffer | null> {
  if (!fs.existsSync(NSM_DEVICE)) {
    logInfo('NSM device not available — skipping keyed attestation', { action: 'enclave.nsm.skipped' });
    return null;
  }

  return getNsmAttestation(undefined, publicKeyBytes);
}

// ─────────────────────────────────────────────────────────────
// Circuit path resolution
// ─────────────────────────────────────────────────────────────

interface CircuitPaths {
  dir: string;
  bytecode: string;
  vk: string;
}

function getCircuitPaths(circuitId: string): CircuitPaths {
  const meta = CIRCUITS[circuitId];
  if (!meta) {
    throw new Error(
      `Unknown circuitId '${circuitId}'. Supported: ${Object.keys(CIRCUITS).join(', ')}`
    );
  }
  const base = path.join(CIRCUIT_BASE_DIR, meta.dir);
  return {
    dir: base,
    bytecode: path.join(base, 'target', meta.bytecode),
    vk: path.join(base, 'target', meta.vk),
  };
}

// ─────────────────────────────────────────────────────────────
// Proof generation
// ─────────────────────────────────────────────────────────────

interface ProofResult {
  proof: string;
  publicInputs: string[];
  attestationDocument?: string;
  timing: {
    witnessMs: number;
    bbMs: number;
    nsmMs: number;
    totalMs: number;
  };
}

/**
 * Convert SDK ProveInputs (snake_case, hex strings) → CircuitParams (camelCase, byte arrays).
 * The E2E encrypted flow sends ProveInputs directly from the SDK.
 * The plaintext flow sends CircuitParams (already converted by AI server).
 * This function detects which format and converts if needed.
 */
function normalizeToCircuitParams(circuitId: string, inputs: Record<string, any>): Record<string, any> {
  // If inputs already have camelCase fields (CircuitParams from plaintext flow), pass through
  if (inputs.signalHash !== undefined) {
    return inputs;
  }

  // SDK ProveInputs format (snake_case) → convert to CircuitParams
  if (inputs.signal_hash !== undefined) {
    const hexToBytes = (hex: string): number[] => {
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
      const bytes: number[] = [];
      for (let i = 0; i < clean.length; i += 2) {
        bytes.push(parseInt(clean.slice(i, i + 2), 16));
      }
      return bytes;
    };

    const rawTxBytes = hexToBytes(inputs.raw_transaction);

    const converted: Record<string, any> = {
      signalHash: hexToBytes(inputs.signal_hash),
      merkleRoot: inputs.merkle_root,
      scopeBytes: hexToBytes(inputs.scope_bytes),
      nullifierBytes: hexToBytes(inputs.nullifier),
      userAddress: inputs.user_address,
      userSignature: inputs.signature,
      userPubkeyX: inputs.user_pubkey_x,
      userPubkeyY: inputs.user_pubkey_y,
      rawTxBytes: Array.from(rawTxBytes),
      txLength: inputs.tx_length,
      attesterPubkeyX: inputs.coinbase_attester_pubkey_x,
      attesterPubkeyY: inputs.coinbase_attester_pubkey_y,
      merkleProof: inputs.merkle_proof,
      merkleLeafIndex: inputs.leaf_index,
      merkleDepth: inputs.depth,
    };

    if (circuitId === 'coinbase_country_attestation') {
      converted.countryList = inputs.country_list;
      converted.countryListLength = (inputs.country_list || []).length;
      converted.isIncluded = inputs.is_included;
    }

    logInfo('Converted ProveInputs to CircuitParams', {
      action: 'enclave.inputs.converted', format: 'sdk_prove_inputs',
    });
    return converted;
  }

  // Unknown format — pass through and let formatCoinbaseInputs handle the error
  logError('Unknown input format', { action: 'enclave.inputs.unknown', keys: Object.keys(inputs) });
  return inputs;
}

async function generateProof(
  circuitId: string,
  inputs: Record<string, any>,
  requestId: string,
): Promise<ProofResult> {
  const meta = CIRCUITS[circuitId];
  if (!meta) {
    throw new Error(
      `Unknown circuitId '${circuitId}'. Supported: ${Object.keys(CIRCUITS).join(', ')}`
    );
  }
  const paths = getCircuitPaths(circuitId);

  // Verify circuit artifacts exist
  for (const [label, filePath] of [['bytecode', paths.bytecode], ['vk', paths.vk]] as const) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Circuit artifact missing: ${label} at ${filePath}`);
    }
  }

  // Create temp working directory
  const workdir = await fsp.mkdtemp(path.join(CIRCUIT_BASE_DIR, `proof-${requestId}-`));
  const proofDir = path.join(workdir, 'proof');
  await fsp.mkdir(proofDir, { recursive: true });

  try {
    const tStart = Date.now();
    logInfo('Proof generation started', { action: 'enclave.prove.started', requestId, circuitId });

    // Step 1: Load compiled circuit JSON
    const circuitJsonPath = path.join(CIRCUIT_BASE_DIR, meta.dir, 'target', meta.bytecode);
    const circuitJson = JSON.parse(await fsp.readFile(circuitJsonPath, 'utf-8'));
    logInfo('Circuit JSON loaded', { action: 'enclave.circuit.loaded', requestId, path: circuitJsonPath });

    // Step 2: Format inputs for noir_js
    let noirInputs: Record<string, unknown>;
    if (circuitId === 'oidc_domain_attestation') {
      noirInputs = formatOidcInputs(inputs as OidcCircuitInputs);
    } else {
      const normalized = normalizeToCircuitParams(circuitId, inputs);
      noirInputs = formatCoinbaseInputs(
        circuitId as 'coinbase_attestation' | 'coinbase_country_attestation',
        normalized as CircuitParams,
      );
    }

    // Step 3: Execute circuit via noir_js to generate witness
    const noir = new Noir(circuitJson);
    let witnessData: Uint8Array;
    try {
      const { witness } = await noir.execute(noirInputs as any);
      witnessData = witness;
    } catch (error: any) {
      throw new Error(`noir_js execute failed: ${error.message || error}`);
    }

    const tWitness = Date.now();
    logInfo('noir_js witness generated', {
      action: 'enclave.witness.generated', requestId, witnessBytes: witnessData.length,
    });

    // Step 4: Write witness to temp file
    const witnessPath = path.join(workdir, 'witness.gz');
    await fsp.writeFile(witnessPath, witnessData);

    // Step 5: Run bb prove
    const bbCmd = [
      'prove',
      '-b', paths.bytecode,
      '-w', witnessPath,
      '-o', proofDir,
      '-k', paths.vk,
      '--oracle_hash', 'keccak',
    ];
    logInfo('bb prove started', { action: 'enclave.bb.started', requestId, cmd: `bb ${bbCmd.join(' ')}` });

    try {
      await execFileAsync('bb', bbCmd, {
        timeout: PROVE_TIMEOUT_MS,
        env: { ...process.env, HOME: '/root' },
      });
      logInfo('bb prove succeeded', { action: 'enclave.bb.succeeded', requestId });
    } catch (err: any) {
      logError('bb prove failed', {
        action: 'enclave.bb.failed', requestId,
        returncode: err.code, stdout: err.stdout, stderr: err.stderr,
      });
      throw new Error(`bb prove failed (exit ${err.code}): ${err.stderr}`);
    }

    const tBb = Date.now();

    // Step 6: Read proof bytes
    const proofFile = path.join(proofDir, 'proof');
    if (!fs.existsSync(proofFile)) {
      throw new Error(`bb prove did not produce output at ${proofFile}`);
    }

    const proofBytes = await fsp.readFile(proofFile);
    const proofHex = '0x' + proofBytes.toString('hex');
    logInfo('Proof read', { action: 'enclave.proof.read', requestId, proofBytes: proofBytes.length });

    // Step 7: Read public inputs
    const publicInputs: string[] = [];
    const publicInputsPath = path.join(proofDir, 'public_inputs');
    if (fs.existsSync(publicInputsPath)) {
      const piBytes = await fsp.readFile(publicInputsPath);
      publicInputs.push('0x' + piBytes.toString('hex'));
      logInfo('Public inputs read', { action: 'enclave.inputs.read', requestId, bytes: piBytes.length });
    } else {
      logInfo('No public_inputs file — returning empty publicInputs array', { action: 'enclave.inputs.empty', requestId });
    }

    // Step 8: NSM attestation
    let attestationB64: string | undefined;
    const proofHash = crypto.createHash('sha256').update(proofBytes).digest();
    const nsmDoc = await getNsmAttestation(proofHash);
    if (nsmDoc) {
      attestationB64 = nsmDoc.toString('base64');
      logInfo('NSM attestation obtained', { action: 'enclave.nsm.obtained', requestId, docBytes: nsmDoc.length });
    } else if (fs.existsSync(NSM_DEVICE)) {
      throw new Error('NSM device exists but attestation failed. Refusing to return proof without attestation.');
    } else {
      logInfo('NSM device not present — attestation skipped (non-enclave environment)', { action: 'enclave.nsm.skipped', requestId });
    }

    const tNsm = Date.now();

    const result: ProofResult = {
      proof: proofHex,
      publicInputs,
      timing: {
        witnessMs: tWitness - tStart,
        bbMs: tBb - tWitness,
        nsmMs: tNsm - tBb,
        totalMs: tNsm - tStart,
      },
    };
    if (attestationB64) {
      result.attestationDocument = attestationB64;
    }

    return result;
  } finally {
    // Clean up workdir
    await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// Encryption / Decryption
// ─────────────────────────────────────────────────────────────

function decryptPayload(encryptedPayload: {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  keyId: string;
}): string {
  // Verify keyId matches
  if (encryptedPayload.keyId !== enclaveKeyId) {
    throw new Error(`Key ID mismatch: expected ${enclaveKeyId}, got ${encryptedPayload.keyId}`);
  }

  // Import ephemeral public key
  const ephemeralPubKeyObj = importX25519PublicKey(encryptedPayload.ephemeralPublicKey);

  // ECDH: derive shared secret
  const sharedSecret = crypto.diffieHellman({
    publicKey: ephemeralPubKeyObj,
    privateKey: enclavePrivateKey,
  });

  // Derive AES key: SHA-256(shared_secret)
  const aesKey = crypto.createHash('sha256').update(sharedSecret).digest();

  // AES-256-GCM decrypt
  const iv = Buffer.from(encryptedPayload.iv, 'hex');
  const ciphertext = Buffer.from(encryptedPayload.ciphertext, 'hex');
  const authTag = Buffer.from(encryptedPayload.authTag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf-8');
}

// ─────────────────────────────────────────────────────────────
// Request handlers
// ─────────────────────────────────────────────────────────────

interface VsockRequest {
  type: string;
  circuitId?: string;
  inputs?: Record<string, any>;
  requestId?: string;
  encryptedPayload?: {
    ephemeralPublicKey: string;
    iv: string;
    ciphertext: string;
    authTag: string;
    keyId: string;
  };
  proofHash?: string;
  metadata?: Record<string, unknown>;
}

interface VsockResponse {
  type: string;
  requestId: string;
  [key: string]: unknown;
}

function handleHealth(request: VsockRequest): VsockResponse {
  return {
    type: 'health',
    requestId: request.requestId || '',
    status: 'ok',
  };
}

function handleGetPublicKey(request: VsockRequest): VsockResponse {
  const requestId = request.requestId || '';

  if (!enclavePublicKeyRaw) {
    return { type: 'error', requestId, error: 'Key pair not initialized' };
  }

  const response: VsockResponse = {
    type: 'publicKey',
    requestId,
    publicKey: enclavePublicKeyRaw.toString('hex'),
    keyId: enclaveKeyId,
  };

  // Async attestation would block; do synchronous check
  // NSM keyed attestation is fetched asynchronously below
  return response;
}

async function handleGetPublicKeyAsync(request: VsockRequest): Promise<VsockResponse> {
  const requestId = request.requestId || '';

  if (!enclavePublicKeyRaw) {
    return { type: 'error', requestId, error: 'Key pair not initialized' };
  }

  const response: VsockResponse = {
    type: 'publicKey',
    requestId,
    publicKey: enclavePublicKeyRaw.toString('hex'),
    keyId: enclaveKeyId,
  };

  const nsmDocWithKey = await getNsmAttestationWithPubkey(enclavePublicKeyRaw);
  if (nsmDocWithKey) {
    response.attestationDocument = nsmDocWithKey.toString('base64');
  }

  return response;
}

async function handleProve(request: VsockRequest): Promise<VsockResponse> {
  let circuitId = request.circuitId;
  let inputs = request.inputs;
  const requestId = request.requestId || '';
  const encryptedPayload = request.encryptedPayload;

  // If encrypted payload present, decrypt to get { circuitId, inputs }
  if (encryptedPayload) {
    try {
      const decrypted = decryptPayload(encryptedPayload);
      const decryptedData = JSON.parse(decrypted);
      circuitId = decryptedData.circuitId || circuitId;
      if (decryptedData.inputs) {
        inputs = decryptedData.inputs;
      }
      logInfo('Encrypted payload decrypted', {
        action: 'enclave.decrypt.success', requestId, keyId: encryptedPayload.keyId,
      });
    } catch (err: any) {
      logError('Encrypted payload decryption failed', {
        action: 'enclave.decrypt.failed', requestId, error: err.message,
      });
      return { type: 'error', requestId, error: `Decryption failed: ${err.message}` };
    }
  }

  if (!circuitId) {
    return { type: 'error', requestId, error: 'Missing circuitId' };
  }
  if (!inputs || typeof inputs !== 'object') {
    return { type: 'error', requestId, error: 'Missing inputs' };
  }

  try {
    const result = await generateProof(circuitId, inputs, requestId);
    const response: VsockResponse = {
      type: 'proof',
      requestId,
      proof: result.proof,
      publicInputs: result.publicInputs,
      timing: result.timing,
    };
    if (result.attestationDocument) {
      response.attestationDocument = result.attestationDocument;
    }
    return response;
  } catch (err: any) {
    if (err.message?.includes('timed out') || err.message?.includes('TIMEOUT')) {
      return { type: 'error', requestId, error: `Proof generation timed out after ${PROVE_TIMEOUT_MS / 1000}s` };
    }
    logError('Unexpected error in handleProve', {
      action: 'enclave.prove.error', error: err.message, stack: err.stack,
    });
    return { type: 'error', requestId, error: err.message || 'Internal error' };
  }
}

async function handleAttestation(request: VsockRequest): Promise<VsockResponse> {
  const requestId = request.requestId || '';
  const proofHashHex = request.proofHash || '';

  try {
    const userData = proofHashHex
      ? Buffer.from(proofHashHex.replace(/^0x/, ''), 'hex')
      : Buffer.alloc(0);
    const nsmDoc = await getNsmAttestation(userData);
    if (nsmDoc) {
      return {
        type: 'attestation',
        requestId,
        attestationDocument: nsmDoc.toString('base64'),
      };
    }
    return { type: 'error', requestId, error: 'NSM device not available' };
  } catch (err: any) {
    return { type: 'error', requestId, error: err.message };
  }
}

async function dispatch(request: VsockRequest): Promise<VsockResponse> {
  switch (request.type) {
    case 'health':
      return handleHealth(request);
    case 'prove':
      return handleProve(request);
    case 'attestation':
      return handleAttestation(request);
    case 'getPublicKey':
      return handleGetPublicKeyAsync(request);
    default:
      return {
        type: 'error',
        requestId: request.requestId || '',
        error: `Unknown request type: '${request.type}'`,
      };
  }
}

// ─────────────────────────────────────────────────────────────
// Connection handler
// ─────────────────────────────────────────────────────────────

function handleConnection(socket: net.Socket, addr: string): void {
  logInfo('Connection accepted', { action: 'enclave.connection.accepted', addr });

  const chunks: Buffer[] = [];
  let responded = false;

  socket.setTimeout(5000);

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const processRequest = async () => {
    if (responded) return;
    responded = true;

    const raw = Buffer.concat(chunks);
    if (raw.length === 0) {
      logError('Empty request received', { action: 'enclave.request.empty' });
      socket.end();
      return;
    }

    logInfo('Request received', { action: 'enclave.request.received', bytes: raw.length });

    let request: VsockRequest;
    try {
      request = JSON.parse(raw.toString('utf-8'));
    } catch (err: any) {
      logError('Invalid JSON in request', { action: 'enclave.request.invalid', error: err.message });
      const errorResponse = { type: 'error', requestId: '', error: `Invalid JSON: ${err.message}` };
      socket.end(JSON.stringify(errorResponse));
      return;
    }

    logInfo('Request dispatched', {
      action: 'enclave.request.dispatched',
      type: request.type,
      requestId: request.requestId,
    });

    try {
      const response = await dispatch(request);
      logInfo('Response sent', {
        action: 'enclave.response.sent',
        type: response.type,
        requestId: response.requestId,
      });
      socket.end(JSON.stringify(response));
    } catch (err: any) {
      logError('Unhandled error in connection handler', {
        action: 'enclave.connection.error', error: err.message, stack: err.stack,
      });
      const errorResponse = { type: 'error', requestId: '', error: `Server error: ${err.message}` };
      try {
        socket.end(JSON.stringify(errorResponse));
      } catch {
        // Ignore write errors
      }
    }
  };

  socket.on('end', processRequest);
  socket.on('timeout', processRequest);

  socket.on('error', (err: Error) => {
    logError('Socket error', { action: 'enclave.connection.error', error: err.message });
    socket.destroy();
  });

  socket.on('close', () => {
    logInfo('Connection closed', { action: 'enclave.connection.closed' });
  });
}

// ─────────────────────────────────────────────────────────────
// TCP fallback server (local testing)
// ─────────────────────────────────────────────────────────────

function runTcpFallback(): void {
  logInfo('TCP fallback server starting', {
    action: 'enclave.server.starting', host: '127.0.0.1', port: TCP_FALLBACK_PORT,
  });

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    handleConnection(socket, addr);
  });

  server.listen(TCP_FALLBACK_PORT, '127.0.0.1', () => {
    logInfo('TCP fallback server listening', {
      action: 'enclave.server.listening', port: TCP_FALLBACK_PORT,
    });
  });

  server.on('error', (err: Error) => {
    logError('TCP server error', { action: 'enclave.server.error', error: err.message });
  });

  process.on('SIGINT', () => {
    logInfo('TCP fallback server shutting down', { action: 'enclave.server.stopping' });
    server.close();
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────
// Vsock server (production)
// ─────────────────────────────────────────────────────────────

function runVsockServer(): void {
  logInfo('Starting enclave vsock server', { action: 'enclave.server.starting', port: VSOCK_PORT });

  // AF_VSOCK requires creating a raw socket via syscall — Node.js net module
  // doesn't support AF_VSOCK natively. We attempt to bind a TCP-like server
  // using the low-level socket approach. If it fails, fall back to TCP.
  try {
    // Try to create AF_VSOCK socket using Node.js net.createServer
    // Node.js doesn't natively support AF_VSOCK, so we fall back to TCP
    // In production, vsock-bridge.py on the host forwards TCP:15000 → vsock:5000
    // Inside the enclave, we listen on TCP 15000 which vsock-bridge connects to
    throw new Error('AF_VSOCK not natively supported in Node.js');
  } catch {
    logError(
      'Failed to create vsock socket. AF_VSOCK not supported in Node.js runtime.',
      { action: 'enclave.server.error' },
    );
    logInfo('Falling back to TCP socket on port 15000', { action: 'enclave.server.fallback' });
    runTcpFallback();
  }
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

function main(): void {
  logInfo('Enclave server starting', {
    action: 'enclave.started',
    nodeVersion: process.version,
    platform: process.platform,
  });
  logInfo('Circuit base directory', { action: 'enclave.config', path: CIRCUIT_BASE_DIR });
  logInfo('Available circuits', { action: 'enclave.config', circuits: Object.keys(CIRCUITS) });

  // Verify circuit artifacts at startup
  for (const [circuitId, meta] of Object.entries(CIRCUITS)) {
    const base = path.join(CIRCUIT_BASE_DIR, meta.dir);
    const bytecode = path.join(base, 'target', meta.bytecode);
    const vk = path.join(base, 'target', meta.vk);
    if (fs.existsSync(bytecode) && fs.existsSync(vk)) {
      logInfo('Circuit artifacts OK', { action: 'enclave.circuit.ok', circuit_id: circuitId });
    } else {
      logError('Circuit artifacts missing', {
        action: 'enclave.circuit.missing',
        circuit_id: circuitId,
        bytecode_exists: fs.existsSync(bytecode),
        vk_exists: fs.existsSync(vk),
      });
    }
  }

  // Generate X25519 key pair for E2E encryption
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  enclavePrivateKey = privateKey;
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  enclavePublicKeyRaw = publicKeyDer.subarray(12); // Strip SPKI header (12 bytes)
  enclaveKeyId = crypto.createHash('sha256').update(enclavePublicKeyRaw).digest('hex').slice(0, 16);
  logInfo('X25519 key pair generated', { action: 'enclave.keygen.done', keyId: enclaveKeyId });

  runVsockServer();
}

main();
