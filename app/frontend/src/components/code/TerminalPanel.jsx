import React, { useEffect, useRef, useState } from "react";
import { TerminalSquare, Play, Trash2, X, ChevronUp, LoaderCircle, Square } from "lucide-react";

export default function TerminalPanel({ open, onClose, onRun, running, entries = [], onClear, cwd = "." }) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, open, running]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const value = command.trim();
    if (!value || running) return;
    setHistory((prev) => [...prev.filter((item) => item !== value), value].slice(-80));
    setHistoryIndex(-1);
    setCommand("");
    onRun?.(value);
  };

  const recall = (direction) => {
    if (history.length === 0) return;
    let next = historyIndex;
    if (direction === "up") next = Math.min(history.length - 1, historyIndex + 1);
    else next = historyIndex - 1;
    setHistoryIndex(next);
    setCommand(next >= 0 ? history[history.length - 1 - next] : "");
  };

  return (
    <section className="code-terminal" aria-label="Terminal">
      <header className="code-terminal-head">
        <span className="code-terminal-title">
          <TerminalSquare size={14} /> Terminal
          <span className="code-terminal-cwd">{cwd}</span>
        </span>
        <div className="code-terminal-actions">
          <button type="button" className="code-icon-btn" onClick={onClear} title="Clear terminal">
            <Trash2 size={14} />
          </button>
          <button type="button" className="code-icon-btn" onClick={onClose} title="Hide terminal">
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="code-terminal-output" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="code-terminal-empty">
            Run commands in this project. Nothing leaves your machine.
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={`code-terminal-entry ${entry.error ? "error" : ""}`}>
            <div className="code-terminal-command">
              <ChevronUp size={12} />
              <span>{entry.command}</span>
              {entry.running && <LoaderCircle size={12} className="spin" />}
              {!entry.running && <span className="code-terminal-exit">exit {entry.code ?? "?"}</span>}
            </div>
            {(entry.stdout || entry.stderr) && (
              <pre className="code-terminal-text">
                {entry.stdout}
                {entry.stdout && entry.stderr ? "\n" : ""}
                {entry.stderr}
              </pre>
            )}
            {entry.error && <pre className="code-terminal-text error">{entry.error}</pre>}
          </div>
        ))}
        {running && <div className="code-terminal-running"><LoaderCircle size={13} className="spin" /> Running…</div>}
      </div>

      <div className="code-terminal-input">
        <span className="code-terminal-prompt">$</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); submit(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); recall("up"); }
            else if (event.key === "ArrowDown") { event.preventDefault(); recall("down"); }
          }}
          placeholder={running ? "Command running…" : "Type a command and press Enter"}
          disabled={running}
          spellCheck={false}
          aria-label="Terminal command"
        />
        <button type="button" onClick={submit} disabled={running || !command.trim()} title="Run command">
          {running ? <Square size={14} /> : <Play size={14} />}
        </button>
      </div>
    </section>
  );
}
