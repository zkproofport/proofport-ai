import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import type {
  Content,
  Part,
  Tool as GeminiSDKTool,
  GenerativeModel,
} from '@google/generative-ai';
import type { LLMProvider, LLMMessage, LLMTool, LLMResponse, ChatOptions } from './llmProvider.js';

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
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: GeminiConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.model || 'gemini-2.0-flash-lite';
  }

  async chat(
    messages: GeminiMessage[],
    systemInstruction: string,
    tools?: GeminiTool[],
    toolChoice?: 'auto' | 'required'
  ): Promise<GeminiMessage> {
    const modelParams: Parameters<GoogleGenerativeAI['getGenerativeModel']>[0] = {
      model: this.model,
      systemInstruction,
    };

    if (tools && tools.length > 0) {
      modelParams.tools = tools as unknown as GeminiSDKTool[];
    }

    if (toolChoice === 'required') {
      modelParams.toolConfig = {
        functionCallingConfig: { mode: FunctionCallingMode.ANY },
      };
    }

    const generativeModel: GenerativeModel = this.genAI.getGenerativeModel(modelParams);

    // Convert GeminiMessage[] to SDK Content[]
    const contents: Content[] = messages.map((msg) => ({
      role: msg.role,
      parts: msg.parts as Part[],
    }));

    let result;
    try {
      result = await generativeModel.generateContent({ contents });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Gemini API error: ${message}`);
    }

    const response = result.response;
    const candidates = response.candidates;

    if (!candidates || candidates.length === 0) {
      throw new Error('No candidates returned from Gemini API');
    }

    const candidate = candidates[0];
    // Convert SDK Parts back to GeminiMessage parts shape
    const parts: GeminiMessage['parts'] = candidate.content.parts.map((p) => {
      if ('functionCall' in p && p.functionCall) {
        return {
          functionCall: {
            name: p.functionCall.name,
            args: p.functionCall.args as Record<string, unknown>,
          },
        };
      }
      if ('text' in p && typeof p.text === 'string') {
        return { text: p.text };
      }
      // Fallback: treat as text
      return { text: '' };
    });

    return {
      role: 'model',
      parts,
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
      { id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args },
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

  async chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[], options?: ChatOptions): Promise<LLMResponse> {
    const geminiMessages = toGeminiMessages(messages);
    const geminiTools = tools.length > 0 ? toGeminiTools(tools) : undefined;
    const geminiResponse = await this.client.chat(geminiMessages, systemPrompt, geminiTools, options?.toolChoice);
    return fromGeminiResponse(geminiResponse);
  }
}
