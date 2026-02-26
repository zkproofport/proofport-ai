'use client';

import { useParams } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect } from 'wagmi';
import { useState, useEffect, useCallback } from 'react';
import { toHex } from 'viem';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('NEXT_PUBLIC_API_BASE_URL environment variable is required');
}

interface PaymentInfo {
  requestId: string;
  circuitId: string;
  scope: string;
  paymentStatus: string;
  paymentTxHash: string | null;
  payTo: string;
  amount: string;
  priceDisplay: string;
  usdcAddress: `0x${string}`;
  chainId: number;
  chainName: string;
  usdcName: string;
  usdcVersion: string;
}

function getBasescanUrl(chainId: number, txHash: string): string {
  const host = chainId === 8453 ? 'basescan.org' : 'sepolia.basescan.org';
  return `https://${host}/tx/${txHash}`;
}

function formatPrice(priceDisplay: string): string {
  return priceDisplay.replace(/^\$/, '') + ' USDC';
}

export default function PaymentPage() {
  const params = useParams();
  const requestId = params.requestId as string;
  const { address, isConnected, connector, chainId: connectedChainId } = useAccount();
  const { disconnect } = useDisconnect();

  const [payInfo, setPayInfo] = useState<PaymentInfo | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'idle' | 'wrong-chain' | 'switching-chain' | 'ready' | 'signing' | 'submitting' | 'success' | 'error' | 'expired'
  >('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [txHash, setTxHash] = useState<string | null>(null);

  // Step 1: Fetch payment info
  useEffect(() => {
    async function fetchPaymentInfo() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/payment/${requestId}`);
        if (!response.ok) {
          if (response.status === 404) {
            setStatus('expired');
            return;
          }
          const error = await response.json();
          throw new Error(error.error || 'Payment request not found');
        }
        const data: PaymentInfo = await response.json();
        setPayInfo(data);

        if (data.paymentStatus === 'completed') {
          setTxHash(data.paymentTxHash);
          setStatus('success');
          return;
        }

        setStatus('idle');
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to load payment request');
        setStatus('error');
      }
    }
    fetchPaymentInfo();
  }, [requestId]);

  // Step 2: When wallet connects or chain changes, check if chain matches
  useEffect(() => {
    if (!isConnected || !payInfo || status === 'loading' || status === 'success' || status === 'expired') return;

    if (connectedChainId !== payInfo.chainId) {
      setStatus('wrong-chain');
    } else if (status === 'wrong-chain' || status === 'idle') {
      setStatus('ready');
    }
  }, [isConnected, connectedChainId, payInfo, status]);

  const handleSwitchChain = useCallback(async () => {
    if (!payInfo) return;
    try {
      setStatus('switching-chain');
      setErrorMessage('');
      const provider = await connector?.getProvider();
      if (!provider) throw new Error('No wallet provider available');
      await (provider as any).request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: toHex(payInfo.chainId) }],
      });
      setStatus('ready');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch network');
      setStatus('wrong-chain');
    }
  }, [payInfo, connector]);

  const handlePay = useCallback(async () => {
    if (!address || !payInfo) return;

    try {
      setStatus('signing');
      setErrorMessage('');

      const now = Math.floor(Date.now() / 1000);
      const validAfter = BigInt(now - 600);
      const validBefore = BigInt(now + 300);
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))) as `0x${string}`;
      const value = BigInt(payInfo.amount);

      const authorization = {
        from: address,
        to: payInfo.payTo as `0x${string}`,
        value,
        validAfter,
        validBefore,
        nonce,
      };

      const typedData = {
        domain: {
          name: payInfo.usdcName,
          version: payInfo.usdcVersion,
          chainId: payInfo.chainId,
          verifyingContract: payInfo.usdcAddress,
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      };

      // Use raw EIP-1193 provider to bypass wagmi's request queue.
      // Avoids "eth_signTypedData_v4 already pending" errors on mobile WalletConnect.
      const provider = await connector?.getProvider();
      if (!provider) throw new Error('No wallet provider available');
      const signature = await (provider as any).request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(typedData)],
      });

      setStatus('submitting');

      const response = await fetch(`${API_BASE_URL}/api/payment/sign/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
          signature,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to submit payment');
      }

      const result = await response.json();
      setTxHash(result.txHash || null);
      setStatus('success');
    } catch (err: any) {
      setErrorMessage(err.message || 'Payment failed');
      setStatus('error');
    }
  }, [address, payInfo, requestId, connector]);

  if (status === 'loading') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Payment</h1>
          <div className="description">Loading payment request...</div>
        </div>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Payment</h1>
          <div className="error">This payment request has expired. Please request a new one.</div>
        </div>
      </div>
    );
  }

  if (status === 'error' && !payInfo) {
    return (
      <div className="container">
        <div className="card">
          <h1 className="title">ZKProofport Payment</h1>
          <div className="error">{errorMessage}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1 className="title">ZKProofport Payment</h1>

        <div className="description">
          Authorize a USDC payment to generate your zero-knowledge proof.
        </div>

        {payInfo && (
          <div className="info" style={{ marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#999', fontSize: '0.8rem' }}>Circuit</span>
              <span style={{ fontSize: '0.875rem' }}>{payInfo.circuitId}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#999', fontSize: '0.8rem' }}>Network</span>
              <span style={{ fontSize: '0.875rem' }}>{payInfo.chainName}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#999', fontSize: '0.8rem' }}>Price</span>
              <span style={{ fontSize: '1rem', fontWeight: 600, color: '#4ade80' }}>
                {formatPrice(payInfo.priceDisplay)}
              </span>
            </div>
          </div>
        )}

        {status === 'success' ? (
          <div className="success">
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Payment confirmed!</div>
            {txHash && payInfo && (
              <div style={{ marginBottom: '0.75rem' }}>
                <a
                  href={getBasescanUrl(payInfo.chainId, txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#86efac', textDecoration: 'underline', fontSize: '0.8rem', wordBreak: 'break-all' }}
                >
                  View on {payInfo.chainId === 8453 ? 'Basescan' : 'Sepolia Basescan'} ↗
                </a>
              </div>
            )}
            <div style={{ color: '#86efac', fontSize: '0.875rem' }}>
              Return to the chat and tell the agent to proceed.
            </div>
          </div>
        ) : !isConnected ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
            <ConnectButton />
          </div>
        ) : (
          <>
            <div className="info">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Connected:</strong>
                <button
                  onClick={() => { disconnect(); setStatus('idle'); setErrorMessage(''); }}
                  style={{ background: 'none', border: 'none', color: '#999', fontSize: '0.75rem', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Change Wallet
                </button>
              </div>
              <span className="address">{address}</span>
            </div>

            {status === 'wrong-chain' && payInfo && (
              <>
                <div className="error" style={{ marginBottom: '1rem' }}>
                  Wrong network. Please switch to {payInfo.chainName}.
                </div>
                <button
                  onClick={handleSwitchChain}
                  className="button"
                >
                  Switch to {payInfo.chainName}
                </button>
              </>
            )}

            {status === 'switching-chain' && (
              <div className="description">Switching network...</div>
            )}

            {status === 'error' && (
              <>
                <div className="error">{errorMessage}</div>
                <button
                  onClick={() => setStatus('ready')}
                  className="button"
                  style={{ marginTop: '0.5rem' }}
                >
                  Try Again
                </button>
              </>
            )}

            {(status === 'ready' || status === 'signing' || status === 'submitting') && (
              <button
                onClick={handlePay}
                className="button"
                disabled={status !== 'ready'}
              >
                {status === 'signing'
                  ? 'Waiting for signature...'
                  : status === 'submitting'
                  ? 'Submitting payment...'
                  : `Pay ${payInfo ? formatPrice(payInfo.priceDisplay) : ''}`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
