'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
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
  createdAt?: string;
  expiresAt?: string;
  attestation: {
    mode: string;
    proofHash: string;
    timestamp: number;
  };
  parsed: AttestationParsed;
  verification: AttestationVerification;
}

type PageStatus = 'loading' | 'loaded' | 'not-found' | 'error';

function formatTimestamp(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toUTCString();
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

export default function AttestationPage() {
  const params = useParams();
  const proofId = params.proofId as string;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [data, setData] = useState<AttestationData | null>(null);

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/proof/${proofId}`);
      const fullData = await response.json();
      const blob = new Blob([JSON.stringify(fullData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `proof-${proofId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback to display data if unified endpoint fails
      if (!data) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `proof-${proofId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [proofId, data]);

  useEffect(() => {
    async function fetchAttestation() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/attestation/${proofId}`);
        if (!response.ok) {
          if (response.status === 404) {
            setStatus('not-found');
            return;
          }
          const err = await response.json();
          throw new Error(err.error || 'Failed to load attestation');
        }
        const attData: AttestationData = await response.json();
        setData(attData);
        setStatus('loaded');
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to load attestation data');
        setStatus('error');
      }
    }
    fetchAttestation();
  }, [proofId]);

  if (status === 'loading') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">TEE Attestation</h1>
          <div className="description" style={{ textAlign: 'center' }}>Loading attestation data...</div>
        </div>
      </div>
    );
  }

  if (status === 'not-found') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">TEE Attestation</h1>
          <div className="error">
            This proof data has expired or was not found.
            <br /><br />
            Proof verification results are available for 24 hours after generation. To keep your results permanently, download the JSON data before expiration.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">TEE Attestation</h1>
          <div className="error">{errorMessage}</div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const allChecksPass = data.verification.rootCaValid &&
    data.verification.chainValid &&
    data.verification.certificateValid &&
    data.verification.signatureValid;

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: '560px' }}>
        <h1 className="title">TEE Attestation</h1>
        <p className="description" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          AWS Nitro Enclave Attestation Verification
        </p>

        {/* Overall status */}
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
              background: allChecksPass ? '#1a3a2a' : '#3a1a1a',
              border: `2px solid ${allChecksPass ? '#4ade80' : '#f87171'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2rem',
              marginBottom: '0.75rem',
            }}
          >
            {allChecksPass ? '✓' : '✗'}
          </div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: allChecksPass ? '#4ade80' : '#f87171',
            }}
          >
            {allChecksPass ? 'Verified' : 'Verification Failed'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
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
              {data.attestation.mode}
            </span>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>
              {data.parsed.digest}
            </span>
          </div>
        </div>

        {/* Verification checks */}
        <div className="info" style={{ marginBottom: '1rem' }}>
          <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.6rem', fontWeight: 600 }}>
            Verification Checks
          </div>
          {[
            { label: 'AWS Root CA', value: data.verification.rootCaValid },
            { label: 'Certificate Chain', value: data.verification.chainValid },
            { label: 'Certificate Validity', value: data.verification.certificateValid },
            { label: 'COSE Signature', value: data.verification.signatureValid },
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
          {data.verification.error && (
            <div style={{ marginTop: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
              {data.verification.error}
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
            {data.parsed.moduleId}
          </div>
        </div>

        {/* Timestamp */}
        <div className="info" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#999', fontSize: '0.8rem' }}>Timestamp</span>
            <span style={{ fontSize: '0.8rem' }}>
              {formatTimestamp(data.attestation.timestamp)}
            </span>
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
                <CopyButton text={data.parsed.pcrs[key]} />
              </div>
              <div
                style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.7rem',
                  color: '#93c5fd',
                  wordBreak: 'break-all',
                  lineHeight: '1.4',
                }}
                title={data.parsed.pcrs[key]}
              >
                {data.parsed.pcrs[key]}
              </div>
            </div>
          ))}
        </div>

        {/* Proof hash */}
        <div className="info" style={{ marginBottom: '1rem' }}>
          <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.4rem' }}>Proof Hash</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                fontFamily: "'Courier New', monospace",
                fontSize: '0.8rem',
                color: '#93c5fd',
                wordBreak: 'break-all',
              }}
            >
              {data.attestation.proofHash}
            </span>
            <CopyButton text={data.attestation.proofHash} />
          </div>
        </div>

        {/* Expiration info */}
        {data.expiresAt && (
          <div className="info" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#999', fontSize: '0.8rem' }}>Data available until</span>
              <span style={{ fontSize: '0.8rem', color: '#666' }}>
                {new Date(data.expiresAt).toUTCString()}
              </span>
            </div>
          </div>
        )}

        {/* Download button */}
        <button
          onClick={handleDownload}
          style={{
            background: '#1e3a5f',
            border: '1px solid #2563eb',
            color: '#93c5fd',
            padding: '0.5rem 1rem',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            width: '100%',
            marginBottom: '1rem',
          }}
        >
          Download Complete Proof Data (JSON)
        </button>

        {/* Link to verify page */}
        <div style={{ textAlign: 'center', marginTop: '0.5rem' }}>
          <a
            href={`/v/${proofId}`}
            style={{
              color: '#93c5fd',
              fontSize: '0.8rem',
              textDecoration: 'underline',
            }}
          >
            View Proof Verification →
          </a>
        </div>
      </div>
    </div>
  );
}
