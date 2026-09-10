import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  tracer,
  GENAI,
  computeCost,
  captureContent,
  recordCall,
  failSpan,
} from './genai.js';

const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_TOOL_MODEL',
    fallbackModel: 'openai/gpt-oss-120b',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    fallbackModel: 'gemini-2.0-flash',
  },
};

export class LlmError extends Error {
  constructor(status, body) {
    super(`LLM call failed (${status}): ${String(body).slice(0, 300)}`);
    this.name = 'LlmError';
    this.status = status;
  }
}

/**
 * Project 02's chat client, now instrumented.
 *
 * Compare the two files side by side: the LLM logic is identical. Everything added
 * here is measurement. That's the point — observability is a wrapper, not a rewrite,
 * and if instrumenting forces you to restructure your code you've done it wrong.
 */
export async function chat({
  provider = 'groq',
  model,
  messages,
  tools,
  toolChoice,
  responseFormat,
  temperature = 0,
  signal,
  // Business context, threaded through so cost can be attributed to a person and a
  // feature rather than just "the LLM". "We spent $400 last month" is useless;
  // "support-agent costs $0.02/conversation and user u_7 ran 3,000 of them" is a
  // decision you can act on.
  userId,
  operation = 'chat',
} = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.apiKeyEnv} is not set in .env`);

  const requestModel = model || process.env[cfg.modelEnv] || cfg.fallbackModel;

  // SPAN NAMING follows the GenAI convention: "{operation} {model}". Low cardinality
  // is the rule — never put a user ID, request ID or the prompt in a span NAME. Those
  // are attributes. A span name is a category you group by; if every span has a
  // unique name, aggregation is impossible and most backends will throttle you.
  return tracer.startActiveSpan(
    `${operation} ${requestModel}`,
    { kind: SpanKind.CLIENT }, // CLIENT = we are calling out to someone else
    async (span) => {
      span.setAttributes({
        [GENAI.OPERATION]: operation,
        [GENAI.PROVIDER]: provider,
        [GENAI.REQUEST_MODEL]: requestModel,
        [GENAI.TEMPERATURE]: temperature,
        ...(userId && { 'enduser.id': userId }),
        ...(tools?.length && { 'gen_ai.request.tool_count': tools.length }),
      });

      captureContent(span, 'gen_ai.input.messages', messages);

      const body = { model: requestModel, messages, temperature };
      if (tools?.length) body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
      if (responseFormat) body.response_format = responseFormat;

      const startedAt = Date.now();

      try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) throw new LlmError(res.status, await res.text().catch(() => ''));

        const data = await res.json();
        const message = data.choices?.[0]?.message ?? {};
        const usage = data.usage ?? {};

        const inputTokens = usage.prompt_tokens ?? 0;
        const outputTokens = usage.completion_tokens ?? 0;
        const { usd, estimated } = computeCost(data.model ?? requestModel, inputTokens, outputTokens);

        // Split so we can show what share of spend is OUTPUT tokens — usually the
        // large majority, because output rates are several times input rates.
        const outputUsd = computeCost(data.model ?? requestModel, 0, outputTokens).usd;

        const durationMs = Date.now() - startedAt;

        span.setAttributes({
          [GENAI.RESPONSE_MODEL]: data.model ?? requestModel,
          [GENAI.INPUT_TOKENS]: inputTokens,
          [GENAI.OUTPUT_TOKENS]: outputTokens,
          [GENAI.FINISH_REASONS]: [data.choices?.[0]?.finish_reason ?? 'unknown'],
          'gen_ai.usage.cost_usd': usd,
          'gen_ai.usage.cost_estimated': estimated,
          // Reasoning tokens are billed as output but never appear in the response
          // text. In project 02 we measured 157 of 218 output tokens being reasoning —
          // 72% of what we paid for was invisible. Worth its own attribute.
          ...(usage.completion_tokens_details?.reasoning_tokens != null && {
            'gen_ai.usage.reasoning_tokens': usage.completion_tokens_details.reasoning_tokens,
          }),
          // Tokens per second — the throughput number that tells you whether a slow
          // request was a big answer or a slow provider.
          'gen_ai.response.tokens_per_second': durationMs
            ? Math.round((outputTokens / durationMs) * 1000)
            : 0,
          'gen_ai.response.tool_call_count': message.tool_calls?.length ?? 0,
        });

        captureContent(span, 'gen_ai.output.messages', message);

        recordCall({
          operation,
          userId,
          provider,
          model: data.model ?? requestModel,
          inputTokens,
          outputTokens,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
          usd,
          outputUsd,
          durationMs,
          toolCalls: message.tool_calls?.map((c) => c.function?.name) ?? [],
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return {
          message,
          usage,
          finishReason: data.choices?.[0]?.finish_reason,
          model: data.model,
          cost: { usd, estimated },
          durationMs,
        };
      } catch (err) {
        failSpan(span, err);
        throw err;
      } finally {
        // ALWAYS end the span. A span that is never ended is never exported — the
        // trace shows a gap where your slowest operation should be, which is exactly
        // the operation you were trying to investigate.
        span.end();
      }
    },
  );
}
