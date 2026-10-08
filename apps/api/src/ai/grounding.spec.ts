import type { Fact } from '@cv/shared';
import { composition, FACTS, SOURCE_TEXT } from '../testing/fixtures.js';
import { toCvDocument } from './generation.workflow.js';
import { containsPhrase, extractNumbers, normalize, verifyCv, verifyFacts } from './grounding.js';

const sourceFact = (id: string, text: string, sourceQuote = text): Fact => ({
  id,
  category: 'experience',
  entry: 'exp_1',
  text,
  sourceQuote,
  origin: 'source',
});

describe('text helpers', () => {
  it('normalizes case, punctuation, whitespace and unicode forms', () => {
    expect(normalize('  Led a\nTEAM — of 4,\tengineers! ')).toBe('led a team of 4 engineers');
    expect(normalize('ﬁnance​')).toBe('finance');
  });

  it('extracts numbers with thousands separators collapsed', () => {
    expect(extractNumbers('1,200 rps, 99.9% uptime, 4 engineers')).toEqual(['1200', '99.9', '4']);
  });

  it('matches phrases on word boundaries only', () => {
    expect(containsPhrase('Worked at Acme Corp.', 'acme corp')).toBe(true);
    expect(containsPhrase('Worked at Acme Corporation', 'Acme Corp')).toBe(false);
  });
});

describe('verifyFacts (quote grounding)', () => {
  it('accepts quotes that differ from the source only in case, whitespace and punctuation', () => {
    const fact = sourceFact('f1', 'Led a team of 4 engineers', 'led a TEAM of 4   engineers.');
    expect(verifyFacts([fact], SOURCE_TEXT).verified).toEqual([fact]);
  });

  it('rejects facts whose quote is not in the source', () => {
    const fact = sourceFact('f1', 'Led a team of 12 engineers', 'Led a team of 12 engineers');
    const { verified, rejected } = verifyFacts([fact], SOURCE_TEXT);
    expect(verified).toEqual([]);
    expect(rejected[0].reason).toBe('quote not found in source');
  });

  it('rejects a quote that only matches part of a word', () => {
    // "Acme Cor" is a substring of the source but not a whole-word match.
    expect(verifyFacts([sourceFact('f1', 'Acme', 'Acme Cor')], SOURCE_TEXT).verified).toEqual([]);
  });

  it('rejects a paraphrase that adds numbers the quote does not contain', () => {
    const fact = sourceFact('f1', 'Led a team of 40 engineers', 'Led a team of 4 engineers');
    const { rejected } = verifyFacts([fact], SOURCE_TEXT);
    expect(rejected[0].reason).toMatch(/numbers not in quote: 40/);
  });

  it('rejects duplicate ids and trivially short quotes', () => {
    const { verified, rejected } = verifyFacts(
      [
        sourceFact('f1', 'Led a team of 4 engineers'),
        sourceFact('f1', 'Maintained internal tools'),
        sourceFact('f2', 'J', 'J'),
      ],
      SOURCE_TEXT,
    );
    expect(verified.map((f) => f.id)).toEqual(['f1']);
    expect(rejected.map((r) => r.reason)).toEqual(['duplicate id', 'quote not found in source']);
  });

  it('accepts all fixture facts', () => {
    expect(verifyFacts(FACTS, SOURCE_TEXT).rejected).toEqual([]);
  });
});

describe('verifyCv (output grounding)', () => {
  const draft = () => composition();
  const check = (mutate: (d: ReturnType<typeof composition>) => void) => {
    const d = draft();
    mutate(d);
    return verifyCv(toCvDocument(d), FACTS);
  };

  it('keeps a fully grounded CV unchanged', () => {
    const doc = toCvDocument(draft());
    const { cv, removed, issues } = verifyCv(doc, FACTS);
    expect(removed).toEqual([]);
    expect(issues).toEqual([]);
    expect(cv).toEqual(doc);
  });

  it('allows rephrasing and reformatting that adds no new facts', () => {
    const { removed } = check((d) => {
      d.experience[0].startDate = 'January 2020';
      d.experience[1].title = 'Developer (Junior)';
      d.contact.phone = '+447700900123';
      d.skills.push('typescript'); // duplicate, case-insensitively
    });
    expect(removed).toEqual([]);
  });

  it('removes bullets that cite no facts or unknown fact ids', () => {
    const { cv, removed } = check((d) => {
      d.experience[0].bullets.push({ text: 'Mentored junior engineers', factIds: [] });
      d.experience[0].bullets.push({ text: 'Designed the platform', factIds: ['f999'] });
    });
    expect(cv.experience[0].bullets.map((b) => b.text)).toEqual([
      'Built a Node.js payments API serving 1,200 requests per second',
      'Led a team of 4 engineers',
    ]);
    expect(removed).toHaveLength(2);
  });

  it('drops unknown ids from a bullet that also cites a real fact', () => {
    const { cv } = check((d) => {
      d.experience[0].bullets[1].factIds = ['f7', 'f999'];
    });
    expect(cv.experience[0].bullets[1].factIds).toEqual(['f7']);
  });

  it('removes bullets with numbers that are not in the facts they cite', () => {
    const { cv, removed } = check((d) => {
      d.experience[0].bullets[0].text = 'Built a payments API serving 5,000 requests per second';
      // 1,200 exists in the ledger, but not in the cited fact f7.
      d.experience[0].bullets[1].text = 'Led a team of 4 engineers handling 1,200 requests per second';
    });
    expect(cv.experience[0].bullets).toEqual([]);
    expect(removed.join('\n')).toMatch(/numbers 5000/);
  });

  it('clears invented company names and asks about them', () => {
    const { cv, issues } = check((d) => {
      d.experience[0].company = 'Initech';
    });
    expect(cv.experience[0].company).toBe('');
    expect(issues).toContainEqual({
      fieldPath: 'experience:exp_1',
      question: 'Which company or organisation was the "Backend Engineer" role at?',
    });
  });

  it('clears invented contact details, and asks for a missing name', () => {
    const { cv, issues } = check((d) => {
      d.contact.fullName = 'Janet Doe';
      d.contact.email = 'jane@acme.com';
      d.contact.phone = '+1 555 0100';
      d.contact.links = ['https://github.com/janedoe'];
    });
    expect(cv.contact).toMatchObject({ fullName: '', email: '', phone: '', links: [] });
    expect(issues).toContainEqual({ fieldPath: 'contact', question: expect.stringMatching(/full name/) });
  });

  it('drops only the summary sentences that contain unsupported numbers', () => {
    const { cv } = check((d) => {
      d.summary = 'Backend engineer with 10+ years of experience. Led a team of 4 engineers.';
    });
    expect(cv.summary).toBe('Led a team of 4 engineers.');
  });

  it('clears dates with years that are not in the facts', () => {
    const { cv, issues } = check((d) => {
      d.experience[1].startDate = '2016';
      d.education[0].endDate = '2021';
    });
    expect(cv.experience[1].startDate).toBe('');
    expect(cv.education[0].endDate).toBe('');
    expect(issues.map((i) => i.fieldPath)).toContain('experience:exp_2');
  });

  describe('per-entry scoping', () => {
    it('clears a real year moved onto a different role', () => {
      const { cv, removed } = check((d) => {
        d.experience[0].startDate = 'Jan 2018'; // 2018 belongs to Globex (exp_2) and the degree, not Acme
        d.experience[1].endDate = '2020'; // 2020 belongs to Acme (exp_1)
        d.education[0].startDate = '2019'; // 2019 belongs to Globex
      });
      expect(cv.experience[0].startDate).toBe('');
      expect(cv.experience[1].endDate).toBe('');
      expect(cv.education[0].startDate).toBe('');
      expect(removed).toHaveLength(3);
    });

    it('drops a bullet that cites another role’s facts', () => {
      const { cv, removed } = check((d) => {
        d.experience[0].bullets.push({ text: 'Maintained internal tools', factIds: ['f9'] });
      });
      expect(cv.experience[0].bullets.map((b) => b.text)).not.toContain('Maintained internal tools');
      expect(removed).toEqual([expect.stringMatching(/^experience:exp_1 bullet without valid facts of this entry/)]);
    });

    it('keeps only the citations that belong to the entry', () => {
      const { cv } = check((d) => {
        d.experience[0].bullets[1].factIds = ['f7', 'f9'];
      });
      expect(cv.experience[0].bullets[1].factIds).toEqual(['f7']);
    });

    it('rejects numbers in education details that come from another entry', () => {
      const { cv } = check((d) => {
        d.education[0].details = 'Graduated 2019';
      });
      expect(cv.education[0].details).toBe('');
    });

    it('clears a real company or title moved onto a different role, and asks about it', () => {
      const { cv, issues } = check((d) => {
        d.experience[0].company = 'Globex'; // Globex is exp_2's employer
        d.experience[1].title = 'Backend Engineer'; // exp_1's title
      });
      expect(cv.experience[0].company).toBe('');
      expect(cv.experience[1].title).toBe('');
      expect(issues.map((i) => i.fieldPath)).toEqual(expect.arrayContaining(['experience:exp_1', 'experience:exp_2']));
    });

    it('clears an education name taken from another entry', () => {
      const { cv } = check((d) => {
        d.education[0].institution = 'Acme Corp';
        d.education[0].field = 'Payments';
      });
      expect(cv.education[0]).toMatchObject({ institution: '', field: '' });
    });

    it('allows a location from the contact facts on any role', () => {
      const { cv, removed } = check((d) => {
        d.experience[0].location = 'London';
      });
      expect(removed).toEqual([]);
      expect(cv.experience[0].location).toBe('London');
    });

    it('lets facts without an entry support any entry', () => {
      // e.g. a section-level answer ("experience"), stored with entry: null.
      const answer: Fact = {
        id: 'answer_1',
        category: 'experience',
        entry: null,
        text: 'I joined Globex in 2017',
        sourceQuote: 'I joined Globex in 2017',
        origin: 'user_answer',
      };
      const d = composition();
      d.experience[1].startDate = '2017';
      d.experience[1].bullets.push({ text: 'Joined Globex in 2017', factIds: ['answer_1'] });
      const { cv, removed } = verifyCv(toCvDocument(d), [...FACTS, answer]);
      expect(removed).toEqual([]);
      expect(cv.experience[1].startDate).toBe('2017');
    });

    it('clears dates of an entry that has no facts of its own', () => {
      const d = composition();
      d.experience.push({ ...d.experience[1], id: 'exp_9', bullets: [] });
      const { cv } = verifyCv(toCvDocument(d), FACTS);
      expect(cv.experience[2]).toMatchObject({ startDate: '', endDate: '' });
    });
  });

  it('removes skills that are not in the facts', () => {
    const { cv } = check((d) => {
      d.skills.push('Rust', 'Kubernetes operators');
    });
    expect(cv.skills).toEqual(['TypeScript', 'PostgreSQL', 'Kubernetes']);
  });

  it('does not mutate its input', () => {
    const doc = toCvDocument(draft());
    doc.experience[0].company = 'Initech';
    const before = structuredClone(doc);
    verifyCv(doc, FACTS);
    expect(doc).toEqual(before);
  });
});
