import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  fetchOptions,
  selectWorkingDirectory,
  streamChat,
  undoWorkspaceFiles,
  type AgentSnapshot,
  type Effort,
  type InteractionResponse,
  type Message,
  type MessageReasoning,
  type Options,
  type Provider,
  type Selection,
} from './chatClient';
import { ConversationFold } from './ConversationFold';
import {
  InteractiveQuestion,
  parseInteractiveContent,
  type InteractiveQuestionData,
} from './InteractiveQuestion';
import { renderMarkdownLite } from './markdownLite';
import { ReasoningCard } from './ReasoningCard';
import { ProviderIcon } from './ProviderIcon';
import { WorkspaceInspector } from './WorkspaceInspector';
import { ProductivityHub } from './ProductivityHub';
import {
  ReviewChanges,
  parseReviewContent,
  type ReviewChangesData,
} from './ReviewChanges';
import {
  makeProject,
  makeSession,
  type ChatCheckpoint,
  type ChatLibrary,
  type ChatSession,
  type PlanItem,
} from './workspaceStore';
import { useChatLibrary } from './useChatLibrary';

const id = () => crypto.randomUUID();

const providerVisuals: Record<Provider, { accent: string; description: string }> = {
  codex: { accent: 'violet', description: 'OpenAI · ChatGPT subscription' },
  claude: { accent: 'amber', description: 'Anthropic · Claude subscription' },
  cursor: { accent: 'black', description: 'Cursor · Cursor subscription' },
  hermes: { accent: 'blue', description: 'Hermes Agent · local CLI' },
  copilot: { accent: 'white', description: 'GitHub · Copilot subscription' },
  kimi: { accent: 'moon', description: 'Moonshot AI · Kimi Code' },
};

const suggestions = [
  'Explain a complex idea simply',
  'Help me plan a new feature',
  'Review a piece of code',
];

const compactSessionPreview = (content: string) =>
  content
    .replace(/```([^\n`]*)\n[\s\S]*?```/g, (_match, info: string) => {
      const file = info.match(/(?:file|filename|title)=([^\s]+)/i)?.[1];
      return file ? `[Code · ${file}]` : '[Code snippet]';
    })
    .replace(/\s+/g, ' ')
    .trim();

export function App() {
  const [draft, setDraft] = useState('');
  const [options, setOptions] = useState<Options>();
  const [selection, setSelection] = useState<Selection>();
  const [runStates, setRunStates] = useState<Record<string, 'running' | 'done' | 'error'>>({});
  const [checkingProvider, setCheckingProvider] = useState(true);
  const [statusError, setStatusError] = useState('');
  const {
    library,
    setLibrary,
    libraryReady,
    loadError: libraryLoadError,
    saveStatus,
  } = useChatLibrary();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(304);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: 'project' | 'session'; id: string; name: string; projectId?: string } | undefined
  >();
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [editingSessionId, setEditingSessionId] = useState<string>();
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [hubOpen, setHubOpen] = useState(false);
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const promptQueuesRef = useRef(new Map<string, string[]>());
  const recoveredQueuesRef = useRef(new Set<string>());
  const initialLibrarySelectionRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const autoScrollRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const importProjectRef = useRef<HTMLInputElement>(null);

  const activeProject = library?.projects.find((project) => project.id === library.activeProjectId);
  const activeSession = activeProject?.sessions.find(
    (session) => session.id === activeProject.activeSessionId,
  );
  const messages = activeSession?.messages ?? [];
  const contextCharacters = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-40)
    .reduce((total, message) => total + message.content.length, 0);
  const activeRunKey = activeProject && activeSession
    ? `${activeProject.id}:${activeSession.id}`
    : undefined;
  const sending = activeRunKey ? runStates[activeRunKey] === 'running' : false;
  const activeWorkspace = activeSession?.worktreePath || activeProject?.workingDirectory;

  const setSessionMessages = (
    projectId: string,
    sessionId: string,
    update: Message[] | ((current: Message[]) => Message[]),
  ) => {
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      const now = new Date().toISOString();
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) => {
          if (project.id !== projectId) return project;
          return {
            ...project,
            updatedAt: now,
            sessions: project.sessions.map((session) => {
              if (session.id !== sessionId) return session;
              const nextMessages =
                typeof update === 'function' ? update(session.messages) : update;
              const firstUser = nextMessages.find((message) => message.role === 'user');
              const generatedTitle =
                session.title === 'New conversation' && firstUser
                  ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 46)
                  : session.title;
              return {
                ...session,
                title: generatedTitle || 'New conversation',
                updatedAt: now,
                messages: nextMessages,
              };
            }),
          };
        }),
      };
    });
  };
  const setMessages = (update: Message[] | ((current: Message[]) => Message[])) => {
    if (!activeProject || !activeSession) return;
    setSessionMessages(activeProject.id, activeSession.id, update);
  };
  const persistPromptQueue = (projectId: string, sessionId: string, prompts: string[]) => {
    setLibrary((current) => current ? {
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId ? {
          ...project,
          sessions: project.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, pendingPrompts: prompts.length ? [...prompts] : undefined }
              : session,
          ),
        } : project,
      ),
    } : current);
  };
  const updateActiveSession = (patch: Partial<ChatSession>) => {
    setLibrary((current) => current ? {
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId ? {
          ...project,
          sessions: project.sessions.map((session) =>
            session.id === project.activeSessionId ? { ...session, ...patch } : session,
          ),
        } : project,
      ),
    } : current);
  };
  const updateProjectMemory = (memory: string) => {
    setLibrary((current) => current ? {
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId ? { ...project, memory } : project,
      ),
    } : current);
  };

  const refresh = async (forceRefresh = false) => {
    setCheckingProvider(true);
    setStatusError('');
    try {
      const next = await fetchOptions(forceRefresh);
      setOptions(next);
      setSelection((old) => {
        const provider =
          next.providers.find((item) => item.id === old?.provider) ??
          next.providers.find((item) => item.id === next.defaults.provider) ??
          next.providers[0];
        if (!provider) return next.defaults;
        const model = provider.models.find((item) => item.id === old?.modelId) ?? provider.models[0];
        if (!model) return next.defaults;
        const effort =
          old?.effort && model.efforts.includes(old.effort)
            ? old.effort
            : model.defaultEffort;
        const permissionId = provider.permissions.some(
          (permission) => permission.id === old?.permissionId,
        )
          ? old?.permissionId
          : provider.defaultPermissionId;
        return {
          provider: provider.id,
          modelId: model.id,
          effort,
          fast: model.supportsFast ? Boolean(old?.fast) : false,
          permissionId,
        };
      });
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not check CLI connections.');
    } finally {
      setCheckingProvider(false);
    }
  };

  useEffect(() => {
    if (!libraryReady || !library || initialLibrarySelectionRef.current) return;
    initialLibrarySelectionRef.current = true;
    const project = library.projects.find((item) => item.id === library.activeProjectId);
    const session = project?.sessions.find((item) => item.id === project.activeSessionId);
    if (session?.selection) setSelection(session.selection);
  }, [library, libraryReady]);

  useEffect(() => {
    if (libraryLoadError) setStatusError(libraryLoadError);
  }, [libraryLoadError]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const providerOptions = options?.providers ?? [];
  const activeProvider = providerOptions.find((provider) => provider.id === selection?.provider);
  const activeModel = activeProvider?.models.find((model) => model.id === selection?.modelId);
  const activePermission =
    activeProvider?.permissions.find((permission) => permission.id === selection?.permissionId) ??
    activeProvider?.permissions.find(
      (permission) => permission.id === activeProvider.defaultPermissionId,
    );
  const activeVisual = selection ? providerVisuals[selection.provider] : providerVisuals.codex;

  const agentSnapshot = (providerId: Provider, modelId: string): AgentSnapshot => {
    const provider = providerOptions.find((item) => item.id === providerId);
    const model = provider?.models.find((item) => item.id === modelId);
    return {
      provider: providerId,
      providerLabel:
        provider?.label ?? providerId.charAt(0).toUpperCase() + providerId.slice(1),
      modelId,
      modelLabel: model?.label ?? modelId,
    };
  };

  const selectAndRemember = (nextSelection: Selection) => {
    setSelection(nextSelection);
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) =>
          project.id === currentLibrary.activeProjectId
            ? {
                ...project,
                sessions: project.sessions.map((session) =>
                  session.id === project.activeSessionId
                    ? { ...session, selection: nextSelection }
                    : session,
                ),
              }
            : project,
        ),
      };
    });
  };

  const changePermission = (permissionId: string) => {
    if (!selection || !activeProvider) return;
    const permission = activeProvider.permissions.find((item) => item.id === permissionId);
    if (
      permission?.risk === 'danger' &&
      !window.confirm(
        `${permission.label} grants high-risk access to your computer. Enable it for this session?`,
      )
    ) {
      return;
    }
    selectAndRemember({ ...selection, permissionId });
  };

  useEffect(() => {
    if (!libraryReady || !selection || !activeSession) return;
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      const project = currentLibrary.projects.find(
        (item) => item.id === currentLibrary.activeProjectId,
      );
      const session = project?.sessions.find((item) => item.id === project.activeSessionId);
      if (
        session?.selection?.provider === selection.provider &&
        session.selection.modelId === selection.modelId &&
        session.selection.effort === selection.effort &&
        session.selection.fast === selection.fast &&
        session.selection.permissionId === selection.permissionId
      ) {
        return currentLibrary;
      }
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((item) =>
          item.id === currentLibrary.activeProjectId
            ? {
                ...item,
                sessions: item.sessions.map((chatSession) =>
                  chatSession.id === item.activeSessionId
                    ? { ...chatSession, selection }
                    : chatSession,
                ),
              }
            : item,
        ),
      };
    });
  }, [activeSession?.id, libraryReady, selection]);

  const recordModelSwitch = (nextSelection: Selection) => {
    if (
      !selection ||
      (selection.provider === nextSelection.provider &&
        selection.modelId === nextSelection.modelId)
    ) {
      return;
    }
    const from = agentSnapshot(selection.provider, selection.modelId);
    const to = agentSnapshot(nextSelection.provider, nextSelection.modelId);
    setMessages((current) => {
      if (!current.some((message) => message.role === 'user' || message.role === 'assistant')) {
        return current;
      }
      return [
        ...current,
        {
          id: id(),
          role: 'system',
          content: `Model changed from ${from.providerLabel} · ${from.modelLabel} to ${to.providerLabel} · ${to.modelLabel}.`,
          sessionEvent: { type: 'model-switch', from, to },
        },
      ];
    });
  };

  const changeProvider = async (providerId: Provider) => {
    const provider = providerOptions.find((item) => item.id === providerId);
    const model = provider?.models[0];
    if (!provider || !model) return;
    const nextSelection: Selection = {
      provider: provider.id,
      modelId: model.id,
      effort: model.defaultEffort,
      fast: false,
      permissionId: provider.defaultPermissionId,
    };
    recordModelSwitch(nextSelection);
    selectAndRemember(nextSelection);
    setCheckingProvider(true);
    setStatusError('');
    try {
      const next = await fetchOptions();
      setOptions(next);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not refresh this connection.');
    } finally {
      setCheckingProvider(false);
    }
  };

  const createProject = () => {
    const incompleteProject = library?.projects.find(
      (project) => !project.workingDirectory?.trim(),
    );
    if (incompleteProject) {
      switchProject(incompleteProject.id);
      setExpandedProjects((current) => ({ ...current, [incompleteProject.id]: true }));
      setStatusError('Choose a working directory to finish setting up this project.');
      setSidebarOpen(true);
      return;
    }
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      const project = makeProject(currentLibrary.projects.length + 1, selection);
      setExpandedProjects((current) => ({ ...current, [project.id]: true }));
      return {
        ...currentLibrary,
        activeProjectId: project.id,
        projects: [...currentLibrary.projects, project],
      };
    });
    setSidebarOpen(true);
  };

  const chooseWorkingDirectory = async () => {
    if (!activeProject) return;
    try {
      const selectedPath = await selectWorkingDirectory();
      if (!selectedPath) return;
      updateProjectWorkingDirectory(selectedPath);
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not open the folder picker.');
    }
  };

  const chooseAdditionalWorkingDirectory = async () => {
    if (!activeProject) return;
    try {
      const selectedPath = await selectWorkingDirectory();
      if (!selectedPath) return;
      setLibrary((currentLibrary) => currentLibrary ? {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) => {
          if (project.id !== currentLibrary.activeProjectId) return project;
          if (
            project.workingDirectory === selectedPath ||
            project.additionalWorkingDirectories?.includes(selectedPath)
          ) {
            return project;
          }
          return {
            ...project,
            additionalWorkingDirectories: [
              ...(project.additionalWorkingDirectories ?? []),
              selectedPath,
            ],
            updatedAt: new Date().toISOString(),
          };
        }),
      } : currentLibrary);
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not add the folder.');
    }
  };

  const removeAdditionalWorkingDirectory = (directory: string) => {
    setLibrary((currentLibrary) => currentLibrary ? {
      ...currentLibrary,
      projects: currentLibrary.projects.map((project) =>
        project.id === currentLibrary.activeProjectId
          ? {
              ...project,
              additionalWorkingDirectories: (project.additionalWorkingDirectories ?? [])
                .filter((item) => item !== directory),
              updatedAt: new Date().toISOString(),
            }
          : project,
      ),
    } : currentLibrary);
  };

  const renameProject = (name: string) => {
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) =>
          project.id === currentLibrary.activeProjectId
            ? { ...project, name, updatedAt: new Date().toISOString() }
            : project,
        ),
      };
    });
  };

  const updateProjectWorkingDirectory = (workingDirectory: string) => {
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) =>
          project.id === currentLibrary.activeProjectId
            ? {
                ...project,
                workingDirectory,
                additionalWorkingDirectories: (project.additionalWorkingDirectories ?? [])
                  .filter((directory) => directory !== workingDirectory),
                updatedAt: new Date().toISOString(),
              }
            : project,
        ),
      };
    });
  };

  const switchProject = (projectId: string) => {
    const project = library?.projects.find((item) => item.id === projectId);
    if (!project) return;
    const session = project.sessions.find((item) => item.id === project.activeSessionId);
    setLibrary((currentLibrary) =>
      currentLibrary ? { ...currentLibrary, activeProjectId: projectId } : currentLibrary,
    );
    setExpandedProjects((current) => ({ ...current, [projectId]: true }));
    if (session?.selection) setSelection(session.selection);
  };

  const createSession = (targetProjectId = activeProject?.id) => {
    if (!targetProjectId) return;
    const targetProject = library?.projects.find((project) => project.id === targetProjectId);
    if (!targetProject?.workingDirectory?.trim()) {
      setStatusError('Choose a working directory before starting a conversation.');
      setSidebarOpen(true);
      return;
    }
    const session = makeSession(selection);
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      return {
        ...currentLibrary,
        activeProjectId: targetProjectId,
        projects: currentLibrary.projects.map((project) =>
          project.id === targetProjectId
            ? {
                ...project,
                activeSessionId: session.id,
                updatedAt: session.updatedAt,
                sessions: [session, ...project.sessions],
              }
            : project,
        ),
      };
    });
    resizeComposer('');
    setSidebarOpen(false);
  };

  const switchSession = (projectId: string, session: ChatSession) => {
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      return {
        ...currentLibrary,
        activeProjectId: projectId,
        projects: currentLibrary.projects.map((project) =>
          project.id === projectId
            ? { ...project, activeSessionId: session.id }
            : project,
        ),
      };
    });
    if (session.selection) setSelection(session.selection);
    resizeComposer('');
    setSidebarOpen(false);
  };

  const startRenamingSession = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setSessionTitleDraft(session.title);
  };

  const commitSessionTitle = (projectId: string, sessionId: string) => {
    const title = sessionTitleDraft.replace(/\s+/g, ' ').trim();
    setEditingSessionId(undefined);
    if (!title) return;
    setLibrary((currentLibrary) => currentLibrary ? {
      ...currentLibrary,
      projects: currentLibrary.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt: new Date().toISOString(),
              sessions: project.sessions.map((session) =>
                session.id === sessionId ? { ...session, title } : session,
              ),
            }
          : project,
      ),
    } : currentLibrary);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setLibrary((currentLibrary) => {
      if (!currentLibrary) return currentLibrary;
      if (deleteTarget.kind === 'project') {
        const projects = currentLibrary.projects.filter(
          (project) => project.id !== deleteTarget.id,
        );
        return {
          ...currentLibrary,
          projects,
          activeProjectId:
            currentLibrary.activeProjectId === deleteTarget.id
              ? projects[0]?.id ?? ''
              : currentLibrary.activeProjectId,
        };
      }
      return {
        ...currentLibrary,
        projects: currentLibrary.projects.map((project) => {
          if (project.id !== (deleteTarget.projectId ?? currentLibrary.activeProjectId)) return project;
          const remaining = project.sessions.filter((session) => session.id !== deleteTarget.id);
          if (remaining.length) {
            return {
              ...project,
              sessions: remaining,
              activeSessionId:
                project.activeSessionId === deleteTarget.id
                  ? remaining[0]!.id
                  : project.activeSessionId,
            };
          }
          return { ...project, sessions: [], activeSessionId: '' };
        }),
      };
    });
    setDeleteTarget(undefined);
  };

  const sessionTime = (value: string) => {
    const date = new Date(value);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        createSession();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setHubOpen(true);
      }
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        setDeleteTarget(undefined);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const resizeComposer = (value: string) => {
    setDraft(value);
    requestAnimationFrame(() => {
      if (!composerRef.current) return;
      composerRef.current.style.height = 'auto';
      composerRef.current.style.height = `${Math.min(composerRef.current.scrollHeight, 180)}px`;
    });
  };

  const sendText = async (
    rawText: string,
    baseMessages: Message[] = messages,
    clearComposer = false,
  ) => {
    const text = rawText.trim();
    const targetProject = activeProject;
    const targetSession = activeSession;
    const selectionSnapshot = selection;
    if (!text || !selectionSnapshot || !targetProject || !targetSession) return;
    if (!targetProject.workingDirectory?.trim()) {
      setStatusError('Choose a working directory before sending a message.');
      setSidebarOpen(true);
      return;
    }
    const runKey = `${targetProject.id}:${targetSession.id}`;
    if (abortControllersRef.current.has(runKey)) return;
    const user: Message = { id: id(), role: 'user', content: text };
    const assistant: Message = {
      id: id(),
      role: 'assistant',
      content: '',
      agent: agentSnapshot(selectionSnapshot.provider, selectionSnapshot.modelId),
      reasoning: {
        content: `Waiting for ${agentSnapshot(selectionSnapshot.provider, selectionSnapshot.modelId).providerLabel} reasoning output…`,
        status: 'thinking',
        startedAt: new Date().toISOString(),
        placeholder: true,
      },
      run: {
        startedAt: new Date().toISOString(),
        status: 'running',
      },
    };
    const turn = [...baseMessages, user];
    const updateTargetMessages = (
      update: Message[] | ((current: Message[]) => Message[]),
    ) => setSessionMessages(targetProject.id, targetSession.id, update);
    updateTargetMessages([...turn, assistant]);
    autoScrollRef.current = true;
    if (clearComposer) resizeComposer('');
    const controller = new AbortController();
    abortControllersRef.current.set(runKey, controller);
    setRunStates((current) => ({ ...current, [runKey]: 'running' }));
    let answer = '';
    let runFailed = false;
    const finishedReasoning = (
      reasoning: MessageReasoning,
      completedAt: string,
    ): MessageReasoning => ({
      ...reasoning,
      content: reasoning.placeholder
        ? `${assistant.agent?.providerLabel ?? 'This provider'} completed the turn without exposing a reasoning trace.`
        : reasoning.content,
      status: 'complete',
      completedAt,
      placeholder: false,
    });
    const completeReasoning = () => {
      const completedAt = new Date().toISOString();
      updateTargetMessages((current) =>
        current.map((message) =>
          message.id === assistant.id && message.reasoning?.status === 'thinking'
            ? {
                ...message,
                reasoning: finishedReasoning(message.reasoning, completedAt),
              }
            : message,
        ),
      );
    };

    try {
      await streamChat(
        turn,
        selectionSnapshot,
        targetSession.worktreePath?.trim() || targetProject.workingDirectory?.trim() || undefined,
        targetProject.additionalWorkingDirectories,
        controller.signal,
        (event) => {
        if (event.type === 'thinking' && event.text) {
          const receivedAt = new Date().toISOString();
          updateTargetMessages((current) =>
            current.map((message) => {
              if (message.id !== assistant.id) return message;
              const previous = message.reasoning;
              const separator =
                previous?.content && !previous.placeholder && !event.delta
                  ? '\n\n'
                  : '';
              return {
                ...message,
                reasoning: {
                  content: `${previous?.placeholder ? '' : previous?.content ?? ''}${separator}${event.text}`,
                  status: 'thinking',
                  startedAt: previous?.startedAt ?? receivedAt,
                  placeholder: false,
                },
              };
            }),
          );
        }
        if (event.type === 'run_started' && event.snapshotId) {
          updateTargetMessages((current) =>
            current.map((message) =>
              message.id === assistant.id
                ? {
                    ...message,
                    reviewAction: {
                      ...message.reviewAction,
                      snapshotId: event.snapshotId,
                    },
                  }
                : message,
            ),
          );
        }
        if (event.type === 'text_delta') {
          answer += event.text;
          updateTargetMessages((current) =>
            current.map((message) =>
              message.id === assistant.id
                ? {
                    ...message,
                    content: answer,
                    reasoning:
                      message.reasoning?.status === 'thinking'
                        ? finishedReasoning(message.reasoning, new Date().toISOString())
                        : message.reasoning,
                  }
                : message,
            ),
          );
        }
        if (event.type === 'turn_done') completeReasoning();
        if (event.type === 'error') {
          runFailed = true;
          updateTargetMessages((current) =>
            current.map((message) =>
              message.id === assistant.id
                ? {
                    ...message,
                    content: answer || event.message,
                    error: true,
                    reasoning:
                      message.reasoning?.status === 'thinking'
                        ? finishedReasoning(message.reasoning, new Date().toISOString())
                        : message.reasoning,
                  }
                : message,
            ),
          );
        }
        },
        {
          projectMemory: targetProject.memory,
          contextFiles: targetSession.contextFiles,
        },
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        runFailed = true;
        updateTargetMessages((current) =>
          current.map((message) =>
            message.id === assistant.id
              ? {
                  ...message,
                  content: error instanceof Error ? error.message : String(error),
                  error: true,
                }
              : message,
          ),
        );
      }
    } finally {
      const completedAt = new Date().toISOString();
      completeReasoning();
      updateTargetMessages((current) =>
        current.map((message) =>
          message.id === assistant.id
            ? {
                ...message,
                run: {
                  ...message.run!,
                  completedAt,
                  durationMs: Date.now() - new Date(message.run?.startedAt ?? completedAt).getTime(),
                  status: controller.signal.aborted ? 'cancelled' : runFailed ? 'error' : 'done',
                  responseCharacters: answer.length,
                },
              }
            : message,
        ),
      );
      abortControllersRef.current.delete(runKey);
      setRunStates((current) => ({ ...current, [runKey]: runFailed ? 'error' : 'done' }));
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`${targetSession.title} ${runFailed ? 'needs attention' : 'is ready'}`, {
          body: runFailed ? 'The agent run failed.' : `${assistant.agent?.providerLabel ?? 'The agent'} finished responding.`,
        });
      }
      const queue = promptQueuesRef.current.get(runKey);
      const nextPrompt = queue?.shift();
      setQueueCounts((current) => ({ ...current, [runKey]: queue?.length ?? 0 }));
      persistPromptQueue(targetProject.id, targetSession.id, queue ?? []);
      if (nextPrompt) {
        const finishedAssistant: Message = {
          ...assistant,
          content: answer,
          error: runFailed,
          run: {
            ...assistant.run!,
            completedAt,
            durationMs: Date.now() - new Date(assistant.run!.startedAt).getTime(),
            status: runFailed ? 'error' : 'done',
            responseCharacters: answer.length,
          },
        };
        window.setTimeout(() => void sendText(nextPrompt, [...turn, finishedAssistant]), 50);
      }
      composerRef.current?.focus();
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeRunKey) return;
    if (sending) {
      const queue = promptQueuesRef.current.get(activeRunKey) ?? [];
      queue.push(text);
      promptQueuesRef.current.set(activeRunKey, queue);
      persistPromptQueue(activeProject!.id, activeSession!.id, queue);
      setQueueCounts((current) => ({ ...current, [activeRunKey]: queue.length }));
      resizeComposer('');
      return;
    }
    await sendText(text, messages, true);
  };

  useEffect(() => {
    if (!activeProject || !activeSession || !activeRunKey) return;
    if (recoveredQueuesRef.current.has(activeRunKey)) return;
    recoveredQueuesRef.current.add(activeRunKey);
    const recovered = [...(activeSession.pendingPrompts ?? [])];
    promptQueuesRef.current.set(activeRunKey, recovered);
    setQueueCounts((current) => ({ ...current, [activeRunKey]: recovered.length }));
    if (!recovered.length || abortControllersRef.current.has(activeRunKey)) return;
    const nextPrompt = recovered.shift()!;
    persistPromptQueue(activeProject.id, activeSession.id, recovered);
    setQueueCounts((current) => ({ ...current, [activeRunKey]: recovered.length }));
    window.setTimeout(() => void sendText(nextPrompt, activeSession.messages), 50);
  }, [activeProject?.id, activeSession?.id, activeRunKey]);
  const retryAssistantMessage = (assistantIndex: number) => {
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex]?.role !== 'user') userIndex -= 1;
    if (userIndex < 0) return;
    void sendText(messages[userIndex]!.content, messages.slice(0, userIndex));
  };

  const submitInteractiveAnswer = (
    messageId: string,
    question: InteractiveQuestionData,
    response: Omit<InteractionResponse, 'submittedAt'>,
  ) => {
    if (sending) return;
    const submittedResponse: InteractionResponse = {
      ...response,
      submittedAt: new Date().toISOString(),
    };
    const updatedMessages = messages.map((message) =>
      message.id === messageId
        ? { ...message, interactionResponse: submittedResponse }
        : message,
    );
    setMessages(updatedMessages);
    const choices = [
      ...response.labels,
      ...(response.otherText ? [`Other: ${response.otherText}`] : []),
    ];
    void sendText(
      `My answer to "${question.prompt}": ${choices.join('; ')}`,
      updatedMessages,
    );
  };

  const requestUndoChanges = async (
    messageId: string,
    review: ReviewChangesData,
  ) => {
    if (sending) return;
    const target = messages.find((message) => message.id === messageId);
    const snapshotId = target?.reviewAction?.snapshotId;
    if (!snapshotId) return;
    const undoRequestedAt = new Date().toISOString();
    const updatedMessages = messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            reviewAction: {
              ...message.reviewAction,
              undoRequestedAt,
              undoError: undefined,
            },
          }
        : message,
    );
    setMessages(updatedMessages);
    try {
      const result = await undoWorkspaceFiles(
        snapshotId,
        review.files.map((file) => file.path),
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                reviewAction: {
                  ...message.reviewAction,
                  undoCompletedAt: new Date().toISOString(),
                  undoError: result.skipped.length
                    ? `Could not restore: ${result.skipped.join(', ')}`
                    : undefined,
                },
              }
            : message,
        ),
      );
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                reviewAction: {
                  ...message.reviewAction,
                  undoError: error instanceof Error ? error.message : String(error),
                },
              }
            : message,
        ),
      );
    }
  };

  const rewindToMessage = (messageId: string) => {
    if (sending) return;
    setMessages((current) => {
      const point = current.findIndex((message) => message.id === messageId);
      if (point < 0 || point >= current.length - 1) return current;
      const foldedMessages = current.slice(point + 1);
      const foldedAt = new Date().toISOString();
      const fold: Message = {
        id: id(),
        role: 'system',
        content: `${foldedMessages.length} later messages folded into an earlier timeline.`,
        sessionEvent: {
          type: 'folded-conversation',
          foldedAt,
          messages: foldedMessages,
        },
      };
      return [...current.slice(0, point + 1), fold];
    });
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const exportActiveProject = () => {
    if (!activeProject) return;
    const blob = new Blob([JSON.stringify(activeProject, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      `${activeProject.name.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'project'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importProject = async (file: File | undefined) => {
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as Partial<ChatLibrary['projects'][number]>;
      if (typeof raw.name !== 'string' || !Array.isArray(raw.sessions)) {
        throw new Error('The selected file is not a Multi CLi Session project export.');
      }
      const now = new Date().toISOString();
      const sessions = raw.sessions.map((session) => ({
        ...session,
        id: id(),
        title: typeof session.title === 'string' ? session.title : 'Imported conversation',
        createdAt: typeof session.createdAt === 'string' ? session.createdAt : now,
        updatedAt: now,
        messages: Array.isArray(session.messages)
          ? session.messages.map((message) => ({ ...message, id: id() }))
          : [],
      }));
      const projectId = id();
      const importedProject = {
        id: projectId,
        name: `${raw.name.trim() || 'Imported project'} (imported)`,
        workingDirectory: '',
        additionalWorkingDirectories: [],
        createdAt: now,
        updatedAt: now,
        activeSessionId: sessions[0]?.id ?? '',
        sessions,
      };
      setLibrary((current) => current ? {
        ...current,
        activeProjectId: projectId,
        projects: [...current.projects, importedProject],
      } : current);
      setExpandedProjects((current) => ({ ...current, [projectId]: true }));
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Could not import this project.');
    } finally {
      if (importProjectRef.current) importProjectRef.current.value = '';
    }
  };

  const connected = Boolean(activeProvider?.session.connected);
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const visibleProjects = (library?.projects ?? []).filter((project) =>
    !normalizedHistoryQuery ||
    project.name.toLocaleLowerCase().includes(normalizedHistoryQuery) ||
    project.sessions.some((session) =>
      session.title.toLocaleLowerCase().includes(normalizedHistoryQuery) ||
      session.messages.some((message) =>
        message.content.toLocaleLowerCase().includes(normalizedHistoryQuery),
      ),
    ),
  );

  return (
    <main
      className={`app-shell theme-${activeVisual.accent} ${inspectorCollapsed ? 'inspector-collapsed' : ''}`}
      style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
    >
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div>
            <strong>Multi CLi Session</strong>
            <small>Projects · sessions · local history</small>
          </div>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="project-toolbar">
          <span>Workspace</span>
          <div>
            <input
              ref={importProjectRef}
              className="project-import-input"
              type="file"
              accept="application/json,.json"
              aria-label="Import project"
              onChange={(event) => void importProject(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => importProjectRef.current?.click()}
              aria-label="Import project"
              title="Import project"
            >↑</button>
            <button
              type="button"
              onClick={exportActiveProject}
              disabled={!activeProject}
              aria-label="Export active project"
              title="Export active project"
            >↓</button>
            <button
              type="button"
              onClick={createProject}
              disabled={library?.projects.some((project) => !project.workingDirectory?.trim())}
              aria-label="Create project"
              title="Create project"
            >＋</button>
          </div>
        </div>

        <button
          type="button"
          className="new-session-button"
          onClick={() => createSession()}
          disabled={!activeProject?.workingDirectory?.trim()}
        >
          <span>＋</span>
          New conversation
          <kbd>⌘ N</kbd>
        </button>

        <section className="history-panel">
          <div className="section-label">
            <span>Projects & conversations</span>
            <b>{library?.projects.length ?? 0}</b>
          </div>
          <label className="history-search">
            <span>⌕</span>
            <input
              value={historyQuery}
              placeholder="Search projects and conversations"
              aria-label="Search projects and conversations"
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
          </label>
          <div className="project-tree">
            {visibleProjects.map((project) => {
              const projectActive = project.id === library?.activeProjectId;
              const expanded = expandedProjects[project.id] ?? projectActive;
              const projectMatches =
                !normalizedHistoryQuery ||
                project.name.toLocaleLowerCase().includes(normalizedHistoryQuery);
              const visibleSessions = projectMatches
                ? project.sessions
                : project.sessions.filter((session) =>
                    session.title.toLocaleLowerCase().includes(normalizedHistoryQuery) ||
                    session.messages.some((message) =>
                      message.content.toLocaleLowerCase().includes(normalizedHistoryQuery),
                    ),
                  );
              return (
                <div className={`project-node ${projectActive ? 'active' : ''}`} key={project.id}>
                  <div className="project-node-head">
                    <button
                      type="button"
                      className="tree-toggle"
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
                      onClick={() => setExpandedProjects((current) => ({ ...current, [project.id]: !expanded }))}
                    >{expanded ? '⌄' : '›'}</button>
                    <button type="button" className="project-node-select" onClick={() => switchProject(project.id)}>
                      <span className="project-folder">{expanded ? '▾' : '▸'}</span>
                      <strong>{project.name}</strong>
                      <b>{project.sessions.length}</b>
                    </button>
                    {projectActive && (
                      <button
                        type="button"
                        className="project-delete"
                        disabled={
                          project.sessions.some((session) =>
                            runStates[`${project.id}:${session.id}`] === 'running')
                        }
                        aria-label={`Delete ${project.name}`}
                        title="Delete project"
                        onClick={() => setDeleteTarget({ kind: 'project', id: project.id, name: project.name })}
                      >×</button>
                    )}
                  </div>
                  {projectActive && expanded && (
                    <div className="project-settings">
                      <input
                        className="project-inline-name"
                        value={project.name}
                        aria-label="Project name"
                        onChange={(event) => renameProject(event.target.value)}
                      />
                      <label className="workspace-path">
                        <span>⌂</span>
                        <input
                          value={project.workingDirectory ?? ''}
                          aria-label="Project working directory"
                          placeholder="Choose a project folder"
                          spellCheck={false}
                          readOnly
                          onClick={() => void chooseWorkingDirectory()}
                        />
                        <button
                          type="button"
                          onClick={() => void chooseWorkingDirectory()}
                        >
                          Choose
                        </button>
                      </label>
                      {!project.workingDirectory?.trim() && (
                        <small className="directory-required">A working directory is required.</small>
                      )}
                      <div className="additional-workspaces">
                        <div>
                          <small>Additional folders</small>
                          <button type="button" onClick={() => void chooseAdditionalWorkingDirectory()}>
                            ＋ Add folder
                          </button>
                        </div>
                        {(project.additionalWorkingDirectories ?? []).map((directory) => (
                          <div className="additional-workspace" key={directory}>
                            <span>⌂</span>
                            <code title={directory}>{directory}</code>
                            <button
                              type="button"
                              aria-label={`Remove ${directory}`}
                              title="Remove folder from project"
                              onClick={() => removeAdditionalWorkingDirectory(directory)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        {!project.additionalWorkingDirectories?.length && (
                          <small className="additional-empty">No additional folders.</small>
                        )}
                      </div>
                    </div>
                  )}
                  {expanded && <div className="session-list">
                  {[...visibleSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => {
              const active = projectActive && session.id === project.activeSessionId;
              const sessionRunState = runStates[`${project.id}:${session.id}`];
              const assistantPreview = session.messages.find(
                (message) => message.role === 'assistant' && message.content,
              )?.content;
              const cleanAssistantPreview = assistantPreview
                ? parseInteractiveContent(
                    parseReviewContent(assistantPreview).displayContent,
                  ).displayContent
                : '';
              const preview =
                compactSessionPreview(cleanAssistantPreview) ||
                session.messages.find((message) => message.role === 'user')?.content ||
                'Start a new conversation';
              return (
                <div className={`session-item ${active ? 'active' : ''}`} key={session.id}>
                  <button type="button" onClick={() => switchSession(project.id, session)}>
                    <span className="session-icon">◌</span>
                    <span className="session-copy">
                      {editingSessionId === session.id ? (
                        <input
                          className="session-title-input"
                          autoFocus
                          value={sessionTitleDraft}
                          aria-label="Conversation name"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setSessionTitleDraft(event.target.value)}
                          onBlur={() => commitSessionTitle(project.id, session.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                            if (event.key === 'Escape') setEditingSessionId(undefined);
                          }}
                        />
                      ) : (
                        <strong onDoubleClick={(event) => {
                          event.stopPropagation();
                          startRenamingSession(session);
                        }}>{session.title}</strong>
                      )}
                      <small>{preview}</small>
                    </span>
                    <span className={`session-run-state ${sessionRunState ?? ''}`}>
                      {sessionRunState === 'running'
                        ? <><i /> Thinking</>
                        : sessionRunState === 'error'
                          ? 'Error'
                          : sessionRunState === 'done'
                            ? 'Done'
                            : <time>{sessionTime(session.updatedAt)}</time>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="session-rename"
                    aria-label={`Rename ${session.title}`}
                    title="Rename conversation"
                    onClick={() => startRenamingSession(session)}
                  >✎</button>
                  <button
                    type="button"
                    className="session-delete"
                    disabled={sessionRunState === 'running'}
                    aria-label={`Delete ${session.title}`}
                    title="Delete conversation"
                    onClick={() => setDeleteTarget({
                      kind: 'session',
                      id: session.id,
                      name: session.title,
                      projectId: project.id,
                    })}
                  >
                    ×
                  </button>
                </div>
              );
            })}
                  {!project.sessions.length && (
                    <button type="button" className="empty-project-chat" onClick={() => {
                      switchProject(project.id);
                      createSession(project.id);
                    }}>＋ Start the first conversation</button>
                  )}
                  </div>}
                </div>
              );
            })}
            {libraryReady && !visibleProjects.length && (
              <div className="history-empty">No matching projects or conversations.</div>
            )}
            {!libraryReady && (
              <>
                {[0, 1, 2].map((item) => <div className="session-skeleton" key={item} />)}
              </>
            )}
          </div>
        </section>

        <div className="connection-panel">
          <div className="section-label">
            <span>Connections</span>
            <button
              type="button"
              className={`icon-button ${checkingProvider ? 'is-spinning' : ''}`}
              onClick={() => void refresh(true)}
              aria-label="Refresh provider connections"
              title="Refresh connections"
            >
              ↻
            </button>
          </div>

          <nav className="provider-list" aria-label="AI providers">
            {providerOptions.map((provider) => {
              const visual = providerVisuals[provider.id];
              const selected = provider.id === selection?.provider;
              return (
                <button
                  type="button"
                  key={provider.id}
                  className={`provider-item ${selected ? 'selected' : ''} ${provider.session.connected ? '' : 'unavailable'}`}
                  disabled={sending || !provider.session.connected}
                  title={provider.session.connected ? `${provider.label} is ready` : provider.session.detail}
                  onClick={() => void changeProvider(provider.id)}
                  aria-pressed={selected}
                  aria-label={`${provider.label}${provider.session.connected ? '' : ' — not connected'}`}
                >
                  <span className={`provider-mark ${visual.accent}`}><ProviderIcon provider={provider.id} /></span>
                  <span className="provider-copy">
                    <strong>{provider.label}</strong>
                    <small>{provider.session.connected ? 'Ready' : 'Sign in required'}</small>
                  </span>
                  <span
                    className={`connection-dot ${provider.session.connected ? 'online' : ''}`}
                    aria-label={provider.session.connected ? 'Connected' : 'Disconnected'}
                  />
                </button>
              );
            })}
          </nav>
          {providerOptions.some((provider) => !provider.session.connected) && (
            <details className="provider-setup">
              <summary>Set up disconnected providers</summary>
              <div>
                {providerOptions.filter((provider) => !provider.session.connected).map((provider) => (
                  <section key={provider.id}>
                    <span><strong>{provider.label}</strong><small>{provider.session.detail}</small></span>
                    <button
                      type="button"
                      title={`Copy ${provider.capabilities.setupCommand}`}
                      onClick={() => void navigator.clipboard.writeText(provider.capabilities.setupCommand)}
                    >
                      Copy <code>{provider.capabilities.setupCommand}</code>
                    </button>
                  </section>
                ))}
              </div>
            </details>
          )}

          <div className="settings-panel">
            <label className="field">
              <span className="field-heading">
                <span>Model</span>
                <b title="Model catalog source">
                  {activeProvider?.models.length ?? 0} · {
                    activeProvider?.modelsSource === 'live-cli' ? 'Live CLI'
                    : activeProvider?.modelsSource === 'local-cache' ? 'Local cache'
                    : activeProvider?.modelsSource === 'official-aliases' ? 'Official aliases'
                    : 'Fallback'
                  }
                </b>
              </span>
              <select
                value={selection?.modelId ?? ''}
                disabled={sending || !activeProvider}
                onChange={(event) => {
                  if (!selection || !activeProvider) return;
                  const model = activeProvider.models.find((item) => item.id === event.target.value);
                  if (!model) return;
                  const nextSelection: Selection = {
                    ...selection,
                    modelId: model.id,
                    effort: model.defaultEffort,
                    fast: false,
                  };
                  recordModelSwitch(nextSelection);
                  selectAndRemember(nextSelection);
                }}
              >
                {Object.entries(
                  (activeProvider?.models ?? []).reduce<
                    Record<string, Options['providers'][number]['models']>
                  >(
                    (groups, model) => {
                      const group = model.group ?? 'Models';
                      (groups[group] ??= []).push(model);
                      return groups;
                    },
                    {},
                  ),
                ).map(([group, models]) => (
                  <optgroup key={group} label={group}>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="setting-grid">
              <label className="field">
                <span>Reasoning</span>
                <select
                  value={selection?.effort ?? ''}
                  disabled={sending || !activeModel?.efforts.length}
                  onChange={(event) =>
                    selection && selectAndRemember({
                      ...selection,
                      effort: event.target.value as Effort,
                    })
                  }
                >
                  {!activeModel?.efforts.length && <option value="">Preset</option>}
                  {activeModel?.efforts.map((effort) => <option key={effort}>{effort}</option>)}
                </select>
              </label>
              <label className="speed-toggle">
                <span>Fast</span>
                <input
                  type="checkbox"
                  checked={selection?.fast ?? false}
                  disabled={sending || !activeModel?.supportsFast}
                  onChange={(event) =>
                    selection && selectAndRemember({ ...selection, fast: event.target.checked })
                  }
                />
                <span className="toggle-track"><span /></span>
              </label>
            </div>
            <label className="field permission-field">
              <span className="field-heading">
                <span>Session access</span>
                <b className={`risk-label ${activePermission?.risk ?? 'safe'}`}>
                  {activePermission?.risk === 'danger'
                    ? 'High risk'
                    : activePermission?.risk === 'caution'
                      ? 'Elevated'
                      : 'Protected'}
                </b>
              </span>
              <select
                value={selection?.permissionId ?? activeProvider?.defaultPermissionId ?? ''}
                disabled={sending || !activeProvider}
                onChange={(event) => changePermission(event.target.value)}
              >
                {activeProvider?.permissions.map((permission) => (
                  <option key={permission.id} value={permission.id}>
                    {permission.label}
                  </option>
                ))}
              </select>
            </label>
            {activePermission && (
              <div className={`permission-note ${activePermission.risk}`}>
                <span className="permission-shield">
                  {activePermission.risk === 'danger' ? '!' : '◇'}
                </span>
                <span>{activePermission.description}</span>
              </div>
            )}
          </div>

          <div className={`cli-card ${connected ? 'online' : ''}`}>
            <div className="cli-card-head">
              <span className={`provider-mark small ${activeVisual.accent}`}><ProviderIcon provider={selection?.provider ?? 'codex'} /></span>
              <div>
                <strong>{activeProvider?.label ?? 'Checking provider'}</strong>
                <span>{checkingProvider ? 'Checking connection…' : connected ? 'Connected' : 'Not connected'}</span>
              </div>
              <span className={`connection-dot ${connected ? 'online' : ''}`} />
            </div>
            {activeProvider?.session.version && !checkingProvider && (
              <div className="cli-version">
                <span>CLI</span>
                <code>{activeProvider.session.version}</code>
              </div>
            )}
          </div>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

      <section className="workspace">
        <header className="workspace-header">
          <button
            type="button"
            className="mobile-sidebar-button"
            aria-label="Open projects and history"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <div className="active-agent">
            <span className={`provider-mark ${activeVisual.accent}`}><ProviderIcon provider={selection?.provider ?? 'codex'} /></span>
            <div>
              <div className="eyebrow session-eyebrow">
                <span className={`mini-dot ${connected ? 'online' : ''}`} />
                <span>{checkingProvider ? 'Checking connection' : connected ? 'Connected' : 'Not connected'}</span>
                {activeProvider?.session.version && !checkingProvider && (
                  <>
                    <i />
                    <code>{activeProvider.session.version}</code>
                  </>
                )}
              </div>
              <h1>{activeProvider?.label ?? 'AI'} <span>Assistant</span></h1>
            </div>
          </div>
          <div className="header-actions">
            <span className={`save-status ${saveStatus}`}>
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : 'Saved'}
            </span>
            {selection && <span className="model-pill">{selection.modelId}</span>}
            <button
              type="button"
              className="inspector-button"
              onClick={() => setInspectorOpen(true)}
            >
              ◇ Artifacts
            </button>
            <button
              type="button"
              className="inspector-button productivity-button"
              onClick={() => setHubOpen(true)}
              title="Productivity hub (Ctrl+K)"
            >
              ✦ Productivity
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!activeProject?.workingDirectory?.trim()}
              onClick={() => createSession()}
            >
              <span>＋</span> New chat
            </button>
          </div>
        </header>

        {libraryReady && !(library?.projects.length) && (
          <div className="project-gate" role="dialog" aria-modal="true" aria-labelledby="project-gate-title">
            <div className="project-gate-card">
              <span className="project-gate-icon">⌂</span>
              <small>Project required</small>
              <h2 id="project-gate-title">Create a project to continue</h2>
              <p>Every conversation must belong to a project with its own working directory.</p>
              <button type="button" onClick={createProject}>＋ Create project</button>
            </div>
          </div>
        )}

        {activeProject && !activeProject.workingDirectory?.trim() && (
          <div className="directory-banner" role="status">
            <span>⌂</span>
            <div>
              <strong>Choose a working directory</strong>
              <small>This project cannot create conversations until a folder is selected.</small>
            </div>
            <button type="button" onClick={() => void chooseWorkingDirectory()}>
              Choose folder
            </button>
          </div>
        )}

        {(statusError || (activeProvider && !connected)) && (
          <div className="connection-banner" role="status">
            <span className="banner-icon">!</span>
            <div>
              <strong>{statusError ? 'Connection check failed' : `${activeProvider?.label} needs attention`}</strong>
              <span>{statusError || activeProvider?.session.detail}</span>
            </div>
            <button type="button" onClick={() => void refresh(true)}>Check again</button>
          </div>
        )}

        <section
          ref={conversationRef}
          className="conversation"
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            autoScrollRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          }}
        >
          {!messages.length && (
            <div className="welcome">
              <div className="orb" aria-hidden="true">
                <div className="orb-core"><ProviderIcon provider={selection?.provider ?? 'codex'} /></div>
                <span className="orbit orbit-one" />
                <span className="orbit orbit-two" />
              </div>
              <div className="welcome-copy">
                <span className="welcome-kicker">{connected ? 'Connection ready' : 'Choose a connected provider'}</span>
                <h2>Where should we begin?</h2>
                <p>
                  A focused space for thoughtful work with {activeProvider?.label ?? 'your local AI'}.
                  Your conversation streams directly from the local CLI.
                </p>
              </div>
              <div className="suggestions">
                {suggestions.map((suggestion, index) => (
                  <button type="button" key={suggestion} onClick={() => {
                    resizeComposer(suggestion);
                    composerRef.current?.focus();
                  }}>
                    <span>{index === 0 ? '✦' : index === 1 ? '◇' : '⌘'}</span>
                    {suggestion}
                    <b>→</b>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="message-stream">
            {messages.map((message, messageIndex) => {
              if (message.role === 'system') {
                if (message.sessionEvent?.type === 'folded-conversation') {
                  return (
                    <ConversationFold
                      key={message.id}
                      messages={message.sessionEvent.messages}
                      foldedAt={message.sessionEvent.foldedAt}
                    />
                  );
                }
                const modelEvent = message.sessionEvent?.type === 'model-switch'
                  ? message.sessionEvent
                  : undefined;
                const sameProvider = modelEvent?.from.provider === modelEvent?.to.provider;
                const fromLabel = modelEvent
                  ? `${sameProvider ? '' : `${modelEvent.from.providerLabel} · `}${modelEvent.from.modelLabel}`
                  : '';
                const toLabel = modelEvent
                  ? `${sameProvider ? '' : `${modelEvent.to.providerLabel} · `}${modelEvent.to.modelLabel}`
                  : '';
                return (
                  <div className="session-event" role="status" key={message.id}>
                    <span className="session-event-line" />
                    <div className="model-switch-card">
                      <span className="model-switch-icon">↗</span>
                      <span className="model-switch-title">Model changed</span>
                      {modelEvent ? (
                        <span className="model-switch-models">
                          <code>{fromLabel}</code>
                          <b>→</b>
                          <code>{toLabel}</code>
                        </span>
                      ) : (
                        <span>{message.content}</span>
                      )}
                    </div>
                    <span className="session-event-line" />
                  </div>
                );
              }
              const reviewParsed =
                message.role === 'assistant'
                  ? parseReviewContent(message.content)
                  : { displayContent: message.content };
              const parsed: ReturnType<typeof parseInteractiveContent> =
                message.role === 'assistant'
                  ? parseInteractiveContent(reviewParsed.displayContent)
                  : { displayContent: reviewParsed.displayContent };
              const messageAgent = message.role === 'assistant' ? message.agent : undefined;
              const messageProviderLabel =
                messageAgent?.providerLabel ?? activeProvider?.label ?? 'Assistant';
              return (
                <article key={message.id} className={`message ${message.role} ${message.error ? 'error' : ''}`}>
                  <div className="message-avatar">
                    {message.role === 'user'
                      ? 'Y'
                      : <ProviderIcon provider={messageAgent?.provider ?? selection?.provider ?? 'codex'} />}
                  </div>
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{message.role === 'user' ? 'You' : messageProviderLabel}</strong>
                      <span>{message.error ? 'Error' : message.role === 'user' ? 'Sent' : 'Assistant'}</span>
                      {messageAgent && <code>{messageAgent.modelLabel}</code>}
                      {messageIndex < messages.length - 1 && (
                        <button
                          type="button"
                          className="rewind-message"
                          disabled={sending}
                          title="Return to this point and fold everything after it"
                          onClick={() => rewindToMessage(message.id)}
                        >
                          ↶ Rewind here
                        </button>
                      )}
                    </div>
                    {message.reasoning && <ReasoningCard reasoning={message.reasoning} />}
                    <div className="message-content" dir="auto">
                      {parsed.displayContent
                        ? renderMarkdownLite(parsed.displayContent)
                        : !parsed.question && !message.reasoning && (
                            <span className="typing-dots"><i /><i /><i /></span>
                          )}
                    </div>
                    {parsed.question && (
                      <InteractiveQuestion
                        question={parsed.question}
                        response={message.interactionResponse}
                        disabled={sending}
                        onSubmit={(response) =>
                          submitInteractiveAnswer(message.id, parsed.question!, response)
                        }
                      />
                    )}
                    {reviewParsed.review && (
                      <ReviewChanges
                        review={reviewParsed.review}
                        action={message.reviewAction}
                        disabled={sending}
                        onUndo={() => requestUndoChanges(message.id, reviewParsed.review!)}
                      />
                    )}
                    {message.error && (
                      <button type="button" className="retry-message" disabled={sending} onClick={() => retryAssistantMessage(messageIndex)}>
                        ↻ Retry this turn
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            <div ref={endRef} />
          </div>
        </section>

        <footer className="composer-wrap">
          <div className={`composer ${draft.trim() ? 'has-content' : ''}`}>
            <textarea
              ref={composerRef}
              value={draft}
              disabled={!activeProject?.workingDirectory?.trim()}
              rows={1}
              aria-label="Message the assistant"
              dir="auto"
              placeholder={connected ? `Message ${activeProvider?.label ?? 'the assistant'}…` : 'Connect this provider to start chatting…'}
              onChange={(event) => resizeComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-context">
                <span className={`mini-dot ${connected ? 'online' : ''}`} />
                <span>{activeProvider?.label ?? 'Provider'}</span>
                <i />
                <span>{selection?.effort ?? 'medium'} reasoning</span>
                {activePermission && (
                  <>
                    <i />
                    <span>{activePermission.label}</span>
                  </>
                )}
              </div>
              {sending ? (
                <button
                  type="button"
                  className="send-button queue"
                  disabled={!draft.trim()}
                  onClick={() => void send()}
                >
                  Queue <span>＋</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="send-button"
                  disabled={
                    !draft.trim() ||
                    !selection ||
                    !connected ||
                    !activeProject?.workingDirectory?.trim()
                  }
                  onClick={() => void send()}
                >
                  Send <span>↑</span>
                </button>
              )}
            </div>
          </div>
          <div className="composer-hint">
            <span><kbd>Enter</kbd> to send</span>
            <span><kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
            <span>Responses may contain mistakes.</span>
            <span
              className={contextCharacters > 24_000 ? 'context-budget exceeded' : 'context-budget'}
              title={contextCharacters > 24_000
                ? 'Older conversation text will be omitted from the next request.'
                : 'Conversation text included in the next request.'}
            >
              {Math.min(contextCharacters, 24_000).toLocaleString()} / 24,000 context
            </span>
            {sending && (
              <button type="button" onClick={() => activeRunKey && abortControllersRef.current.get(activeRunKey)?.abort()}>
                ■ Stop current run
              </button>
            )}
            {activeRunKey && Boolean(queueCounts[activeRunKey]) && <span>{queueCounts[activeRunKey]} queued</span>}
          </div>
        </footer>
      </section>

      <WorkspaceInspector
        messages={messages}
        open={inspectorOpen}
        collapsed={inspectorCollapsed}
        sending={sending}
        workingDirectory={activeWorkspace}
        onClose={() => setInspectorOpen(false)}
        onToggleCollapsed={() => setInspectorCollapsed((value) => !value)}
        onResize={setInspectorWidth}
        onUndo={(messageId, review) => requestUndoChanges(messageId, review)}
      />
      <ProductivityHub
        open={hubOpen}
        project={activeProject}
        session={activeSession}
        onClose={() => setHubOpen(false)}
        onMemoryChange={updateProjectMemory}
        onContextChange={(contextFiles) => updateActiveSession({ contextFiles })}
        onPlanChange={(plan: PlanItem[]) => updateActiveSession({ plan })}
        onCheckpoint={(checkpoint: ChatCheckpoint) =>
          updateActiveSession({ checkpoints: [...(activeSession?.checkpoints ?? []), checkpoint] })
        }
        onRestoreCheckpoint={(checkpoint) => {
          if (!window.confirm(`Restore "${checkpoint.label}" and fold later messages?`)) return;
          setMessages((current) => {
            const kept = current.slice(0, checkpoint.messageCount);
            const later = current.slice(checkpoint.messageCount);
            if (!later.length) return current;
            return [...kept, {
              id: id(),
              role: 'system',
              content: `${later.length} messages folded after restoring ${checkpoint.label}.`,
              sessionEvent: {
                type: 'folded-conversation',
                foldedAt: new Date().toISOString(),
                messages: later,
              },
            }];
          });
          setHubOpen(false);
        }}
        onWorktreeCreated={(worktreePath, worktreeBranch) =>
          updateActiveSession({ worktreePath, worktreeBranch })
        }
        onWorktreeRemoved={() =>
          updateActiveSession({ worktreePath: undefined, worktreeBranch: undefined })
        }
        onUseTemplate={(text) => {
          resizeComposer(text);
          requestAnimationFrame(() => composerRef.current?.focus());
        }}
      />
      {inspectorOpen && (
        <button
          type="button"
          className="inspector-backdrop"
          aria-label="Close workspace sidebar"
          onClick={() => setInspectorOpen(false)}
        />
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-icon">×</div>
            <div>
              <span className="modal-kicker">Permanent action</span>
              <h2 id="delete-title">Delete {deleteTarget.kind}?</h2>
              <p>
                “{deleteTarget.name}” and its saved history will be removed from this device.
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setDeleteTarget(undefined)}>Cancel</button>
              <button type="button" className="danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
