import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { ModelResponse, ToolerConfig } from './types.js';

export class OllamaClient {
  private url: string;
  private model: string;
  private logDir: string;

  constructor(config: ToolerConfig) {
    this.url = config.ollamaUrl;
    this.model = config.model;
    this.logDir = config.logDir;
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
        stream: true,
        options: {
          temperature: 0.3,
          num_predict: -1,    // unlimited — model decides when to stop
          top_p: 0.9,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('Ollama returned no stream body');
    }

    // ── Stream processing ──────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawContent = '';
    let tokensUsed = 0;
    let promptTokens = 0;
    let finishReason = 'unknown';
    let inThinkBlock = false;
    let buffer = '';

    process.stdout.write(`  [ollama] ${this.model} streaming: `);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Ollama streams newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }

        const token = chunk.message?.content ?? '';
        rawContent += token;

        // ── Live console output ────────────────────────────
        // Track <think> blocks for display
        const combined = rawContent;
        if (token) {
          if (combined.includes('<think>') && !combined.includes('</think>')) {
            // Inside thinking — show dots
            if (!inThinkBlock) {
              process.stdout.write('🧠');
              inThinkBlock = true;
            }
            // Show a dot every ~200 chars of thinking
            if (rawContent.length % 200 < token.length) {
              process.stdout.write('.');
            }
          } else {
            if (inThinkBlock) {
              process.stdout.write(' → ');
              inThinkBlock = false;
            }
            // Show code-relevant tokens live
            if (token.includes('```')) {
              process.stdout.write('📄');
            } else if (token.includes('\n')) {
              process.stdout.write('·');
            }
          }
        }

        // Final chunk has metadata
        if (chunk.done) {
          tokensUsed = chunk.eval_count ?? 0;
          promptTokens = chunk.prompt_eval_count ?? 0;
          finishReason = chunk.done_reason ?? 'stop';
        }
      }
    }

    const elapsed = Date.now() - startTime;

    // ── Strip thinking ─────────────────────────────────────
    const { thinking, output: strippedContent } = extractThinking(rawContent);
    const thinkingTokensEstimate = thinking ? Math.ceil(thinking.length / 4) : 0;
    const contentLen = strippedContent.trim().length;
    const codeBlocks = (strippedContent.match(/```/g) || []).length / 2;

    // ── Summary line ───────────────────────────────────────
    process.stdout.write('\n');
    console.log(`  [ollama] done ${(elapsed / 1000).toFixed(1)}s | prompt:${promptTokens} eval:${tokensUsed} | reason:${finishReason} | output:${contentLen}ch ${Math.floor(codeBlocks)}blk`);

    // ── Thinking diagnostics ───────────────────────────────
    if (thinking) {
      console.log(`  [ollama] 🧠 thinking: ~${thinkingTokensEstimate}tok (~${Math.ceil(thinking.length / 1000)}k chars) | first 150: "${thinking.slice(0, 150).replace(/\n/g, '↵')}"`);
      if (contentLen < 50) {
        console.warn(`  ⚠ ALL TOKENS SPENT THINKING — no useful output`);
      }
    }

    // ── Empty output diagnostics ───────────────────────────
    if (contentLen < 10) {
      console.warn(`  ⚠ EMPTY/SHORT OUTPUT`);
      console.warn(`    reason:${finishReason} eval:${tokensUsed} raw:${rawContent.length}ch stripped:${contentLen}ch think:${thinking ? 'YES' : 'no'}`);
      if (finishReason === 'length') {
        console.warn(`    ⚠ HIT TOKEN LIMIT`);
      }
      const promptLen = prompt.length + systemPrompt.length;
      console.warn(`    prompt+system: ${promptLen}ch`);
    }

    // ── Debug log ──────────────────────────────────────────
    this.logRaw(rawContent, strippedContent, thinking, prompt, elapsed, tokensUsed, promptTokens, finishReason);

    return { content: strippedContent, tokensUsed };
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
    const regex = /```(?:(\S+)\n)?([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const label = match[1] ?? '';
      const code = match[2]?.trim() ?? '';
      const filename = label.includes('.') ? label : undefined;
      if (code) blocks.push({ filename, code });
    }
    if (blocks.length === 0 && response.trim()) {
      blocks.push({ code: response.trim() });
    }
    return blocks;
  }

  private logRaw(
    rawContent: string,
    strippedContent: string,
    thinking: string | null,
    prompt: string,
    elapsed: number,
    evalCount: number,
    promptEvalCount: number,
    doneReason: string,
  ) {
    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        model: this.model,
        elapsed_ms: elapsed,
        eval_count: evalCount,
        prompt_eval_count: promptEvalCount,
        done_reason: doneReason,
        raw_content_length: rawContent.length,
        stripped_content_length: strippedContent.trim().length,
        thinking_length: thinking?.length ?? 0,
        thinking_preview: thinking?.slice(0, 300) ?? null,
        output_preview: strippedContent.slice(0, 300),
        prompt_preview: prompt.slice(0, 200),
        code_blocks_found: (strippedContent.match(/```/g) || []).length / 2,
      };
      appendFileSync(
        join(this.logDir, 'ollama-debug.jsonl'),
        JSON.stringify(entry) + '\n',
        'utf-8'
      );
    } catch { /* don't crash on log failure */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Think-block extraction
// ═══════════════════════════════════════════════════════════════

function extractThinking(content: string): { thinking: string | null; output: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  let thinking = '';
  let match;
  while ((match = thinkRegex.exec(content)) !== null) {
    thinking += match[1];
  }

  // Unclosed <think> (hit token limit mid-thought)
  const unclosedMatch = content.match(/<think>([\s\S]*)$/);
  if (unclosedMatch && !content.includes('</think>')) {
    thinking += unclosedMatch[1];
  }

  const output = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim();

  return {
    thinking: thinking.length > 0 ? thinking : null,
    output,
  };
}
