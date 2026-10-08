import { useQueryClient } from '@tanstack/react-query';
import type { CvDetail, CvDocument } from '@cv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keys, useSaveContent } from '../queries';

const AUTOSAVE_DELAY_MS = 800;

/**
 * Local editable copy of the CV with debounced, optimistic autosave.
 *
 * Keystrokes update the local draft instantly; after a pause the whole
 * document is saved (optimistically written to the query cache). Saves are
 * serialised so each one carries the version the previous one produced. If a
 * save fails, the mutation rolls the cache back and the draft follows it.
 * Changes from elsewhere (an answered question, another device) replace the
 * draft only when the user has nothing unsaved.
 */
export function useCvDraft(cv: CvDetail) {
  const qc = useQueryClient();
  const save = useSaveContent(cv.id);
  const [draft, setDraft] = useState<CvDocument>(() => cv.content!);
  const [hasPendingEdits, setHasPendingEdits] = useState(false);

  const draftRef = useRef(draft);
  const pending = useRef(false);
  const inFlight = useRef(false);
  const ownVersion = useRef(cv.version);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const replaceDraft = useCallback((content: CvDocument) => {
    draftRef.current = content;
    setDraft(content);
  }, []);

  // Follow changes made elsewhere, but never clobber unsaved local edits.
  useEffect(() => {
    if (!pending.current && !inFlight.current && cv.content && cv.version !== ownVersion.current) {
      ownVersion.current = cv.version;
      replaceDraft(cv.content);
    }
  }, [cv.version, cv.content, replaceDraft]);

  const commit = useCallback(() => {
    if (inFlight.current) return; // the running save picks up the latest draft when it settles
    const version = qc.getQueryData<CvDetail>(keys.cv(cv.id))?.version ?? ownVersion.current;
    pending.current = false;
    inFlight.current = true;
    save.mutate(
      { version, content: forSaving(draftRef.current) },
      {
        onSuccess: (updated) => {
          ownVersion.current = updated.version;
        },
        onError: () => {
          // The mutation restored the last accepted content; drop local edits made on top of the failed one.
          pending.current = false;
          clearTimeout(timer.current);
          const restored = qc.getQueryData<CvDetail>(keys.cv(cv.id))?.content;
          if (restored) replaceDraft(restored);
        },
        onSettled: () => {
          inFlight.current = false;
          if (pending.current) commit();
          else setHasPendingEdits(false);
        },
      },
    );
  }, [qc, cv.id, save, replaceDraft]);

  const update = useCallback(
    (fn: (d: CvDocument) => void) => {
      const next = structuredClone(draftRef.current);
      fn(next);
      replaceDraft(next);
      pending.current = true;
      setHasPendingEdits(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(commit, AUTOSAVE_DELAY_MS);
    },
    [commit, replaceDraft],
  );

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current || inFlight.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearTimeout(timer.current);
    };
  }, []);

  return { draft, update, saving: hasPendingEdits };
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
