import OpenAI from 'openai';
import chalk from 'chalk';
import { MODEL, OPENAI_API_KEY, OPENAI_TEMPERATURE, OPENAI_TOP_P } from '../core/config.js';

let openaiClient = null;

function usesCompletionTokenParam(model) {
  return String(model || '').startsWith('gpt-5');
}

export function getOpenAIClient() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  return openaiClient;
}

/**
 * Unified OpenAI API wrapper.
 * Accepts the same param shape used throughout the app.
 * Handles rate-limit / overload retries with exponential backoff.
 */
export async function claudeCreate(params, attempt = 0) {
  try {
    const messages = [];

    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }

    for (const msg of params.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          }
        }
        const mergedText = parts.map(part => part.text).filter(Boolean).join('\n\n');
        messages.push({ role: msg.role, content: mergedText });
      }
    }

    const model = params.model || MODEL;
    const request = { model, messages };

    if (usesCompletionTokenParam(model)) {
      request.max_completion_tokens = params.max_completion_tokens ?? params.max_tokens;
    } else {
      request.max_tokens = params.max_tokens;
      request.temperature = params.temperature ?? OPENAI_TEMPERATURE;
      request.top_p = params.top_p ?? OPENAI_TOP_P;
    }

    const response = await getOpenAIClient().chat.completions.create(request);

    return {
      content: [{ type: 'text', text: response.choices[0]?.message?.content ?? '' }],
    };
  } catch (err) {
    const status = err?.status ?? err?.statusCode;
    const isRetryable = status === 429 || status === 529 ||
      err?.message?.includes('overloaded') || err?.message?.includes('rate');
    if (!isRetryable || attempt >= 4) throw err;

    const retryAfterMs =
      (err?.headers?.['retry-after'] ? parseFloat(err.headers['retry-after']) * 1000 : 0)
      || (2 ** attempt) * 15_000;   // 15 s, 30 s, 60 s, 120 s

    const reason = status === 529 ? 'overloaded' : 'rate limit';
    console.log(chalk.yellow(
      `  [${reason}] waiting ${Math.round(retryAfterMs / 1000)}s before retry ${attempt + 1}/4...`
    ));
    await new Promise(r => setTimeout(r, retryAfterMs));
    return claudeCreate(params, attempt + 1);
  }
}
