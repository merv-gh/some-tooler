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
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 16384,
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
    const rawContent = data.message?.content ?? '';
    const tokensUsed = data.eval_count ?? 0;
    const promptTokens = data.prompt_eval_count ?? 0;
    const finishReason = data.done_reason ?? 'unknown';

    // ── Detect and strip <think> blocks ────────────────────
    const { thinking, output: strippedContent } = extractThinking(rawContent);
    const thinkingTokensEstimate = thinking ? Math.ceil(thinking.length / 4) : 0;

    // ── Logging header ─────────────────────────────────────
    const contentLen = strippedContent.trim().length;
    const codeBlocks = (strippedContent.match(/```/g) || []).length / 2;

    console.log(`  [ollama] ${this.model} | ${(elapsed / 1000).toFixed(1)}s | prompt:${promptTokens} eval:${tokensUsed} | reason:${finishReason} | output:${contentLen}ch ${Math.floor(codeBlocks)}blk`);

    // ── Thinking diagnostics ───────────────────────────────
    if (thinking) {
      console.log(`  [ollama] 🧠 THINKING detected: ~${thinkingTokensEstimate} tokens (~${Math.ceil(thinking.length / 1000)}k chars)`);
      console.log(`  [ollama]    first 200 chars: "${thinking.slice(0, 200).replace(/\n/g, '↵')}"`);

      const ratio = tokensUsed > 0 ? (thinkingTokensEstimate / tokensUsed * 100).toFixed(0) : '?';
      console.log(`  [ollama]    thinking/total ratio: ~${ratio}%`);

      if (contentLen < 50) {
        console.warn(`  ⚠ [ollama] MODEL SPENT ALL TOKENS THINKING — no useful output!`);
        console.warn(`    thinking: ~${thinkingTokensEstimate} tokens`);
        console.warn(`    actual output: ${contentLen} chars`);
        console.warn(`    This is the #1 cause of empty output with qwen3/3.5 models.`);
        console.warn(`    Consider: /no_think prefix, or switching to a non-thinking model variant.`);
      }
    }

    // ── Empty/short output diagnostics ─────────────────────
    if (contentLen < 10) {
      console.warn(`  ⚠ [ollama] EMPTY/SHORT OUTPUT`);
      console.warn(`    done_reason: ${finishReason}`);
      if (finishReason === 'length') {
        console.warn(`    ⚠ HIT TOKEN LIMIT — output truncated. num_predict may need increase.`);
      }
      console.warn(`    total_duration: ${data.total_duration ? (data.total_duration / 1e9).toFixed(1) + 's' : 'n/a'}`);
      console.warn(`    eval_count: ${tokensUsed} (tokens generated)`);
      console.warn(`    prompt_eval_count: ${promptTokens} (tokens in prompt)`);
      console.warn(`    raw content length: ${rawContent.length} chars`);
      console.warn(`    stripped content length: ${contentLen} chars`);
      console.warn(`    had <think> block: ${thinking ? 'YES' : 'no'}`);
      const promptLen = prompt.length + systemPrompt.length;
      console.warn(`    prompt+system chars: ${promptLen}`);
      if (promptLen > 30000) {
        console.warn(`    ⚠ Prompt may exceed model context window!`);
      }
    }

    // ── Dump raw response to log file for debugging ────────
    this.logRaw(data, rawContent, strippedContent, thinking, prompt, elapsed);

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

  /** Append raw ollama response to debug log */
  private logRaw(
    data: any,
    rawContent: string,
    strippedContent: string,
    thinking: string | null,
    prompt: string,
    elapsed: number
  ) {
    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        model: this.model,
        elapsed_ms: elapsed,
        eval_count: data.eval_count,
        prompt_eval_count: data.prompt_eval_count,
        done_reason: data.done_reason,
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

/**
 * Qwen3/3.5 models wrap reasoning in <think>...</think>.
 * This eats tokens from num_predict budget.
 * Strip it, return separately for diagnostics.
 */
function extractThinking(content: string): { thinking: string | null; output: string } {
  // Pattern: <think>...</think> (can appear multiple times, can be at start)
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  let thinking = '';
  let match;
  while ((match = thinkRegex.exec(content)) !== null) {
    thinking += match[1];
  }

  // Also handle unclosed <think> (model hit token limit mid-thinking)
  const unclosedMatch = content.match(/<think>([\s\S]*)$/);
  if (unclosedMatch && !content.includes('</think>')) {
    thinking += unclosedMatch[1];
  }

  const output = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')  // closed blocks
    .replace(/<think>[\s\S]*$/g, '')            // unclosed trailing block
    .trim();

  return {
    thinking: thinking.length > 0 ? thinking : null,
    output,
  };
}
