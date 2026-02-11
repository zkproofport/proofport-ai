'use client';

import { useParams } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage } from 'wagmi';
import { useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
}

export default function SigningPage() {
  const params = useParams();
  const requestId = params.requestId as string;
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [status, setStatus] = useState<'idle' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleSign = async () => {
    if (!address) return;

    try {
      setStatus('signing');
      setErrorMessage('');

      const message = `Sign to authorize ZKProofport proof generation\n\nRequest: ${requestId}`;
      const signature = await signMessageAsync({ message });

      setStatus('submitting');

      const response = await fetch(`${API_BASE_URL}/api/signing/callback/${requestId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          signature,
          address,
        }),
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

  return (
    <div className="container">
      <div className="card">
        <h1 className="title">ZKProofport Signing Request</h1>

        <div className="description">
          Please connect your wallet and sign the message to authorize proof generation.
        </div>

        <div className="request-id">
          <strong>Request ID:</strong>
          <br />
          {requestId}
        </div>

        {!isConnected ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
            <ConnectButton />
          </div>
        ) : (
          <>
            <div className="info">
              <strong>Connected Address:</strong>
              <br />
              {address}
            </div>

            {status === 'success' ? (
              <div className="success">
                Signature submitted successfully! You can close this page.
              </div>
            ) : status === 'error' ? (
              <>
                <div className="error">
                  {errorMessage}
                </div>
                <button onClick={handleSign} className="button">
                  Try Again
                </button>
              </>
            ) : (
              <button
                onClick={handleSign}
                className="button"
                disabled={status === 'signing' || status === 'submitting'}
              >
                {status === 'signing'
                  ? 'Waiting for signature...'
                  : status === 'submitting'
                  ? 'Submitting...'
                  : 'Sign Message'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
