import type { LLMProvider, LLMMessage, LLMTool, LLMResponse, ChatOptions } from './llmProvider.js';
import { createLogger } from '../logger.js';

const log = createLogger('LLM');

export class MultiLLMProvider implements LLMProvider {
  name = 'multi';
  private providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error('At least one LLM provider is required');
    }
    this.providers = providers;
  }

  async chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[], options?: ChatOptions): Promise<LLMResponse> {
    let lastError: Error | undefined;
    const logCtx = options?.logContext ?? {};

    for (const provider of this.providers) {
      try {
        log.info({ action: 'llm.call.started', provider: provider.name, ...logCtx }, 'LLM call started');
        const response = await provider.chat(messages, systemPrompt, tools, options);
        log.info({ action: 'llm.call.succeeded', provider: provider.name, ...logCtx }, 'LLM call succeeded');
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMsg = lastError.message.replace(/\n/g, ' ');
        log.warn({ action: 'llm.call.failed', provider: provider.name, error: errorMsg, ...logCtx }, 'LLM call failed, trying next');
        continue;
      }
    }

    const finalMsg = lastError?.message?.replace(/\n/g, ' ');
    throw new Error(`All LLM providers failed. Last error: ${finalMsg}`);
  }
}
