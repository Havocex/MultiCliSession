import { useEffect, useRef, useState } from 'react';
import {
  fetchLibrary,
  LibraryConflictError,
  mergeChatLibraries,
  saveLibrary,
  type ChatLibrary,
} from './workspaceStore';

export function useChatLibrary() {
  const [library, setLibrary] = useState<ChatLibrary>();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const revisionRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void fetchLibrary()
      .then((nextLibrary) => {
        if (cancelled) return;
        revisionRef.current = nextLibrary.revision ?? 0;
        setLibrary(nextLibrary);
        setReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Could not load chat history.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !library) return;
    setSaveStatus('saving');
    const timer = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const revision = await saveLibrary(library, revisionRef.current);
          revisionRef.current = revision;
          setSaveStatus('saved');
        })
        .catch(async (error) => {
          if (error instanceof LibraryConflictError) {
            try {
              const remote = await fetchLibrary();
              revisionRef.current = remote.revision ?? 0;
              setLibrary((local) => local ? mergeChatLibraries(remote, local) : remote);
              setSaveStatus('saving');
              return;
            } catch {
              // Fall through to a visible save error.
            }
          }
          setSaveStatus('error');
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [library, ready]);

  return {
    library,
    setLibrary,
    libraryReady: ready,
    loadError,
    saveStatus,
  };
}
