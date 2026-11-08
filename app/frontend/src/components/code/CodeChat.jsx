import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp, Square, Sparkles, Settings2, Trash2, FileCode2, Check, X,
  TerminalSquare, FilePlus2, FilePenLine, Search, FolderTree, LoaderCircle,
  Copy, CheckCheck, Wrench,
} from "lucide-react";

const TOOL_ICONS = {
  list_files: FolderTree,
  read_file: FileCode2,
  write_file: FilePenLine,
  create_file: FilePlus2,
  edit_file: FilePenLine,
  delete_file: Trash2,
  rename_file: FilePenLine,
  search_files: Search,
  run_command: TerminalSquare,
};

const stripToolBlocks = (text) => String(text || "")
  .replace(/```tool\s*\n?[\s\S]*?```/gi, "")
  .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

function InlineText({ text }) {
  const nodes = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key++} className="code-inline">{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (_) {}
  };
  return (
    <div className="code-chat-code">
      <div className="code-chat-code-head">
        <span>{language || "code"}</span>
        <button type="button" onClick={copy} title="Copy code">
          {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function Markdown({ text }) {
  const source = String(text || "");
  const segments = [];
  const fence = /```([a-zA-Z0-9+#._-]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  let key = 0;
  while ((match = fence.exec(source)) !== null) {
    if (match.index > last) segments.push({ type: "text", value: source.slice(last, match.index), key: key++ });
    segments.push({ type: "code", language: match[1], value: match[2], key: key++ });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ type: "text", value: source.slice(last), key: key++ });

  return (
    <div className="code-chat-markdown">
      {segments.map((segment) => {
        if (segment.type === "code") {
          return <CodeBlock key={segment.key} language={segment.language} code={segment.value.replace(/\n$/, "")} />;
        }
        const lines = segment.value.split(/\r?\n/);
        return (
          <React.Fragment key={segment.key}>
            {lines.map((line, index) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={index} className="code-chat-gap" />;
              const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
              if (heading) {
                const level = Math.min(4, heading[1].length);
                const Tag = `h${level + 2}`;
                return <Tag key={index} className="code-chat-heading"><InlineText text={heading[2]} /></Tag>;
              }
              const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
              if (bullet) {
                return (
                  <div key={index} className="code-chat-bullet">
                    <span aria-hidden="true">•</span>
                    <span><InlineText text={bullet[1]} /></span>
                  </div>
                );
              }
              const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
              if (numbered) {
                return (
                  <div key={index} className="code-chat-bullet">
                    <span aria-hidden="true">{numbered[1]}.</span>
                    <span><InlineText text={numbered[2]} /></span>
                  </div>
                );
              }
              return <p key={index} className="code-chat-paragraph"><InlineText text={line} /></p>;
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ToolCard({ tool }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.tool] || Wrench;
  const hasDetail = Boolean(tool.detail);
  return (
    <div className={`code-tool-card ${tool.ok === false ? "failed" : ""} ${tool.pending ? "pending" : ""}`}>
      <button
        type="button"
        className="code-tool-head"
        onClick={() => hasDetail && setOpen((value) => !value)}
        aria-expanded={hasDetail ? open : undefined}
      >
        <span className="code-tool-icon">
          {tool.pending ? <LoaderCircle size={13} className="spin" /> : <Icon size={13} />}
        </span>
        <span className="code-tool-name">{tool.tool.replace(/_/g, " ")}</span>
        <span className="code-tool-summary">{tool.summary}</span>
        <span className="code-tool-state">
          {tool.pending ? null : tool.ok === false ? <X size={13} /> : <Check size={13} />}
        </span>
      </button>
      {open && hasDetail && <pre className="code-tool-detail">{tool.detail}</pre>}
    </div>
  );
}

function MessageBubble({ message }) {
  if (message.role === "user") {
    return (
      <div className="code-msg user">
        <div className="code-msg-body">{message.content}</div>
      </div>
    );
  }

  const prose = message.prose ?? stripToolBlocks(message.content);
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const empty = !prose && tools.length === 0;

  return (
    <div className={`code-msg assistant ${message.error ? "error" : ""}`}>
      <div className={`code-msg-avatar ${message.streaming ? "thinking" : ""}`}>
        <Sparkles size={14} />
      </div>
      <div className="code-msg-body">
        {message.error ? (
          <p className="code-msg-error">{message.content}</p>
        ) : (
          <>
            {empty && message.streaming && (
              <div className="code-thinking"><span /><span /><span /></div>
            )}
            {prose && <Markdown text={prose} />}
            {tools.length > 0 && (
              <div className="code-tool-stack">
                {tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
              </div>
            )}
            {message.streaming && prose && <span className="code-caret" aria-hidden="true" />}
          </>
        )}
      </div>
    </div>
  );
}

export default function CodeChat({
  messages = [],
  input,
  setInput,
  onSend,
  onStop,
  busy,
  ready,
  modelReady = ready,
  modelLabel,
  activeFile,
  includeFile,
  setIncludeFile,
  settings,
  setSettings,
  onClearChat,
  onNewSession,
  workspaceName,
  contextChars,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const followRef = useRef(true);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
    node.style.overflowY = node.scrollHeight > 180 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    if (!followRef.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const handleScroll = (event) => {
    const node = event.currentTarget;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  const submit = () => {
    if (busy || !ready) return;
    const text = String(input || "").trim();
    if (!text) return;
    onSend?.(text);
  };

  const suggestions = [
    { label: "Explain this project", prompt: "Give me a clear tour of this project: its purpose, stack, entry points, and the most important files. Read the key files first." },
    { label: "Find and fix a bug", prompt: "Look through this project for a likely bug or rough edge. Explain what you find, then fix it and summarize the change." },
    { label: "Add a feature", prompt: "Suggest one small, valuable feature that fits this project, then implement it end to end with tests or a manual verification step." },
    { label: "Write tests", prompt: "Find the core logic in this project and add useful automated tests for it. Use the project's existing test tooling if present." },
  ];

  return (
    <aside className="code-chat">
      <header className="code-chat-head">
        <div className="code-chat-title">
          <span className="code-chat-mark"><Sparkles size={15} /></span>
          <div>
            <strong>Monami Code</strong>
            <span className="code-chat-sub">
              <span className={`code-status-dot ${modelReady ? "online" : ""}`} />
              {modelReady ? modelLabel || "Model ready" : "No model loaded"}
            </span>
          </div>
        </div>
        <div className="code-chat-head-actions">
          <button type="button" className="code-icon-btn" onClick={onNewSession} disabled={busy} title="New code session" aria-label="New code session">
            <FilePlus2 size={16} />
          </button>
          <button type="button" className="code-icon-btn" onClick={onClearChat} disabled={busy} title="Clear conversation" aria-label="Clear conversation">
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className={`code-icon-btn ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen((value) => !value)}
            title="Assistant settings"
            aria-label="Assistant settings"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      {settingsOpen && (
        <div className="code-chat-settings">
          <label>
            <span>Creativity <em>{Number(settings.temperature).toFixed(1)}</em></span>
            <input
              type="range" min="0" max="1" step="0.1"
              value={settings.temperature}
              onChange={(event) => setSettings({ ...settings, temperature: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Max tool steps <em>{settings.maxSteps}</em></span>
            <input
              type="range" min="1" max="24" step="1"
              value={settings.maxSteps}
              onChange={(event) => setSettings({ ...settings, maxSteps: Number(event.target.value) })}
            />
          </label>
          <label className="code-switch-row">
            <span>
              Allow the assistant to run commands
              <em>It can run tests and builds in this folder.</em>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.allowCommands}
              className={`code-switch ${settings.allowCommands ? "on" : ""}`}
              onClick={() => setSettings({ ...settings, allowCommands: !settings.allowCommands })}
            >
              <span />
            </button>
          </label>
          <p className="code-chat-settings-note">Runs fully offline. File edits are backed up and can be undone from the Changes tab.</p>
        </div>
      )}

      <div className="code-chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="code-chat-home">
            <div className="code-chat-home-mark"><Sparkles size={22} /></div>
            <h3>Build something in {workspaceName || "your project"}</h3>
            <p>I can read your files, write code, and run checks — all on this machine, with no internet.</p>
            {!ready && (
              <div className="code-chat-home-hint">
                <strong>No model loaded.</strong> Pick one from the menu at the top of this screen, or open <em>Settings → Code</em> / <em>Models</em> to download a powerful coding model (Qwen2.5-Coder, DeepSeek-Coder, CodeLlama).
              </div>
            )}
            <div className="code-chat-suggestions">
              {suggestions.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    if (!ready) return;
                    setInput(item.prompt);
                    textareaRef.current?.focus();
                  }}
                  disabled={!ready}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="code-chat-thread">
            {messages.map((message, index) => (
              <MessageBubble key={message.id || index} message={message} />
            ))}
          </div>
        )}
      </div>

      <div className="code-composer">
        {activeFile && (
          <div className="code-context-row">
            <button
              type="button"
              className={`code-context-chip ${includeFile ? "on" : ""}`}
              onClick={() => setIncludeFile(!includeFile)}
              title={includeFile ? "Current file is shared with the assistant" : "Share the open file with the assistant"}
            >
              <FileCode2 size={13} />
              <span>{activeFile}</span>
              {includeFile ? <Check size={12} /> : null}
            </button>
            {contextChars > 0 && <span className="code-context-meta">{contextChars.toLocaleString()} chars selected</span>}
          </div>
        )}
        <div className="code-composer-box">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              !workspaceName
                ? "Open a project folder to start coding"
                : ready
                  ? "Describe what to build, fix, or explain…"
                  : "Load a text model to start coding"
            }
            rows={1}
            disabled={!ready}
            aria-label="Message the coding assistant"
          />
          <div className="code-composer-actions">
            <span className="code-composer-hint">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" className="code-send-btn stop" onClick={onStop} title="Stop">
                <Square size={15} />
              </button>
            ) : (
              <button type="button" className="code-send-btn" onClick={submit} disabled={!ready || !input.trim()} title="Send">
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
        <p className="code-offline-note">
          <span className={`code-status-dot ${ready ? "online" : ""}`} />
          Offline · edits are real, but backed up
        </p>
      </div>
    </aside>
  );
}
