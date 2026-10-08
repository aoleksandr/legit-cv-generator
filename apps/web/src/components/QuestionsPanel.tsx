import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LIMITS, parseFieldPath, type CvDetail, type CvDocument, type Question } from '@cv/shared';
import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner } from './ErrorBanner';

/** Human label for the part of the CV a question is about, e.g. "Experience · Acme Corp". */
export function fieldLabel(fieldPath: string, content: CvDocument | null): string {
  const path = parseFieldPath(fieldPath);
  if (!path) return 'CV';
  const section = path.section[0].toUpperCase() + path.section.slice(1);
  if (!path.entryId || !content) return section;
  if (path.section === 'experience') {
    const e = content.experience.find((x) => x.id === path.entryId);
    return e ? `${section} · ${e.company || e.title || 'role'}` : section;
  }
  const e = content.education.find((x) => x.id === path.entryId);
  return e ? `${section} · ${e.institution || e.degree || 'entry'}` : section;
}

function scrollToField(fieldPath: string) {
  const path = parseFieldPath(fieldPath);
  if (!path) return;
  const el = document.getElementById(path.entryId ? `entry-${path.entryId}` : `section-${path.section}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function QuestionsPanel({ cv, disabledReason }: { cv: CvDetail; disabledReason?: string }) {
  const open = cv.questions.filter((q) => q.status === 'open');
  const answered = cv.questions.filter((q) => q.status === 'answered');

  return (
    <aside className="card p-4 sm:p-5">
      <h2 className="font-semibold">Questions from the AI</h2>
      <p className="mb-4 text-sm text-slate-500">
        {open.length > 0
          ? 'Some details were missing or unclear. Your answers update the relevant part of the CV.'
          : 'No open questions. You can still edit anything by hand.'}
      </p>
      {disabledReason && open.length > 0 && <p className="mb-3 text-xs text-amber-700">{disabledReason}</p>}
      <ul className="space-y-3">
        {open.map((q) => (
          <QuestionItem key={q.id} cv={cv} question={q} disabled={!!disabledReason} />
        ))}
      </ul>
      {answered.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-slate-500">Answered ({answered.length})</summary>
          <ul className="mt-2 space-y-2">
            {answered.map((q) => (
              <li key={q.id} className="rounded-lg bg-slate-50 p-2">
                <p className="text-slate-600">{q.question}</p>
                <p className="mt-1 text-slate-900">{q.answer}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function QuestionItem({ cv, question, disabled }: { cv: CvDetail; question: Question; disabled: boolean }) {
  const qc = useQueryClient();
  const [answer, setAnswer] = useState(question.answer ?? '');
  const refresh = (q: Question) => {
    qc.setQueryData<CvDetail>(['cv', cv.id], (old) =>
      old ? { ...old, questions: old.questions.map((x) => (x.id === q.id ? q : x)) } : old,
    );
    void qc.invalidateQueries({ queryKey: ['cv', cv.id] });
  };
  const submit = useMutation({ mutationFn: () => api.answer(cv.id, question.id, answer.trim()), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: () => api.dismiss(cv.id, question.id), onSuccess: refresh });

  const busy = question.applying || submit.isPending;
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <button type="button" className="mb-1 text-xs font-medium text-indigo-600 hover:underline" onClick={() => scrollToField(question.fieldPath)}>
        {fieldLabel(question.fieldPath, cv.content)}
      </button>
      <p className="mb-2 text-sm">{question.question}</p>
      {question.applying ? (
        <div className="flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
          Updating your CV…
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) submit.mutate();
          }}
          className="space-y-2"
        >
          <textarea
            className="input min-h-20"
            value={answer}
            maxLength={LIMITS.answerMaxChars}
            placeholder="Your answer"
            onChange={(e) => setAnswer(e.target.value)}
            disabled={disabled}
          />
          {question.error && <ErrorBanner>{question.error}</ErrorBanner>}
          <ErrorBanner error={submit.error ?? dismiss.error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => dismiss.mutate()} disabled={busy || dismiss.isPending || disabled}>
              Skip
            </button>
            <button className="btn-primary px-3 py-1.5" disabled={busy || !answer.trim() || disabled}>
              Answer
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
