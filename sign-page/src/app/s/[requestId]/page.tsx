'use client';

import { useParams } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWalletClient, useDisconnect } from 'wagmi';
import { useState, useEffect, useCallback } from 'react';
import { toBytes } from 'viem';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
}

export default function SigningPage() {
  const params = useParams();
  const requestId = params.requestId as string;
  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient({ chainId: connectedChainId });

  const [signalHash, setSignalHash] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'idle' | 'preparing' | 'ready' | 'signing' | 'submitting' | 'success' | 'error' | 'expired'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Step 1: Fetch request to verify it exists and is pending
  useEffect(() => {
    async function fetchRequest() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/signing/${requestId}`);
        if (!response.ok) {
          if (response.status === 404) {
            setStatus('expired');
            return;
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to load signing request');
        }
        const data = await response.json();

        if (data.status === 'completed') {
          setStatus('success');
          return;
        }
        if (data.status === 'expired') {
          setStatus('expired');
          return;
        }
        if (data.status !== 'pending') {
          throw new Error(`Unexpected request status: ${data.status}`);
        }
        if (new Date(data.expiresAt) < new Date()) {
          setStatus('expired');
          return;
        }

        setStatus('idle');
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to load signing request');
        setStatus('error');
      }
    }
    fetchRequest();
  }, [requestId]);

  // Step 2: When wallet connects, call prepare endpoint to compute signalHash
  const prepareSigningRequest = useCallback(async (walletAddress: string) => {
    try {
      setStatus('preparing');
      setErrorMessage('');

      const response = await fetch(`${API_BASE_URL}/api/signing/${requestId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          setStatus('expired');
          return;
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to prepare signing request');
      }

      const data = await response.json();
      setSignalHash(data.signalHash);
      setStatus('ready');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to prepare signing request');
      setStatus('error');
    }
  }, [requestId]);

  // Auto-prepare when wallet connects
  useEffect(() => {
    if (isConnected && address && status === 'idle') {
      prepareSigningRequest(address);
    }
  }, [isConnected, address, status, prepareSigningRequest]);

  // Step 3: Sign the signalHash
  const handleSign = async () => {
    if (!address || !signalHash) return;

    try {
      setStatus('signing');
      setErrorMessage('');

      // Sign the raw signalHash bytes using personal_sign
      // This matches the mobile app's signing behavior
      if (!walletClient) throw new Error('Wallet not connected');
      const signature = await walletClient.signMessage({
        message: { raw: toBytes(signalHash as `0x${string}`) },
      });

      setStatus('submitting');

      const response = await fetch(`${API_BASE_URL}/api/signing/callback/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature, address }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to submit signature');
      }

      setStatus('success');
    } catch (error: any) {
      setStatus('error');
      setErrorMessage(error.message || 'Failed to sign message');
    }
  };

  if (status === 'loading') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Signing Request</h1>
          <div className="description">Loading signing request...</div>
        </div>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Signing Request</h1>
          <div className="error">This signing request has expired. Please request a new one.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1 className="title">ZKProofport Signing Request</h1>

        <div className="description">
          Connect your wallet and sign the message to authorize proof generation.
        </div>

        {!isConnected ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
            <ConnectButton />
          </div>
        ) : (
          <>
            <div className="info">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Connected:</strong>
                {status !== 'success' && (
                  <button
                    onClick={() => { disconnect(); setStatus('idle'); setSignalHash(null); setErrorMessage(''); }}
                    style={{ background: 'none', border: 'none', color: '#999', fontSize: '0.75rem', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    Change Wallet
                  </button>
                )}
              </div>
              <span className="address">{address}</span>
            </div>

            {status === 'preparing' && (
              <div className="description">Preparing signing request...</div>
            )}

            {status === 'success' ? (
              <div className="success">
                Signature submitted successfully! You can close this page.
              </div>
            ) : status === 'error' ? (
              <>
                <div className="error">{errorMessage}</div>
                <button onClick={() => address && prepareSigningRequest(address)} className="button">
                  Try Again
                </button>
              </>
            ) : (
              <button
                onClick={handleSign}
                className="button"
                disabled={status !== 'ready'}
              >
                {status === 'signing'
                  ? 'Waiting for signature...'
                  : status === 'submitting'
                  ? 'Submitting...'
                  : status === 'preparing'
                  ? 'Preparing...'
                  : 'Sign Message'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
