import { LIMITS, TargetRoleSchema } from '@cv/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ErrorBanner } from '../components/ErrorBanner';
import { useCreateCv } from '../queries';

type Source = 'pdf' | 'text';

export function NewCvPage() {
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>('pdf');
  const [targetRole, setTargetRole] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useCreateCv();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const error = validate();
    setFormError(error);
    if (error) return;
    const input =
      source === 'pdf'
        ? ({ source, file: file!, targetRole: targetRole.trim() } as const)
        : ({ source, targetRole: targetRole.trim(), text: text.trim() } as const);
    create.mutate(input, { onSuccess: (cv) => navigate(`/cvs/${cv.id}`) });
  };

  const validate = (): string | null => {
    if (!TargetRoleSchema.safeParse(targetRole).success) return 'Enter the role you are targeting (2-120 characters).';
    if (source === 'pdf') {
      if (!file) return 'Choose a PDF file.';
      if (file.size > LIMITS.pdfMaxBytes) return `The file is larger than ${LIMITS.pdfMaxBytes / 1024 / 1024} MB.`;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')
        return 'The file must be a PDF.';
    } else {
      const length = text.trim().length;
      if (length < LIMITS.sourceTextMinChars)
        return `Tell us a bit more (at least ${LIMITS.sourceTextMinChars} characters).`;
      if (length > LIMITS.sourceTextMaxChars)
        return `The text is too long (max ${LIMITS.sourceTextMaxChars} characters).`;
    }
    return null;
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">New CV</h1>

      <div>
        <label className="label" htmlFor="role">
          Target role
        </label>
        <input
          id="role"
          className="input"
          placeholder="e.g. Senior Backend Engineer"
          value={targetRole}
          onChange={(e) => setTargetRole(e.target.value)}
          maxLength={120}
        />
      </div>

      <div className="card p-4 sm:p-6">
        <div role="tablist" className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
          {(['pdf', 'text'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={source === s}
              onClick={() => setSource(s)}
              className={`rounded-md py-2 text-sm font-medium transition ${source === s ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {s === 'pdf' ? 'Upload a PDF' : 'Describe yourself'}
            </button>
          ))}
        </div>

        {source === 'pdf' ? (
          <div>
            <label className="label" htmlFor="file">
              Your current CV (PDF, max 5 MB)
            </label>
            <input
              id="file"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
            />
            <p className="mt-2 text-xs text-slate-500">
              The PDF needs selectable text. For scanned documents, use the text option.
            </p>
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="text">
              Your background
            </label>
            <textarea
              id="text"
              className="input min-h-64"
              placeholder="Your name and contact details, where you've worked (with dates), what you did there, your education and skills…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={LIMITS.sourceTextMaxChars}
            />
            <p className="mt-1 text-right text-xs text-slate-400">
              {text.length.toLocaleString()} / {LIMITS.sourceTextMaxChars.toLocaleString()}
            </p>
          </div>
        )}
      </div>

      <p className="text-sm text-slate-500">
        The AI rewrites and restructures what you provide, but it won't make anything up. If something is missing or
        unclear, it will ask you.
      </p>

      {formError ? <ErrorBanner>{formError}</ErrorBanner> : <ErrorBanner error={create.error} />}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={() => navigate('/')}>
          Cancel
        </button>
        <button className="btn-primary" disabled={create.isPending}>
          Generate CV
        </button>
      </div>
    </form>
  );
}
