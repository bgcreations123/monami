import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderOpen, ChevronDown, RefreshCw, Search, Files, History, X,
  PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, TerminalSquare,
  Boxes, LoaderCircle, AlertTriangle, CircleCheck, FolderPlus,
  Code2, Sparkles, Circle, Trash2,
} from "lucide-react";
import CodeEditor from "./code/CodeEditor";
import FileTree from "./code/FileTree";
import CodeChat from "./code/CodeChat";
import TerminalPanel from "./code/TerminalPanel";
import DiffView from "./code/DiffView";
import {
  getCodeState, openCodeWorkspace, pickCodeWorkspace, getCodeTree,
  readCodeFile, writeCodeFile, createCodeEntry, deleteCodeEntry, renameCodeEntry,
  searchCode, runCodeCommand, getCodeChanges, revertCodeChange, clearCodeChanges,
  listCodeSessions, getCodeSession, saveCodeSession, deleteCodeSession,
  streamCodeAgent,
} from "../services/codeApi";
import { listLlmModels, getLlmStatus, startLlm, stopLlm, getBackendStatus, stopServer } from "../services/api";

const stripToolBlocks = (text) => String(text || "")
  .replace(/```tool\s*\n?[\s\S]*?```/gi, "")
  .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// While tokens stream in, a tool block may still be open. Hide it so the chat
// shows prose instead of half-written JSON.
const visibleProse = (text) => String(text || "")
  .replace(/```tool[\s\S]*?```/gi, "")
  .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
  .replace(/```tool[\s\S]*$/i, "")
  .replace(/<tool_call>[\s\S]*$/i, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const DEFAULT_SETTINGS = { temperature: 0.2, maxSteps: 12, allowCommands: false };

function readCodeSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem("codeSettings") || "{}");
    return {
      temperature: Number.isFinite(Number(parsed.temperature)) ? Number(parsed.temperature) : DEFAULT_SETTINGS.temperature,
      maxSteps: Number.isFinite(Number(parsed.maxSteps)) ? Number(parsed.maxSteps) : DEFAULT_SETTINGS.maxSteps,
      allowCommands: parsed.allowCommands === true,
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

let uid = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${uid += 1}`;

function fileTitle(messages) {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "Code session";
  const line = String(first.content || "").split("\n")[0].trim();
  return line.slice(0, 80) || "Code session";
}

export default function CodeStudio({
  showAlert,
  showConfirm,
  textSettings,
  activeSessionId,
  setActiveSessionId,
  onSessionsChanged,
  onOpenModels,
}) {
  // workspace + explorer
  const [workspace, setWorkspace] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [treeEntries, setTreeEntries] = useState([]);
  const [explorerTab, setExplorerTab] = useState("files");
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [explorerVisible, setExplorerVisible] = useState(() => localStorage.getItem("codeExplorerVisible") !== "false");
  const [chatVisible, setChatVisible] = useState(() => localStorage.getItem("codeChatVisible") !== "false");

  // files + tabs
  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState("");
  const [diffChange, setDiffChange] = useState(null);
  const [revealLine, setRevealLine] = useState(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // changes
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);

  // terminal
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalEntries, setTerminalEntries] = useState([]);
  const [terminalRunning, setTerminalRunning] = useState(false);

  // model
  const [models, setModels] = useState([]);
  const [llmStatus, setLlmStatus] = useState({ ready: false, model: "", contextSize: null });
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("selectedLlmModel") || "");
  const [loadingModel, setLoadingModel] = useState("");

  // chat
  const [sessionId, setSessionId] = useState(activeSessionId || null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [includeFile, setIncludeFile] = useState(true);
  const [settings, setSettings] = useState(readCodeSettings);
  const [contextChars, setContextChars] = useState(0);

  // prompt dialog
  const [promptDialog, setPromptDialog] = useState(null);

  const editorRef = useRef(null);
  const sessionRef = useRef(sessionId);
  const messagesRef = useRef(messages);
  const workspaceRef = useRef(workspace);
  const modelRef = useRef("");
  const abortRef = useRef(null);
  const runRef = useRef(null);
  const savedSessionRef = useRef(null);

  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => { localStorage.setItem("codeSettings", JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem("codeExplorerVisible", String(explorerVisible)); }, [explorerVisible]);
  useEffect(() => { localStorage.setItem("codeChatVisible", String(chatVisible)); }, [chatVisible]);

  modelRef.current = llmStatus.ready ? llmStatus.model : "";

  // Stop the in-flight agent run (if any) and tell the server to stop too, so a
  // session switch or folder change never leaves a stream running in the dark.
  const cancelRun = useCallback(() => {
    if (!abortRef.current) return;
    const previous = sessionRef.current;
    try { abortRef.current.abort(); } catch (_) {}
    abortRef.current = null;
    runRef.current = null;
    setBusy(false);
    if (previous) {
      fetch("/api/code/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: previous }),
      }).catch(() => {});
    }
  }, []);

  const askText = useCallback(({ title, label, value = "", placeholder = "", confirmLabel = "Create" }) => (
    new Promise((resolve) => {
      setPromptDialog({ title, label, value, placeholder, confirmLabel, resolve });
    })
  ), []);

  // ── state + model bootstrap ────────────────────────────────────────────────
  const refreshChanges = useCallback(async (id = sessionRef.current) => {
    setChangesLoading(true);
    try {
      const list = await getCodeChanges(id || "manual");
      setChanges(list);
    } catch (_) {
      setChanges([]);
    } finally {
      setChangesLoading(false);
    }
  }, []);

  const refreshTree = useCallback(() => setTreeVersion((value) => value + 1), []);

  const refreshState = useCallback(async () => {
    try {
      const data = await getCodeState();
      setWorkspace(data.workspace || "");
      setWorkspaceName(data.name || "");
      setRecentWorkspaces(data.recentWorkspaces || []);
      setLlmStatus({ ready: Boolean(data.llm?.ready), model: data.llm?.model || "", contextSize: data.llm?.contextSize || null });
      if (data.llm?.model) modelRef.current = data.llm.model;
      setTreeVersion((value) => value + 1);
    } catch (err) {
      showAlert?.({ title: "Workspace Error", message: err.message || String(err), danger: true });
    } finally {
      setLoadingState(false);
    }
  }, [showAlert]);

  const refreshModels = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([listLlmModels(), getLlmStatus()]);
      const selectable = (list || []).filter((model) => !model.isProjector);
      setModels(selectable);
      setLlmStatus({ ready: Boolean(status.ready), model: status.settings?.model || "", contextSize: status.settings?.contextSize || null });
      if (status.ready && status.settings?.model) {
        setSelectedModel(status.settings.model);
        setLoadingModel("");
      } else {
        setSelectedModel((current) => current || localStorage.getItem("selectedLlmModel") || selectable[0]?.filename || "");
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshState();
    refreshModels();
    const timer = setInterval(() => {
      getLlmStatus().then((status) => {
        setLlmStatus((prev) => {
          if (prev.ready === Boolean(status.ready) && prev.model === (status.settings?.model || "") && prev.contextSize === (status.settings?.contextSize || null)) return prev;
          return { ready: Boolean(status.ready), model: status.settings?.model || "", contextSize: status.settings?.contextSize || null };
        });
        if (status.ready && status.settings?.model) {
          setSelectedModel(status.settings.model);
          setLoadingModel("");
        }
      }).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [refreshState, refreshModels]);

  // Load the flat tree for quick-open whenever the workspace changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!workspace) { setTreeEntries([]); return; }
      try {
        const rootEntries = await getCodeTree(".");
        const collected = [];
        const folders = ["."];
        collected.push(...rootEntries);
        // one more level is enough for quick open and keeps this cheap
        for (const entry of rootEntries.filter((item) => item.type === "directory").slice(0, 40)) folders.push(entry.path);
        for (const folder of folders.slice(1)) {
          try {
            const children = await getCodeTree(folder);
            collected.push(...children);
          } catch (_) {}
        }
        if (!cancelled) setTreeEntries(collected);
      } catch (_) {
        if (!cancelled) setTreeEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace, treeVersion]);

  // ── workspace actions ──────────────────────────────────────────────────────
  const resetWorkspaceView = useCallback(() => {
    cancelRun();
    setTabs([]);
    setActivePath("");
    setDiffChange(null);
    setMessages([]);
    setSessionId(null);
    sessionRef.current = null;
    setActiveSessionId?.(null);
    setTreeEntries([]);
    setChanges([]);
  }, [cancelRun, setActiveSessionId]);

  const applyWorkspace = useCallback((data) => {
    setWorkspace(data.workspace || "");
    setWorkspaceName(data.name || "");
    setWorkspaceMenu(false);
    setTreeVersion((value) => value + 1);
    setDiffChange(null);
    setTabs([]);
    setActivePath("");
  }, []);

  const handleOpenFolder = useCallback(async () => {
    try {
      const data = await pickCodeWorkspace();
      if (data.cancelled) return;
      resetWorkspaceView();
      applyWorkspace(data);
    } catch (err) {
      showAlert?.({ title: "Could Not Open Folder", message: err.message || String(err), danger: true });
    }
  }, [applyWorkspace, resetWorkspaceView, showAlert]);

  const handleRecentFolder = useCallback(async (folder) => {
    try {
      const data = await openCodeWorkspace(folder);
      resetWorkspaceView();
      applyWorkspace(data);
    } catch (err) {
      showAlert?.({ title: "Could Not Open Folder", message: err.message || String(err), danger: true });
    }
  }, [applyWorkspace, resetWorkspaceView, showAlert]);

  // ── model actions ──────────────────────────────────────────────────────────
  const buildStartOptions = () => ({
    threads: textSettings?.threads,
    // Coding needs room for a file tree, file reads, and multi-step tool calls.
    contextSize: Math.max(8192, Number(textSettings?.contextSize) || 0),
    gpuLayers: textSettings?.gpuLayers ?? -1,
    enableThinking: textSettings?.enableThinking === true,
    flashAttn: textSettings?.flashAttn,
    cacheTypeK: textSettings?.cacheTypeK,
    cacheTypeV: textSettings?.cacheTypeV,
    mlock: textSettings?.mlock,
    mmap: textSettings?.mmap,
    cachePrompt: textSettings?.cachePrompt,
    defragThold: textSettings?.defragThold,
    batchSize: textSettings?.batchSize,
    ubatchSize: textSettings?.ubatchSize,
    performanceProfile: textSettings?.performanceProfile,
    preferredBackend: textSettings?.preferredBackend,
  });

  const handleLoadModel = useCallback(async (filename) => {
    if (!filename || loadingModel) return;
    const imageStatus = await getBackendStatus().catch(() => null);
    const imageModel = imageStatus?.ready && imageStatus.settings?.model
      ? imageStatus.settings.model.split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|gguf)$/i, "")
      : null;
    if (imageModel) {
      const confirmed = await showConfirm?.({
        title: "Unload the image model?",
        message: `${imageModel} is loaded for images. Monami can only keep one large model in memory, so it will be unloaded to load ${filename.replace(/\.gguf$/i, "")}.`,
        confirmLabel: "Unload and load",
      });
      if (!confirmed) return;
    }
    setLoadingModel(filename);
    setSelectedModel(filename);
    localStorage.setItem("selectedLlmModel", filename);
    try {
      if (imageModel) await stopServer();
      const result = await startLlm(filename, buildStartOptions());
      setLlmStatus({ ready: true, model: result.settings?.model || filename, contextSize: result.settings?.contextSize || null });
    } catch (err) {
      showAlert?.({ title: "Text Model Load Failed", message: err.message || String(err), danger: true });
    } finally {
      setLoadingModel("");
    }
  }, [loadingModel, showAlert, showConfirm, textSettings]);

  const handleUnloadModel = useCallback(async () => {
    try {
      await stopLlm();
      setLlmStatus({ ready: false, model: "", contextSize: null });
    } catch (err) {
      showAlert?.({ title: "Unload Failed", message: err.message || String(err), danger: true });
    }
  }, [showAlert]);

  // ── session persistence ────────────────────────────────────────────────────
  const persistSession = useCallback(async (messageList, id, ws) => {
    const targetId = id || sessionRef.current;
    if (!targetId || !messageList.length) return;
    const conversation = {
      id: targetId,
      title: fileTitle(messageList),
      workspace: ws || workspaceRef.current || "",
      model: modelRef.current || "",
      timestamp: Date.now(),
      messages: messageList.map((message) => ({
        role: message.role,
        content: message.role === "assistant" ? stripToolBlocks(message.content) : message.content,
        ...(Array.isArray(message.tools) && message.tools.length ? {
          tools: message.tools.map((tool) => ({
            id: tool.id, tool: tool.tool, summary: tool.summary, ok: tool.ok !== false, detail: tool.detail || "",
          })),
        } : {}),
      })),
    };
    try {
      await saveCodeSession(conversation);
      savedSessionRef.current = targetId;
      onSessionsChanged?.();
    } catch (err) {
      console.warn("Could not save code session:", err);
    }
  }, [onSessionsChanged]);

  // Load a session chosen from the sidebar
  useEffect(() => {
    if (!activeSessionId) {
      if (sessionRef.current) {
        cancelRun();
        persistSession(messagesRef.current, sessionRef.current, workspaceRef.current);
      }
      setSessionId(null);
      sessionRef.current = null;
      setMessages([]);
      return;
    }
    if (activeSessionId === sessionRef.current) return;
    cancelRun();
    let cancelled = false;
    (async () => {
      try {
        const conversation = await getCodeSession(activeSessionId);
        if (cancelled) return;
        setSessionId(conversation.id);
        sessionRef.current = conversation.id;
        setMessages((conversation.messages || []).map((message, index) => ({
          id: `loaded_${index}`,
          role: message.role,
          content: message.content || "",
          prose: message.role === "assistant" ? message.content || "" : undefined,
          tools: message.tools || [],
          streaming: false,
        })));
        if (conversation.workspace && conversation.workspace !== workspaceRef.current) {
          try {
            const data = await openCodeWorkspace(conversation.workspace);
            setWorkspace(data.workspace);
            setWorkspaceName(data.name);
            setTreeVersion((value) => value + 1);
          } catch (_) {}
        }
      } catch (err) {
        showAlert?.({ title: "Could Not Open Session", message: err.message || String(err), danger: true });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Refresh change history when the session changes
  useEffect(() => {
    refreshChanges(sessionId);
  }, [sessionId, refreshChanges]);

  // ── file tabs ──────────────────────────────────────────────────────────────
  const openFile = useCallback(async (path, line = null) => {
    setDiffChange(null);
    const existing = tabs.find((tab) => tab.path === path);
    if (existing) {
      setActivePath(path);
      if (line) setRevealLine({ path, line, nonce: Date.now() });
      return;
    }
    try {
      const file = await readCodeFile(path);
      setTabs((prev) => [...prev, {
        path: file.path,
        content: file.content,
        original: file.content,
        language: file.language,
        dirty: false,
      }]);
      setActivePath(file.path);
      if (line) setRevealLine({ path: file.path, line, nonce: Date.now() });
    } catch (err) {
      showAlert?.({ title: "Could Not Open File", message: err.message || String(err), danger: true });
    }
  }, [tabs, showAlert]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) || null, [tabs, activePath]);

  const updateActiveContent = useCallback((value) => {
    setTabs((prev) => prev.map((tab) => (
      tab.path === activePath ? { ...tab, content: value, dirty: value !== tab.original } : tab
    )));
  }, [activePath]);

  const saveActive = useCallback(async () => {
    const tab = tabs.find((item) => item.path === activePath);
    if (!tab || !tab.dirty) return;
    try {
      await writeCodeFile(tab.path, tab.content, sessionRef.current || "manual");
      setTabs((prev) => prev.map((item) => (
        item.path === tab.path ? { ...item, original: item.content, dirty: false } : item
      )));
      refreshChanges();
      refreshTree();
    } catch (err) {
      showAlert?.({ title: "Save Failed", message: err.message || String(err), danger: true });
    }
  }, [tabs, activePath, refreshChanges, refreshTree, showAlert]);

  const closeTab = useCallback(async (path) => {
    const tab = tabs.find((item) => item.path === path);
    if (tab?.dirty) {
      const confirmed = await showConfirm?.({
        title: "Discard unsaved changes?",
        message: `${path} has unsaved changes. Close it anyway?`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!confirmed) return;
    }
    setTabs((prev) => {
      const next = prev.filter((item) => item.path !== path);
      if (activePath === path) setActivePath(next.length ? next[next.length - 1].path : "");
      return next;
    });
  }, [tabs, activePath, showConfirm]);

  const handleCreateEntry = useCallback(async (type, baseFolder) => {
    const label = type === "directory" ? "New folder path" : "New file path";
    const hint = baseFolder ? `${baseFolder}/` : "src/example.js";
    const value = await askText({
      title: type === "directory" ? "Create Folder" : "Create File",
      label,
      placeholder: hint,
      value: baseFolder ? `${baseFolder}/` : "",
      confirmLabel: "Create",
    });
    if (!value) return;
    try {
      await createCodeEntry(value, type, sessionRef.current || "manual");
      refreshTree();
      refreshChanges();
      if (type !== "directory") openFile(value);
    } catch (err) {
      showAlert?.({ title: "Create Failed", message: err.message || String(err), danger: true });
    }
  }, [askText, openFile, refreshChanges, refreshTree, showAlert]);

  const handleRenameEntry = useCallback(async (node) => {
    const value = await askText({
      title: "Rename",
      label: "New path",
      value: node.path,
      placeholder: node.path,
      confirmLabel: "Rename",
    });
    if (!value || value === node.path) return;
    try {
      await renameCodeEntry(node.path, value, sessionRef.current || "manual");
      setTabs((prev) => {
        const next = prev.filter((tab) => tab.path !== node.path && !tab.path.startsWith(`${node.path}/`));
        if (activePath === node.path || activePath.startsWith(`${node.path}/`)) setActivePath(next.length ? next[next.length - 1].path : "");
        return next;
      });
      refreshTree();
      refreshChanges();
    } catch (err) {
      showAlert?.({ title: "Rename Failed", message: err.message || String(err), danger: true });
    }
  }, [askText, activePath, refreshChanges, refreshTree, showAlert]);

  const handleDeleteEntry = useCallback(async (node) => {
    const confirmed = await showConfirm?.({
      title: "Delete from disk?",
      message: `Delete "${node.path}"? ${node.type === "directory" ? "Everything inside it will be removed. " : ""}Text files can be restored from the Changes tab.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteCodeEntry(node.path, sessionRef.current || "manual");
      setTabs((prev) => {
        const next = prev.filter((tab) => tab.path !== node.path && !tab.path.startsWith(`${node.path}/`));
        if (activePath === node.path || activePath.startsWith(`${node.path}/`)) setActivePath(next.length ? next[next.length - 1].path : "");
        return next;
      });
      refreshTree();
      refreshChanges();
    } catch (err) {
      showAlert?.({ title: "Delete Failed", message: err.message || String(err), danger: true });
    }
  }, [activePath, refreshChanges, refreshTree, showAlert, showConfirm]);

  const handleSearch = useCallback(async (event) => {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (!query) { setSearchResults([]); return; }
    setSearching(true);
    try {
      setSearchResults(await searchCode(query, ".", 60));
    } catch (err) {
      showAlert?.({ title: "Search Failed", message: err.message || String(err), danger: true });
    } finally {
      setSearching(false);
    }
  }, [searchQuery, showAlert]);

  const handleRevertChange = useCallback(async (change) => {
    const confirmed = await showConfirm?.({
      title: "Undo this change?",
      message: `Restore the previous version of "${change.path}"?`,
      confirmLabel: "Undo",
    });
    if (!confirmed) return;
    try {
      await revertCodeChange(sessionRef.current || "manual", change.id);
      refreshChanges();
      refreshTree();
      if (change.action === "rename") {
        setTabs((prev) => prev.map((tab) => (tab.path === change.note ? { ...tab, path: change.path } : tab)));
        if (activePath === change.note) setActivePath(change.path);
      } else if (change.action === "create") {
        setTabs((prev) => {
          const next = prev.filter((tab) => tab.path !== change.path);
          if (activePath === change.path) setActivePath(next.length ? next[next.length - 1].path : "");
          return next;
        });
      } else if (tabs.some((tab) => tab.path === change.path)) {
        const file = await readCodeFile(change.path).catch(() => null);
        if (file) {
          setTabs((prev) => prev.map((tab) => (tab.path === change.path ? { ...tab, content: file.content, original: file.content, dirty: false } : tab)));
        }
      }
    } catch (err) {
      showAlert?.({ title: "Undo Failed", message: err.message || String(err), danger: true });
    }
  }, [refreshChanges, refreshTree, showAlert, showConfirm, tabs]);

  const handleClearChanges = useCallback(async () => {
    const confirmed = await showConfirm?.({
      title: "Clear change history?",
      message: "Backups for this session will be deleted. Your files stay exactly as they are, but these changes can no longer be undone.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await clearCodeChanges(sessionRef.current || "manual");
      setChanges([]);
    } catch (err) {
      showAlert?.({ title: "Could Not Clear History", message: err.message || String(err), danger: true });
    }
  }, [showAlert, showConfirm]);

  // ── terminal ───────────────────────────────────────────────────────────────
  const runTerminalCommand = useCallback(async (command) => {
    const entryId = nextId("term");
    setTerminalEntries((prev) => [...prev, { id: entryId, command, running: true }]);
    setTerminalRunning(true);
    try {
      const result = await runCodeCommand(command, ".", 180000);
      setTerminalEntries((prev) => prev.map((entry) => (
        entry.id === entryId
          ? {
              ...entry,
              running: false,
              code: result.code,
              stdout: result.stdout || "",
              stderr: result.stderr || "",
              error: result.timedOut ? "Command timed out after 3 minutes." : "",
            }
          : entry
      )));
      refreshTree();
      refreshChanges();
    } catch (err) {
      setTerminalEntries((prev) => prev.map((entry) => (
        entry.id === entryId ? { ...entry, running: false, error: err.message || String(err) } : entry
      )));
    } finally {
      setTerminalRunning(false);
    }
  }, [refreshChanges, refreshTree]);

  // ── chat ───────────────────────────────────────────────────────────────────
  const patchAssistant = useCallback((assistantId, patch) => {
    setMessages((prev) => prev.map((message) => (message.id === assistantId ? { ...message, ...patch } : message)));
  }, []);

  const handleSend = useCallback(async (text) => {
    if (!llmStatus.ready) {
      showAlert?.({ title: "Load a Text Model", message: "Open the model menu at the top and load a GGUF model before coding.", danger: true });
      return;
    }
    if (!workspace) {
      showAlert?.({ title: "Open a Project", message: "Choose a project folder first. The assistant needs a workspace to read and edit.", danger: true });
      return;
    }

    let id = sessionRef.current;
    if (!id) {
      id = `code_${Date.now()}`;
      sessionRef.current = id;
      setSessionId(id);
      setActiveSessionId?.(id);
    }

    const userMessage = { id: nextId("u"), role: "user", content: text };
    const assistantId = nextId("a");
    const assistantMessage = { id: assistantId, role: "assistant", content: "", prose: "", tools: [], streaming: true };

    const history = messagesRef.current
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: message.role === "assistant" ? stripToolBlocks(message.prose ?? message.content) : message.content,
      }));

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setBusy(true);
    setDiffChange(null);

    let selection = "";
    if (includeFile && editorRef.current && activePath) {
      const node = editorRef.current;
      if (node.selectionStart !== node.selectionEnd) {
        selection = node.value.slice(node.selectionStart, node.selectionEnd).slice(0, 6000);
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    runRef.current = { assistantId, committed: "", step: "" };

    const refreshRunState = (patch = {}) => {
      const run = runRef.current;
      if (!run) return;
      const content = visibleProse(run.committed + (run.committed && run.step ? "\n\n" : "") + run.step);
      patchAssistant(run.assistantId, { content, prose: content, ...patch });
    };

    try {
      await streamCodeAgent({
        sessionId: id,
        messages: history,
        input: text,
        settings,
        context: {
          openFile: includeFile && activePath ? { path: activePath } : null,
          selection: selection || "",
        },
      }, {
        onStep: () => { /* step boundaries are handled by assistant events */ },
        onToken: (token) => {
          if (!runRef.current) return;
          runRef.current.step += token;
          refreshRunState({ streaming: true });
        },
        onReasoning: () => {},
        onAssistant: (payload) => {
          if (!runRef.current) return;
          const run = runRef.current;
          const prose = visibleProse(payload.prose ?? stripToolBlocks(payload.content));
          if (prose) {
            run.committed = run.committed ? `${run.committed}\n\n${prose}` : prose;
          }
          run.step = "";
          refreshRunState({ streaming: true });
        },
        onToolStart: (payload) => {
          setMessages((prev) => prev.map((message) => (
            message.id === assistantId
              ? {
                  ...message,
                  tools: [...(message.tools || []), { id: payload.id, tool: payload.tool, summary: payload.summary, pending: true }],
                }
              : message
          )));
        },
        onToolResult: (payload) => {
          setMessages((prev) => prev.map((message) => (
            message.id === assistantId
              ? {
                  ...message,
                  tools: (message.tools || []).map((tool) => (
                    tool.id === payload.id
                      ? { ...tool, pending: false, ok: payload.ok !== false, detail: payload.detail, summary: payload.summary || tool.summary }
                      : tool
                  )),
                }
              : message
          )));
        },
        onDone: (payload) => {
          const run = runRef.current;
          if (!run) return;
          if (run.step) {
            run.committed = visibleProse(run.committed ? `${run.committed}\n\n${run.step}` : run.step);
            run.step = "";
          }
          if (!run.committed && payload.content) run.committed = visibleProse(payload.content);
          patchAssistant(run.assistantId, { content: run.committed, prose: run.committed, streaming: false });
          setMessages((prev) => {
            const finalMessages = prev.map((message) => (
              message.id === assistantId ? { ...message, streaming: false } : message
            ));
            persistSession(finalMessages, id, workspaceRef.current);
            return finalMessages;
          });
          refreshTree();
          refreshChanges(id);
        },
        onError: (message) => {
          if (!runRef.current) return;
          patchAssistant(assistantId, { content: message, prose: message, streaming: false, error: true });
          setMessages((prev) => {
            persistSession(prev, id, workspaceRef.current);
            return prev;
          });
        },
      }, controller.signal);
    } catch (err) {
      if (err.name !== "AbortError") {
        patchAssistant(assistantId, { content: err.message || String(err), prose: err.message || String(err), streaming: false, error: true });
      } else {
        patchAssistant(assistantId, { streaming: false });
      }
    } finally {
      abortRef.current = null;
      runRef.current = null;
      setBusy(false);
    }
  }, [llmStatus.ready, workspace, includeFile, activePath, settings, patchAssistant, persistSession, refreshTree, refreshChanges, setActiveSessionId, showAlert]);

  const handleStop = useCallback(async () => {
    try {
      await fetch("/api/code/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionRef.current }),
      });
    } catch (_) {}
    abortRef.current?.abort();
  }, []);

  const handleNewSession = useCallback(async () => {
    if (messagesRef.current.length) {
      await persistSession(messagesRef.current, sessionRef.current, workspaceRef.current);
    }
    setMessages([]);
    setInput("");
    setSessionId(null);
    sessionRef.current = null;
    setActiveSessionId?.(null);
    setDiffChange(null);
  }, [persistSession, setActiveSessionId]);

  const handleClearChat = useCallback(async () => {
    const confirmed = await showConfirm?.({
      title: "Clear this conversation?",
      message: "The chat history for this code session will be deleted. Files on disk are not touched.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!confirmed) return;
    const id = sessionRef.current;
    setMessages([]);
    setInput("");
    if (id) {
      try { await deleteCodeSession(id); } catch (_) {}
      await persistSession([], id, workspaceRef.current).catch(() => {});
    }
    setSessionId(null);
    sessionRef.current = null;
    setActiveSessionId?.(null);
    onSessionsChanged?.();
  }, [onSessionsChanged, persistSession, setActiveSessionId, showConfirm]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event) => {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        setQuickOpen((value) => !value);
        setQuickQuery("");
      } else if (key === "j") {
        event.preventDefault();
        setTerminalOpen((value) => !value);
      } else if (key === "s") {
        event.preventDefault();
        saveActive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  // ── derived ────────────────────────────────────────────────────────────────
  const ready = llmStatus.ready && Boolean(workspace);
  const modelLabel = llmStatus.model
    ? llmStatus.model.replace(/\.gguf$/i, "")
    : selectedModel.replace(/\.gguf$/i, "");
  const quickResults = useMemo(() => {
    const query = quickQuery.trim().toLowerCase();
    const files = treeEntries.filter((entry) => entry.type === "file");
    if (!query) return files.slice(0, 40);
    return files.filter((entry) => entry.path.toLowerCase().includes(query)).slice(0, 40);
  }, [treeEntries, quickQuery]);

  return (
    <div className="code-studio">
      {/* top bar */}
      <header className="code-topbar">
        <div className="code-topbar-left">
          <button
            type="button"
            className="code-icon-btn"
            onClick={() => setExplorerVisible((value) => !value)}
            title={explorerVisible ? "Hide explorer" : "Show explorer"}
          >
            {explorerVisible ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
          </button>

          <div className="code-workspace-picker">
            <button
              type="button"
              className="code-workspace-btn"
              onClick={() => setWorkspaceMenu((value) => !value)}
              aria-expanded={workspaceMenu}
            >
              <FolderOpen size={16} />
              <span className="code-workspace-name">{workspaceName || (loadingState ? "Opening…" : "Open a project")}</span>
              <ChevronDown size={14} />
            </button>
            {workspaceMenu && (
              <>
                <div className="code-menu-scrim" onClick={() => setWorkspaceMenu(false)} role="presentation" />
                <div className="code-workspace-menu">
                  <button type="button" className="code-workspace-item primary" onClick={handleOpenFolder}>
                    <FolderOpen size={15} /> Open folder…
                  </button>
                  {recentWorkspaces.length > 0 && <div className="code-menu-label">Recent</div>}
                  {recentWorkspaces.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      className={`code-workspace-item ${folder === workspace ? "current" : ""}`}
                      onClick={() => handleRecentFolder(folder)}
                      title={folder}
                    >
                      <FolderOpen size={14} />
                      <span className="code-workspace-item-name">{folder.split(/[\\/]/).pop()}</span>
                      <span className="code-workspace-item-path">{folder}</span>
                    </button>
                  ))}
                  {workspace && (
                    <>
                      <div className="code-menu-divider" />
                      <button type="button" className="code-workspace-item" onClick={() => setWorkspaceMenu(false)}>
                        <X size={14} /> Close menu
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="code-topbar-actions">
            <button type="button" className="code-icon-btn" onClick={refreshTree} title="Refresh files">
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              className={`code-icon-btn ${terminalOpen ? "active" : ""}`}
              onClick={() => setTerminalOpen((value) => !value)}
              title="Terminal (Ctrl+J)"
            >
              <TerminalSquare size={16} />
            </button>
          </div>
        </div>

        <div className="code-topbar-right">
          <div className="code-model-control">
            {llmStatus.ready ? (
              <>
                <span className="code-model-chip" title={llmStatus.model}>
                  <Circle size={8} className="code-model-dot" />
                  {modelLabel || "Model loaded"}
                </span>
                <button type="button" className="code-model-action" onClick={handleUnloadModel} title="Unload the text model">
                  Unload
                </button>
              </>
            ) : loadingModel ? (
              <span className="code-model-chip loading"><LoaderCircle size={13} className="spin" /> Loading {loadingModel.replace(/\.gguf$/i, "")}</span>
            ) : (
              <>
                <select
                  className="code-model-select"
                  value={selectedModel}
                  onChange={(event) => handleLoadModel(event.target.value)}
                  aria-label="Load a text model"
                >
                  <option value="">{models.length ? "Load a text model…" : "No GGUF models installed"}</option>
                  {models.map((model) => (
                    <option key={model.filename} value={model.filename}>
                      {model.filename.replace(/\.gguf$/i, "")}
                    </option>
                  ))}
                </select>
                {models.length === 0 && onOpenModels && (
                  <button type="button" className="code-model-action" onClick={onOpenModels} title="Open the model manager">
                    Get a model
                  </button>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            className="code-icon-btn"
            onClick={() => setChatVisible((value) => !value)}
            title={chatVisible ? "Hide assistant" : "Show assistant"}
          >
            {chatVisible ? <PanelRightClose size={17} /> : <PanelRight size={17} />}
          </button>
        </div>
      </header>

      <div className={`code-body ${explorerVisible ? "" : "no-explorer"} ${chatVisible ? "" : "no-chat"} ${terminalOpen ? "with-terminal" : ""}`}>
        {/* explorer */}
        {explorerVisible && (
          <aside className="code-explorer">
            <div className="code-explorer-tabs">
              <button type="button" className={explorerTab === "files" ? "active" : ""} onClick={() => setExplorerTab("files")}>
                <Files size={14} /> Files
              </button>
              <button type="button" className={explorerTab === "search" ? "active" : ""} onClick={() => setExplorerTab("search")}>
                <Search size={14} /> Search
              </button>
              <button type="button" className={explorerTab === "changes" ? "active" : ""} onClick={() => { setExplorerTab("changes"); refreshChanges(); }}>
                <History size={14} /> Changes
                {changes.length > 0 && <span className="code-explorer-badge">{changes.length}</span>}
              </button>
            </div>

            {explorerTab === "files" && (
              workspace ? (
                <FileTree
                  rootName={workspaceName}
                  version={treeVersion}
                  activePath={activePath}
                  onOpenFile={openFile}
                  onRequestCreate={handleCreateEntry}
                  onRequestRename={handleRenameEntry}
                  onRequestDelete={handleDeleteEntry}
                />
              ) : (
                <div className="code-explorer-empty">
                  <FolderPlus size={26} />
                  <h4>No project open</h4>
                  <p>Open a folder to browse and edit its files.</p>
                  <button type="button" className="code-primary-btn" onClick={handleOpenFolder}>
                    <FolderOpen size={15} /> Open folder
                  </button>
                </div>
              )
            )}

            {explorerTab === "search" && (
              <div className="code-search">
                <form className="code-search-box" onSubmit={handleSearch}>
                  <Search size={14} />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search in files…"
                    aria-label="Search in files"
                    autoFocus
                  />
                  {searchQuery && (
                    <button type="button" onClick={() => { setSearchQuery(""); setSearchResults([]); }} aria-label="Clear search">
                      <X size={13} />
                    </button>
                  )}
                </form>
                {searching && <div className="code-search-status"><LoaderCircle size={13} className="spin" /> Searching…</div>}
                {!searching && searchResults.length > 0 && (
                  <div className="code-search-results">
                    {searchResults.map((result, index) => (
                      <button
                        key={`${result.path}:${result.line}:${index}`}
                        type="button"
                        className="code-search-result"
                        onClick={() => openFile(result.path, result.line)}
                        title={`${result.path}:${result.line}`}
                      >
                        <span className="code-search-result-path">{result.path}<em>:{result.line}</em></span>
                        <span className="code-search-result-preview">{result.preview}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!searching && searchQuery && searchResults.length === 0 && (
                  <div className="code-search-status">No matches.</div>
                )}
              </div>
            )}

            {explorerTab === "changes" && (
              <div className="code-changes">
                <div className="code-changes-head">
                  <span>{changes.length} change{changes.length === 1 ? "" : "s"} this session</span>
                  <span className="code-changes-actions">
                    <button type="button" onClick={() => refreshChanges()} title="Refresh changes">
                      <RefreshCw size={13} />
                    </button>
                    <button type="button" onClick={handleClearChanges} title="Clear change history" disabled={!changes.length}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {changesLoading && <div className="code-search-status"><LoaderCircle size={13} className="spin" /> Loading…</div>}
                {!changesLoading && changes.length === 0 && (
                  <div className="code-changes-empty">
                    <History size={22} />
                    <p>File edits made here will appear with an undo button.</p>
                  </div>
                )}
                {changes.map((change) => (
                  <button
                    key={change.id}
                    type="button"
                    className={`code-change-row ${diffChange?.id === change.id ? "active" : ""}`}
                    onClick={() => { setDiffChange(change); setActivePath(""); }}
                  >
                    <span className={`code-change-action ${change.action}`}>{change.action.slice(0, 3)}</span>
                    <span className="code-change-info">
                      <span className="code-change-path">{change.path}</span>
                      <span className="code-change-stats">
                        {change.additions > 0 && <em className="add">+{change.additions}</em>}
                        {change.deletions > 0 && <em className="del">−{change.deletions}</em>}
                        <span>{change.note || change.action}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}

        {/* editor area */}
        <section className="code-main">
          <div className="code-tabbar">
            <div className="code-tabs">
              {diffChange && (
                <div className="code-tab diff active">
                  <Sparkles size={13} />
                  <span>Changes: {diffChange.path.split("/").pop()}</span>
                  <button type="button" onClick={() => setDiffChange(null)} aria-label="Close diff"><X size={13} /></button>
                </div>
              )}
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`code-tab ${tab.path === activePath && !diffChange ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setDiffChange(null); setActivePath(tab.path); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDiffChange(null); setActivePath(tab.path); }
                  }}
                  title={tab.path}
                >
                  <span className="code-tab-name">{tab.path.split("/").pop()}</span>
                  {tab.dirty && <span className="code-tab-dirty" />}
                  <button
                    type="button"
                    className="code-tab-close"
                    onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}
                    aria-label={`Close ${tab.path}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {!diffChange && tabs.length === 0 && <span className="code-tabbar-hint">No open editors</span>}
            </div>
            <div className="code-tabbar-actions">
              <button type="button" onClick={() => setQuickOpen(true)} title="Quick open (Ctrl+P)">
                <Search size={14} /> Quick open
              </button>
            </div>
          </div>

          <div className="code-editor-region">
            {diffChange ? (
              <DiffView change={diffChange} onRevert={handleRevertChange} onOpen={openFile} />
            ) : (
              <CodeEditor
                tab={activeTab}
                onChange={updateActiveContent}
                onSave={saveActive}
                editorRef={editorRef}
                revealLine={revealLine}
                onSelectionChange={(start, end) => setContextChars(end > start ? end - start : 0)}
              />
            )}
          </div>

          <TerminalPanel
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            onRun={runTerminalCommand}
            running={terminalRunning}
            entries={terminalEntries}
            onClear={() => setTerminalEntries([])}
            cwd={workspaceName || "."}
          />
        </section>

        {/* chat */}
        {chatVisible && (
          <CodeChat
            messages={messages}
            input={input}
            setInput={setInput}
            onSend={handleSend}
            onStop={handleStop}
            busy={busy}
            ready={ready}
            modelReady={llmStatus.ready}
            modelLabel={modelLabel}
            activeFile={activePath}
            includeFile={includeFile}
            setIncludeFile={setIncludeFile}
            settings={settings}
            setSettings={setSettings}
            onClearChat={handleClearChat}
            onNewSession={handleNewSession}
            workspaceName={workspaceName}
            contextChars={contextChars}
          />
        )}
      </div>

      {/* quick open palette */}
      {quickOpen && (
        <div className="code-palette-backdrop" role="presentation" onMouseDown={() => setQuickOpen(false)}>
          <div className="code-palette" role="dialog" aria-modal="true" aria-label="Quick open" onMouseDown={(event) => event.stopPropagation()}>
            <div className="code-palette-input">
              <Search size={15} />
              <input
                autoFocus
                value={quickQuery}
                onChange={(event) => setQuickQuery(event.target.value)}
                placeholder="Search files by name"
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuickOpen(false);
                  if (event.key === "Enter" && quickResults[0]) {
                    event.preventDefault();
                    openFile(quickResults[0].path);
                    setQuickOpen(false);
                  }
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div className="code-palette-results">
              {quickResults.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="code-palette-item"
                  onClick={() => { openFile(entry.path); setQuickOpen(false); }}
                >
                  <Code2 size={14} />
                  <span>{entry.path}</span>
                </button>
              ))}
              {quickResults.length === 0 && <div className="code-palette-empty">No matching files.</div>}
            </div>
          </div>
        </div>
      )}

      {/* text prompt dialog */}
      {promptDialog && (
        <div className="code-palette-backdrop" role="presentation">
          <div className="code-prompt" role="dialog" aria-modal="true" aria-label={promptDialog.title}>
            <h3>{promptDialog.title}</h3>
            <label>
              <span>{promptDialog.label}</span>
              <input
                autoFocus
                value={promptDialog.value}
                placeholder={promptDialog.placeholder}
                onChange={(event) => setPromptDialog((prev) => ({ ...prev, value: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    promptDialog.resolve(promptDialog.value.trim());
                    setPromptDialog(null);
                  } else if (event.key === "Escape") {
                    promptDialog.resolve("");
                    setPromptDialog(null);
                  }
                }}
              />
            </label>
            <div className="code-prompt-actions">
              <button type="button" className="code-ghost-btn" onClick={() => { promptDialog.resolve(""); setPromptDialog(null); }}>
                Cancel
              </button>
              <button
                type="button"
                className="code-primary-btn"
                onClick={() => { promptDialog.resolve(promptDialog.value.trim()); setPromptDialog(null); }}
                disabled={!promptDialog.value.trim()}
              >
                {promptDialog.confirmLabel || "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* status bar */}
      <footer className="code-statusbar">
        <span className={`code-statusbar-item ${ready ? "ok" : "warn"}`}>
          {ready ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
          {ready ? "Ready" : !workspace ? "No folder open" : "Model not loaded"}
        </span>
        <span className="code-statusbar-item"><Boxes size={13} /> {tabs.length} open</span>
        <span className="code-statusbar-item"><History size={13} /> {changes.length} changes</span>
        <span className="code-statusbar-spacer" />
        <span className="code-statusbar-item subtle">{workspace || "Offline coding workspace"}</span>
      </footer>
    </div>
  );
}
