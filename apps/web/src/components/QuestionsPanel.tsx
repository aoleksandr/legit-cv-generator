import { LIMITS, parseFieldPath, type CvDetail, type CvDocument, type Question } from '@cv/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAnswerQuestion, useDismissQuestion } from '../queries';

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

export function QuestionsPanel({ cv }: { cv: CvDetail }) {
  const open = cv.questions.filter((q) => q.status === 'open');
  const answered = cv.questions.filter((q) => q.status === 'answered');

  return (
    // When the page caps its height (wide screens), the heading stays put and only the questions scroll.
    <aside className="card flex min-h-0 flex-col p-4 sm:p-5">
      <div className="shrink-0">
        <h2 className="font-semibold">Questions from the AI</h2>
        <p className="mb-4 text-sm text-slate-500">
          {open.length > 0
            ? 'Some details were missing or unclear. Your answers update the relevant part of the CV.'
            : 'No open questions. You can still edit anything by hand.'}
        </p>
      </div>
      {/* Padding keeps focus rings from being clipped by the scroll container. */}
      <div className="-m-1 min-h-0 flex-1 overflow-y-auto p-1">
        <ul className="space-y-3">
          {open.map((q) => (
            <QuestionItem key={q.id} cv={cv} question={q} />
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
      </div>
    </aside>
  );
}

function QuestionItem({ cv, question }: { cv: CvDetail; question: Question }) {
  const [answer, setAnswer] = useState(question.answer ?? '');
  const submit = useAnswerQuestion(cv.id);
  const dismiss = useDismissQuestion(cv.id);

  // The answer is applied by a background job; tell the user if that job gave up.
  const wasApplying = useRef(question.applying);
  useEffect(() => {
    if (wasApplying.current && !question.applying && question.error) {
      toast.error('Your answer could not be applied', { description: question.error });
    }
    wasApplying.current = question.applying;
  }, [question.applying, question.error]);

  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <button
        type="button"
        className="mb-1 text-xs font-medium text-indigo-600 hover:underline"
        onClick={() => scrollToField(question.fieldPath)}
      >
        {fieldLabel(question.fieldPath, cv.content)}
      </button>
      <p className="mb-2 text-sm">{question.question}</p>
      {question.applying ? (
        <div className="space-y-1 text-sm" aria-live="polite">
          <p className="rounded-lg bg-slate-50 p-2 text-slate-900">{question.answer}</p>
          <p className="text-xs text-slate-500">Adding your answer to the CV. It will appear in the editor shortly.</p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) submit.mutate({ questionId: question.id, answer: answer.trim() });
          }}
          className="space-y-2"
        >
          <textarea
            className="input min-h-20"
            value={answer}
            maxLength={LIMITS.answerMaxChars}
            placeholder="Your answer"
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => dismiss.mutate(question.id)}>
              Skip
            </button>
            <button className="btn-primary px-3 py-1.5" disabled={!answer.trim()}>
              Answer
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
