import { MAX_ATTEMPTS_PER_CALL } from '../ai/cv-llm.js';
import { jobExpireSeconds } from './queue.service.js';

describe('jobExpireSeconds', () => {
  it('is 15 minutes at the default 180 s LLM timeout', () => {
    expect(jobExpireSeconds(180_000)).toBe(15 * 60);
  });

  it.each([30_000, 180_000, 300_000, 600_000])('outlives the worst-case run for a %i ms LLM timeout', (timeoutMs) => {
    // Extract + compose, each with a repair attempt, each capped by the timeout.
    const worstCaseMs = 2 * MAX_ATTEMPTS_PER_CALL * timeoutMs;
    expect(jobExpireSeconds(timeoutMs) * 1000).toBeGreaterThan(worstCaseMs);
  });
});
