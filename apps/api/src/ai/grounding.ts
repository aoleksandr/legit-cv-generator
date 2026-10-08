import type { CvDocument, ExperienceItem, EducationItem, Fact } from '@cv/shared';

/**
 * Deterministic grounding checks. This is the part of the anti-hallucination
 * design that does not rely on the model behaving: every fact must quote the
 * source verbatim, and every concrete detail in the generated CV (names,
 * numbers, dates, contact details) must trace back to verified facts.
 * Anything that fails is removed and, where useful, turned into a question.
 */

/** Lowercase, unify unicode forms, and reduce punctuation/whitespace to single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Numbers mentioned in a text, with thousands separators removed ("1,200" -> "1200"). */
export function extractNumbers(text: string): string[] {
  const cleaned = text.replace(/(\d)[,\u00a0\u202f ](?=\d{3}\b)/g, '$1');
  return cleaned.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** True when `needle` appears in `haystack` as whole words, ignoring case and punctuation. */
export function containsPhrase(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (!n) return true;
  return ` ${normalize(haystack)} `.includes(` ${n} `);
}

export interface Issue {
  fieldPath: string;
  question: string;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface FactCheckResult {
  verified: Fact[];
  rejected: { fact: Fact; reason: string }[];
}

/**
 * A fact survives only if its quote appears verbatim (modulo case/punctuation)
 * in the source, and its paraphrased text introduces no numbers the quote lacks.
 */
export function verifyFacts(facts: Fact[], sourceText: string): FactCheckResult {
  const source = ` ${normalize(sourceText)} `;
  const result: FactCheckResult = { verified: [], rejected: [] };
  const seen = new Set<string>();

  for (const fact of facts) {
    if (seen.has(fact.id)) {
      result.rejected.push({ fact, reason: 'duplicate id' });
      continue;
    }
    const quote = normalize(fact.sourceQuote);
    if (quote.length < 2 || !source.includes(` ${quote} `)) {
      result.rejected.push({ fact, reason: 'quote not found in source' });
      continue;
    }
    const quoteNumbers = new Set(extractNumbers(fact.sourceQuote));
    const invented = extractNumbers(fact.text).filter((n) => !quoteNumbers.has(n));
    if (invented.length > 0) {
      result.rejected.push({ fact, reason: `numbers not in quote: ${invented.join(', ')}` });
      continue;
    }
    seen.add(fact.id);
    result.verified.push(fact);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generated CV
// ---------------------------------------------------------------------------

class Corpus {
  private readonly text: string;
  private readonly numbers: Set<string>;
  private readonly byId: Map<string, Fact>;

  constructor(facts: Fact[]) {
    this.byId = new Map(facts.map((f) => [f.id, f]));
    const all = facts.map((f) => `${f.text}\n${f.sourceQuote}`).join('\n');
    this.text = ` ${normalize(all)} `;
    this.numbers = new Set(extractNumbers(all));
  }

  has(value: string): boolean {
    const n = normalize(value);
    return !n || this.text.includes(` ${n} `);
  }

  /**
   * Every word of the value appears in the facts (allows reordering, not invention).
   * A word of 4+ characters may also match the same word with a common ending, so
   * "Intern" matches "Internship", "Engineer" "Engineering" and "Design" "Designer".
   * Any other continuation is a different word: "Java" does not match "JavaScript".
   * With `within`, only those facts count (see forEntry).
   */
  hasWords(value: string, within?: Fact[]): boolean {
    const text = within ? factText(within) : this.text;
    return normalize(value)
      .split(' ')
      .filter(Boolean)
      .every((w) => text.includes(` ${w} `) || (w.length >= 4 && new RegExp(` ${w}${WORD_ENDINGS} `, 'u').test(text)));
  }

  /**
   * Name-like words in prose (employers, products, technologies) that the facts don't
   * mention. Prose may be reworded freely, but "for Google" or "on Kubernetes" must come
   * from somewhere. `extra` is additional trusted text, such as the target role.
   */
  unsupportedNames(prose: string, { within, extra = '' }: { within?: Fact[]; extra?: string } = {}): string[] {
    const text = `${within ? factText(within) : this.text} ${normalize(extra)} `;
    const known = (w: string) => text.includes(` ${normalize(w)} `);
    return nameLikeWords(prose).filter((w) => !known(w) && !(/s$/.test(w) && w.length > 2 && known(w.slice(0, -1))));
  }

  hasDigits(value: string): boolean {
    const digits = value.replace(/\D/g, '');
    return !digits || this.text.replace(/\D/g, '').includes(digits) || this.digitsInFacts(digits);
  }

  unsupportedNumbers(text: string, within?: Fact[]): string[] {
    const allowed = within
      ? new Set(within.flatMap((f) => extractNumbers(`${f.text}\n${f.sourceQuote}`)))
      : this.numbers;
    return extractNumbers(text).filter((n) => !allowed.has(n));
  }

  fact(id: string): Fact | undefined {
    return this.byId.get(id);
  }

  /**
   * Facts that may support a CV entry: those about the entry itself, plus those
   * not attributed to any entry (contact, skills, section-level answers). A fact
   * about another job never counts, so details can't migrate between roles.
   */
  forEntry(entryId: string): Fact[] {
    return [...this.byId.values()].filter((f) => belongsTo(f, entryId));
  }

  private digitsInFacts(digits: string): boolean {
    for (const f of this.byId.values()) {
      if (f.sourceQuote.replace(/\D/g, '').includes(digits)) return true;
    }
    return false;
  }
}

const factText = (facts: Fact[]) => ` ${normalize(facts.map((f) => `${f.text}\n${f.sourceQuote}`).join('\n'))} `;

/** Endings that make a variant of the same word, not a different one ("Java" + "Script"). */
const WORD_ENDINGS = '(?:s|es|er|ers|ing|ings|ed|ment|ments|ion|ions|ship|ships)';

const MONTHS = new Set(
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'.split(
    ' ',
  ),
);

/**
 * Words that look like names: capitalised mid-sentence ("at Acme", "on Kubernetes"),
 * or with capitals inside ("TypeScript", "AWS", "iOS") anywhere. A capitalised word
 * that starts a sentence is usually just the action verb ("Built"), so it doesn't count.
 * Month names are left to the date checks.
 */
export function nameLikeWords(prose: string): string[] {
  const out: string[] = [];
  for (const sentence of prose.split(/(?<=[.!?;:])\s+/)) {
    const words = sentence
      .split(/[\s/–—-]+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, ''))
      .filter(Boolean);
    words.forEach((word, i) => {
      if (word.length < 2 || !/\p{L}/u.test(word) || MONTHS.has(word.toLowerCase())) return;
      const innerCapital = /\p{Lu}/u.test(word.slice(1));
      const capitalisedMidSentence = i > 0 && /^\p{Lu}/u.test(word);
      if (innerCapital || capitalisedMidSentence) out.push(word);
    });
  }
  return out;
}

function belongsTo(fact: Fact, entryId: string): boolean {
  return fact.entry === null || fact.entry === entryId;
}

export interface CvCheckResult {
  cv: CvDocument;
  issues: Issue[];
  /** Human-readable log of what was removed, for debugging and tests. */
  removed: string[];
}

/** `targetRole` may be named in the summary ("… seeking Backend Engineer roles") without a fact. */
export function verifyCv(
  input: CvDocument,
  facts: Fact[],
  { targetRole = '' }: { targetRole?: string } = {},
): CvCheckResult {
  const corpus = new Corpus(facts);
  const issues: Issue[] = [];
  const removed: string[] = [];
  const cv: CvDocument = structuredClone(input);

  // Contact details must be copied exactly.
  const contact = cv.contact;
  for (const key of ['fullName', 'email', 'location'] as const) {
    if (contact[key] && !corpus.has(contact[key])) {
      removed.push(`contact.${key}: ${contact[key]}`);
      contact[key] = '';
    }
  }
  if (contact.phone && !corpus.hasDigits(contact.phone)) {
    removed.push(`contact.phone: ${contact.phone}`);
    contact.phone = '';
  }
  contact.links = contact.links.filter((link) => {
    const ok = corpus.has(link);
    if (!ok) removed.push(`contact.links: ${link}`);
    return ok;
  });
  if (!contact.fullName) {
    issues.push({ fieldPath: 'contact', question: 'What is your full name as it should appear on the CV?' });
  }

  // Summary: drop sentences that introduce numbers ("10+ years") or names ("former Google engineer")
  // not found in the facts.
  if (cv.summary) {
    const sentences = cv.summary.match(/[^.!?]+[.!?]*/g) ?? [cv.summary];
    const kept = sentences.filter((s) => {
      const numbers = corpus.unsupportedNumbers(s);
      if (numbers.length) removed.push(`summary sentence (numbers ${numbers.join(', ')}): ${s.trim()}`);
      const names = numbers.length ? [] : corpus.unsupportedNames(s, { extra: targetRole });
      if (names.length) removed.push(`summary sentence (names ${names.join(', ')}): ${s.trim()}`);
      return numbers.length === 0 && names.length === 0;
    });
    cv.summary = kept.join('').trim();
  }

  cv.experience = cv.experience.map((item) => checkExperience(item, corpus, issues, removed));
  cv.education = cv.education.map((item) => checkEducation(item, corpus, issues, removed));

  cv.skills = dedupe(cv.skills).filter((skill) => {
    const ok = corpus.hasWords(skill);
    if (!ok) removed.push(`skill: ${skill}`);
    return ok;
  });

  return { cv, issues: dedupeIssues(issues), removed };
}

function checkExperience(item: ExperienceItem, corpus: Corpus, issues: Issue[], removed: string[]): ExperienceItem {
  const path = `experience:${item.id}`;
  const label = item.company || item.title || 'this role';
  const own = corpus.forEntry(item.id);

  for (const key of ['title', 'company', 'location'] as const) {
    if (item[key] && !corpus.hasWords(item[key], own)) {
      removed.push(`${path}.${key}: ${item[key]}`);
      item[key] = '';
    }
  }
  for (const key of ['startDate', 'endDate'] as const) {
    // Dates may be reformatted ("Mar" -> "March", "now" -> "Present"), but years must come from this entry's facts.
    if (item[key] && corpus.unsupportedNumbers(item[key], own).length > 0) {
      removed.push(`${path}.${key}: ${item[key]}`);
      item[key] = '';
    }
  }

  item.bullets = item.bullets.filter((bullet) => {
    const cited = bullet.factIds.map((id) => corpus.fact(id)).filter((f): f is Fact => !!f && belongsTo(f, item.id));
    if (cited.length === 0) {
      removed.push(`${path} bullet without valid facts of this entry: ${bullet.text}`);
      return false;
    }
    const bad = corpus.unsupportedNumbers(bullet.text, cited);
    if (bad.length) {
      removed.push(`${path} bullet (numbers ${bad.join(', ')}): ${bullet.text}`);
      return false;
    }
    // Names may come from any fact of this entry ("at Acme" when the cited fact is the achievement),
    // never from another role.
    const names = corpus.unsupportedNames(bullet.text, { within: own });
    if (names.length) {
      removed.push(`${path} bullet (names ${names.join(', ')}): ${bullet.text}`);
      return false;
    }
    bullet.factIds = cited.map((f) => f.id);
    return true;
  });

  if (!item.title) issues.push({ fieldPath: path, question: `What was your job title at ${label}?` });
  if (!item.company)
    issues.push({
      fieldPath: path,
      question: `Which company or organisation was the "${item.title || 'this'}" role at?`,
    });
  if (!item.startDate) issues.push({ fieldPath: path, question: `When did you start and finish at ${label}?` });
  return item;
}

function checkEducation(item: EducationItem, corpus: Corpus, issues: Issue[], removed: string[]): EducationItem {
  const path = `education:${item.id}`;
  const own = corpus.forEntry(item.id);
  for (const key of ['institution', 'degree', 'field'] as const) {
    if (item[key] && !corpus.hasWords(item[key], own)) {
      removed.push(`${path}.${key}: ${item[key]}`);
      item[key] = '';
    }
  }
  for (const key of ['startDate', 'endDate'] as const) {
    // Dates may be reformatted ("Mar" -> "March", "now" -> "Present"), but years must come from this entry's facts.
    if (item[key] && corpus.unsupportedNumbers(item[key], own).length > 0) {
      removed.push(`${path}.${key}: ${item[key]}`);
      item[key] = '';
    }
  }
  if (
    item.details &&
    (corpus.unsupportedNumbers(item.details, own).length > 0 ||
      corpus.unsupportedNames(item.details, { within: own }).length > 0)
  ) {
    removed.push(`${path}.details: ${item.details}`);
    item.details = '';
  }
  if (!item.institution) {
    issues.push({ fieldPath: path, question: `Where did you study for "${item.degree || 'this qualification'}"?` });
  }
  return item;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = normalize(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.fieldPath}|${i.question}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
