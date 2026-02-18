export interface LLMMessage {
  role: 'user' | 'assistant';
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ id?: string; name: string; result: unknown }>;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface LLMResponse {
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[]): Promise<LLMResponse>;
}
