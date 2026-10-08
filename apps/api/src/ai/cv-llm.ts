import { Logger } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { StreamErrorRetryProcessor } from '@mastra/core/processors';
import type { Fact } from '@cv/shared';
import type { z } from 'zod';
import { config } from '../config.js';
import { APPLY_ANSWER_INSTRUCTIONS, COMPOSER_INSTRUCTIONS, EXTRACTOR_INSTRUCTIONS } from './prompts.js';
import {
  CompositionOutputSchema,
  ExtractionOutputSchema,
  sectionOutputSchemas,
  type CompositionOutput,
  type ExtractionOutput,
  type SectionKind,
} from './llm-schemas.js';

export type SectionValue<K extends SectionKind> = z.infer<(typeof sectionOutputSchemas)[K]>['value'];

export interface ApplyAnswerInput<K extends SectionKind> {
  kind: K;
  current: SectionValue<K>;
  facts: Fact[];
  question: string;
  answer: string;
  answerFactId: string;
  targetRole: string;
}

/**
 * The boundary between the app and the model. Everything behind it is
 * untrusted; tests replace it with a fake. `signal` aborts the call (the job
 * expired or the worker is shutting down).
 */
export interface CvLlm {
  extractFacts(input: { sourceText: string; targetRole: string }, signal?: AbortSignal): Promise<ExtractionOutput>;
  composeCv(input: { facts: Fact[]; targetRole: string }, signal?: AbortSignal): Promise<CompositionOutput>;
  applyAnswer<K extends SectionKind>(input: ApplyAnswerInput<K>, signal?: AbortSignal): Promise<SectionValue<K>>;
}

export const CV_LLM = Symbol('CV_LLM');

/** agent.generate() runs per LLM call: the first try plus one repair attempt. Each is capped by config.llmTimeoutMs. */
export const MAX_ATTEMPTS_PER_CALL = 2;

/** A failure the user can be told about. `retryable` drives job retries. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Keep candidate text from closing our data tags early. */
export function asData(tag: string, text: string): string {
  const cleaned = text.replace(/<\/?\s*(source|facts|current|answer)\s*>/gi, ' ');
  return `<${tag}>\n${cleaned}\n</${tag}>`;
}

export class MastraCvLlm implements CvLlm {
  private readonly logger = new Logger(MastraCvLlm.name);
  private readonly extractor: Agent;
  private readonly composer: Agent;
  private readonly answerer: Agent;

  constructor() {
    const main = `anthropic/${config.models.main}`;
    // Mastra's default error processors include a stream retry (2 more tries, 3 s apart) that
    // multiplies with modelSettings.maxRetries: 3 meant 12 requests to an overloaded API.
    // Replacing it by id keeps the other stability defaults; maxRetries stays the single knob.
    const errorProcessors = () => [new StreamErrorRetryProcessor({ maxRetries: 0 })];
    this.extractor = new Agent({
      id: 'fact-extractor',
      name: 'Fact extractor',
      instructions: EXTRACTOR_INSTRUCTIONS,
      model: main,
      errorProcessors: errorProcessors(),
    });
    this.composer = new Agent({
      id: 'cv-composer',
      name: 'CV composer',
      instructions: COMPOSER_INSTRUCTIONS,
      model: main,
      errorProcessors: errorProcessors(),
    });
    this.answerer = new Agent({
      id: 'answer-applier',
      name: 'Answer applier',
      instructions: APPLY_ANSWER_INSTRUCTIONS,
      model: main,
      errorProcessors: errorProcessors(),
    });
  }

  extractFacts({ sourceText, targetRole }: { sourceText: string; targetRole: string }, signal?: AbortSignal) {
    const prompt = [
      `Target role: ${JSON.stringify(targetRole)}`,
      asData('source', sourceText),
      'Extract the facts and gaps.',
    ].join('\n\n');
    return this.generate(this.extractor, prompt, ExtractionOutputSchema, signal);
  }

  composeCv({ facts, targetRole }: { facts: Fact[]; targetRole: string }, signal?: AbortSignal) {
    const prompt = [
      `Target role: ${JSON.stringify(targetRole)}`,
      asData(
        'facts',
        JSON.stringify(
          facts.map(({ id, category, entry, text }) => ({ id, category, entry, text })),
          null,
          1,
        ),
      ),
      'Write the CV.',
    ].join('\n\n');
    return this.generate(this.composer, prompt, CompositionOutputSchema, signal);
  }

  async applyAnswer<K extends SectionKind>(input: ApplyAnswerInput<K>, signal?: AbortSignal): Promise<SectionValue<K>> {
    const prompt = [
      `Target role: ${JSON.stringify(input.targetRole)}`,
      `Part of the CV to update: ${input.kind}`,
      asData('current', JSON.stringify(input.current, null, 1)),
      asData(
        'facts',
        JSON.stringify(
          input.facts.map(({ id, category, entry, text }) => ({ id, category, entry, text })),
          null,
          1,
        ),
      ),
      `Question asked: ${JSON.stringify(input.question)}`,
      `The answer below is stored as fact id "${input.answerFactId}".`,
      asData('answer', input.answer),
      'Return the updated value.',
    ].join('\n\n');
    const schema = sectionOutputSchemas[input.kind] as z.ZodType<{ value: SectionValue<K> }>;
    const out = await this.generate(this.answerer, prompt, schema, signal);
    return out.value;
  }

  /**
   * One generation with structured output. A malformed response gets one
   * repair attempt (the model sees the validation error); transport errors are
   * retried by the provider client (maxRetries) and then surfaced as retryable.
   */
  private async generate<T>(agent: Agent, prompt: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    if (!config.anthropicApiKey) {
      throw new LlmError('The AI service is not configured (ANTHROPIC_API_KEY is missing).', false);
    }
    let lastError: unknown;
    let messages = prompt;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CALL; attempt++) {
      throwIfAborted(signal);
      try {
        const res = await agent.generate(messages, {
          abortSignal: signal,
          structuredOutput: { schema },
          modelSettings: {
            maxOutputTokens: 16_000,
            maxRetries: 3,
            timeout: { totalMs: config.llmTimeoutMs },
          },
        });
        // An aborted run resolves (finishReason "aborted", no object) rather than throwing.
        throwIfAborted(signal);
        const parsed = schema.safeParse(res.object);
        if (parsed.success) return parsed.data;
        lastError = parsed.error;
        this.logger.warn(
          `${agent.id}: invalid structured output (attempt ${attempt}): ${parsed.error.message.slice(0, 500)}`,
        );
        messages = `${prompt}\n\nYour previous response did not match the required schema: ${parsed.error.message.slice(0, 1000)}\nReturn a valid response.`;
      } catch (err) {
        throwIfAborted(signal);
        if (isSchemaFailure(err) && attempt === 1) {
          lastError = err;
          this.logger.warn(`${agent.id}: structured output failed validation, retrying once`);
          continue;
        }
        throw toLlmError(err);
      }
    }
    throw new LlmError('The AI returned an invalid response. Please try again.', true, { cause: lastError });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LlmError('The AI request was cancelled.', true, { cause: signal.reason });
}

function isSchemaFailure(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /structured output|schema|validation|parse|json/i.test(msg);
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return new LlmError('The AI service rejected our credentials.', false, { cause: err });
  }
  if (status === 400) {
    return new LlmError('The AI service rejected the request.', false, { cause: err });
  }
  const name = err instanceof Error ? err.name : '';
  if (/timeout|abort/i.test(name)) {
    return new LlmError('The AI took too long to respond.', true, { cause: err });
  }
  return new LlmError('The AI service is temporarily unavailable.', true, { cause: err });
}
