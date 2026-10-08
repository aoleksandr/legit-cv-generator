import { Document, Font, Link, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { CvDocument, EducationItem, ExperienceItem } from '@cv/shared';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Embedded TTFs (Inter, OFL) instead of the built-in Helvetica, which only covers
// Latin-1: names like "Олександр" or "Zoë Łukasz" must render, and the text stays selectable.
const fontsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
Font.register({
  family: 'Inter',
  fonts: [
    { src: resolve(fontsDir, 'Inter_400Regular.ttf'), fontWeight: 400 },
    { src: resolve(fontsDir, 'Inter_600SemiBold.ttf'), fontWeight: 600 },
  ],
});
// Don't break words with hyphens.
Font.registerHyphenationCallback((word) => [word]);

const ACCENT = '#3730a3';
const MUTED = '#64748b';

const s = StyleSheet.create({
  page: { fontFamily: 'Inter', fontSize: 9.5, lineHeight: 1.4, color: '#0f172a', paddingVertical: 36, paddingHorizontal: 42 },
  name: { fontSize: 20, fontWeight: 600, lineHeight: 1.2, marginBottom: 6 },
  contactRow: { flexDirection: 'row', flexWrap: 'wrap', color: MUTED, fontSize: 9 },
  contactItem: { marginRight: 12 },
  link: { color: ACCENT, textDecoration: 'none' },
  linkLine: { fontSize: 9, color: MUTED, marginTop: 1 },
  section: { marginTop: 14 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 600,
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    borderBottomWidth: 0.75,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 2,
    marginBottom: 6,
  },
  entry: { marginBottom: 8 },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  entryTitle: { fontWeight: 600, flexShrink: 1, paddingRight: 8 },
  entryDates: { color: MUTED, fontSize: 9 },
  entrySub: { color: MUTED, fontSize: 9, marginBottom: 2 },
  bullet: { flexDirection: 'row', marginTop: 1.5 },
  bulletDot: { width: 10 },
  bulletText: { flex: 1 },
  skills: { flexDirection: 'row', flexWrap: 'wrap' },
});

const dates = (start: string, end: string) =>
  start && start === end ? start : [start, end].filter(Boolean).join(' – ');
const join = (...parts: string[]) => parts.filter(Boolean).join(', ');

/** Only real web/mail links become clickable; anything else (e.g. "javascript:") stays plain text. */
function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (/^mailto:/i.test(value)) return value;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function CvPdf({ cv, title }: { cv: CvDocument; title: string }) {
  const { contact } = cv;
  const contactItems = [contact.email, contact.phone, contact.location].filter(Boolean);
  return (
    <Document title={title} author={contact.fullName || undefined} creator="AI CV Builder" producer="AI CV Builder">
      <Page size="A4" style={s.page}>
        <View>
          {contact.fullName && <Text style={s.name}>{contact.fullName}</Text>}
          {contactItems.length > 0 && (
            <View style={s.contactRow}>
              {contactItems.map((item) => (
                <Text key={item} style={s.contactItem}>
                  {item}
                </Text>
              ))}
            </View>
          )}
          {/* One link per line: URLs are long and unreadable when squeezed into the contact row. */}
          {contact.links.map((link) => {
            const href = safeHref(link);
            return href ? (
              <Link key={link} src={href} style={[s.linkLine, s.link]}>
                {link}
              </Link>
            ) : (
              <Text key={link} style={s.linkLine}>
                {link}
              </Text>
            );
          })}
        </View>

        {cv.summary && (
          <Section title="Summary" keepTogether>
            <Text>{cv.summary}</Text>
          </Section>
        )}

        {cv.experience.length > 0 && (
          <Section title="Experience">
            {cv.experience.map((e) => (
              <Experience key={e.id} item={e} />
            ))}
          </Section>
        )}

        {cv.education.length > 0 && (
          <Section title="Education" keepTogether={cv.education.length <= 4}>
            {cv.education.map((e) => (
              <Education key={e.id} item={e} />
            ))}
          </Section>
        )}

        {cv.skills.length > 0 && (
          <Section title="Skills" keepTogether>
            <Text>{cv.skills.join('  ·  ')}</Text>
          </Section>
        )}
      </Page>
    </Document>
  );
}

/**
 * Short sections never split across pages; long ones (experience) may, but
 * their heading is never left alone at the bottom of a page.
 */
function Section({ title, keepTogether = false, children }: { title: string; keepTogether?: boolean; children: React.ReactNode }) {
  return (
    <View style={s.section} wrap={!keepTogether}>
      <Text style={s.sectionTitle} minPresenceAhead={80}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Experience({ item }: { item: ExperienceItem }) {
  const heading = [item.title, item.company].filter(Boolean).join(' · ');
  return (
    <View style={s.entry} wrap={item.bullets.length > 6}>
      <View style={s.entryHeader} minPresenceAhead={30}>
        <Text style={s.entryTitle}>{heading}</Text>
        <Text style={s.entryDates}>{dates(item.startDate, item.endDate)}</Text>
      </View>
      {item.location && <Text style={s.entrySub}>{item.location}</Text>}
      {item.bullets.map((b) => (
        <View key={b.id} style={s.bullet} wrap={false}>
          <Text style={s.bulletDot}>•</Text>
          <Text style={s.bulletText}>{b.text}</Text>
        </View>
      ))}
    </View>
  );
}

function Education({ item }: { item: EducationItem }) {
  const heading = join(item.degree, item.field) || item.institution;
  return (
    <View style={s.entry} wrap={false}>
      <View style={s.entryHeader}>
        <Text style={s.entryTitle}>{heading}</Text>
        <Text style={s.entryDates}>{dates(item.startDate, item.endDate)}</Text>
      </View>
      {heading !== item.institution && item.institution && <Text style={s.entrySub}>{item.institution}</Text>}
      {item.details && <Text>{item.details}</Text>}
    </View>
  );
}
