import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileCode2, FileJson,
  FileText, FileImage, FileType2, FileTerminal, FileArchive, LoaderCircle,
  Pencil, Trash2,
} from "lucide-react";
import { getCodeTree } from "../../services/codeApi";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|pl|lua|r|scala|vue|svelte|astro|html?|css|scss|sass|less|sql|sh|bash|zsh|ps1|bat|cmd)$/i;
const CONFIG_EXT = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|xml|env|lock)$/i;
const TERMINAL_EXT = /\.(sh|bash|zsh|ps1|bat|cmd)$/i;
const ARCHIVE_EXT = /\.(zip|tar|gz|7z|rar|jar|war)$/i;

function FileIcon({ name, size = 15 }) {
  if (IMAGE_EXT.test(name)) return <FileImage size={size} className="code-file-icon image" />;
  if (TERMINAL_EXT.test(name)) return <FileTerminal size={size} className="code-file-icon terminal" />;
  if (CONFIG_EXT.test(name)) return <FileJson size={size} className="code-file-icon config" />;
  if (ARCHIVE_EXT.test(name)) return <FileArchive size={size} className="code-file-icon archive" />;
  if (CODE_EXT.test(name)) return <FileCode2 size={size} className="code-file-icon code" />;
  if (/\.(md|mdx|txt|rst)$/i.test(name)) return <FileText size={size} className="code-file-icon docs" />;
  return <FileType2 size={size} className="code-file-icon" />;
}

function TreeNode({ node, depth, expanded, children, onToggle, onOpenFile, activePath, onRename, onDelete }) {
  const isFolder = node.type === "directory";
  const isOpen = expanded.has(node.path);
  const isActive = !isFolder && activePath === node.path;
  const isLoading = isOpen && !children.has(node.path);

  return (
    <div className="code-tree-branch">
      <div
        className={`code-tree-row ${isActive ? "active" : ""} ${isFolder ? "folder" : ""}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        role="button"
        tabIndex={0}
        onClick={() => (isFolder ? onToggle(node.path) : onOpenFile(node.path))}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (isFolder) onToggle(node.path);
            else onOpenFile(node.path);
          }
        }}
        title={node.path}
      >
        <span className="code-tree-caret">
          {isFolder && (isLoading ? <LoaderCircle size={12} className="spin" /> : isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </span>
        {isFolder
          ? (isOpen ? <FolderOpen size={15} className="code-folder-icon open" /> : <Folder size={15} className="code-folder-icon" />)
          : <FileIcon name={node.name} />}
        <span className="code-tree-name">{node.name}</span>
        <span className="code-tree-actions">
          <button
            type="button"
            className="code-tree-action"
            title="Rename"
            aria-label={`Rename ${node.name}`}
            onClick={(event) => { event.stopPropagation(); onRename(node); }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="code-tree-action danger"
            title="Delete"
            aria-label={`Delete ${node.name}`}
            onClick={(event) => { event.stopPropagation(); onDelete(node); }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {isFolder && isOpen && (
        <div className="code-tree-children">
          {isLoading && <div className="code-tree-loading" style={{ paddingLeft: `${20 + depth * 13}px` }}>Loading…</div>}
          {(children.get(node.path) || []).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              children={children}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              activePath={activePath}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
          {!isLoading && (children.get(node.path) || []).length === 0 && (
            <div className="code-tree-empty" style={{ paddingLeft: `${20 + depth * 13}px` }}>Empty folder</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  rootName = "Workspace",
  version = 0,
  activePath,
  onOpenFile,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
}) {
  const [children, setChildren] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState("");

  const loadFolder = useCallback(async (folderPath) => {
    try {
      const entries = await getCodeTree(folderPath);
      setChildren((prev) => {
        const next = new Map(prev);
        next.set(folderPath, entries);
        return next;
      });
      setError("");
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      try {
        const entries = await getCodeTree(".");
        if (cancelled) return;
        setChildren((prev) => {
          const next = new Map();
          next.set(".", entries);
          // keep expanded folders so the tree doesn't collapse on save
          for (const folder of expanded) {
            if (prev.has(folder)) next.set(folder, prev.get(folder));
          }
          return next;
        });
        setError("");
        // refresh the folders the user can currently see
        for (const folder of Array.from(expanded)) {
          loadFolder(folder);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    }
    reload();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const toggle = (folderPath) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else {
        next.add(folderPath);
        if (!children.has(folderPath)) loadFolder(folderPath);
      }
      return next;
    });
  };

  const rootEntries = children.get(".") || [];

  return (
    <div className="code-tree">
      <div className="code-tree-head">
        <span className="code-tree-root" title={rootName}>
          <FolderOpen size={14} /> {rootName}
        </span>
        <span className="code-tree-count">{rootEntries.length}</span>
      </div>

      <div className="code-tree-scroll">
        {error && <div className="code-tree-error">{error}</div>}
        {!error && rootEntries.length === 0 && <div className="code-tree-empty">This folder is empty.</div>}
        {rootEntries.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            children={children}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            activePath={activePath}
            onRename={onRequestRename}
            onDelete={onRequestDelete}
          />
        ))}
      </div>

      <div className="code-tree-footer">
        <button type="button" onClick={() => onRequestCreate?.("file", "")}>
          New file
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => onRequestCreate?.("directory", "")}>
          New folder
        </button>
      </div>
    </div>
  );
}
