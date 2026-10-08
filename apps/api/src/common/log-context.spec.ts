import { Writable } from 'node:stream';
import { pino } from 'pino';
import { logContext, withLogContext } from './log-context.js';

/** A real pino logger with the same mixin the app uses, writing JSON lines to memory. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { logger: pino({ mixin: logContext }, stream), lines };
}

describe('log context', () => {
  it('adds the job fields to every line written inside, across awaits', async () => {
    const { logger, lines } = capture();

    await withLogContext({ queue: 'generate-cv', cvId: 'cv1', attempt: 2 }, async () => {
      logger.info('before');
      await new Promise((r) => setTimeout(r, 5));
      logger.info({ event: 'llm_call' }, 'after');
    });
    logger.info('outside');

    expect(lines.map(({ msg, cvId, attempt }) => ({ msg, cvId, attempt }))).toEqual([
      { msg: 'before', cvId: 'cv1', attempt: 2 },
      { msg: 'after', cvId: 'cv1', attempt: 2 },
      { msg: 'outside', cvId: undefined, attempt: undefined },
    ]);
  });

  it('does not carry one line’s fields over to the next', () => {
    const { logger, lines } = capture();
    withLogContext({ cvId: 'cv1' }, () => {
      logger.error({ event: 'job_error', final: true }, 'failed');
      logger.info({ event: 'job_finished' }, 'finished');
    });
    expect(lines[1]).toMatchObject({ cvId: 'cv1', event: 'job_finished' });
    expect(lines[1]).not.toHaveProperty('final');
  });

  it('nests: inner fields add to the outer ones', () => {
    const { logger, lines } = capture();
    withLogContext({ cvId: 'cv1' }, () => withLogContext({ step: 'compose' }, () => logger.info('x')));
    expect(lines[0]).toMatchObject({ cvId: 'cv1', step: 'compose' });
  });
});
