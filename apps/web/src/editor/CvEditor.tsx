import type { CvDocument, EducationItem, ExperienceItem } from '@cv/shared';
import { useState, type ReactNode } from 'react';

type Update = (fn: (d: CvDocument) => void) => void;

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function move<T>(list: T[], from: number, to: number) {
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

export function CvEditor({ draft, update }: { draft: CvDocument; update: Update }) {
  return (
    <div className="space-y-4">
      <ContactSection draft={draft} update={update} />
      <Section title="Summary" id="section-summary">
        <AutoTextarea
          value={draft.summary}
          maxLength={2000}
          placeholder="A short summary targeting the role"
          onChange={(v) => update((d) => void (d.summary = v))}
        />
      </Section>
      <ExperienceSection draft={draft} update={update} />
      <EducationSection draft={draft} update={update} />
      <SkillsSection draft={draft} update={update} />
    </div>
  );
}

function Section({
  title,
  id,
  actions,
  children,
}: {
  title: string;
  id: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-20 p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  maxLength = 200,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <input
      className="input"
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function AutoTextarea({
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <textarea
      className="input field-sizing-content min-h-16 resize-y"
      rows={rows}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn-ghost h-8 w-8 p-0"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

function ContactSection({ draft, update }: { draft: CvDocument; update: Update }) {
  const c = draft.contact;
  return (
    <Section title="Contact" id="section-contact">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <TextInput value={c.fullName} onChange={(v) => update((d) => void (d.contact.fullName = v))} />
        </Field>
        <Field label="Email">
          <TextInput value={c.email} onChange={(v) => update((d) => void (d.contact.email = v))} />
        </Field>
        <Field label="Phone">
          <TextInput value={c.phone} onChange={(v) => update((d) => void (d.contact.phone = v))} />
        </Field>
        <Field label="Location">
          <TextInput value={c.location} onChange={(v) => update((d) => void (d.contact.location = v))} />
        </Field>
        <Field label="Links (one per line)" className="sm:col-span-2">
          <AutoTextarea
            rows={2}
            value={c.links.join('\n')}
            placeholder="https://linkedin.com/in/…"
            onChange={(v) =>
              update((d) => {
                d.contact.links = v.split('\n').slice(0, 10);
              })
            }
          />
        </Field>
      </div>
    </Section>
  );
}

function ExperienceSection({ draft, update }: { draft: CvDocument; update: Update }) {
  const add = () =>
    update((d) => {
      d.experience.push({
        id: newId('exp'),
        title: '',
        company: '',
        location: '',
        startDate: '',
        endDate: '',
        bullets: [],
      });
    });
  return (
    <Section
      title="Experience"
      id="section-experience"
      actions={
        <button
          type="button"
          className="btn-secondary px-3 py-1"
          onClick={add}
          disabled={draft.experience.length >= 50}
        >
          Add role
        </button>
      }
    >
      {draft.experience.length === 0 && <p className="text-sm text-slate-500">No experience yet.</p>}
      <div className="space-y-4">
        {draft.experience.map((item, i) => (
          <ExperienceEntry key={item.id} item={item} index={i} count={draft.experience.length} update={update} />
        ))}
      </div>
    </Section>
  );
}

function ExperienceEntry({
  item,
  index,
  count,
  update,
}: {
  item: ExperienceItem;
  index: number;
  count: number;
  update: Update;
}) {
  const [open, setOpen] = useState(true);
  const set = (fn: (e: ExperienceItem) => void) => update((d) => fn(d.experience[index]));
  const heading = [item.title, item.company].filter(Boolean).join(' · ') || 'New role';

  return (
    <div id={`entry-${item.id}`} className="scroll-mt-20 rounded-lg border border-slate-200">
      <div className="flex items-center gap-1 border-b border-slate-100 px-3 py-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="mr-1 inline-block w-3 text-slate-400">{open ? '▾' : '▸'}</span>
          {heading}
        </button>
        <IconButton
          label="Move up"
          onClick={() => update((d) => move(d.experience, index, index - 1))}
          disabled={index === 0}
        >
          ↑
        </IconButton>
        <IconButton
          label="Move down"
          onClick={() => update((d) => move(d.experience, index, index + 1))}
          disabled={index === count - 1}
        >
          ↓
        </IconButton>
        <IconButton
          label="Remove role"
          onClick={() => confirm(`Remove "${heading}"?`) && update((d) => void d.experience.splice(index, 1))}
        >
          ✕
        </IconButton>
      </div>
      {open && (
        <div className="space-y-4 p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Job title">
              <TextInput value={item.title} onChange={(v) => set((e) => void (e.title = v))} />
            </Field>
            <Field label="Company">
              <TextInput value={item.company} onChange={(v) => set((e) => void (e.company = v))} />
            </Field>
            <Field label="Location">
              <TextInput value={item.location} onChange={(v) => set((e) => void (e.location = v))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start">
                <TextInput
                  value={item.startDate}
                  placeholder="2021"
                  onChange={(v) => set((e) => void (e.startDate = v))}
                />
              </Field>
              <Field label="End">
                <TextInput
                  value={item.endDate}
                  placeholder="Present"
                  onChange={(v) => set((e) => void (e.endDate = v))}
                />
              </Field>
            </div>
          </div>
          <div>
            <span className="label">Bullet points</span>
            <ul className="space-y-2">
              {item.bullets.map((b, j) => (
                <li key={b.id} className="flex items-start gap-1">
                  <span className="mt-2 text-slate-400">•</span>
                  <div className="flex-1">
                    <AutoTextarea
                      rows={1}
                      maxLength={500}
                      value={b.text}
                      onChange={(v) => set((e) => void (e.bullets[j].text = v))}
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row">
                    <IconButton
                      label="Move bullet up"
                      onClick={() => set((e) => move(e.bullets, j, j - 1))}
                      disabled={j === 0}
                    >
                      ↑
                    </IconButton>
                    <IconButton label="Remove bullet" onClick={() => set((e) => void e.bullets.splice(j, 1))}>
                      ✕
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn-ghost mt-2 text-indigo-600"
              disabled={item.bullets.length >= 30}
              onClick={() => set((e) => void e.bullets.push({ id: newId('b'), text: '', factIds: [] }))}
            >
              + Add bullet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EducationSection({ draft, update }: { draft: CvDocument; update: Update }) {
  const add = () =>
    update((d) => {
      d.education.push({
        id: newId('edu'),
        institution: '',
        degree: '',
        field: '',
        startDate: '',
        endDate: '',
        details: '',
      });
    });
  return (
    <Section
      title="Education"
      id="section-education"
      actions={
        <button type="button" className="btn-secondary px-3 py-1" onClick={add} disabled={draft.education.length >= 20}>
          Add
        </button>
      }
    >
      {draft.education.length === 0 && <p className="text-sm text-slate-500">No education yet.</p>}
      <div className="space-y-4">
        {draft.education.map((item, i) => (
          <EducationEntry key={item.id} item={item} index={i} count={draft.education.length} update={update} />
        ))}
      </div>
    </Section>
  );
}

function EducationEntry({
  item,
  index,
  count,
  update,
}: {
  item: EducationItem;
  index: number;
  count: number;
  update: Update;
}) {
  const set = (fn: (e: EducationItem) => void) => update((d) => fn(d.education[index]));
  const heading = [item.degree, item.institution].filter(Boolean).join(' · ') || 'New entry';
  return (
    <div id={`entry-${item.id}`} className="scroll-mt-20 rounded-lg border border-slate-200">
      <div className="flex items-center gap-1 border-b border-slate-100 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{heading}</span>
        <IconButton
          label="Move up"
          onClick={() => update((d) => move(d.education, index, index - 1))}
          disabled={index === 0}
        >
          ↑
        </IconButton>
        <IconButton
          label="Move down"
          onClick={() => update((d) => move(d.education, index, index + 1))}
          disabled={index === count - 1}
        >
          ↓
        </IconButton>
        <IconButton
          label="Remove"
          onClick={() => confirm(`Remove "${heading}"?`) && update((d) => void d.education.splice(index, 1))}
        >
          ✕
        </IconButton>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4">
        <Field label="Institution">
          <TextInput value={item.institution} onChange={(v) => set((e) => void (e.institution = v))} />
        </Field>
        <Field label="Degree">
          <TextInput value={item.degree} onChange={(v) => set((e) => void (e.degree = v))} />
        </Field>
        <Field label="Field of study">
          <TextInput value={item.field} onChange={(v) => set((e) => void (e.field = v))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <TextInput value={item.startDate} onChange={(v) => set((e) => void (e.startDate = v))} />
          </Field>
          <Field label="End">
            <TextInput value={item.endDate} onChange={(v) => set((e) => void (e.endDate = v))} />
          </Field>
        </div>
        <Field label="Details" className="sm:col-span-2">
          <AutoTextarea
            rows={2}
            maxLength={1000}
            value={item.details}
            onChange={(v) => set((e) => void (e.details = v))}
          />
        </Field>
      </div>
    </div>
  );
}

function SkillsSection({ draft, update }: { draft: CvDocument; update: Update }) {
  const [input, setInput] = useState('');
  const add = () => {
    const skills = input
      .split(',')
      .map((s) => s.trim().slice(0, 100))
      .filter(Boolean);
    if (skills.length === 0) return;
    update((d) => {
      const existing = new Set(d.skills.map((s) => s.toLowerCase()));
      for (const s of skills) if (!existing.has(s.toLowerCase()) && d.skills.length < 100) d.skills.push(s);
    });
    setInput('');
  };
  return (
    <Section title="Skills" id="section-skills">
      <ul className="mb-3 flex flex-wrap gap-2">
        {draft.skills.map((skill, i) => (
          <li
            key={`${skill}-${i}`}
            className="flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1 pl-3 text-sm"
          >
            {skill}
            <button
              type="button"
              className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              aria-label={`Remove ${skill}`}
              onClick={() => update((d) => void d.skills.splice(i, 1))}
            >
              ✕
            </button>
          </li>
        ))}
        {draft.skills.length === 0 && <li className="text-sm text-slate-500">No skills yet.</li>}
      </ul>
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Add skills, comma separated"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn-secondary" onClick={add}>
          Add
        </button>
      </div>
    </Section>
  );
}
