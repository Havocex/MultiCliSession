import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './apiClient';
import type { ChatCheckpoint, ChatProject, ChatSession, PlanItem } from './workspaceStore';

const templates = [
  { title: 'Plan a feature', text: 'Create an implementation plan for the following feature. Identify ambiguities only when they materially affect the design:\n\n' },
  { title: 'Fix a bug', text: 'Diagnose and fix this bug. Reproduce it when possible, make the smallest safe change, and run relevant tests:\n\n' },
  { title: 'Review code', text: 'Review the selected context for correctness, security, maintainability, and missing tests. Prioritize actionable findings:\n\n' },
  { title: 'Refactor safely', text: 'Refactor the selected code without changing behavior. Keep the change focused and verify it with tests:\n\n' },
  { title: 'Write tests', text: 'Add focused tests for the selected context, including important edge cases. Run them and report the result:\n\n' },
];

interface GitStatus {
  branch: string;
  available?: boolean;
  changes: Array<{ status: string; path: string }>;
  worktrees: Array<{ path: string; branch: string }>;
}

export function ProductivityHub({
  open,
  project,
  session,
  onClose,
  onMemoryChange,
  onContextChange,
  onPlanChange,
  onCheckpoint,
  onRestoreCheckpoint,
  onWorktreeCreated,
  onWorktreeRemoved,
  onUseTemplate,
}: {
  open: boolean;
  project?: ChatProject;
  session?: ChatSession;
  onClose: () => void;
  onMemoryChange: (memory: string) => void;
  onContextChange: (files: string[]) => void;
  onPlanChange: (plan: PlanItem[]) => void;
  onCheckpoint: (checkpoint: ChatCheckpoint) => void;
  onRestoreCheckpoint: (checkpoint: ChatCheckpoint) => void;
  onWorktreeCreated: (path: string, branch: string) => void;
  onWorktreeRemoved: () => void;
  onUseTemplate: (text: string) => void;
}) {
  const [tab, setTab] = useState<'plan' | 'context' | 'memory' | 'git' | 'metrics' | 'templates'>('plan');
  const [files, setFiles] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState('');
  const [newTask, setNewTask] = useState('');
  const [git, setGit] = useState<GitStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refreshGit = async () => {
    if (!workspace) return;
    const response = await apiFetch(`/api/productivity/git-status?path=${encodeURIComponent(workspace)}`);
    if (response.ok) setGit(await response.json() as GitStatus);
  };
  const gitAction = async (action: 'stage' | 'unstage' | 'discard', file: string) => {
    if (!workspace) return;
    if (action === 'discard' && !window.confirm(`Permanently discard local changes in "${file}"?`)) return;
    setError('');
    const response = await apiFetch('/api/productivity/git-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace, file, action }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) {
      setError(body.error || 'Git action failed.');
      return;
    }
    await refreshGit();
  };
  const worktreeAction = async (action: 'merge' | 'remove') => {
    if (!project?.workingDirectory || !session?.worktreePath || !session.worktreeBranch) return;
    const verb = action === 'merge'
      ? 'merge this branch into the main project'
      : 'remove this worktree';
    if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/productivity/worktree-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: project.workingDirectory,
          worktreePath: session.worktreePath,
          branch: session.worktreeBranch,
          action,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Worktree action failed.');
      if (action === 'remove') onWorktreeRemoved();
      await refreshGit();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const workspace = session?.worktreePath || project?.workingDirectory;
  useEffect(() => {
    if (!open || !workspace) return;
    const controller = new AbortController();
    void Promise.all([
      apiFetch(`/api/productivity/files?path=${encodeURIComponent(workspace)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : { files: [] }),
      apiFetch(`/api/productivity/git-status?path=${encodeURIComponent(workspace)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : undefined),
    ]).then(([fileResult, gitResult]) => {
      setFiles(Array.isArray(fileResult.files) ? fileResult.files : []);
      setGit(gitResult as GitStatus | undefined);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [open, workspace]);

  const visibleFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase();
    return files.filter((file) => !query || file.toLowerCase().includes(query)).slice(0, 150);
  }, [fileQuery, files]);
  const completed = session?.plan?.filter((item) => item.status === 'done').length ?? 0;
  const runs = session?.messages.filter((message) => message.role === 'assistant' && message.run) ?? [];
  const durations = runs.flatMap((message) => message.run?.durationMs ?? []);
  const averageDuration = durations.length
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length / 1000)
    : 0;

  if (!open) return null;
  return (
    <div className="hub-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="productivity-hub" role="dialog" aria-modal="true" aria-label="Productivity hub" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><small>SESSION CONTROL CENTER</small><h2>Productivity hub</h2></div>
          <button type="button" onClick={onClose} aria-label="Close productivity hub">×</button>
        </header>
        <nav>
          {([
            ['plan', 'Plan'],
            ['context', 'Context'],
            ['memory', 'Memory'],
            ['git', 'Git & Worktree'],
            ['metrics', 'Metrics'],
            ['templates', 'Templates'],
          ] as const).map(([id, label]) => (
            <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="hub-content">
          {tab === 'plan' && <>
            <div className="hub-section-head">
              <div><h3>Execution plan</h3><p>{completed} of {session?.plan?.length ?? 0} tasks completed</p></div>
              <span className="plan-progress"><i style={{ width: `${session?.plan?.length ? completed / session.plan.length * 100 : 0}%` }} /></span>
            </div>
            <div className="task-list">
              {(session?.plan ?? []).map((item) => (
                <div className={`plan-task ${item.status}`} key={item.id}>
                  <button type="button" className="task-check" onClick={() => onPlanChange((session?.plan ?? []).map((task) =>
                    task.id === item.id ? { ...task, status: task.status === 'done' ? 'pending' : 'done' } : task,
                  ))}>{item.status === 'done' ? '✓' : ''}</button>
                  <input value={item.text} onChange={(event) => onPlanChange((session?.plan ?? []).map((task) =>
                    task.id === item.id ? { ...task, text: event.target.value } : task,
                  ))} />
                  <select value={item.status} onChange={(event) => onPlanChange((session?.plan ?? []).map((task) =>
                    task.id === item.id ? { ...task, status: event.target.value as PlanItem['status'] } : task,
                  ))}>
                    <option value="pending">Pending</option><option value="running">Running</option>
                    <option value="blocked">Blocked</option><option value="done">Done</option>
                  </select>
                  <button type="button" className="task-remove" onClick={() => onPlanChange((session?.plan ?? []).filter((task) => task.id !== item.id))}>×</button>
                </div>
              ))}
              {!session?.plan?.length && <div className="hub-empty">Turn the plan into a visible checklist and keep execution on track.</div>}
            </div>
            <form className="task-add" onSubmit={(event) => {
              event.preventDefault();
              const text = newTask.trim();
              if (!text) return;
              onPlanChange([...(session?.plan ?? []), { id: crypto.randomUUID(), text, status: 'pending' }]);
              setNewTask('');
            }}>
              <input value={newTask} onChange={(event) => setNewTask(event.target.value)} placeholder="Add a task…" />
              <button type="submit">Add task</button>
            </form>
            <div className="checkpoint-section">
              <div className="hub-section-head"><div><h3>Checkpoints</h3><p>Return to a known point in this conversation.</p></div>
                <button type="button" onClick={() => onCheckpoint({
                  id: crypto.randomUUID(), label: `Checkpoint ${(session?.checkpoints?.length ?? 0) + 1}`,
                  createdAt: new Date().toISOString(), messageCount: session?.messages.length ?? 0,
                })}>＋ Save checkpoint</button>
              </div>
              {(session?.checkpoints ?? []).map((checkpoint) => (
                <button type="button" className="checkpoint-row" key={checkpoint.id} onClick={() => onRestoreCheckpoint(checkpoint)}>
                  <span>◇</span><div><strong>{checkpoint.label}</strong><small>{checkpoint.messageCount} messages · {new Date(checkpoint.createdAt).toLocaleString()}</small></div><b>Restore</b>
                </button>
              ))}
            </div>
          </>}
          {tab === 'context' && <>
            <div className="hub-section-head"><div><h3>Selected context</h3><p>Only these files are attached to the next agent request.</p></div><b>{session?.contextFiles?.length ?? 0} selected</b></div>
            <input className="hub-search" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Search workspace files…" />
            <div className="context-files">
              {visibleFiles.map((file) => {
                const checked = session?.contextFiles?.includes(file) ?? false;
                return <label key={file}><input type="checkbox" checked={checked} onChange={() =>
                  onContextChange(checked ? (session?.contextFiles ?? []).filter((item) => item !== file) : [...(session?.contextFiles ?? []), file])
                } /><code>{file}</code></label>;
              })}
            </div>
          </>}
          {tab === 'memory' && <>
            <div className="hub-section-head"><div><h3>Project memory</h3><p>Persistent instructions shared by every session in this project.</p></div><b>{project?.memory?.length ?? 0} / 12000</b></div>
            <textarea className="memory-editor" value={project?.memory ?? ''} maxLength={12000} onChange={(event) => onMemoryChange(event.target.value)}
              placeholder={'Examples:\n• Architecture and important directories\n• Build and test commands\n• Coding conventions\n• Constraints the agent must always respect'} />
          </>}
          {tab === 'git' && <>
            <div className="git-overview">
              <div><small>ACTIVE BRANCH</small><strong>{session?.worktreeBranch || git?.branch || 'Not a Git repository'}</strong></div>
              <div><small>WORKSPACE</small><code>{workspace}</code></div>
            </div>
            {!session?.worktreePath ? (
              <div className="worktree-cta"><span>⑂</span><h3>Isolate this session</h3><p>Create a dedicated Git branch and worktree so parallel agents cannot overwrite each other.</p>
                <button type="button" disabled={busy || !project?.workingDirectory || git?.available === false} onClick={async () => {
                  if (!project || !session) return;
                  setBusy(true); setError('');
                  try {
                    const response = await apiFetch('/api/productivity/worktree', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: project.workingDirectory, sessionId: session.id, title: session.title }),
                    });
                    const body = await response.json() as { path?: string; branch?: string; error?: string };
                    if (!response.ok || !body.path || !body.branch) throw new Error(body.error || 'Could not create worktree.');
                    onWorktreeCreated(body.path, body.branch);
                  } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
                  finally { setBusy(false); }
                }}>{busy ? 'Creating…' : git?.available === false ? 'Initialize Git to enable worktrees' : 'Create session worktree'}</button>
                {error && <small className="hub-error">{error}</small>}
              </div>
            ) : <div className="worktree-ready"><span>✓</span><div><strong>Session isolated</strong><p>Agent commands now run inside this worktree.</p>
              <div className="worktree-actions">
                <button type="button" disabled={busy} onClick={() => void worktreeAction('merge')}>Merge into project</button>
                <button type="button" disabled={busy} className="discard" onClick={() => void worktreeAction('remove')}>Remove worktree</button>
              </div>
            </div></div>}
            <div className="git-changes"><h3>Working changes <b>{git?.changes.length ?? 0}</b></h3>
              {(git?.changes ?? []).map((change) => <div key={`${change.status}-${change.path}`}>
                <b>{change.status}</b><code>{change.path}</code>
                <span>
                  <button type="button" onClick={() => void gitAction('stage', change.path)}>Stage</button>
                  <button type="button" onClick={() => void gitAction('unstage', change.path)}>Unstage</button>
                  <button type="button" className="discard" onClick={() => void gitAction('discard', change.path)}>Discard</button>
                </span>
              </div>)}
              {!git?.changes.length && <p>No uncommitted changes.</p>}
              {error && <small className="hub-error">{error}</small>}
            </div>
          </>}
          {tab === 'metrics' && <>
            {'Notification' in window && Notification.permission !== 'granted' && (
              <button type="button" className="notification-cta" onClick={() => void Notification.requestPermission()}>
                Enable completion notifications
              </button>
            )}
            <div className="metric-grid">
              <div><small>RUNS</small><strong>{runs.length}</strong><span>assistant turns</span></div>
              <div><small>AVERAGE</small><strong>{averageDuration || '—'}{averageDuration ? 's' : ''}</strong><span>response time</span></div>
              <div><small>SUCCESS</small><strong>{runs.length ? Math.round(runs.filter((message) => message.run?.status === 'done').length / runs.length * 100) : 0}%</strong><span>completed turns</span></div>
              <div><small>CONTEXT</small><strong>{session?.contextFiles?.length ?? 0}</strong><span>attached files</span></div>
            </div>
            <div className="run-history">
              {runs.slice().reverse().map((message) => <div key={message.id}><span className={message.run?.status} /><code>{message.agent?.modelLabel}</code><b>{message.run?.durationMs ? `${(message.run.durationMs / 1000).toFixed(1)}s` : '—'}</b><small>{message.run?.responseCharacters ?? 0} chars</small></div>)}
            </div>
          </>}
          {tab === 'templates' && <div className="template-grid">
            {templates.map((template) => <button type="button" key={template.title} onClick={() => { onUseTemplate(template.text); onClose(); }}>
              <span>✦</span><strong>{template.title}</strong><p>{template.text.split('\n')[0]}</p><b>Use template →</b>
            </button>)}
          </div>}
        </div>
      </section>
    </div>
  );
}
