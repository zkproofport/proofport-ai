import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMTool, LLMResponse, ChatOptions } from './llmProvider.js';

interface OpenAIConfig {
  apiKey: string;
  model?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

function toOpenAIMessages(messages: LLMMessage[], systemPrompt: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            content: JSON.stringify(tr.result),
            tool_call_id: tr.id || tr.name,
          });
        }
      } else {
        result.push({ role: 'user', content: msg.content || '' });
      }
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id || tc.name,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.content || '' });
      }
    }
  }

  return result;
}

function toOpenAITools(tools: LLMTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model || 'gpt-4o-mini';
  }

  async chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[], options?: ChatOptions): Promise<LLMResponse> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: toOpenAIMessages(messages, systemPrompt) as OpenAI.Chat.ChatCompletionMessageParam[],
    };

    if (tools.length > 0) {
      params.tools = toOpenAITools(tools) as OpenAI.Chat.ChatCompletionTool[];
    }

    if (options?.toolChoice === 'required' && tools.length > 0) {
      params.tool_choice = 'required';
    }

    let data: OpenAI.Chat.ChatCompletion;
    try {
      data = await this.client.chat.completions.create(params);
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API error (${err.status}): ${err.message}`);
      }
      throw err;
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error('No choices returned from OpenAI API');
    }

    const choice = data.choices[0];
    const result: LLMResponse = {};

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls
        .filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        }));
    }

    if (choice.message.content) {
      result.content = choice.message.content;
    }

    return result;
  }
}
