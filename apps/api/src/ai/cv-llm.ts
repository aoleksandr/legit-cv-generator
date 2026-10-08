import { Logger } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
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
 * untrusted; tests replace it with a fake.
 */
export interface CvLlm {
  extractFacts(input: { sourceText: string; targetRole: string }): Promise<ExtractionOutput>;
  composeCv(input: { facts: Fact[]; targetRole: string }): Promise<CompositionOutput>;
  applyAnswer<K extends SectionKind>(input: ApplyAnswerInput<K>): Promise<SectionValue<K>>;
}

export const CV_LLM = Symbol('CV_LLM');

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
    this.extractor = new Agent({
      id: 'fact-extractor',
      name: 'Fact extractor',
      instructions: EXTRACTOR_INSTRUCTIONS,
      model: main,
    });
    this.composer = new Agent({
      id: 'cv-composer',
      name: 'CV composer',
      instructions: COMPOSER_INSTRUCTIONS,
      model: main,
    });
    this.answerer = new Agent({
      id: 'answer-applier',
      name: 'Answer applier',
      instructions: APPLY_ANSWER_INSTRUCTIONS,
      model: main,
    });
  }

  extractFacts({ sourceText, targetRole }: { sourceText: string; targetRole: string }) {
    const prompt = [
      `Target role: ${JSON.stringify(targetRole)}`,
      asData('source', sourceText),
      'Extract the facts and gaps.',
    ].join('\n\n');
    return this.generate(this.extractor, prompt, ExtractionOutputSchema);
  }

  composeCv({ facts, targetRole }: { facts: Fact[]; targetRole: string }) {
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
    return this.generate(this.composer, prompt, CompositionOutputSchema);
  }

  async applyAnswer<K extends SectionKind>(input: ApplyAnswerInput<K>): Promise<SectionValue<K>> {
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
    const out = await this.generate(this.answerer, prompt, schema);
    return out.value;
  }

  /**
   * One generation with structured output. A malformed response gets one
   * repair attempt (the model sees the validation error); transport errors are
   * retried by the provider client (maxRetries) and then surfaced as retryable.
   */
  private async generate<T>(agent: Agent, prompt: string, schema: z.ZodType<T>): Promise<T> {
    if (!config.anthropicApiKey) {
      throw new LlmError('The AI service is not configured (ANTHROPIC_API_KEY is missing).', false);
    }
    let lastError: unknown;
    let messages = prompt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await agent.generate(messages, {
          structuredOutput: { schema },
          modelSettings: {
            maxOutputTokens: 16_000,
            maxRetries: 3,
            timeout: { totalMs: config.llmTimeoutMs },
          },
        });
        const parsed = schema.safeParse(res.object);
        if (parsed.success) return parsed.data;
        lastError = parsed.error;
        this.logger.warn(
          `${agent.id}: invalid structured output (attempt ${attempt}): ${parsed.error.message.slice(0, 500)}`,
        );
        messages = `${prompt}\n\nYour previous response did not match the required schema: ${parsed.error.message.slice(0, 1000)}\nReturn a valid response.`;
      } catch (err) {
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
