import type { LLMProvider, LLMMessage, LLMTool, LLMResponse } from './llmProvider.js';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: { content: unknown } } }
  >;
}

export interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
  }>;
}

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

export interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
      >;
      role: string;
    };
    finishReason: string;
  }>;
}

export class GeminiClient {
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-2.0-flash-lite';
  }

  async chat(
    messages: GeminiMessage[],
    systemInstruction: string,
    tools?: GeminiTool[]
  ): Promise<GeminiMessage> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      contents: messages,
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data: GeminiResponse = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('No candidates returned from Gemini API');
    }

    const candidate = data.candidates[0];
    return {
      role: 'model',
      parts: candidate.content.parts,
    };
  }
}

function toGeminiMessages(messages: LLMMessage[]): GeminiMessage[] {
  const result: GeminiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.toolResults && msg.toolResults.length > 0) {
        result.push({
          role: 'user',
          parts: msg.toolResults.map((tr) => ({
            functionResponse: { name: tr.name, response: { content: tr.result } },
          })),
        });
      } else {
        result.push({ role: 'user', parts: [{ text: msg.content || '' }] });
      }
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'model',
          parts: msg.toolCalls.map((tc) => ({
            functionCall: { name: tc.name, args: tc.args },
          })),
        });
      } else {
        result.push({ role: 'model', parts: [{ text: msg.content || '' }] });
      }
    }
  }

  return result;
}

function toGeminiTools(tools: LLMTool[]): GeminiTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

function fromGeminiResponse(geminiMsg: GeminiMessage): LLMResponse {
  const result: LLMResponse = {};

  const functionCallPart = geminiMsg.parts.find(
    (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
      'functionCall' in p
  );

  if (functionCallPart) {
    result.toolCalls = [
      { name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args },
    ];
  }

  const textPart = geminiMsg.parts.find((p): p is { text: string } => 'text' in p);
  if (textPart) {
    result.content = textPart.text;
  }

  return result;
}

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private client: GeminiClient;

  constructor(config: GeminiConfig) {
    this.client = new GeminiClient(config);
  }

  async chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[]): Promise<LLMResponse> {
    const geminiMessages = toGeminiMessages(messages);
    const geminiTools = tools.length > 0 ? toGeminiTools(tools) : undefined;
    const geminiResponse = await this.client.chat(geminiMessages, systemPrompt, geminiTools);
    return fromGeminiResponse(geminiResponse);
  }
}
