import React, { useEffect, useMemo, useRef, useState } from "react";
import { WrapText, Save, Type, Minus, Plus } from "lucide-react";

const LANG_LABEL = {
  javascript: "JavaScript", jsx: "React", typescript: "TypeScript", tsx: "React TS",
  python: "Python", json: "JSON", css: "CSS", scss: "SCSS", html: "HTML",
  markdown: "Markdown", yaml: "YAML", shell: "Shell", powershell: "PowerShell",
  rust: "Rust", go: "Go", java: "Java", c: "C", cpp: "C++", csharp: "C#",
  sql: "SQL", ruby: "Ruby", php: "PHP", vue: "Vue", svelte: "Svelte",
  text: "Text", xml: "XML", toml: "TOML", makefile: "Makefile", dockerfile: "Dockerfile",
};

export default function CodeEditor({
  tab,
  onChange,
  onSave,
  editorRef,
  onCursorChange,
  onSelectionChange,
  revealLine,
}) {
  const localRef = useRef(null);
  const gutterRef = useRef(null);
  const shellRef = useRef(null);
  const [wrap, setWrap] = useState(() => localStorage.getItem("codeEditorWrap") === "true");
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("codeEditorFont") || 13));
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  const content = tab?.content ?? "";
  const lineCount = useMemo(() => content.split(/\r?\n/).length, [content]);
  const byteSize = useMemo(() => new Blob([content]).size, [content]);

  useEffect(() => {
    localStorage.setItem("codeEditorWrap", String(wrap));
  }, [wrap]);
  useEffect(() => {
    localStorage.setItem("codeEditorFont", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const next = Math.max(10, Math.min(24, fontSize));
    node.style.fontSize = `${next}px`;
  }, [fontSize]);

  // Scroll a requested line into view (used by search results and diffs).
  useEffect(() => {
    if (!revealLine?.path || !tab || revealLine.path !== tab.path) return;
    const node = localRef.current;
    if (!node) return;
    const lines = content.split(/\r?\n/);
    const index = Math.max(0, Math.min(lines.length - 1, Number(revealLine.line || 1) - 1));
    // Count real characters (CRLF files use two) so the offset stays exact.
    let offset = 0;
    for (let i = 0; i < index; i += 1) {
      offset += lines[i].length + (content[offset + lines[i].length] === "\r" ? 2 : 1);
    }
    const lineHeight = node.scrollHeight / Math.max(1, lines.length);
    node.focus();
    node.setSelectionRange(offset, offset + (lines[index] || "").length);
    node.scrollTop = Math.max(0, index * lineHeight - node.clientHeight / 3);
    if (gutterRef.current) gutterRef.current.scrollTop = node.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine]);

  const syncScroll = (event) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
      gutterRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  };

  const reportSelection = () => {
    const node = localRef.current;
    if (!node) return;
    const upto = node.value.slice(0, node.selectionStart);
    const lines = upto.split(/\r?\n/);
    const next = { line: lines.length, column: (lines[lines.length - 1] || "").length + 1 };
    setCursor(next);
    onCursorChange?.(next);
    onSelectionChange?.(node.selectionStart, node.selectionEnd);
  };

  const handleKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      const node = event.currentTarget;
      const start = node.selectionStart;
      const end = node.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      onChange?.(next);
      requestAnimationFrame(() => {
        node.selectionStart = node.selectionEnd = start + 2;
      });
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const node = event.currentTarget;
      const start = node.selectionStart;
      const lineStart = content.lastIndexOf("\n", start - 1) + 1;
      if (content.slice(lineStart, lineStart + 2) === "  ") {
        const next = content.slice(0, lineStart) + content.slice(lineStart + 2);
        onChange?.(next);
        requestAnimationFrame(() => {
          node.selectionStart = node.selectionEnd = Math.max(lineStart, start - 2);
        });
      }
      return;
    }
  };

  if (!tab) {
    return (
      <div className="code-editor-empty">
        <div className="code-editor-empty-art">{`{ }`}</div>
        <h3>No file open</h3>
        <p>Pick a file from the explorer, or ask the assistant to build something new.</p>
        <span className="code-kbd-hint">
          <kbd>Ctrl</kbd> + <kbd>P</kbd> quick open · <kbd>Ctrl</kbd> + <kbd>J</kbd> terminal
        </span>
      </div>
    );
  }

  return (
    <div className="code-editor">
      <div className="code-editor-toolbar">
        <div className="code-editor-filemeta">
          <span className="code-editor-lang">{LANG_LABEL[tab.language] || tab.language || "Text"}</span>
          <span className={`code-dirty-dot ${tab.dirty ? "is-dirty" : ""}`} title={tab.dirty ? "Unsaved changes" : "Saved"} />
        </div>
        <div className="code-editor-actions">
          <button
            type="button"
            className={`code-icon-btn ${wrap ? "active" : ""}`}
            onClick={() => setWrap((value) => !value)}
            title={wrap ? "Disable word wrap" : "Enable word wrap"}
          >
            <WrapText size={15} />
          </button>
          <div className="code-font-stepper" title="Font size">
            <button type="button" onClick={() => setFontSize((value) => Math.max(10, value - 1))} aria-label="Smaller text">
              <Minus size={12} />
            </button>
            <span><Type size={12} /> {fontSize}</span>
            <button type="button" onClick={() => setFontSize((value) => Math.min(24, value + 1))} aria-label="Larger text">
              <Plus size={12} />
            </button>
          </div>
          <button
            type="button"
            className="code-save-btn"
            onClick={() => onSave?.()}
            disabled={!tab.dirty}
            title="Save (Ctrl+S)"
          >
            <Save size={14} />
            Save
          </button>
        </div>
      </div>

      <div ref={shellRef} className={`code-editor-shell ${wrap ? "is-wrapped" : ""}`}>
        <div className="code-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index} className="code-gutter-line">{index + 1}</div>
          ))}
        </div>
        <textarea
          ref={(node) => {
            localRef.current = node;
            if (editorRef) editorRef.current = node;
          }}
          className="code-textarea"
          value={content}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap={wrap ? "soft" : "off"}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onKeyUp={reportSelection}
          onSelect={reportSelection}
          onClick={reportSelection}
          aria-label={`Editing ${tab.path}`}
        />
      </div>

      <div className="code-editor-status">
        <span>{tab.path}</span>
        <span className="code-editor-status-right">
          <span>Ln {cursor.line}, Col {cursor.column}</span>
          <span>{lineCount} lines</span>
          <span>{byteSize.toLocaleString()} bytes</span>
        </span>
      </div>
    </div>
  );
}
