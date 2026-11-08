// code.cjs — offline coding workspace: sandboxed file tools + agentic chat loop.
//
// The workspace is whatever folder the user opens. Every path is resolved and
// checked to stay inside that folder. The local llama.cpp server is used through
// the same OpenAI-compatible endpoint as the TextChat screen, so this feature is
// 100% offline like the rest of Monami.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const MAX_READ_BYTES = 512 * 1024;        // read_file cap for the model
const MAX_EDITOR_BYTES = 4 * 1024 * 1024; // editor cap
const MAX_TOOL_RESULT_CHARS = 7000;       // per tool result kept in the prompt
const MAX_COMMAND_OUTPUT = 200 * 1024;
const MAX_TREE_ENTRIES = 320;
const MAX_SEARCH_RESULTS = 80;
const MAX_CHANGE_LOG = 120;
const DEFAULT_MAX_STEPS = 12;
const MAX_AGENT_STEPS = 24;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "output", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".output", ".vercel", ".netlify", "__pycache__",
  ".venv", "venv", "env", ".mypy_cache", ".pytest_cache", ".ruff_cache", "target",
  "bin", "obj", ".idea", ".vs", ".cache", ".parcel-cache", ".turbo", ".gradle",
  ".dart_tool", "Pods", "DerivedData", ".terraform", ".DS_Store",
]);

const IGNORED_FILE_RE = /(?:^\.DS_Store$|\.(?:lockb|pyc|pyo|class|o|obj|dll|exe|so|dylib|bin|png|jpe?g|gif|webp|ico|mp[34]|wav|flac|zip|tar|gz|7z|rar|pdf|woff2?|ttf|otf|eot|safetensors|gguf|ckpt|onnx)$)/i;

const LANGUAGE_BY_EXT = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".ts": "typescript", ".tsx": "tsx", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java",
  ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift", ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".cs": "csharp",
  ".php": "php", ".pl": "perl", ".lua": "lua", ".r": "r", ".scala": "scala",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".ps1": "powershell",
  ".bat": "batch", ".cmd": "batch", ".sql": "sql", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "scss", ".less": "less",
  ".json": "json", ".jsonc": "json", ".yml": "yaml", ".yaml": "yaml",
  ".toml": "toml", ".ini": "ini", ".cfg": "ini", ".conf": "ini",
  ".md": "markdown", ".mdx": "markdown", ".txt": "text", ".xml": "xml",
  ".svg": "xml", ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
  ".dockerfile": "dockerfile", ".graphql": "graphql", ".gql": "graphql",
};
const LANGUAGE_BY_NAME = {
  dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake",
  ".gitignore": "gitignore", ".env": "ini", "cargo.lock": "toml",
  "package-lock.json": "json", "pnpm-lock.yaml": "yaml",
};

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function nowId(prefix = "c") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function looksBinary(buffer) {
  const length = Math.min(buffer.length, 8192);
  for (let i = 0; i < length; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function languageFor(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (LANGUAGE_BY_NAME[base]) return LANGUAGE_BY_NAME[base];
  return LANGUAGE_BY_EXT[path.extname(base)] || "text";
}

// A compact, stable line diff (LCS). Falls back to a coarse diff for huge files.
function makeDiff(before, after) {
  const beforeLines = String(before ?? "").split(/\r?\n/);
  const afterLines = String(after ?? "").split(/\r?\n/);
  let additions = 0;
  let deletions = 0;

  if (beforeLines.length + afterLines.length > 2400) {
    const lines = [
      ...beforeLines.slice(0, 200).map((text) => ({ type: "del", text })),
      ...afterLines.slice(0, 200).map((text) => ({ type: "add", text })),
    ];
    deletions = beforeLines.length;
    additions = afterLines.length;
    return { additions, deletions, lines, truncated: true };
  }

  const n = beforeLines.length;
  const m = afterLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = beforeLines[i] === afterLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push({ type: "same", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "del", text: beforeLines[i] });
      deletions += 1;
      i += 1;
    } else {
      lines.push({ type: "add", text: afterLines[j] });
      additions += 1;
      j += 1;
    }
  }
  while (i < n) { lines.push({ type: "del", text: beforeLines[i] }); deletions += 1; i += 1; }
  while (j < m) { lines.push({ type: "add", text: afterLines[j] }); additions += 1; j += 1; }
  return { additions, deletions, lines, truncated: false };
}

function createCodeFeature({ ROOT, json, readJsonBody, getLlmState }) {
  const CONFIG_DIR = path.join(ROOT, "app", "config");
  const CONFIG_FILE = path.join(CONFIG_DIR, "code-workspace.json");
  const SESSIONS_DIR = path.join(ROOT, "app", "code-sessions");
  const BACKUPS_DIR = path.join(ROOT, "app", "code-backups");
  const DEFAULT_WORKSPACE = path.join(ROOT, "app", "code-workspace");

  const activeRuns = new Map();       // sessionId -> { aborted, request }
  const changeCache = new Map();      // sessionId -> entries (loaded lazily)

  // ── workspace state ────────────────────────────────────────────────────────
  function readConfig() {
    const parsed = safeJsonParse(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : "", {}) || {};
    const recent = Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces.filter((p) => typeof p === "string") : [];
    return {
      currentWorkspace: typeof parsed.currentWorkspace === "string" ? parsed.currentWorkspace : "",
      recentWorkspaces: [...new Set(recent)].slice(0, 12),
    };
  }

  function writeConfig(next) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  }

  function isDirectory(target) {
    try { return fs.statSync(target).isDirectory(); } catch (_) { return false; }
  }

  function getWorkspace() {
    const config = readConfig();
    if (config.currentWorkspace && isDirectory(config.currentWorkspace)) return config.currentWorkspace;
    if (isDirectory(DEFAULT_WORKSPACE)) return DEFAULT_WORKSPACE;
    return "";
  }

  function setWorkspace(folder) {
    const resolved = path.resolve(String(folder || ""));
    if (!resolved || !isDirectory(resolved)) throw new Error("That folder does not exist or is not a directory.");
    const config = readConfig();
    const recent = [resolved, ...config.recentWorkspaces.filter((p) => p !== resolved)].slice(0, 12);
    writeConfig({ currentWorkspace: resolved, recentWorkspaces: recent });
    return resolved;
  }

  // ── path sandbox ───────────────────────────────────────────────────────────
  function workspaceRoot() {
    const root = getWorkspace();
    if (!root) {
      const error = new Error("Open a project folder first.");
      error.statusCode = 409;
      throw error;
    }
    return root;
  }

  function resolveSafe(relative, { allowRoot = true } = {}) {
    const root = workspaceRoot();
    const raw = String(relative ?? "").trim().replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/")) {
      throw new Error("Use paths relative to the workspace, not absolute paths.");
    }
    const cleaned = raw.replace(/^\.\/+/, "").replace(/\/+/g, "/");
    if (cleaned.split("/").some((part) => part === "..")) {
      throw new Error("Paths may not leave the workspace.");
    }
    const abs = path.resolve(root, cleaned || ".");
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error("Paths may not leave the workspace.");
    }
    if (!allowRoot && abs === root) {
      throw new Error("That operation is not allowed on the workspace root.");
    }
    return { root, abs, relative: path.relative(root, abs).replace(/\\/g, "/") };
  }

  function assertWritable(abs, root) {
    const relative = path.relative(root, abs);
    const parts = relative.split(path.sep);
    if (parts.some((part) => IGNORED_DIRS.has(part))) {
      throw new Error("This location is inside a generated or dependency folder and is protected.");
    }
  }

  function summarizePath(abs, root) {
    return path.relative(root, abs).replace(/\\/g, "/") || ".";
  }

  // ── file system helpers ────────────────────────────────────────────────────
  function listDirectory(abs) {
    const root = workspaceRoot();
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .map((entry) => {
        const entryAbs = path.join(abs, entry.name);
        let size = 0;
        let modified = 0;
        try {
          const stat = fs.statSync(entryAbs);
          size = entry.isDirectory() ? 0 : stat.size;
          modified = stat.mtimeMs;
        } catch (_) {}
        return {
          name: entry.name,
          path: summarizePath(entryAbs, root),
          type: entry.isDirectory() ? "directory" : "file",
          size,
          modified,
          language: entry.isDirectory() ? null : languageFor(entry.name),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    return entries;
  }

  function walkTree(dirAbs, baseRoot, depth, state) {
    if (state.entries.length >= state.maxEntries || depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const entry of entries) {
      if (state.entries.length >= state.maxEntries) return;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const relative = summarizePath(abs, baseRoot);
      let size = 0;
      try { size = entry.isDirectory() ? 0 : fs.statSync(abs).size; } catch (_) {}
      if (entry.isDirectory()) {
        state.lines.push(`${"  ".repeat(depth + 1)}${entry.name}/`);
        state.entries.push({ path: relative, type: "directory", size: 0 });
        if (depth > 0) walkTree(abs, baseRoot, depth - 1, state);
      } else {
        state.lines.push(`${"  ".repeat(depth + 1)}${entry.name}${size ? `  (${Math.max(1, Math.round(size / 1024))} KB)` : ""}`);
        state.entries.push({ path: relative, type: "file", size });
      }
    }
  }

  function workspaceTree(maxDepth = 3, maxEntries = MAX_TREE_ENTRIES) {
    const root = workspaceRoot();
    const state = { entries: [], lines: [], maxEntries };
    walkTree(root, root, Math.max(0, Math.min(5, maxDepth)), state);
    return {
      root,
      name: path.basename(root) || root,
      entries: state.entries,
      text: state.lines.join("\n") || "(empty workspace)",
      truncated: state.entries.length >= maxEntries,
    };
  }

  function isBinaryFile(abs) {
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return false;
      const fd = fs.openSync(abs, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 8192));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        return looksBinary(buffer);
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {
      return false;
    }
  }

  function readTextFile(abs, { maxBytes = MAX_READ_BYTES } = {}) {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error("That path is a folder, not a file.");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
    if (stat.size > 0) {
      const fd = fs.openSync(abs, "r");
      try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    }
    const slice = buffer.subarray(0, Math.min(buffer.length, maxBytes));
    if (looksBinary(slice)) throw new Error("This looks like a binary file and cannot be shown as text.");
    return {
      content: slice.toString("utf8"),
      size: stat.size,
      truncated: stat.size > maxBytes,
      language: languageFor(abs),
    };
  }

  async function writeTextFile(abs, content, root) {
    assertWritable(abs, root);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  }

  // ── change log / backups ───────────────────────────────────────────────────
  function sanitizeSessionId(value) {
    const clean = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    return clean || "manual";
  }

  function sessionBackupDir(session) {
    return path.join(BACKUPS_DIR, sanitizeSessionId(session));
  }

  function loadChanges(session) {
    const key = sanitizeSessionId(session);
    if (changeCache.has(key)) return changeCache.get(key);
    const logPath = path.join(sessionBackupDir(key), "log.json");
    const entries = safeJsonParse(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "", []) || [];
    changeCache.set(key, entries);
    return entries;
  }

  function saveChanges(session, entries) {
    const dir = sessionBackupDir(session);
    fs.mkdirSync(dir, { recursive: true });
    const trimmed = entries.slice(-MAX_CHANGE_LOG);
    fs.writeFileSync(path.join(dir, "log.json"), JSON.stringify(trimmed, null, 2));
    changeCache.set(sanitizeSessionId(session), trimmed);
  }

  async function recordChange({ session, root, relative, absolute, action, before = null, after = null, note = "" }) {
    const id = nowId("chg");
    const entries = loadChanges(session);
    let backup = null;
    if (before !== null) {
      const dir = sessionBackupDir(session);
      fs.mkdirSync(dir, { recursive: true });
      backup = `${id}-${path.basename(relative)}.bak`;
      fs.writeFileSync(path.join(dir, backup), before, "utf8");
    }
    const diff = before !== null && after !== null ? makeDiff(before, after) : null;
    const entry = {
      id,
      session: sanitizeSessionId(session),
      path: relative,
      action,
      timestamp: Date.now(),
      backup,
      note,
      additions: diff?.additions ?? (after ? String(after).split(/\r?\n/).length : 0),
      deletions: diff?.deletions ?? (before ? String(before).split(/\r?\n/).length : 0),
      diff: diff ? { ...diff, lines: diff.lines.slice(0, 600) } : null,
    };
    entries.push(entry);
    saveChanges(session, entries);
    return { entry, absolute };
  }

  // ── sessions ───────────────────────────────────────────────────────────────
  function sanitizeConversation(conversation) {
    if (!conversation || typeof conversation !== "object") return null;
    const id = String(conversation.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    if (!id) return null;
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages.slice(-400).map((message) => {
          if (!message || typeof message !== "object") return null;
          const role = String(message.role || "").trim();
          if (!["user", "assistant"].includes(role)) return null;
          const content = typeof message.content === "string" ? message.content.slice(0, 200000) : "";
          const tools = Array.isArray(message.tools)
            ? message.tools.slice(-80).map((tool) => ({
                id: String(tool?.id || ""),
                tool: String(tool?.tool || ""),
                summary: String(tool?.summary || "").slice(0, 2000),
                ok: tool?.ok !== false,
                detail: String(tool?.detail || "").slice(0, 4000),
              }))
            : undefined;
          return { role, content, ...(tools ? { tools } : {}) };
        }).filter(Boolean)
      : [];
    return {
      id,
      title: String(conversation.title || "Code session").slice(0, 160),
      workspace: String(conversation.workspace || "").slice(0, 1024),
      model: String(conversation.model || "").slice(0, 256),
      timestamp: Number(conversation.timestamp) || Date.now(),
      messages,
    };
  }

  function listSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs.readdirSync(SESSIONS_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const parsed = safeJsonParse(fs.readFileSync(path.join(SESSIONS_DIR, name), "utf8"), null);
        if (!parsed?.id) return null;
        return {
          id: parsed.id,
          title: parsed.title || "Code session",
          workspace: parsed.workspace || "",
          model: parsed.model || "",
          timestamp: Number(parsed.timestamp) || 0,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── the agent ──────────────────────────────────────────────────────────────
  const TOOL_DOCS = `
AVAILABLE TOOLS (call exactly one or more per reply using a single fenced block each):

list_files      {"tool":"list_files","path":"src","depth":2}
read_file       {"tool":"read_file","path":"src/app.js","start_line":1,"end_line":200}
write_file      {"tool":"write_file","path":"src/new.js","content":"...full file..."}
edit_file       {"tool":"edit_file","path":"src/app.js","old_text":"exact text","new_text":"replacement","replace_all":false}
create_file     {"tool":"create_file","path":"src/new.js","content":"..."}
delete_file     {"tool":"delete_file","path":"src/old.js"}
rename_file     {"tool":"rename_file","from":"src/a.js","to":"src/b.js"}
search_files    {"tool":"search_files","query":"fetchUser","path":".","max_results":40}
run_command     {"tool":"run_command","command":"npm test","cwd":"."}

RULES
- To call a tool, reply with ONLY a fenced code block that starts with the word tool:
  \`\`\`tool
  {"tool":"read_file","path":"src/app.js"}
  \`\`\`
- Do not wrap the tool block in prose or JSON arrays. Never invent tool names.
- Paths must be relative to the workspace root. Never use absolute paths, drive letters, or "..".
- Inspect files with read_file/search_files before changing them. Never invent file contents.
- Use edit_file for targeted changes (old_text must match exactly, including whitespace). Use write_file only for a complete rewrite or a new file.
- After a tool result arrives, continue working. When the task is complete, reply in plain language with a short summary of what changed and how to verify it.
- If the request is ambiguous or destructive, ask a short clarifying question instead of guessing.
- Match the existing code style, imports, and naming conventions.
- Keep answers concise. Prefer working code over long explanations.
`.trim();

  function buildSystemPrompt(workspace, tree, settings) {
    const allowCommands = settings.allowCommands === true;
    return [
      `You are Monami Code, an expert offline software engineer working directly inside the user's project folder.`,
      `Workspace root: ${workspace}`,
      ``,
      `You have real access to this folder through tools. Changes you make are written to disk immediately and are shown to the user with an undo option.`,
      allowCommands
        ? `You may run shell commands with run_command. Commands execute on the user's machine inside the workspace. Use them for tests, builds and git status. Never run destructive or unrelated commands.`
        : `Command execution is DISABLED. Do not call run_command. If a command is needed, explain it and ask the user to run it in the terminal.`,
      ``,
      `PROJECT FILES (${tree.truncated ? "truncated" : "full"} listing):`,
      truncate(tree.text, 5000),
      ``,
      TOOL_DOCS,
    ].join("\n");
  }

  const TOOL_NAMES = new Set([
    "list_files", "read_file", "write_file", "edit_file", "create_file",
    "delete_file", "rename_file", "search_files", "run_command",
  ]);

  function extractToolCalls(text) {
    const calls = [];
    const pushRaw = (raw) => {
      const trimmed = String(raw || "").trim();
      if (!trimmed) return;
      let parsed = safeJsonParse(trimmed);
      if (!parsed) {
        // Tolerate ```json fences and trailing commas that models sometimes add.
        const unwrapped = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        parsed = safeJsonParse(unwrapped) || safeJsonParse(unwrapped.replace(/,\s*([}\]])/g, "$1"));
      }
      if (!parsed || typeof parsed !== "object") {
        calls.push({ tool: "__invalid__", error: "That tool block is not valid JSON.", raw: truncate(trimmed, 800) });
        return;
      }
      const tool = String(parsed.tool || parsed.name || parsed.action || "").trim();
      if (!TOOL_NAMES.has(tool)) {
        calls.push({ tool: "__invalid__", error: `Unknown tool "${tool || "(missing)"}".`, raw: truncate(trimmed, 800) });
        return;
      }
      calls.push({ ...parsed, tool });
    };

    const fence = /```tool\s*\n?([\s\S]*?)```/gi;
    let match;
    while ((match = fence.exec(text)) !== null) pushRaw(match[1]);

    const tag = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    while ((match = tag.exec(text)) !== null) pushRaw(match[1]);

    // Some models wrap the call in a plain ```json fence instead of ```tool.
    if (calls.length === 0) {
      const jsonFence = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
      while ((match = jsonFence.exec(text)) !== null) {
        let parsed = safeJsonParse(match[1]);
        if (!parsed) parsed = safeJsonParse(String(match[1]).replace(/,\s*([}\]])/g, "$1"));
        if (parsed && typeof parsed === "object" && TOOL_NAMES.has(String(parsed.tool || ""))) {
          calls.push({ ...parsed, tool: String(parsed.tool) });
        }
      }
    }

    return calls;
  }

  function stripToolBlocks(text) {
    return String(text || "")
      .replace(/```tool\s*\n?[\s\S]*?```/gi, "")
      .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, "")
      // A plain ```json fence that holds a tool call should not be shown as prose.
      .replace(/```(?:json)?\s*\n?([\s\S]*?)```/gi, (whole, body) => {
        let parsed = safeJsonParse(body);
        if (!parsed) parsed = safeJsonParse(String(body).replace(/,\s*([}\]])/g, "$1"));
        return parsed && typeof parsed === "object" && TOOL_NAMES.has(String(parsed.tool || "")) ? "" : whole;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function argOf(args, names) {
    for (const name of names) {
      if (args[name] !== undefined && args[name] !== null) return args[name];
    }
    return undefined;
  }

  function summarizeToolCall(tool, args) {
    const target = argOf(args, ["path", "file", "file_path", "filename", "from"]) || "";
    switch (tool) {
      case "list_files": return `List ${target || "."}`;
      case "read_file": return `Read ${target}`;
      case "write_file": return `Write ${target}`;
      case "edit_file": return `Edit ${target}`;
      case "create_file": return `Create ${target}`;
      case "delete_file": return `Delete ${target}`;
      case "rename_file": return `Rename ${target} → ${argOf(args, ["to", "new_path", "destination"]) || ""}`;
      case "search_files": return `Search "${argOf(args, ["query", "q", "pattern"]) || ""}"`;
      case "run_command": return `Run ${argOf(args, ["command", "cmd"]) || ""}`;
      default: return tool;
    }
  }

  async function executeTool(call, context) {
    const { session, settings } = context;
    const root = workspaceRoot();

    if (call.tool === "__invalid__") {
      return { ok: false, summary: "Invalid tool call", detail: call.error, forModel: `ERROR: ${call.error}\nReply again with a single valid tool block.` };
    }

    const tool = call.tool;
    const args = call;
    const pathArg = argOf(args, ["path", "file", "file_path", "filename", "filePath"]);

    if (tool === "list_files") {
      const target = resolveSafe(pathArg === undefined ? "." : pathArg);
      if (!isDirectory(target.abs)) throw new Error(`${target.relative} is not a folder.`);
      const depth = clampNumber(argOf(args, ["depth"]), 0, 4, 2);
      const state = { entries: [], lines: [], maxEntries: 200 };
      walkTree(target.abs, root, depth, state);
      const text = state.lines.length ? state.lines.join("\n") : "(empty folder)";
      return { ok: true, summary: `Listed ${state.entries.length} entries`, detail: text, forModel: text };
    }

    if (tool === "read_file") {
      if (!pathArg) throw new Error("read_file needs a path.");
      const target = resolveSafe(pathArg);
      const file = readTextFile(target.abs, { maxBytes: MAX_READ_BYTES });
      let content = file.content;
      const start = Number(argOf(args, ["start_line", "startLine"]));
      const end = Number(argOf(args, ["end_line", "endLine"]));
      let header = `File: ${target.relative} (${file.size} bytes)`;
      if (Number.isFinite(start) || Number.isFinite(end)) {
        const lines = content.split(/\r?\n/);
        const from = Math.max(1, Number.isFinite(start) ? start : 1);
        const to = Math.min(lines.length, Number.isFinite(end) ? end : from + 399);
        content = lines.slice(from - 1, to).map((line, index) => `${from + index} | ${line}`).join("\n");
        header = `File: ${target.relative} (lines ${from}-${to} of ${lines.length})`;
      }
      if (file.truncated) content += `\n… [file truncated at ${MAX_READ_BYTES} bytes]`;
      return { ok: true, summary: `Read ${target.relative}${file.truncated ? " (truncated)" : ""}`, detail: content, forModel: `${header}\n\n${content}` };
    }

    if (tool === "write_file" || tool === "create_file") {
      if (!pathArg) throw new Error(`${tool} needs a path.`);
      const target = resolveSafe(pathArg, { allowRoot: false });
      assertWritable(target.abs, root);
      const content = String(argOf(args, ["content", "text", "new_content"]) ?? "");
      if (Buffer.byteLength(content) > MAX_EDITOR_BYTES) {
        throw new Error("That file is too large to write from the assistant.");
      }
      const exists = fs.existsSync(target.abs);
      if (tool === "create_file" && exists) throw new Error(`${target.relative} already exists. Use edit_file or write_file instead.`);
      if (exists && !fs.statSync(target.abs).isFile()) throw new Error(`${target.relative} is a folder.`);
      if (exists && isBinaryFile(target.abs)) throw new Error(`${target.relative} is a binary file; the assistant cannot overwrite it.`);
      const before = exists ? fs.readFileSync(target.abs, "utf8") : null;
      await writeTextFile(target.abs, content, root);
      await recordChange({
        session, root, relative: target.relative, absolute: target.abs,
        action: exists ? "write" : "create", before, after: content,
      });
      const lineCount = content.split(/\r?\n/).length;
      return {
        ok: true,
        summary: `${exists ? "Wrote" : "Created"} ${target.relative} (${lineCount} lines)`,
        detail: `Saved ${target.relative}.`,
        forModel: `OK: ${exists ? "wrote" : "created"} ${target.relative} (${lineCount} lines).`,
        change: { path: target.relative, action: exists ? "write" : "create" },
      };
    }

    if (tool === "edit_file") {
      if (!pathArg) throw new Error("edit_file needs a path.");
      const target = resolveSafe(pathArg, { allowRoot: false });
      if (!fs.existsSync(target.abs)) throw new Error(`${target.relative} does not exist.`);
      const oldText = String(argOf(args, ["old_text", "oldText", "old_string", "oldString", "old", "search"]) ?? "");
      const newText = String(argOf(args, ["new_text", "newText", "new_string", "newString", "new", "replace", "replacement"]) ?? "");
      if (!oldText) throw new Error("edit_file needs old_text (the exact text to replace).");
      if (isBinaryFile(target.abs)) throw new Error(`${target.relative} is a binary file; the assistant cannot edit it.`);
      const before = fs.readFileSync(target.abs, "utf8");
      const replaceAll = args.replace_all === true || args.replaceAll === true;
      const occurrences = before.split(oldText).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_text was not found in ${target.relative}. Read the file again and copy the exact text, including indentation.`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`old_text appears ${occurrences} times in ${target.relative}. Include more surrounding context, or set replace_all to true.`);
      }
      // A function replacement keeps `$&`, `$1`, etc. in newText literal.
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
      await writeTextFile(target.abs, after, root);
      await recordChange({ session, root, relative: target.relative, absolute: target.abs, action: "edit", before, after });
      const delta = makeDiff(before, after);
      return {
        ok: true,
        summary: `Edited ${target.relative} (+${delta.additions} −${delta.deletions})`,
        detail: `Updated ${target.relative}.`,
        forModel: `OK: edited ${target.relative}. ${delta.additions} line(s) added, ${delta.deletions} removed.`,
        change: { path: target.relative, action: "edit" },
      };
    }

    if (tool === "delete_file") {
      if (!pathArg) throw new Error("delete_file needs a path.");
      const target = resolveSafe(pathArg, { allowRoot: false });
      assertWritable(target.abs, root);
      if (!fs.existsSync(target.abs)) throw new Error(`${target.relative} does not exist.`);
      if (fs.statSync(target.abs).isDirectory()) throw new Error("delete_file only removes files. Ask the user to remove folders.");
      if (isBinaryFile(target.abs)) throw new Error(`${target.relative} is a binary file; delete it from the file tree instead.`);
      const before = fs.readFileSync(target.abs, "utf8");
      await fsp.unlink(target.abs);
      await recordChange({ session, root, relative: target.relative, absolute: target.abs, action: "delete", before, after: null });
      return { ok: true, summary: `Deleted ${target.relative}`, detail: `Deleted ${target.relative}.`, forModel: `OK: deleted ${target.relative}.`, change: { path: target.relative, action: "delete" } };
    }

    if (tool === "rename_file") {
      const fromArg = argOf(args, ["from", "path", "old_path", "source"]);
      const toArg = argOf(args, ["to", "new_path", "destination", "target"]);
      if (!fromArg || !toArg) throw new Error("rename_file needs from and to paths.");
      const source = resolveSafe(fromArg, { allowRoot: false });
      const destination = resolveSafe(toArg, { allowRoot: false });
      assertWritable(source.abs, root);
      assertWritable(destination.abs, root);
      if (!fs.existsSync(source.abs)) throw new Error(`${source.relative} does not exist.`);
      if (fs.existsSync(destination.abs)) throw new Error(`${destination.relative} already exists.`);
      await fsp.mkdir(path.dirname(destination.abs), { recursive: true });
      await fsp.rename(source.abs, destination.abs);
      await recordChange({ session, root, relative: source.relative, absolute: source.abs, action: "rename", note: destination.relative });
      return {
        ok: true,
        summary: `Renamed ${source.relative} → ${destination.relative}`,
        detail: `Renamed ${source.relative} to ${destination.relative}.`,
        forModel: `OK: renamed ${source.relative} to ${destination.relative}.`,
        change: { path: destination.relative, action: "rename" },
      };
    }

    if (tool === "search_files") {
      const query = String(argOf(args, ["query", "q", "pattern"]) || "");
      if (!query.trim()) throw new Error("search_files needs a query.");
      const start = resolveSafe(pathArg === undefined ? "." : pathArg);
      const limit = clampNumber(argOf(args, ["max_results", "maxResults", "limit"]), 1, MAX_SEARCH_RESULTS, 40);
      const needle = query.toLowerCase();
      const results = [];
      let scanned = 0;
      const walk = (dir) => {
        if (results.length >= limit || scanned >= 5000) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          if (results.length >= limit || scanned >= 5000) return;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(abs); continue; }
          scanned += 1;
          const lower = entry.name.toLowerCase();
          if (IGNORED_FILE_RE.test(lower)) continue;
          let stat;
          try { stat = fs.statSync(abs); } catch (_) { continue; }
          if (stat.size > 1024 * 1024) continue;
          let text;
          try { text = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
          if (text.includes("\u0000")) continue;
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length && results.length < limit; index += 1) {
            if (lines[index].toLowerCase().includes(needle)) {
              results.push(`${summarizePath(abs, root)}:${index + 1}: ${lines[index].trim().slice(0, 220)}`);
            }
          }
        }
      };
      walk(start.abs);
      const text = results.length ? results.join("\n") : "No matches found.";
      return { ok: true, summary: `${results.length} match(es)`, detail: text, forModel: text };
    }

    if (tool === "run_command") {
      if (settings.allowCommands !== true) {
        return {
          ok: false,
          summary: "Command blocked",
          detail: "Command execution is disabled for the assistant.",
          forModel: "ERROR: command execution is disabled. Ask the user to enable it in the Code settings, or explain the command they should run.",
        };
      }
      const command = String(argOf(args, ["command", "cmd"]) || "").trim();
      if (!command) throw new Error("run_command needs a command.");
      if (command.length > 2000) throw new Error("That command is too long.");
      const cwdTarget = argOf(args, ["cwd", "dir", "directory"]);
      const cwd = cwdTarget ? resolveSafe(cwdTarget).abs : root;
      const result = await runShell(command, cwd, 180000);
      const output = [
        result.stdout ? `STDOUT:\n${truncate(result.stdout, 12000)}` : "",
        result.stderr ? `STDERR:\n${truncate(result.stderr, 6000)}` : "",
        `Exit code: ${result.code ?? "null"}`,
      ].filter(Boolean).join("\n\n");
      return {
        ok: result.code === 0,
        summary: `${command} → exit ${result.code ?? "?"}`,
        detail: output,
        forModel: `${output}`,
      };
    }

    throw new Error(`Unknown tool "${tool}".`);
  }

  function runShell(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1", TERM: "dumb" },
      });
      const finish = (code, timedOut = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
      };
      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString();
      });
      child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
      child.on("close", (code) => finish(code));
      timer = setTimeout(() => {
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          } else {
            child.kill("SIGKILL");
          }
        } catch (_) {}
        finish(null, true);
      }, Math.max(1000, Math.min(timeoutMs || 180000, 600000)));
    });
  }

  // ── llama.cpp streaming ────────────────────────────────────────────────────
  function streamCompletion({ port, messages, temperature, maxTokens, signal, onToken, onReasoning }) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: "local-model",
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        top_p: 0.95,
        top_k: 40,
        min_p: 0.05,
        repeat_penalty: 1.05,
      });
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            let message = `The local model returned HTTP ${response.statusCode}.`;
            const parsed = safeJsonParse(body, null);
            if (parsed?.error?.message) message = parsed.error.message;
            reject(new Error(message));
          });
          return;
        }
        response.setEncoding("utf8");
        let buffer = "";
        let content = "";
        let reasoning = "";
        let finishReason = null;
        response.on("data", (chunk) => {
          buffer += chunk;
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || "";
          for (const event of events) {
            for (const line of event.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              const parsed = safeJsonParse(raw, null);
              if (!parsed) continue;
              const choice = parsed.choices?.[0];
              const delta = choice?.delta || {};
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              if (typeof delta.content === "string" && delta.content) {
                content += delta.content;
                onToken?.(delta.content);
              }
              const think = delta.reasoning_content || delta.reasoning;
              if (typeof think === "string" && think) {
                reasoning += think;
                onReasoning?.(think);
              }
            }
          }
        });
        response.on("end", () => resolve({ content, reasoning, finishReason }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(15 * 60 * 1000, () => request.destroy(new Error("The local model timed out.")));
      if (signal) {
        if (signal.aborted) { request.destroy(new Error("aborted")); return; }
        signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
      }
      request.write(payload);
      request.end();
    });
  }

  function trimConversation(messages, contextSize, reserveTokens = 0) {
    const usableTokens = Math.max(1536, Number(contextSize || 4096) - Number(reserveTokens || 0) - 256);
    const budgetChars = Math.max(8000, Math.min(120000, Math.floor(usableTokens * 3)));
    const system = messages[0];
    let rest = messages.slice(1);
    const serialized = () => rest.reduce((sum, message) => sum + String(message.content || "").length, 0);
    while (rest.length > 6 && serialized() > budgetChars) rest.shift();
    rest = rest.map((message) => (
      String(message.content || "").length > MAX_TOOL_RESULT_CHARS
        ? { ...message, content: truncate(message.content, MAX_TOOL_RESULT_CHARS) }
        : message
    ));
    while (rest.length > 4 && serialized() > budgetChars) rest.shift();
    return [system, ...rest];
  }

  async function handleAgentChat(req, res, body) {
    const llm = getLlmState();
    if (!llm.ready) {
      return json(res, 409, { ok: false, error: "Load a text model before using the coding assistant." });
    }

    let root;
    try { root = workspaceRoot(); } catch (error) {
      return json(res, error.statusCode || 409, { ok: false, error: error.message });
    }

    const sessionId = sanitizeSessionId(body.sessionId || nowId("ses"));
    const settings = {
      temperature: clampNumber(body.settings?.temperature, 0, 1.5, 0.2),
      maxTokens: clampNumber(body.settings?.maxTokens, 256, 8192, 2048),
      maxSteps: clampNumber(body.settings?.maxSteps, 1, MAX_AGENT_STEPS, DEFAULT_MAX_STEPS),
      allowCommands: body.settings?.allowCommands === true,
    };

    const visible = Array.isArray(body.messages) ? body.messages : [];
    const userInput = String(body.input || "").trim();
    const context = body.context && typeof body.context === "object" ? body.context : {};

    let userContent = userInput;
    if (context.openFile?.path) {
      const suffix = context.selection ? `\n\nSelected text from ${context.openFile.path}:\n\`\`\`\n${truncate(context.selection, 6000)}\n\`\`\`` : `\n\nCurrent file: ${context.openFile.path}`;
      userContent = `${userContent}${suffix}`;
    }
    if (!userContent.trim()) {
      return json(res, 400, { ok: false, error: "Write a message first." });
    }

    const tree = workspaceTree(3, 200);
    const systemPrompt = buildSystemPrompt(root, tree, settings);
    const conversation = [
      { role: "system", content: systemPrompt },
      ...visible.slice(-40).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || "").slice(0, 20000),
      })),
      { role: "user", content: userContent },
    ];

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);

    const controller = new AbortController();
    const run = { aborted: false, controller };
    activeRuns.set(sessionId, run);

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const cleanup = () => {
      activeRuns.delete(sessionId);
      if (!res.writableEnded) res.end();
    };
    res.on("close", () => {
      run.aborted = true;
      controller.abort();
    });

    send("session", { sessionId, workspace: root, model: llm.model || "" });

    let step = 0;
    let finalText = "";
    let stopped = false;
    let promptTokens = 0;
    const changes = [];
    const maxSteps = settings.maxSteps;

    try {
      while (step < maxSteps && !run.aborted) {
        send("step", { index: step, max: maxSteps });
        // Leave room in the context window for the reply itself.
        const contextSize = Number(llm.contextSize) || 4096;
        const maxTokens = Math.min(settings.maxTokens, Math.max(512, Math.floor(contextSize / 4)));
        const prepared = trimConversation(conversation, contextSize, maxTokens);
        const response = await streamCompletion({
          port: llm.port,
          messages: prepared,
          temperature: settings.temperature,
          maxTokens,
          signal: controller.signal,
          onToken: (token) => send("token", { text: token }),
          onReasoning: (token) => send("reasoning", { text: token }),
        });
        promptTokens += prepared.reduce((sum, message) => sum + Math.ceil(String(message.content || "").length / 4), 0);

        const raw = response.content || "";
        const calls = extractToolCalls(raw);
        const prose = stripToolBlocks(raw);
        send("assistant", {
          content: raw,
          prose,
          toolCalls: calls.map((call) => ({ tool: call.tool, summary: summarizeToolCall(call.tool, call) })),
          finishReason: response.finishReason,
        });

        if (calls.length === 0) {
          finalText = prose || raw;
          break;
        }

        conversation.push({ role: "assistant", content: raw });
        for (const call of calls) {
          if (run.aborted) break;
          const summary = summarizeToolCall(call.tool, call);
          const callId = nowId("tool");
          send("tool_start", { id: callId, tool: call.tool, summary, args: call });
          let result;
          try {
            result = await executeTool(call, { session: sessionId, settings });
          } catch (error) {
            result = {
              ok: false,
              summary: summary,
              detail: error.message || String(error),
              forModel: `ERROR: ${error.message || String(error)}`,
            };
          }
          send("tool_result", {
            id: callId,
            tool: call.tool,
            summary: result.summary,
            ok: result.ok !== false,
            detail: truncate(result.detail || "", 4000),
          });
          if (result.change) changes.push(result.change);
          conversation.push({
            role: "user",
            content: `TOOL RESULT — ${call.tool} — ${result.ok !== false ? "success" : "failed"}\n${truncate(result.forModel || result.detail || "", MAX_TOOL_RESULT_CHARS)}\n\nContinue the task. Call another tool if needed, otherwise give the final answer.`,
          });
        }
        step += 1;
      }

      if (run.aborted) stopped = true;
      if (!finalText && !stopped && step >= maxSteps) {
        finalText = `I reached the ${maxSteps}-step limit for one request. Ask me to continue and I'll keep going from here.`;
        send("token", { text: `\n\n${finalText}` });
      }

      send("done", {
        sessionId,
        content: finalText,
        stopped,
        steps: step,
        changes,
        usage: {
          promptTokens,
          contextSize: llm.contextSize || null,
          model: llm.model || "",
        },
      });
    } catch (error) {
      if (run.aborted || error?.message === "aborted") {
        send("done", { sessionId, content: "", stopped: true, steps: step, changes });
      } else {
        console.error("  [code] agent failed:", error);
        send("error", { message: error.message || String(error) });
      }
    } finally {
      cleanup();
    }
  }

  // ── route handler ──────────────────────────────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname;

    // workspace -------------------------------------------------------------
    if (route === "/api/code/state" && req.method === "GET") {
      const config = readConfig();
      const workspace = getWorkspace();
      const llm = getLlmState();
      let tree = null;
      if (workspace) {
        try { tree = workspaceTree(2, 200); } catch (_) {}
      }
      return json(res, 200, {
        ok: true,
        workspace,
        name: workspace ? path.basename(workspace) : "",
        recentWorkspaces: config.recentWorkspaces.filter(isDirectory),
        tree,
        llm: {
          ready: Boolean(llm.ready),
          model: llm.model || "",
          contextSize: llm.contextSize || null,
        },
        limits: { maxSteps: MAX_AGENT_STEPS },
      });
    }

    if (route === "/api/code/workspace" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const workspace = setWorkspace(body.path);
        return json(res, 200, { ok: true, workspace, name: path.basename(workspace), tree: workspaceTree(2, 200) });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/pick-workspace" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      const picked = await pickFolder(body?.title);
      if (!picked) return json(res, 200, { ok: true, cancelled: true });
      try {
        const workspace = setWorkspace(picked);
        return json(res, 200, { ok: true, workspace, name: path.basename(workspace), tree: workspaceTree(2, 200) });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/create-workspace" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const name = String(body.name || "").trim();
        if (!name) throw new Error("Project name is required.");
        if (/[\\/]/.test(name) || name === "." || name === "..") throw new Error("Project name cannot contain slashes or be empty.");
        if (/[<>:\"|?*]/.test(name)) throw new Error("Project name contains invalid characters.");
        const parent = body.parent ? path.resolve(String(body.parent)) : "";
        if (parent && (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())) {
          throw new Error("The chosen location does not exist or is not a folder.");
        }
        const baseParent = parent || path.join(os.homedir(), "Documents", "Monami Projects");
        fs.mkdirSync(baseParent, { recursive: true });
        const target = path.join(baseParent, name);
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isDirectory()) throw new Error("A file with that name already exists.");
          // reopen existing
        } else {
          fs.mkdirSync(target, { recursive: true });
        }
        const workspace = setWorkspace(target);
        return json(res, 200, { ok: true, workspace, name: path.basename(workspace), parent: baseParent, tree: workspaceTree(2, 200) });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }

    // file browsing ---------------------------------------------------------
    if (route === "/api/code/tree" && req.method === "GET") {
      try {
        const target = resolveSafe(url.searchParams.get("path") || ".");
        if (!isDirectory(target.abs)) return json(res, 400, { ok: false, error: "That path is not a folder." });
        return json(res, 200, { ok: true, path: target.relative, entries: listDirectory(target.abs) });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/read-file" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const target = resolveSafe(body.path);
        const file = readTextFile(target.abs, { maxBytes: MAX_EDITOR_BYTES });
        return json(res, 200, {
          ok: true,
          path: target.relative,
          content: file.content,
          language: file.language,
          size: file.size,
          truncated: file.truncated,
        });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/write-file" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const target = resolveSafe(body.path, { allowRoot: false });
        const content = String(body.content ?? "");
        if (Buffer.byteLength(content) > MAX_EDITOR_BYTES) {
          return json(res, 413, { ok: false, error: "That file is too large to save from the editor." });
        }
        const exists = fs.existsSync(target.abs);
        if (exists && fs.statSync(target.abs).isDirectory()) return json(res, 400, { ok: false, error: "That path is a folder." });
        const before = exists ? fs.readFileSync(target.abs, "utf8") : null;
        await writeTextFile(target.abs, content, workspaceRoot());
        const { entry } = await recordChange({
          session: sanitizeSessionId(body.session || "manual"),
          root: workspaceRoot(),
          relative: target.relative,
          absolute: target.abs,
          action: exists ? "write" : "create",
          before,
          after: content,
          note: "manual save",
        });
        return json(res, 200, { ok: true, path: target.relative, changeId: entry.id, size: Buffer.byteLength(content) });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/create-entry" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const root = workspaceRoot();
        const target = resolveSafe(body.path, { allowRoot: false });
        assertWritable(target.abs, root);
        const type = body.type === "directory" ? "directory" : "file";
        if (fs.existsSync(target.abs)) return json(res, 409, { ok: false, error: "That path already exists." });
        if (type === "directory") {
          await fsp.mkdir(target.abs, { recursive: true });
        } else {
          const content = String(body.content ?? "");
          await writeTextFile(target.abs, content, root);
          await recordChange({
            session: sanitizeSessionId(body.session || "manual"),
            root, relative: target.relative, absolute: target.abs,
            action: "create", before: null, after: content, note: "manual create",
          });
        }
        return json(res, 200, { ok: true, path: target.relative, type });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/delete-entry" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const root = workspaceRoot();
        const session = sanitizeSessionId(body.session || "manual");
        const target = resolveSafe(body.path, { allowRoot: false });
        assertWritable(target.abs, root);
        if (!fs.existsSync(target.abs)) return json(res, 404, { ok: false, error: "That path does not exist." });
        const stat = fs.statSync(target.abs);

        if (stat.isFile()) {
          let before = null;
          try { before = fs.readFileSync(target.abs, "utf8"); } catch (_) {}
          if (before !== null && !before.includes("\u0000")) {
            await recordChange({
              session, root, relative: target.relative, absolute: target.abs,
              action: "delete", before, after: null, note: "manual delete",
            });
          }
        } else if (stat.isDirectory()) {
          // Back up the text files inside the folder so a folder delete is still undoable.
          const files = [];
          let totalBytes = 0;
          const collect = (dir) => {
            if (files.length >= 300 || totalBytes >= 8 * 1024 * 1024) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
              if (files.length >= 300 || totalBytes >= 8 * 1024 * 1024) return;
              if (IGNORED_DIRS.has(entry.name)) continue;
              const abs = path.join(dir, entry.name);
              if (entry.isDirectory()) { collect(abs); continue; }
              try {
                const info = fs.statSync(abs);
                if (info.size > 512 * 1024) continue;
                files.push({ abs, size: info.size });
                totalBytes += info.size;
              } catch (_) {}
            }
          };
          collect(target.abs);
          for (const file of files) {
            let before = null;
            try { before = fs.readFileSync(file.abs, "utf8"); } catch (_) {}
            if (before === null || before.includes("\u0000")) continue;
            await recordChange({
              session, root, relative: summarizePath(file.abs, root), absolute: file.abs,
              action: "delete", before, after: null, note: "manual delete folder",
            });
          }
        }

        await fsp.rm(target.abs, { recursive: true, force: true });
        return json(res, 200, { ok: true, path: target.relative });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/rename-entry" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const root = workspaceRoot();
        const source = resolveSafe(body.from, { allowRoot: false });
        const destination = resolveSafe(body.to, { allowRoot: false });
        assertWritable(source.abs, root);
        assertWritable(destination.abs, root);
        if (!fs.existsSync(source.abs)) return json(res, 404, { ok: false, error: "The source does not exist." });
        if (fs.existsSync(destination.abs)) return json(res, 409, { ok: false, error: "The destination already exists." });
        await fsp.mkdir(path.dirname(destination.abs), { recursive: true });
        await fsp.rename(source.abs, destination.abs);
        await recordChange({
          session: sanitizeSessionId(body.session || "manual"),
          root, relative: source.relative, absolute: source.abs,
          action: "rename", note: destination.relative,
        });
        return json(res, 200, { ok: true, from: source.relative, to: destination.relative });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/search" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const result = await executeTool({ tool: "search_files", query: body.query, path: body.path || ".", max_results: body.maxResults || 40 }, {
          session: "search",
          settings: {},
        });
        const rows = String(result.detail || "").split("\n").filter((line) => line && line !== "No matches found.").map((line) => {
          const match = line.match(/^(.*?):(\d+): (.*)$/);
          return match ? { path: match[1], line: Number(match[2]), preview: match[3] } : null;
        }).filter(Boolean);
        return json(res, 200, { ok: true, results: rows });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    // terminal --------------------------------------------------------------
    if (route === "/api/code/run-command" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const root = workspaceRoot();
        const cwdTarget = body.cwd ? resolveSafe(body.cwd).abs : root;
        const command = String(body.command || "").trim();
        if (!command) return json(res, 400, { ok: false, error: "Type a command first." });
        const result = await runShell(command, cwdTarget, clampNumber(body.timeoutMs, 1000, 600000, 180000));
        return json(res, 200, { ok: true, ...result, cwd: summarizePath(cwdTarget, root) });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    // change log ------------------------------------------------------------
    if (route === "/api/code/changes" && req.method === "GET") {
      const session = sanitizeSessionId(url.searchParams.get("session") || "manual");
      return json(res, 200, { ok: true, changes: [...loadChanges(session)].reverse() });
    }

    if (route === "/api/code/revert-change" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const session = sanitizeSessionId(body.session || "manual");
        const entries = loadChanges(session);
        const index = entries.findIndex((entry) => entry.id === body.id);
        if (index === -1) return json(res, 404, { ok: false, error: "That change is no longer in the history." });
        const entry = entries[index];
        const target = resolveSafe(entry.path, { allowRoot: false });
        assertWritable(target.abs, workspaceRoot());
        if (entry.action === "create") {
          await fsp.rm(target.abs, { force: true });
        } else if (entry.action === "rename") {
          const original = resolveSafe(entry.path, { allowRoot: false });
          const renamed = resolveSafe(entry.note, { allowRoot: false });
          if (!fs.existsSync(renamed.abs)) {
            return json(res, 409, { ok: false, error: `${entry.note} no longer exists, so this rename cannot be undone.` });
          }
          if (fs.existsSync(original.abs)) {
            return json(res, 409, { ok: false, error: `${entry.path} already exists again. Remove or rename it first.` });
          }
          await fsp.mkdir(path.dirname(original.abs), { recursive: true });
          await fsp.rename(renamed.abs, original.abs);
        } else if (entry.backup) {
          const backupPath = path.join(sessionBackupDir(session), entry.backup);
          if (!fs.existsSync(backupPath)) return json(res, 404, { ok: false, error: "The backup for that change is missing." });
          await fsp.mkdir(path.dirname(target.abs), { recursive: true });
          await fsp.copyFile(backupPath, target.abs);
        } else {
          return json(res, 400, { ok: false, error: "That change cannot be undone." });
        }
        entries.splice(index, 1);
        saveChanges(session, entries);
        return json(res, 200, { ok: true, path: entry.path });
      } catch (error) {
        return json(res, error.statusCode || 400, { ok: false, error: error.message });
      }
    }

    if (route === "/api/code/clear-changes" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const session = sanitizeSessionId(body.session || "manual");
      // Drop the log and every backup file so the promise in the UI is true.
      try { fs.rmSync(sessionBackupDir(session), { recursive: true, force: true }); } catch (_) {}
      changeCache.delete(session);
      return json(res, 200, { ok: true });
    }

    // sessions --------------------------------------------------------------
    if (route === "/api/code/sessions" && req.method === "GET") {
      return json(res, 200, { ok: true, sessions: listSessions() });
    }

    if (route === "/api/code/session" && req.method === "GET") {
      const id = String(url.searchParams.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (!id || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "That code session was not found." });
      return json(res, 200, { ok: true, conversation: safeJsonParse(fs.readFileSync(file, "utf8"), null) });
    }

    if (route === "/api/code/save-session" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const conversation = sanitizeConversation(body.conversation);
      if (!conversation) return json(res, 400, { ok: false, error: "Invalid session data." });
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SESSIONS_DIR, `${conversation.id}.json`), JSON.stringify(conversation, null, 2));
      return json(res, 200, { ok: true, conversation });
    }

    if (route === "/api/code/delete-session" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const id = String(body.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!id) return json(res, 400, { ok: false, error: "Missing session id." });
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, 200, { ok: true });
    }

    // agent ------------------------------------------------------------------
    if (route === "/api/code/chat" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      return handleAgentChat(req, res, body);
    }

    if (route === "/api/code/cancel" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const run = activeRuns.get(sanitizeSessionId(body.sessionId));
      if (run) {
        run.aborted = true;
        run.controller.abort();
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: "Unknown code endpoint." });
  }

  // ── native folder picker ───────────────────────────────────────────────────
  function pickFolder(title) {
    return new Promise((resolve) => {
      let command;
      let args;
      if (process.platform === "win32") {
        command = "powershell";
        const description = title || "Choose a project folder for Monami Code";
        args = ["-NoProfile", "-STA", "-Command", [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
          `$d.Description = '${description.replace(/'/g, "''")}'`,
          "$d.ShowNewFolderButton = $true",
          "$f = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}",
          "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
        ].join("; ")];
      } else if (process.platform === "darwin") {
        command = "osascript";
        args = ["-e", "activate", "-e", "POSIX path of (choose folder with prompt \"Choose a project folder for Monami Code\")"];
      } else {
        command = "zenity";
        args = ["--file-selection", "--directory", "--title=Choose a project folder for Monami Code"];
      }
      const child = spawn(command, args, { windowsHide: false });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(String(output || "").trim()));
    });
  }

  return { handle };
}

module.exports = createCodeFeature;
