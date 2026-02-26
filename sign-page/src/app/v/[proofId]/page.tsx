'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
}

const CIRCUIT_DISPLAY_NAMES: Record<string, string> = {
  coinbase_attestation: 'Coinbase KYC',
  coinbase_country_attestation: 'Coinbase Country',
};

interface ProofData {
  proofId: string;
  circuitId: string;
  nullifier: string;
  isValid: boolean;
  verifierAddress: string;
  chainId: string;
}

interface AttestationParsed {
  moduleId: string;
  digest: string;
  timestamp: number;
  pcrs: {
    pcr0: string;
    pcr1: string;
    pcr2: string;
  };
  userData: string | null;
  nonce: string | null;
}

interface AttestationVerification {
  isValid: boolean;
  rootCaValid: boolean;
  chainValid: boolean;
  certificateValid: boolean;
  signatureValid: boolean;
  error: string | null;
}

interface AttestationData {
  proofId: string;
  circuitId: string;
  attestation: {
    mode: string;
    proofHash: string;
    timestamp: number;
  };
  parsed: AttestationParsed;
  verification: AttestationVerification;
}

type PageStatus = 'loading' | 'verified' | 'invalid' | 'not-found' | 'error';

function getBasescanUrl(chainId: string, address: string): string {
  const host = chainId === '8453' ? 'basescan.org' : 'sepolia.basescan.org';
  return `https://${host}/address/${address}`;
}

function truncateHex(hex: string, chars: number = 6): string {
  if (hex.length <= chars * 2 + 4) return hex;
  return `${hex.slice(0, chars + 2)}...${hex.slice(-chars)}`;
}

function formatTimestamp(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}

function CheckIcon() {
  return (
    <span style={{ color: '#4ade80', marginRight: '0.5rem', fontWeight: 700 }}>✓</span>
  );
}

function CrossIcon() {
  return (
    <span style={{ color: '#f87171', marginRight: '0.5rem', fontWeight: 700 }}>✗</span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title="Copy full value"
      style={{
        background: 'none',
        border: '1px solid #444',
        borderRadius: '4px',
        color: copied ? '#4ade80' : '#999',
        fontSize: '0.7rem',
        cursor: 'pointer',
        padding: '0.1rem 0.4rem',
        marginLeft: '0.5rem',
        flexShrink: 0,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function VerificationPage() {
  const params = useParams();
  const proofId = params.proofId as string;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [proofData, setProofData] = useState<ProofData | null>(null);
  const [activeTab, setActiveTab] = useState<'proof' | 'attestation'>('proof');
  const [attestationData, setAttestationData] = useState<AttestationData | null>(null);
  const [attestationLoaded, setAttestationLoaded] = useState(false);

  // Fetch proof verification and probe attestation in parallel
  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/verify/${proofId}`);
        if (!response.ok) {
          if (response.status === 404) {
            setStatus('not-found');
            return;
          }
          const err = await response.json();
          throw new Error(err.error || 'Failed to load proof data');
        }
        const data: ProofData = await response.json();
        setProofData(data);
        setStatus(data.isValid ? 'verified' : 'invalid');
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to load proof data');
        setStatus('error');
      }

      // Probe attestation endpoint (non-blocking — 404 means no TEE)
      try {
        const attResponse = await fetch(`${API_BASE_URL}/api/v1/attestation/${proofId}`);
        if (attResponse.ok) {
          const attData: AttestationData = await attResponse.json();
          setAttestationData(attData);
          setAttestationLoaded(true);
        }
        // 404 = no attestation → attestationStatus stays 'idle', hasTee stays false
      } catch {
        // Network error — silently ignore, tab just won't appear
      }
    }
    fetchData();
  }, [proofId]);

  const handleTabClick = useCallback((tab: 'proof' | 'attestation') => {
    setActiveTab(tab);
  }, []);

  const hasTee = attestationLoaded && attestationData !== null;

  if (status === 'loading') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Proof Verification</h1>
          <div className="description" style={{ textAlign: 'center' }}>Loading proof data...</div>
        </div>
      </div>
    );
  }

  if (status === 'not-found') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Proof Verification</h1>
          <div className="error">Proof not found. The proof ID may be invalid or the proof has not been generated yet.</div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Proof Verification</h1>
          <div className="error">{errorMessage}</div>
        </div>
      </div>
    );
  }

  const isVerified = status === 'verified';
  const displayName = proofData ? (CIRCUIT_DISPLAY_NAMES[proofData.circuitId] || proofData.circuitId) : '';

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: hasTee ? '560px' : '500px' }}>
        <h1 className="title">ZKProofport Proof Verification</h1>

        {/* Status badge */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: isVerified ? '#1a3a2a' : '#3a1a1a',
              border: `2px solid ${isVerified ? '#4ade80' : '#f87171'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2rem',
              marginBottom: '0.75rem',
            }}
          >
            {isVerified ? '✓' : '✗'}
          </div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: isVerified ? '#4ade80' : '#f87171',
            }}
          >
            {isVerified ? 'Verified' : 'Invalid'}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
            {displayName}
          </div>
        </div>

        {/* Tab bar — only shown when TEE attestation is available */}
        {hasTee && (
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid #333',
              marginBottom: '1.5rem',
            }}
          >
            {(['proof', 'attestation'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabClick(tab)}
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === tab ? '2px solid #2563eb' : '2px solid transparent',
                  color: activeTab === tab ? '#f0f0f0' : '#666',
                  fontSize: '0.875rem',
                  fontWeight: activeTab === tab ? 600 : 400,
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  marginBottom: '-1px',
                  transition: 'color 0.15s',
                }}
              >
                {tab === 'attestation' ? 'TEE Attestation' : 'Proof Details'}
              </button>
            ))}
          </div>
        )}

        {/* Proof Details tab */}
        {(!hasTee || activeTab === 'proof') && proofData && (
          <div>
            {!hasTee && (
              <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '1rem', fontWeight: 600 }}>
                Proof Details
              </div>
            )}

            {/* Circuit */}
            <div className="info" style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#999', fontSize: '0.8rem' }}>Circuit</span>
                <span style={{ fontSize: '0.875rem' }}>{displayName}</span>
              </div>
            </div>

            {/* Nullifier */}
            <div className="info" style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.4rem' }}>Nullifier</div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span
                  style={{
                    fontFamily: "'Courier New', monospace",
                    fontSize: '0.8rem',
                    color: '#93c5fd',
                    wordBreak: 'break-all',
                  }}
                  title={proofData.nullifier}
                >
                  {truncateHex(proofData.nullifier)}
                </span>
                <CopyButton text={proofData.nullifier} />
              </div>
            </div>

            {/* Verifier address */}
            <div className="info" style={{ marginBottom: '1rem' }}>
              <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.4rem' }}>Verifier Contract</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <a
                  href={getBasescanUrl(proofData.chainId, proofData.verifierAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: "'Courier New', monospace",
                    fontSize: '0.8rem',
                    color: '#93c5fd',
                    textDecoration: 'underline',
                    wordBreak: 'break-all',
                  }}
                  title={proofData.verifierAddress}
                >
                  {truncateHex(proofData.verifierAddress)} ↗
                </a>
                <CopyButton text={proofData.verifierAddress} />
              </div>
            </div>

            {/* Chain */}
            <div className="info">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#999', fontSize: '0.8rem' }}>Network</span>
                <span style={{ fontSize: '0.875rem' }}>
                  {proofData.chainId === '8453' ? 'Base Mainnet' : proofData.chainId === '84532' ? 'Base Sepolia' : `Chain ${proofData.chainId}`}
                  <span style={{ color: '#666', fontSize: '0.75rem', marginLeft: '0.4rem' }}>
                    ({proofData.chainId})
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* TEE Attestation tab */}
        {hasTee && activeTab === 'attestation' && attestationData && (
          <div>
                {/* Mode badge + verification status */}
                <div className="info" style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <span style={{ color: '#999', fontSize: '0.8rem' }}>TEE Mode</span>
                    <span
                      style={{
                        background: '#1e3a5f',
                        border: '1px solid #2563eb',
                        borderRadius: '4px',
                        padding: '0.15rem 0.5rem',
                        fontSize: '0.75rem',
                        color: '#93c5fd',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {attestationData.attestation.mode}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#999', fontSize: '0.8rem' }}>Timestamp</span>
                    <span style={{ fontSize: '0.8rem' }}>
                      {formatTimestamp(attestationData.attestation.timestamp)}
                    </span>
                  </div>
                </div>

                {/* Verification checks */}
                <div className="info" style={{ marginBottom: '1rem' }}>
                  <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.6rem', fontWeight: 600 }}>
                    Verification Checks
                  </div>
                  {[
                    { label: 'AWS Root CA', value: attestationData.verification.rootCaValid },
                    { label: 'Certificate Chain', value: attestationData.verification.chainValid },
                    { label: 'Certificate Validity', value: attestationData.verification.certificateValid },
                    { label: 'COSE Signature', value: attestationData.verification.signatureValid },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginBottom: '0.35rem',
                        fontSize: '0.875rem',
                      }}
                    >
                      {value ? <CheckIcon /> : <CrossIcon />}
                      <span style={{ color: value ? '#f0f0f0' : '#999' }}>{label}</span>
                    </div>
                  ))}
                  {attestationData.verification.error && (
                    <div style={{ marginTop: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
                      {attestationData.verification.error}
                    </div>
                  )}
                </div>

                {/* Module ID */}
                <div className="info" style={{ marginBottom: '1rem' }}>
                  <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.4rem' }}>Module ID</div>
                  <div
                    style={{
                      fontFamily: "'Courier New', monospace",
                      fontSize: '0.8rem',
                      color: '#93c5fd',
                      wordBreak: 'break-all',
                    }}
                  >
                    {attestationData.parsed.moduleId}
                  </div>
                </div>

                {/* PCR values */}
                <div className="info" style={{ marginBottom: '1rem' }}>
                  <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.6rem', fontWeight: 600 }}>
                    PCR Values
                  </div>
                  {(['pcr0', 'pcr1', 'pcr2'] as const).map((key) => (
                    <div key={key} style={{ marginBottom: '0.6rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                        <span style={{ color: '#999', fontSize: '0.75rem', textTransform: 'uppercase' }}>{key}</span>
                        <CopyButton text={attestationData.parsed.pcrs[key]} />
                      </div>
                      <div
                        style={{
                          fontFamily: "'Courier New', monospace",
                          fontSize: '0.7rem',
                          color: '#93c5fd',
                          wordBreak: 'break-all',
                          lineHeight: '1.4',
                        }}
                        title={attestationData.parsed.pcrs[key]}
                      >
                        {attestationData.parsed.pcrs[key]}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Proof hash */}
                <div className="info">
                  <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.4rem' }}>Proof Hash</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span
                      style={{
                        fontFamily: "'Courier New', monospace",
                        fontSize: '0.8rem',
                        color: '#93c5fd',
                        wordBreak: 'break-all',
                      }}
                      title={attestationData.attestation.proofHash}
                    >
                      {truncateHex(attestationData.attestation.proofHash)}
                    </span>
                    <CopyButton text={attestationData.attestation.proofHash} />
                  </div>
                </div>
          </div>
        )}
      </div>
    </div>
  );
}
