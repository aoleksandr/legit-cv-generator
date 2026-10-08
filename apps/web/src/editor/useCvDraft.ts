import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CvDetail, CvDocument } from '@cv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

const AUTOSAVE_DELAY_MS = 800;

/**
 * Local editable copy of the CV with debounced autosave and optimistic locking.
 *
 * - While there are no unsaved edits, the draft follows the server (e.g. when
 *   an answered question updates the CV).
 * - Saves send the version the edits were based on; a 409 means the CV changed
 *   elsewhere (another device, or an answer applied meanwhile) and the user
 *   chooses to reload instead of silently overwriting.
 */
export function useCvDraft(cv: CvDetail) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CvDocument>(() => cv.content!);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const baseVersion = useRef(cv.version);
  const dirty = useRef(false);
  const editSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftRef = useRef(draft);
  const conflict = useRef(false);

  // Follow server changes when the user has nothing unsaved.
  useEffect(() => {
    if (!dirty.current && cv.content && cv.version !== baseVersion.current) {
      baseVersion.current = cv.version;
      draftRef.current = cv.content;
      setDraft(cv.content);
    }
  }, [cv.version, cv.content]);

  const save = useMutation({
    mutationFn: ({ content }: { content: CvDocument; seq: number }) =>
      api.updateContent(cv.id, baseVersion.current, forSaving(content)),
    onMutate: () => setSaveState('saving'),
    onSuccess: (updated, { seq }) => {
      baseVersion.current = updated.version;
      qc.setQueryData(['cv', cv.id], updated);
      if (seq === editSeq.current) {
        dirty.current = false;
        setSaveState('saved');
      }
      setSaveError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        conflict.current = true;
        setSaveState('conflict');
      } else {
        setSaveState('error');
        setSaveError(err instanceof Error ? err.message : 'Could not save');
      }
    },
  });

  const flush = useCallback(
    (content: CvDocument) => {
      clearTimeout(timer.current);
      save.mutate({ content, seq: editSeq.current });
    },
    [save],
  );

  const update = useCallback(
    (fn: (d: CvDocument) => void) => {
      const next = structuredClone(draftRef.current);
      fn(next);
      draftRef.current = next;
      setDraft(next);
      dirty.current = true;
      editSeq.current++;
      clearTimeout(timer.current);
      // After a conflict, stop autosaving until the user decides (reload or keep editing locally).
      if (conflict.current) return;
      setSaveState('pending');
      timer.current = setTimeout(() => flush(draftRef.current), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  /** Discard local edits and take the server's latest version. */
  const reloadLatest = useCallback(async () => {
    clearTimeout(timer.current);
    const latest = await qc.fetchQuery({ queryKey: ['cv', cv.id], queryFn: () => api.getCv(cv.id) });
    dirty.current = false;
    conflict.current = false;
    baseVersion.current = latest.version;
    if (latest.content) {
      draftRef.current = latest.content;
      setDraft(latest.content);
    }
    setSaveState('idle');
  }, [qc, cv.id]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearTimeout(timer.current);
    };
  }, []);

  return { draft, update, saveState, saveError, retrySave: () => flush(draftRef.current), reloadLatest, hasUnsaved: () => dirty.current };
}

/**
 * The draft may hold work-in-progress values the API rejects (an empty bullet
 * the user is about to type into, blank link lines). Strip them from what we
 * send, without touching the draft itself.
 */
function forSaving(content: CvDocument): CvDocument {
  return {
    ...content,
    contact: { ...content.contact, links: content.contact.links.map((l) => l.trim()).filter(Boolean) },
    experience: content.experience.map((e) => ({ ...e, bullets: e.bullets.filter((b) => b.text.trim()) })),
    skills: content.skills.filter((s) => s.trim()),
  };
}
