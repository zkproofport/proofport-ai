import type { LLMProvider, LLMMessage, LLMTool, LLMResponse } from './llmProvider.js';

export class MultiLLMProvider implements LLMProvider {
  name = 'multi';
  private providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error('At least one LLM provider is required');
    }
    this.providers = providers;
  }

  async chat(messages: LLMMessage[], systemPrompt: string, tools: LLMTool[]): Promise<LLMResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        console.log(`[Chat] Trying ${provider.name}...`);
        const response = await provider.chat(messages, systemPrompt, tools);
        console.log(`[Chat] ${provider.name} succeeded`);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMsg = lastError.message.replace(/\n/g, ' ');
        console.warn(`[Chat] ${provider.name} failed: ${errorMsg}, trying next...`);
        continue;
      }
    }

    const finalMsg = lastError?.message?.replace(/\n/g, ' ');
    throw new Error(`All LLM providers failed. Last error: ${finalMsg}`);
  }
}
