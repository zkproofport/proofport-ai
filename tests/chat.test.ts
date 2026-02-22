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

      // Mock the SDK's generateContent via the internal genAI instance
      const mockGenerateContent = vi.fn().mockResolvedValue({
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello! How can I help you?' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).genAI.getGenerativeModel = vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      const geminiTools = [{ functionDeclarations: CHAT_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      const result = await client.chat(messages, SYSTEM_PROMPT, geminiTools);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        role: 'model',
        parts: [{ text: 'Hello! How can I help you?' }],
      });
    });

    it('should handle API errors', async () => {
      const client = new GeminiClient({ apiKey: 'test-key' });

      // Mock the SDK's generateContent to throw an error (simulating a 400 response)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).genAI.getGenerativeModel = vi.fn().mockReturnValue({
        generateContent: vi.fn().mockRejectedValue(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent: [400 Bad Request] Invalid request')),
      });

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      await expect(client.chat(messages, SYSTEM_PROMPT)).rejects.toThrow('Gemini API error:');
    });

    it('should handle missing candidates', async () => {
      const client = new GeminiClient({ apiKey: 'test-key' });

      // Mock the SDK's generateContent to return empty candidates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).genAI.getGenerativeModel = vi.fn().mockReturnValue({
        generateContent: vi.fn().mockResolvedValue({
          response: { candidates: [] },
        }),
      });

      const messages: GeminiMessage[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
      ];

      await expect(client.chat(messages, SYSTEM_PROMPT)).rejects.toThrow('No candidates returned');
    });
  });

  describe('CHAT_TOOLS', () => {
    it('should define all three skills', () => {
      expect(CHAT_TOOLS).toHaveLength(6);

      const skillNames = CHAT_TOOLS.map(fn => fn.name);
      expect(skillNames).toContain('request_signing');
      expect(skillNames).toContain('check_status');
      expect(skillNames).toContain('request_payment');
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
      expect(verifyProof?.parameters.required).toEqual([]);
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
      expect(SYSTEM_PROMPT).toContain('proveragent.base.eth');
      expect(SYSTEM_PROMPT).toContain('generate_proof');
      expect(SYSTEM_PROMPT).toContain('verify_proof');
      expect(SYSTEM_PROMPT).toContain('get_supported_circuits');
      expect(SYSTEM_PROMPT).toContain('$0.10 USDC');
      expect(SYSTEM_PROMPT).toContain('x402');
    });

    it('should emphasize not making up data', () => {
      expect(SYSTEM_PROMPT).toContain('NEVER fabricate proof data');
      expect(SYSTEM_PROMPT).toContain('ALWAYS use function calling tools');
    });
  });
});
