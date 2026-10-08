import type { CvDetail, ProgressStep } from '@cv/shared';

const STEPS: { key: ProgressStep; label: string }[] = [
  { key: 'extracting', label: 'Reading your background' },
  { key: 'verifying', label: 'Checking every fact against your text' },
  { key: 'writing', label: 'Writing the CV for your target role' },
  { key: 'checking', label: 'Double-checking nothing was invented' },
];

export function GenerationProgress({ cv }: { cv: CvDetail }) {
  const current = cv.progressStep ? STEPS.findIndex((s) => s.key === cv.progressStep) : -1;
  return (
    <div className="card mx-auto max-w-xl p-6" aria-live="polite">
      <div className="mb-4">
        <div>
          <h2 className="font-semibold">{cv.status === 'queued' ? 'Waiting to start…' : 'Generating your CV…'}</h2>
          <p className="text-sm text-slate-500">
            This can take a minute or two. You can leave this page or close the tab. Your CV will be here when you come back.
          </p>
        </div>
      </div>
      <ol className="space-y-2">
        {STEPS.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'todo';
          return (
            <li key={step.key} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                  state === 'done' ? 'bg-emerald-500 text-white' : state === 'active' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span className={state === 'todo' ? 'text-slate-400' : 'text-slate-800'}>{step.label}</span>
            </li>
          );
        })}
      </ol>
      {cv.error && <p className="mt-4 text-sm text-amber-700">{cv.error}</p>}
    </div>
  );
}
