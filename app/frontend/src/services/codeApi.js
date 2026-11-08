// Client for the offline Monami Code workspace.
// All endpoints live on the local server; nothing leaves the machine.

async function readJson(res, fallbackMessage) {
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(fallbackMessage);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data;
}

async function post(path, body, fallbackMessage) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return readJson(res, fallbackMessage);
}

export async function getCodeState() {
  const res = await fetch("/api/code/state");
  return readJson(res, "The local server returned invalid code workspace data.");
}

export async function openCodeWorkspace(folder) {
  return post("/api/code/workspace", { path: folder }, "Could not open that folder.");
}

export async function pickCodeWorkspace(title) {
  return post("/api/code/pick-workspace", { title }, "Could not open the folder picker.");
}

export async function createCodeWorkspace(name, parent) {
  return post("/api/code/create-workspace", { name, parent }, "Could not create that project.");
}

export async function getCodeTree(relativePath = ".") {
  const res = await fetch(`/api/code/tree?path=${encodeURIComponent(relativePath)}`);
  const data = await readJson(res, "Could not read that folder.");
  return data.entries || [];
}

export async function readCodeFile(relativePath) {
  return post("/api/code/read-file", { path: relativePath }, "Could not read that file.");
}

export async function writeCodeFile(relativePath, content, session) {
  return post("/api/code/write-file", { path: relativePath, content, session }, "Could not save that file.");
}

export async function createCodeEntry(relativePath, type = "file", session) {
  return post("/api/code/create-entry", { path: relativePath, type, session }, "Could not create that entry.");
}

export async function deleteCodeEntry(relativePath, session) {
  return post("/api/code/delete-entry", { path: relativePath, session }, "Could not delete that entry.");
}

export async function renameCodeEntry(from, to, session) {
  return post("/api/code/rename-entry", { from, to, session }, "Could not rename that entry.");
}

export async function searchCode(query, relativePath = ".", maxResults = 40) {
  const data = await post("/api/code/search", { query, path: relativePath, maxResults }, "Search failed.");
  return data.results || [];
}

export async function runCodeCommand(command, cwd = ".", timeoutMs = 180000) {
  return post("/api/code/run-command", { command, cwd, timeoutMs }, "The command could not be started.");
}

export async function getCodeChanges(session) {
  const res = await fetch(`/api/code/changes?session=${encodeURIComponent(session || "manual")}`);
  const data = await readJson(res, "Could not load the change history.");
  return data.changes || [];
}

export async function revertCodeChange(session, id) {
  return post("/api/code/revert-change", { session, id }, "Could not undo that change.");
}

export async function clearCodeChanges(session) {
  return post("/api/code/clear-changes", { session }, "Could not clear the change history.");
}

export async function listCodeSessions() {
  const res = await fetch("/api/code/sessions");
  const data = await readJson(res, "Could not load code sessions.");
  return data.sessions || [];
}

export async function getCodeSession(id) {
  const res = await fetch(`/api/code/session?id=${encodeURIComponent(id)}`);
  const data = await readJson(res, "Could not load that code session.");
  return data.conversation;
}

export async function saveCodeSession(conversation) {
  const data = await post("/api/code/save-session", { conversation }, "Could not save the code session.");
  return data.conversation;
}

export async function deleteCodeSession(id) {
  return post("/api/code/delete-session", { id }, "Could not delete that code session.");
}

// Streams the agent loop. handlers: onSession, onStep, onToken, onReasoning,
// onAssistant, onToolStart, onToolResult, onDone, onError.
export async function streamCodeAgent(body, handlers = {}, signal) {
  const res = await fetch("/api/code/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let message = `Code request failed (HTTP ${res.status}).`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch (_) {}
    throw new Error(message);
  }
  if (!res.body) throw new Error("Streaming is not supported by this browser.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const consume = (block) => {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return; }

    switch (event) {
      case "session": handlers.onSession?.(payload); break;
      case "step": handlers.onStep?.(payload); break;
      case "token": handlers.onToken?.(payload.text || ""); break;
      case "reasoning": handlers.onReasoning?.(payload.text || ""); break;
      case "assistant": handlers.onAssistant?.(payload); break;
      case "tool_start": handlers.onToolStart?.(payload); break;
      case "tool_result": handlers.onToolResult?.(payload); break;
      case "done": handlers.onDone?.(payload); break;
      case "error": handlers.onError?.(payload.message || "The coding assistant failed."); break;
      default: break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
}
