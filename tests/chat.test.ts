import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient, type GeminiMessage } from '../src/chat/geminiClient.js';
import { CHAT_TOOLS } from '../src/chat/tools.js';
import { SYSTEM_PROMPT } from '../src/chat/systemPrompt.js';

describe('Chat Integration', () => {
  describe('GeminiClient', () => {
    it('should construct with api key and default model', () => {
      const client = new GeminiClient({ apiKey: 'test-key' });
      expect(client).toBeDefined();
    });

    it('should construct with custom model', () => {
      const client = new GeminiClient({ apiKey: 'test-key', model: 'gemini-pro' });
      expect(client).toBeDefined();
    });

    it('should format chat request with messages and system prompt', async () => {
      const client = new GeminiClient({ apiKey: 'test-key' });

      // Mock fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello! How can I help you?' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
        }),
      });
      global.fetch = mockFetch;

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      const geminiTools = [{ functionDeclarations: CHAT_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      await client.chat(messages, SYSTEM_PROMPT, geminiTools);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('gemini-2.0-flash-lite:generateContent');
      expect(callArgs[0]).toContain('key=test-key');

      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.contents).toEqual(messages);
      expect(requestBody.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
      expect(requestBody.tools).toEqual(geminiTools);
    });

    it('should handle API errors', async () => {
      const client = new GeminiClient({ apiKey: 'test-key' });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid request',
      });
      global.fetch = mockFetch;

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      await expect(client.chat(messages, SYSTEM_PROMPT)).rejects.toThrow('Gemini API error (400)');
    });

    it('should handle missing candidates', async () => {
      const client = new GeminiClient({ apiKey: 'test-key' });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ candidates: [] }),
      });
      global.fetch = mockFetch;

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      await expect(client.chat(messages, SYSTEM_PROMPT)).rejects.toThrow('No candidates returned');
    });
  });

  describe('CHAT_TOOLS', () => {
    it('should define all three skills', () => {
      expect(CHAT_TOOLS).toHaveLength(3);

      const skillNames = CHAT_TOOLS.map(fn => fn.name);
      expect(skillNames).toContain('generate_proof');
      expect(skillNames).toContain('verify_proof');
      expect(skillNames).toContain('get_supported_circuits');
    });

    it('should define generate_proof with correct parameters', () => {
      const generateProof = CHAT_TOOLS.find(fn => fn.name === 'generate_proof');
      expect(generateProof).toBeDefined();
      expect(generateProof?.parameters.required).toEqual(['circuitId', 'scope']);
      expect(generateProof?.parameters.properties).toHaveProperty('circuitId');
      expect(generateProof?.parameters.properties).toHaveProperty('scope');
      expect(generateProof?.parameters.properties).toHaveProperty('address');
      expect(generateProof?.parameters.properties).toHaveProperty('signature');
      expect(generateProof?.parameters.properties).toHaveProperty('requestId');
      expect(generateProof?.parameters.properties).toHaveProperty('countryList');
      expect(generateProof?.parameters.properties).toHaveProperty('isIncluded');
    });

    it('should define verify_proof with correct parameters', () => {
      const verifyProof = CHAT_TOOLS.find(fn => fn.name === 'verify_proof');
      expect(verifyProof).toBeDefined();
      expect(verifyProof?.parameters.required).toEqual(['circuitId', 'proof', 'publicInputs']);
      expect(verifyProof?.parameters.properties).toHaveProperty('circuitId');
      expect(verifyProof?.parameters.properties).toHaveProperty('proof');
      expect(verifyProof?.parameters.properties).toHaveProperty('publicInputs');
      expect(verifyProof?.parameters.properties).toHaveProperty('chainId');
    });

    it('should define get_supported_circuits with no required parameters', () => {
      const getCircuits = CHAT_TOOLS.find(fn => fn.name === 'get_supported_circuits');
      expect(getCircuits).toBeDefined();
      expect(getCircuits?.parameters.required).toEqual([]);
    });
  });

  describe('SYSTEM_PROMPT', () => {
    it('should contain key instructions', () => {
      expect(SYSTEM_PROMPT).toContain('proveragent.eth');
      expect(SYSTEM_PROMPT).toContain('generate_proof');
      expect(SYSTEM_PROMPT).toContain('verify_proof');
      expect(SYSTEM_PROMPT).toContain('get_supported_circuits');
      expect(SYSTEM_PROMPT).toContain('$0.10 USDC');
      expect(SYSTEM_PROMPT).toContain('x402');
    });

    it('should emphasize not making up data', () => {
      expect(SYSTEM_PROMPT).toContain('NEVER fabricate proof data');
      expect(SYSTEM_PROMPT).toContain('ALWAYS use the function calling tools');
    });
  });
});
