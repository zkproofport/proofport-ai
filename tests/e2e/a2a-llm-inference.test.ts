/**
 * A2A LLM Text Inference Integration Tests (Real Gemini API)
 *
 * Tests that the real Gemini LLM correctly routes natural language messages
 * to the correct skill tool calls, including English, Korean, and mixed inputs.
 *
 * Requires GEMINI_API_KEY environment variable. All tests are skipped if not set.
 */

import { describe, it, expect } from 'vitest';
import { GeminiProvider } from '../../src/chat/geminiClient.js';
import { CHAT_TOOLS } from '../../src/chat/tools.js';
import type { LLMProvider, LLMResponse } from '../../src/chat/llmProvider.js';
import { A2A_INFERENCE_PROMPT } from '../../src/a2a/taskHandler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

async function inferSkill(
  text: string,
  provider: LLMProvider
): Promise<{ skill: string; params: Record<string, unknown> } | null> {
  const response: LLMResponse = await provider.chat(
    [{ role: 'user', content: text }],
    A2A_INFERENCE_PROMPT,
    CHAT_TOOLS
  );

  if (!response.toolCalls || response.toolCalls.length === 0) {
    return null;
  }

  return {
    skill: response.toolCalls[0].name,
    params: response.toolCalls[0].args,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe.skipIf(!process.env.GEMINI_API_KEY)('A2A LLM Text Inference (Real LLM)', () => {
  let provider: GeminiProvider;

  // Create provider once for the whole suite — API key is required (checked by skipIf)
  provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! });

  // ── English tests ────────────────────────────────────────────────────

  it('EN: "list supported circuits" → get_supported_circuits', { timeout: 30000 }, async () => {
    const result = await inferSkill('list supported circuits', provider);
    expect(result?.skill).toBe('get_supported_circuits');
  });

  it('EN: "generate a proof for coinbase_attestation with scope test.com" → generate_proof', { timeout: 30000 }, async () => {
    const result = await inferSkill(
      'generate a proof for coinbase_attestation with scope test.com',
      provider
    );
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.circuitId).toBe('coinbase_attestation');
    expect(result?.params.scope).toBe('test.com');
  });

  it('EN: "verify proof 0xaabb for coinbase_attestation" → verify_proof', { timeout: 30000 }, async () => {
    const result = await inferSkill('verify proof 0xaabb for coinbase_attestation on chain 84532', provider);
    expect(result?.skill).toBe('verify_proof');
    expect(result?.params.circuitId).toBe('coinbase_attestation');
  });

  it('EN: "what circuits do you support?" → get_supported_circuits', { timeout: 30000 }, async () => {
    const result = await inferSkill('what circuits do you support?', provider);
    expect(result?.skill).toBe('get_supported_circuits');
  });

  it('EN: "I need a KYC proof for myapp.com" → generate_proof with coinbase circuit and myapp.com scope', { timeout: 30000 }, async () => {
    const result = await inferSkill('I need a KYC proof for myapp.com', provider);
    expect(result?.skill).toBe('generate_proof');
    // circuitId must reference coinbase attestation
    expect(
      result?.params.circuitId === 'coinbase_attestation' ||
      String(result?.params.circuitId).includes('coinbase')
    ).toBe(true);
    expect(result?.params.scope).toBe('myapp.com');
  });

  // ── Korean tests ─────────────────────────────────────────────────────

  it('KO: "지원하는 회로 목록 보여줘" → get_supported_circuits', { timeout: 30000 }, async () => {
    const result = await inferSkill('지원하는 회로 목록 보여줘', provider);
    expect(result?.skill).toBe('get_supported_circuits');
  });

  it('KO: "coinbase_attestation 증명 생성해줘" → generate_proof with coinbase_attestation', { timeout: 30000 }, async () => {
    const result = await inferSkill('coinbase_attestation 증명 생성해줘', provider);
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.circuitId).toBe('coinbase_attestation');
  });

  it('KO: "coinbase_attestation 증명 0xaabb 검증해줘" → verify_proof', { timeout: 30000 }, async () => {
    const result = await inferSkill('coinbase_attestation 증명 0xaabb 검증해줘', provider);
    expect(result?.skill).toBe('verify_proof');
    expect(result?.params.circuitId).toBe('coinbase_attestation');
  });

  it('KO: "coinbase_country_attestation KR 포함되게 증명 생성해줘" → generate_proof with KR inclusion', { timeout: 30000 }, async () => {
    const result = await inferSkill(
      'coinbase_country_attestation KR 포함되게 증명 생성해줘',
      provider
    );
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.circuitId).toBe('coinbase_country_attestation');
    expect(result?.params.countryList).toEqual(expect.arrayContaining(['KR']));
    expect(result?.params.isIncluded).toBe(true);
  });

  // ── Mixed language tests ─────────────────────────────────────────────

  it('MX: "proof 생성해줘 myapp.com" → generate_proof with myapp.com scope', { timeout: 30000 }, async () => {
    const result = await inferSkill('proof 생성해줘 myapp.com', provider);
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.scope).toBe('myapp.com');
  });

  it('MX: "coinbase_attestation 서킷의 myapp.com 으로 proof 생성해줘" → generate_proof', { timeout: 30000 }, async () => {
    const result = await inferSkill(
      'coinbase_attestation 서킷의 myapp.com 으로 proof 생성해줘',
      provider
    );
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.circuitId).toBe('coinbase_attestation');
    expect(result?.params.scope).toBe('myapp.com');
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it('EDGE: "hello world" — does not throw (result may be null or a tool call)', { timeout: 30000 }, async () => {
    // LLMs are unpredictable with unrelated text — just verify no exception is thrown
    let threwError = false;
    try {
      await inferSkill('hello world', provider);
    } catch {
      threwError = true;
    }
    expect(threwError).toBe(false);
  });

  it('EDGE: "coinbase_country_attestation US 제외하고 증명 만들어줘" → generate_proof with isIncluded=false', { timeout: 30000 }, async () => {
    const result = await inferSkill(
      'coinbase_country_attestation US 제외하고 증명 만들어줘',
      provider
    );
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.isIncluded).toBe(false);
    expect(result?.params.countryList).toEqual(expect.arrayContaining(['US']));
  });

  it('EDGE: "KR US JP 포함 coinbase_country_attestation 증명 생성" → generate_proof with all 3 country codes', { timeout: 30000 }, async () => {
    const result = await inferSkill(
      'KR US JP 포함 coinbase_country_attestation 증명 생성',
      provider
    );
    expect(result?.skill).toBe('generate_proof');
    expect(result?.params.countryList).toEqual(expect.arrayContaining(['KR', 'US', 'JP']));
  });
});
