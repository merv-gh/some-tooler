import type { ModelResponse, ToolerConfig } from './types.js';

export class OllamaClient {
  private url: string;
  private model: string;

  constructor(config: ToolerConfig) {
    this.url = config.ollamaUrl;
    this.model = config.model;
  }

  async generate(prompt: string, systemPrompt: string): Promise<ModelResponse> {
    const startTime = Date.now();

    const response = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: {
          temperature: 0.3,       // low temp for code
          num_predict: 4096,
          top_p: 0.9,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = await response.json() as any;
    const elapsed = Date.now() - startTime;

    console.log(`  [ollama] ${this.model} responded in ${(elapsed / 1000).toFixed(1)}s`);

    return {
      content: data.message?.content ?? '',
      tokensUsed: data.eval_count ?? 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Extract code blocks from model response */
  static extractCode(response: string): { filename?: string; code: string }[] {
    const blocks: { filename?: string; code: string }[] = [];
    // Match ```lang\n...``` or ```filename\n...```
    const regex = /```(?:(\S+)\n)?([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const label = match[1] ?? '';
      const code = match[2]?.trim() ?? '';
      // If label looks like a filename (has extension)
      const filename = label.includes('.') ? label : undefined;
      if (code) blocks.push({ filename, code });
    }
    // If no code blocks, treat entire response as code (last resort)
    if (blocks.length === 0 && response.trim()) {
      blocks.push({ code: response.trim() });
    }
    return blocks;
  }
}
