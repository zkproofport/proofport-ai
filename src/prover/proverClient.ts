import { loadConfig } from '../config/index.js';
import type { ProverResponse } from '../types/index.js';

export class ProverClient {
  private baseUrl: string;
  private maxRetries = 3;
  private proveTimeout = 120000;
  private defaultTimeout = 10000;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || loadConfig().proverUrl;
  }

  async prove(circuitId: string, inputs: string[]): Promise<ProverResponse> {
    return this.retryRequest(async () => {
      const response = await fetch(`${this.baseUrl}/prove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuitId, inputs, onChain: true }),
        signal: AbortSignal.timeout(this.proveTimeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    });
  }

  async verify(circuitId: string, proof: number[]): Promise<{ isValid: boolean }> {
    return this.retryRequest(async () => {
      const response = await fetch(`${this.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuitId, proof, onChain: true }),
        signal: AbortSignal.timeout(this.defaultTimeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    });
  }

  async getCircuits(): Promise<{ circuits: string[] }> {
    return this.retryRequest(async () => {
      const response = await fetch(`${this.baseUrl}/circuits`, {
        signal: AbortSignal.timeout(this.defaultTimeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    });
  }

  async health(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(this.defaultTimeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  private async retryRequest<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
