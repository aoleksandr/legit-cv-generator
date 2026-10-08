/**
 * Opt-in eval of the real generation pipeline against the Anthropic API:
 *   pnpm eval            (needs ANTHROPIC_API_KEY in .env; costs roughly two Sonnet calls per case)
 * Writes a summary to eval/out/report.md and each case's full output next to it (eval/out is gitignored).
 *
 * Hard checks fail the run: the anti-hallucination guarantees on real model output,
 * plus each case's own expectations. Inflated wording is only measured and reported.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { MastraCvLlm } from '../src/ai/cv-llm.js';
import { runGeneration, type GenerationResult } from '../src/ai/generation.workflow.js';
import { extractNumbers, normalize } from '../src/ai/grounding.js';
import { CASES, INFLATION_TERMS, type EvalCase } from './cases.js';

interface Row {
  case: string;
  passed: boolean;
  seconds: number;
  roles: number;
  bullets: number;
  questions: number;
  removedByChecks: number;
  inflation: string;
}

const rows: Row[] = [];
const OUT_DIR = resolve(import.meta.dirname, 'out');
const REPORT_PATH = resolve(OUT_DIR, 'report.md');

/** Every string value in the CV, with the field it came from. */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      k === 'id' || k === 'factIds' ? [] : strings(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

/** Guarantees that must hold for any input, whatever the model writes. */
function checkInvariants(c: EvalCase, { content }: GenerationResult) {
  const source = ` ${normalize(c.source)} `;
  const sourceNumbers = new Set(extractNumbers(c.source));
  const all = strings(content);

  // Phone numbers may be reformatted; they are compared by digits in their own case.
  const unsupported = all
    .filter(([path]) => path !== 'contact.phone')
    .flatMap(([path, text]) =>
      extractNumbers(text)
        .filter((n) => !sourceNumbers.has(n))
        .map((n) => `${path}: ${n}`),
    );
  expect(unsupported, 'numbers not in the source').toEqual([]);

  const names = [
    ...content.experience.map((e) => e.company),
    ...content.education.map((e) => e.institution),
    content.contact.fullName,
    content.contact.email,
  ].filter(Boolean);
  const invented = names.filter((n) =>
    normalize(n)
      .split(' ')
      .some((w) => !source.includes(` ${w} `)),
  );
  expect(invented, 'names not in the source').toEqual([]);

  const text = all
    .map(([, t]) => t)
    .join('\n')
    .toLowerCase();
  for (const banned of c.mustNotContain ?? []) {
    expect(text, `must not contain "${banned}"`).not.toContain(banned.toLowerCase());
  }
}

function inflation(c: EvalCase, { content }: GenerationResult): string[] {
  const source = normalize(c.source);
  const output = normalize(
    strings(content)
      .map(([, t]) => t)
      .join('\n'),
  );
  return INFLATION_TERMS.filter((t) => output.includes(normalize(t)) && !source.includes(normalize(t)));
}

describe.skipIf(!config.anthropicApiKey)(`generation eval (${config.models.main})`, () => {
  // Written to a file (and stdout): Vitest's reporter swallows console output from hooks.
  afterAll(() => {
    const inflated = rows.filter((r) => r.inflation !== '-').length;
    const report = [
      `# Generation eval`,
      '',
      `Model \`${config.models.main}\`, run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      '',
      '| Case | Passed | Roles | Bullets | Questions | Removed by checks | Inflated wording | Seconds |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.case} | ${r.passed ? 'yes' : '**no**'} | ${r.roles} | ${r.bullets} | ${r.questions} | ${r.removedByChecks} | ${r.inflation} | ${r.seconds} |`,
      ),
      '',
      `Inflated wording (terms not in the source) in ${inflated}/${rows.length} CVs. This is what an LLM critic would target.`,
      '',
    ].join('\n');
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, report);
    process.stdout.write(`\n${report}\nReport written to ${REPORT_PATH}\n`);
  });

  const llm = new MastraCvLlm();

  for (const [index, c] of CASES.entries()) {
    it.concurrent(c.name, async () => {
      const started = Date.now();
      const row: Row = {
        case: c.name,
        passed: false,
        seconds: 0,
        roles: 0,
        bullets: 0,
        questions: 0,
        removedByChecks: 0,
        inflation: '',
      };
      rows[index] = row;
      try {
        const result = await runGeneration(llm, { sourceText: c.source, targetRole: c.targetRole });
        Object.assign(row, {
          roles: result.content.experience.length,
          bullets: result.content.experience.reduce((n, e) => n + e.bullets.length, 0),
          questions: result.questions.length,
          removedByChecks: result.removed.length,
          inflation: inflation(c, result).join(', ') || '-',
        });
        // Full output per case, for reading what the model wrote (gitignored).
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(resolve(OUT_DIR, `${index + 1}.json`), JSON.stringify({ case: c.name, ...result }, null, 2));
        checkInvariants(c, result);
        c.expect?.(result);
        row.passed = true;
      } finally {
        row.seconds = Math.round((Date.now() - started) / 1000);
      }
    });
  }
});
