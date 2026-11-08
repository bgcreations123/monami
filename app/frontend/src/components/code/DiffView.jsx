import React from "react";
import { RotateCcw, FileCode2, FilePlus2, FileMinus2, PenLine, ArrowRightLeft, Check } from "lucide-react";

const ACTION_META = {
  create: { label: "Created", Icon: FilePlus2 },
  write: { label: "Rewrote", Icon: FileCode2 },
  edit: { label: "Edited", Icon: PenLine },
  delete: { label: "Deleted", Icon: FileMinus2 },
  rename: { label: "Renamed", Icon: ArrowRightLeft },
};

function relativeTime(timestamp) {
  const delta = Date.now() - Number(timestamp || 0);
  if (delta < 60000) return "just now";
  if (delta < 3600000) return `${Math.round(delta / 60000)} min ago`;
  if (delta < 86400000) return `${Math.round(delta / 3600000)} h ago`;
  return new Date(timestamp).toLocaleString();
}

export default function DiffView({ change, onRevert, onOpen }) {
  if (!change) {
    return (
      <div className="code-editor-empty">
        <div className="code-editor-empty-art">±</div>
        <h3>No change selected</h3>
        <p>Pick a change from the Changes tab to review it line by line.</p>
      </div>
    );
  }

  const meta = ACTION_META[change.action] || { label: change.action, Icon: PenLine };
  const { Icon } = meta;

  return (
    <div className="code-diff">
      <header className="code-diff-head">
        <div className="code-diff-title">
          <span className={`code-diff-badge ${change.action}`}><Icon size={13} /> {meta.label}</span>
          <span className="code-diff-path">{change.path}</span>
          {change.note && <span className="code-diff-note">{change.note}</span>}
        </div>
        <div className="code-diff-actions">
          <span className="code-diff-time">{relativeTime(change.timestamp)}</span>
          {onOpen && change.action !== "delete" && (
            <button
              type="button"
              className="code-icon-btn"
              onClick={() => onOpen(change.action === "rename" ? (change.note || change.path) : change.path)}
              title="Open file"
            >
              <FileCode2 size={15} />
            </button>
          )}
          <button type="button" className="code-diff-revert" onClick={() => onRevert?.(change)} title="Undo this change">
            <RotateCcw size={14} /> Undo
          </button>
        </div>
      </header>

      {change.diff?.lines?.length ? (
        <div className="code-diff-body">
          <div className="code-diff-stats">
            <span className="add">+{change.diff.additions}</span>
            <span className="del">−{change.diff.deletions}</span>
            {change.diff.truncated && <span className="muted">partial diff for a large file</span>}
          </div>
          <pre className="code-diff-lines">
            {change.diff.lines.map((line, index) => (
              <div key={index} className={`code-diff-line ${line.type}`}>
                <span className="code-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
                <span className="code-diff-text">{line.text || " "}</span>
              </div>
            ))}
          </pre>
        </div>
      ) : (
        <div className="code-diff-empty">
          <Check size={16} />
          <p>{change.action === "delete" ? "This file was removed. Undo restores it." : "No line diff is stored for this change. Undo restores the previous version."}</p>
        </div>
      )}
    </div>
  );
}
