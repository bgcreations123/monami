import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  Clapperboard,
  Download,
  Film,
  LoaderCircle,
  Mic,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import {
  analyzeVideo,
  cancelVideoJob,
  deleteVideoOutput,
  deleteVideoSource,
  generateVideoCaptions,
  getTtsStatus,
  getVideoAnalysis,
  getVideoCaptions,
  getVideoJobStatus,
  chatWithLlm,
  getLlmStatus,
  getVideoStatus,
  importVideoFile,
  listTtsModels,
  listVideoOutputs,
  listVideoSources,
  renderVideoExport,
  speakTts,
} from "../services/api";
import "../styles/video.css";

const FALLBACK_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male" },
];

const MAX_CHARS = 5000;

function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function clockSeconds(seconds) {
  const total = Number(seconds) || 0;
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function VideoEditor({ showAlert, showConfirm }) {
  const [status, setStatus] = useState({
    available: false,
    version: "",
    error: "Checking for FFmpeg…",
    hints: [],
    job: { active: false },
  });
  const [videos, setVideos] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [job, setJob] = useState({ active: false, kind: "", phase: "", progress: 0 });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [resolution, setResolution] = useState("source");
  const [volume, setVolume] = useState(1);
  const [removeSilence, setRemoveSilence] = useState(false);
  const [silencePreset, setSilencePreset] = useState("normal");
  const [analysis, setAnalysis] = useState(null);

  const [captions, setCaptions] = useState(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionBurn, setCaptionBurn] = useState(true);
  const [captionSize, setCaptionSize] = useState("m");
  const [captionColor, setCaptionColor] = useState("#ffffff");
  const [captionPosition, setCaptionPosition] = useState("bottom");

  const [narrationText, setNarrationText] = useState("");
  const [narration, setNarration] = useState(null);
  const [narrationBusy, setNarrationBusy] = useState(false);
  const [narrationVolume, setNarrationVolume] = useState(1);
  const [narrationDelay, setNarrationDelay] = useState(0);
  const [ttsStatus, setTtsStatus] = useState({ voices: [], settings: {} });
  const [ttsModels, setTtsModels] = useState([]);
  const [ttsVoice, setTtsVoice] = useState("af_heart");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsSpeed, setTtsSpeed] = useState(1);

  const [outputName, setOutputName] = useState("");
  const [lastExport, setLastExport] = useState(null);

  const [aiCommand, setAiCommand] = useState("");
  const [aiPlan, setAiPlan] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [llmStatus, setLlmStatus] = useState({ ready: false, running: false, error: "" });

  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const jobKindRef = useRef("");

  const selected = useMemo(() => videos.find((video) => video.id === selectedId) || null, [videos, selectedId]);
  const voices = ttsStatus.voices?.length ? ttsStatus.voices : FALLBACK_VOICES;
  const installedModels = useMemo(() => ttsModels.filter((model) => model.installed), [ttsModels]);
  const selectedVoice = voices.find((voice) => voice.id === ttsVoice);
  const busy = Boolean(job?.active) || importing || narrationBusy;

  const refreshVideos = useCallback(async (selectAfter = null) => {
    const list = await listVideoSources();
    setVideos(list);
    if (selectAfter) {
      setSelectedId(selectAfter);
    } else {
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id || null));
    }
    return list;
  }, []);

  const refreshOutputs = useCallback(async () => {
    try {
      setOutputs(await listVideoOutputs());
    } catch (err) {
      console.warn("Could not load video exports:", err);
    }
  }, []);

  const refreshStatus = useCallback(async (force = false) => {
    const next = await getVideoStatus(force);
    setStatus(next);
    if (next.job?.active) {
      setJob(next.job);
      if (!jobKindRef.current) jobKindRef.current = next.job.kind || "";
    }
  }, []);

  const refreshTts = useCallback(async () => {
    try {
      const [nextStatus, models] = await Promise.all([getTtsStatus(), listTtsModels()]);
      setTtsStatus(nextStatus);
      setTtsModels(models);
      const installed = models.filter((model) => model.installed);
      setTtsModel((current) => {
        if (current && installed.some((model) => model.filename === current)) return current;
        const active = nextStatus.settings?.model;
        if (active && installed.some((model) => model.filename === active)) return active;
        return installed.find((model) => model.recommended)?.filename || installed[0]?.filename || "";
      });
    } catch (err) {
      console.warn("Could not read voice status:", err);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshVideos().catch((err) => setError(err.message || String(err)));
    refreshOutputs();
    refreshTts();
  }, [refreshStatus, refreshVideos, refreshOutputs, refreshTts]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getLlmStatus();
        if (!cancelled) setLlmStatus(next);
      } catch (_) {}
    };
    tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Remember the running task type so its result can be routed when polling finishes
  useEffect(() => {
    if (!job?.active) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await getVideoJobStatus();
        if (stopped) return;
        setJob(next);
        if (next.active) return;
        const kind = jobKindRef.current;
        jobKindRef.current = "";
        if (next.error) {
          setError(next.error);
          return;
        }
        if (kind === "captions") {
          setCaptions(next.result || null);
          setCaptionsEnabled(true);
          setNotice("Captions are ready. They are burned in when you export.");
          refreshVideos().catch(() => {});
        } else if (kind === "analyze") {
          setAnalysis(next.result || null);
          setNotice(
            next.result?.removedSeconds
              ? `Found ${next.result.removedSeconds}s of silence to trim.`
              : "No long silences were found with this preset.",
          );
        } else if (kind === "render") {
          setLastExport(next.result || null);
          setNotice("Export finished.");
          refreshOutputs();
        }
        refreshStatus();
      } catch (_) {
        // The server may be mid-restart; the next poll tries again
      }
    };
    const interval = setInterval(tick, 700);
    tick();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [job?.active, refreshOutputs, refreshStatus, refreshVideos]);

  // Load whatever was cached for this clip when it is selected
  useEffect(() => {
    if (!selectedId) {
      setAnalysis(null);
      setCaptions(null);
      return;
    }
    let cancelled = false;
    setAnalysis(null);
    setCaptions(null);
    setLastExport(null);
    Promise.all([
      getVideoAnalysis(selectedId).catch(() => null),
      getVideoCaptions(selectedId).catch(() => null),
    ]).then(([cachedAnalysis, cachedCaptions]) => {
      if (cancelled) return;
      setAnalysis(cachedAnalysis);
      setCaptions(cachedCaptions);
      if (cachedCaptions?.segments?.length) setCaptionsEnabled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // A fresh clip always starts with the full timeline selected
  useEffect(() => {
    if (!selected) return;
    const duration = Number(selected.duration) || 0;
    setTrimStart(0);
    setTrimEnd(duration);
    setOutputName(String(selected.originalName || selected.name || "video").replace(/\.[^.]+$/, ""));
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImport = useCallback(async (file) => {
    if (!file) return;
    setError("");
    setNotice("");
    setImporting(true);
    setImportProgress(0);
    try {
      const video = await importVideoFile(file, setImportProgress);
      await refreshVideos(video.id);
      setNotice(`Imported ${video.name}.`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setImporting(false);
      setImportProgress(0);
    }
  }, [refreshVideos]);

  const handleDeleteSource = useCallback(async (video, event) => {
    event?.stopPropagation();
    if (!video) return;
    const ok = showConfirm
      ? await showConfirm({
        title: "Remove Video",
        message: `Remove "${video.name}" from the editor? Its exports are kept.`,
        confirmLabel: "Remove",
        danger: true,
      })
      : window.confirm(`Remove "${video.name}" from the editor?`);
    if (!ok) return;
    try {
      await deleteVideoSource(video.id);
      await refreshVideos();
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [refreshVideos, showConfirm]);

  const handleDeleteOutput = useCallback(async (output) => {
    const ok = showConfirm
      ? await showConfirm({
        title: "Delete Export",
        message: `Delete "${output.displayName || output.filename}" and its subtitle file?`,
        confirmLabel: "Delete",
        danger: true,
      })
      : window.confirm(`Delete "${output.displayName || output.filename}"?`);
    if (!ok) return;
    try {
      await deleteVideoOutput(output.filename);
      await refreshOutputs();
      setLastExport((current) => (current?.filename === output.filename ? null : current));
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [refreshOutputs, showConfirm]);

  const handleAnalyze = useCallback(async () => {
    if (!selected) return;
    setError("");
    setNotice("");
    try {
      const response = await analyzeVideo(selected.id, silencePreset);
      jobKindRef.current = "analyze";
      setJob({ active: true, kind: "analyze", phase: "Listening for silence…", progress: 0 });
      if (response.jobId) setNotice("");
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [selected, silencePreset]);

  const handleCaptions = useCallback(async () => {
    if (!selected) return;
    setError("");
    setNotice("");
    try {
      await generateVideoCaptions(selected.id);
      jobKindRef.current = "captions";
      setJob({ active: true, kind: "captions", phase: "Preparing captions…", progress: 0 });
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [selected]);

  const handleNarration = useCallback(async (textOverride) => {
    const text = String(textOverride ?? narrationText).trim();
    if (!text) {
      setError("Type the narration text first.");
      return null;
    }
    if (textOverride != null) setNarrationText(text);
    setError("");
    setNotice("");
    setNarrationBusy(true);
    try {
      const output = await speakTts(text.slice(0, MAX_CHARS), {
        model: ttsModel || undefined,
        voice: ttsVoice,
        speed: ttsSpeed,
      });
      setNarration(output);
      setNotice("Voiceover generated. It is mixed in when you export.");
      refreshTts();
      return output;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    } finally {
      setNarrationBusy(false);
    }
  }, [narrationText, ttsModel, ttsVoice, ttsSpeed, refreshTts]);

  const handleExport = useCallback(async (narrationOverride = null, outputNameOverride = null) => {
    if (!selected) return;
    if (captionsEnabled && !captions?.segments?.length) {
      setError("Generate captions first, or turn captions off for this export.");
      return;
    }
    if (!(trimEnd > trimStart)) {
      setError("The trim end has to come after the trim start.");
      return;
    }
    setError("");
    setNotice("");
    try {
      await renderVideoExport({
        videoId: selected.id,
        outputName: outputNameOverride || outputName || selected.originalName,
        trimStart,
        trimEnd,
        speed,
        rotate,
        flipH,
        flipV,
        resolution,
        volume,
        removeSilence,
        silencePreset,
        captions: {
          enabled: captionsEnabled,
          burn: captionBurn,
          style: { size: captionSize, color: captionColor, position: captionPosition },
        },
        narration: (narrationOverride || narration)
          ? { file: (narrationOverride || narration).audioFile, volume: narrationVolume, delay: narrationDelay }
          : null,
      });
      jobKindRef.current = "render";
      setJob({ active: true, kind: "render", phase: "Preparing the timeline…", progress: 0 });
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [
    selected, captionsEnabled, captions, trimStart, trimEnd, speed, rotate, flipH, flipV,
    resolution, volume, removeSilence, silencePreset, captionBurn, captionSize, captionColor,
    captionPosition, narration, narrationVolume, narrationDelay, outputName,
  ]);

  const handleCancel = useCallback(async () => {
    try {
      await cancelVideoJob();
      setNotice("Cancelling…");
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  const waitForJob = useCallback(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = await getVideoJobStatus();
      setJob(next);
      if (!next.active) return next;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }, []);

  const extractJson = (text) => {
    const fenced = String(text || "").match(/```(?:json)?\\s*([\\s\\S]*?)```/i);
    const candidate = fenced ? fenced[1] : String(text || "");
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("The AI did not return a usable edit plan. Try rephrasing the command.");
    }
    return JSON.parse(candidate.slice(start, end + 1));
  };

  const handleAiEdit = useCallback(async () => {
    const command = aiCommand.trim();
    if (!command) {
      setError("Type an instruction for the AI first.");
      return;
    }
    if (!selected) {
      setError("Import and select a video before asking the AI to edit it.");
      return;
    }
    if (!llmStatus?.ready) {
      setError("No text model is loaded. Download one on Models and start it in Chat, then try again.");
      return;
    }
    setAiBusy(true);
    setError("");
    setNotice("");
    try {
      const metadata = {
        name: selected.name,
        duration: selected.duration,
        width: selected.width,
        height: selected.height,
        hasAudio: selected.hasAudio,
        current: {
          trimStart,
          trimEnd,
          speed,
          rotate,
          flipH,
          flipV,
          resolution,
          volume,
          removeSilence,
          silencePreset,
          captionsEnabled,
          captionBurn,
        },
      };
      const system = [
        "You are a video editing assistant for a local offline editor.",
        "Convert the user's instruction into a JSON object and output JSON only.",
        "Available fields (include only the ones to change):",
        "trimStart (seconds), trimEnd (seconds), speed (0.25-4), rotate (0,90,180,270),",
        "flipH (boolean), flipV (boolean), resolution (\"source\",\"1080\",\"720\",\"480\"),",
        "volume (0-2), removeSilence (boolean), silencePreset (\"gentle\",\"normal\",\"aggressive\"),",
        "captions (boolean), captionBurn (boolean), captionSize (\"s\",\"m\",\"l\"),",
        "captionColor (hex), captionPosition (\"top\",\"middle\",\"bottom\"),",
        "narrationText (string or null), narrationVolume (0-2), narrationDelay (seconds),",
        "export (boolean, true only when the user asks to render/export/finish).",
        "If the user asks for captions, set captions:true. If they ask to remove pauses, set removeSilence:true.",
        "If they ask to narrate, put the spoken text in narrationText, otherwise null.",
        "If they ask to render/export/finish, set export:true.",
        "Use null for fields you are not changing; never use empty strings for booleans.",
        "Do not invent numbers; use sensible defaults when the user is vague.",
      ].join(" ");
      const { content } = await chatWithLlm(
        [
          { role: "system", content: system },
          { role: "user", content: `Current video: ${JSON.stringify(metadata)}\\nInstruction: ${command}` },
        ],
        { temperature: 0.1, maxTokens: 700 },
      );
      const plan = extractJson(content);
      setAiPlan(plan);

      if (typeof plan.trimStart === "number") setTrimStart(Math.max(0, Math.min(plan.trimStart, selected.duration)));
      if (typeof plan.trimEnd === "number") setTrimEnd(Math.max(0.2, Math.min(plan.trimEnd, selected.duration)));
      if (typeof plan.speed === "number") setSpeed(Math.max(0.25, Math.min(plan.speed, 4)));
      if (typeof plan.rotate === "number") setRotate([0, 90, 180, 270].includes(plan.rotate) ? plan.rotate : rotate);
      if (typeof plan.flipH === "boolean") setFlipH(plan.flipH);
      if (typeof plan.flipV === "boolean") setFlipV(plan.flipV);
      if (typeof plan.resolution === "string" && plan.resolution) setResolution(["source", "1080", "720", "480"].includes(plan.resolution) ? plan.resolution : resolution);
      if (typeof plan.volume === "number") setVolume(Math.max(0, Math.min(plan.volume, 2)));
      if (typeof plan.removeSilence === "boolean") setRemoveSilence(plan.removeSilence);
      if (typeof plan.silencePreset === "string" && plan.silencePreset && ["gentle", "normal", "aggressive"].includes(plan.silencePreset)) setSilencePreset(plan.silencePreset);
      if (typeof plan.captions === "boolean") setCaptionsEnabled(plan.captions);
      if (typeof plan.captionBurn === "boolean") setCaptionBurn(plan.captionBurn);
      if (typeof plan.captionSize === "string" && plan.captionSize) setCaptionSize(plan.captionSize);
      if (typeof plan.captionColor === "string" && plan.captionColor) setCaptionColor(plan.captionColor);
      if (typeof plan.captionPosition === "string" && plan.captionPosition) setCaptionPosition(plan.captionPosition);
      if (typeof plan.narrationVolume === "number") setNarrationVolume(Math.max(0, Math.min(plan.narrationVolume, 2)));
      if (typeof plan.narrationDelay === "number") setNarrationDelay(Math.max(0, plan.narrationDelay));
      if (typeof plan.outputName === "string" && plan.outputName.trim()) setOutputName(plan.outputName.trim());

      // Run any requested generation steps in order
      let generatedNarration = null;
      if (plan.removeSilence === true && !analysis) {
        await handleAnalyze();
        await waitForJob();
      }
      if (plan.captions === true && !captions?.segments?.length) {
        await handleCaptions();
        await waitForJob();
      }
      if (typeof plan.narrationText === "string" && plan.narrationText.trim()) {
        generatedNarration = await handleNarration(plan.narrationText);
      }
      const shouldExport = plan.export === true || (typeof plan.export === "string" && plan.export.trim().length > 0);
      if (shouldExport) {
        await handleExport(generatedNarration, typeof plan.export === "string" ? plan.export.trim() : null);
        await waitForJob();
      }

      setNotice(plan.export === true ? "AI edit applied and exported." : "AI edit applied. Review the settings, then export.");
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setAiBusy(false);
    }
  }, [
    aiCommand, selected, llmStatus, trimStart, trimEnd, speed, rotate, flipH, flipV,
    resolution, volume, removeSilence, silencePreset, captionsEnabled, captionBurn, analysis,
    captions, handleAnalyze, handleCaptions, handleNarration, handleExport, waitForJob,
  ]);

  const effectiveDuration = useMemo(() => {
    if (!selected) return 0;
    const trimmed = Math.max(0, trimEnd - trimStart);
    const removed = removeSilence ? Math.min(Number(analysis?.removedSeconds) || 0, trimmed * 0.95) : 0;
    return Math.max(0, (trimmed - removed) / (Number(speed) || 1));
  }, [selected, trimStart, trimEnd, removeSilence, analysis, speed]);

  const dropHandler = (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) handleImport(file);
  };

  return (
    <div className="page video-page">
      <div className="page-scroll">
        <div className="page-column video-column">
          <header className="page-header">
            <div>
              <h2 className="page-title">Video</h2>
              <p className="page-subtitle">Trim, caption and narrate clips on this computer.</p>
            </div>
            <div className="video-header-actions">
              <span className={`tag ${status.available ? "tag-success" : ""}`} title={status.ffmpeg || ""}>
                {status.available ? `FFmpeg ${status.version || "ready"}` : "FFmpeg missing"}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => refreshStatus(true)}
                disabled={busy}
              >
                <RefreshCw size={15} aria-hidden="true" />
                Recheck
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                {importing ? <LoaderCircle size={15} className="video-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
                {importing ? `Importing ${importProgress}%` : "Import video"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,.mkv,.m4v,.mov,.webm,.avi,.wmv,.mts,.m2ts,.ts"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  handleImport(file);
                }}
              />
            </div>
          </header>

          {!status.available && (
            <div className="video-install" role="alert">
              <strong>FFmpeg is needed to edit video.</strong>
              <p>{status.error || "Install FFmpeg, then press Recheck."}</p>
              <ul>
                {(status.hints || []).map((hint) => <li key={hint}>{hint}</li>)}
              </ul>
            </div>
          )}

          {notice && <p className="video-notice" role="status">{notice}</p>}
          {error && <p className="video-notice video-notice-error" role="alert">{error}</p>}

          {job?.active && (
            <div className="video-progress" role="status" aria-live="polite">
              <div className="video-progress-head">
                <LoaderCircle size={16} className="video-spin" aria-hidden="true" />
                <span>{job.phase || "Working…"}</span>
                <span>{job.progress ? `${job.progress}%` : ""}</span>
                <button type="button" className="btn btn-danger video-cancel" onClick={handleCancel}>
                  <Square size={12} aria-hidden="true" />
                  Cancel
                </button>
              </div>
              <div className="video-progress-bar" aria-hidden="true">
                <div className="video-progress-fill" style={{ width: `${job.progress || 0}%` }} />
              </div>
              {job.speed && <div className="video-progress-meta">Encoding at {job.speed}</div>}
            </div>
          )}

          <div className="video-layout">
            <section className="video-stage">
              {selected ? (
                <>
                  <div className="video-player-frame">
                    <video
                      ref={videoRef}
                      key={selected.id}
                      src={selected.url}
                      poster={selected.posterUrl || undefined}
                      controls
                      preload="metadata"
                    />
                  </div>
                  <div className="video-source-meta">
                    <div>
                      <span className="video-source-name" title={selected.name}>{selected.name}</span>
                      <span className="video-source-detail">
                        {selected.width}×{selected.height} · {formatClock(selected.duration)} · {formatBytes(selected.sizeBytes)}
                        {selected.hasAudio ? " · has audio" : " · no audio"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={(event) => handleDeleteSource(selected, event)}
                      aria-label="Remove video"
                      title="Remove video"
                      disabled={busy}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <div
                  className="video-dropzone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={dropHandler}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
                  }}
                >
                  <Clapperboard size={34} aria-hidden="true" />
                  <span className="video-dropzone-title">Drop a video here</span>
                  <span className="video-dropzone-hint">MP4, MOV, MKV, WebM and most other common formats.</span>
                </div>
              )}

              <div className="video-sources">
                <div className="video-section-head">
                  <span className="video-section-title">Imported videos</span>
                  <span className="video-section-count">{videos.length}</span>
                </div>
                {videos.length === 0 ? (
                  <p className="video-muted">Nothing imported yet.</p>
                ) : (
                  <ul className="video-source-list">
                    {videos.map((video) => (
                      <li key={video.id}>
                        <button
                          type="button"
                          className={`video-source-row ${video.id === selectedId ? "is-active" : ""}`}
                          onClick={() => setSelectedId(video.id)}
                          disabled={busy}
                        >
                          {video.posterUrl ? (
                            <img src={video.posterUrl} alt="" className="video-source-thumb" />
                          ) : (
                            <span className="video-source-thumb video-source-thumb-empty"><Film size={16} /></span>
                          )}
                          <span className="video-source-row-main">
                            <span className="video-source-row-name">{video.name}</span>
                            <span className="video-source-row-meta">
                              {formatClock(video.duration)} · {formatBytes(video.sizeBytes)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <aside className="video-panel">
              <section className="video-card">
                <div className="video-card-head">
                  <Sparkles size={16} aria-hidden="true" />
                  <h3>AI edit with commands</h3>
                </div>
                <p className="video-hint">
                  Describe what to do in plain language. There is no separate "video model":
                  editing runs on FFmpeg, Whisper and Kokoro on this machine, and your loaded text
                  model ({llmStatus?.ready ? "ready" : "not loaded"}) turns the command into edits.
                  {llmStatus?.ready ? "" : " Download/start a text model in Models or Chat."}
                </p>
                <textarea
                  className="video-narration-text"
                  value={aiCommand}
                  placeholder="Example: trim to the first 30 seconds, remove silence, add captions, narrate 'Welcome to my video', and export."
                  onChange={(event) => setAiCommand(event.target.value)}
                  disabled={aiBusy || busy}
                />
                <div className="video-inline-fields">
                  <button
                    type="button"
                    className="btn btn-primary video-narrate-btn"
                    disabled={aiBusy || busy || !aiCommand.trim() || !selected}
                    onClick={handleAiEdit}
                  >
                    {aiBusy ? <LoaderCircle size={14} className="video-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
                    {aiBusy ? "Working…" : "Run AI edit"}
                  </button>
                </div>
                {aiPlan && (
                  <details className="video-ai-plan">
                    <summary>AI plan</summary>
                    <pre>{JSON.stringify(aiPlan, null, 2)}</pre>
                  </details>
                )}
              </section>

              <section className="video-card">
                <div className="video-card-head">
                  <Scissors size={16} aria-hidden="true" />
                  <h3>Trim &amp; look</h3>
                </div>
                {!selected ? (
                  <p className="video-muted">Import a video to start editing.</p>
                ) : (
                  <>
                    <div className="video-trim">
                      <div className="video-trim-labels">
                        <span>Start {formatClock(trimStart)}</span>
                        <span>End {formatClock(trimEnd)}</span>
                      </div>
                      <label className="video-field">
                        <span className="field-label">Trim start</span>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0.2, selected.duration)}
                          step={0.1}
                          value={trimStart}
                          disabled={busy}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            setTrimStart(Math.min(value, Math.max(0, trimEnd - 0.2)));
                          }}
                        />
                      </label>
                      <label className="video-field">
                        <span className="field-label">Trim end</span>
                        <input
                          type="range"
                          min={0.2}
                          max={Math.max(0.2, selected.duration)}
                          step={0.1}
                          value={trimEnd}
                          disabled={busy}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            setTrimEnd(Math.max(value, trimStart + 0.2));
                          }}
                        />
                      </label>
                      <p className="video-hint">
                        Keeping {formatClock(Math.max(0, trimEnd - trimStart))} of {formatClock(selected.duration)}.
                      </p>
                    </div>

                    <label className="video-field">
                      <span className="field-label">Speed <b>{Number(speed).toFixed(2)}×</b></span>
                      <input
                        type="range"
                        min={0.25}
                        max={4}
                        step={0.05}
                        value={speed}
                        disabled={busy}
                        onChange={(event) => setSpeed(Number(event.target.value))}
                      />
                    </label>

                    <div className="video-field">
                      <span className="field-label">Rotate</span>
                      <div className="segmented video-segmented" role="group" aria-label="Rotate">
                        {[0, 90, 180, 270].map((value) => (
                          <button
                            key={value}
                            type="button"
                            className="segmented-item"
                            aria-pressed={rotate === value}
                            disabled={busy}
                            onClick={() => setRotate(value)}
                          >
                            {value}°
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="video-inline-fields">
                      <button
                        type="button"
                        className={`btn ${flipH ? "video-toggle-on" : ""}`}
                        aria-pressed={flipH}
                        disabled={busy}
                        onClick={() => setFlipH((value) => !value)}
                      >
                        Flip horizontal
                      </button>
                      <button
                        type="button"
                        className={`btn ${flipV ? "video-toggle-on" : ""}`}
                        aria-pressed={flipV}
                        disabled={busy}
                        onClick={() => setFlipV((value) => !value)}
                      >
                        Flip vertical
                      </button>
                    </div>

                    <div className="video-inline-fields">
                      <label className="video-field video-field-grow">
                        <span className="field-label">Resolution</span>
                        <select value={resolution} disabled={busy} onChange={(event) => setResolution(event.target.value)}>
                          <option value="source">Source</option>
                          <option value="1080">1080p</option>
                          <option value="720">720p</option>
                          <option value="480">480p</option>
                        </select>
                      </label>
                      {selected.hasAudio && (
                        <label className="video-field video-field-grow">
                          <span className="field-label">Volume <b>{Math.round(volume * 100)}%</b></span>
                          <input
                            type="range"
                            min={0}
                            max={2}
                            step={0.05}
                            value={volume}
                            disabled={busy}
                            onChange={(event) => setVolume(Number(event.target.value))}
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}
              </section>

              <section className="video-card">
                <div className="video-card-head">
                  <Volume2 size={16} aria-hidden="true" />
                  <h3>Smart silence removal</h3>
                </div>
                {!selected ? (
                  <p className="video-muted">Available after a video is imported.</p>
                ) : (
                  <>
                    <label className="video-switch">
                      <input
                        type="checkbox"
                        checked={removeSilence}
                        disabled={busy || !selected.hasAudio}
                        onChange={(event) => setRemoveSilence(event.target.checked)}
                      />
                      <span>Cut long pauses automatically</span>
                    </label>
                    <div className="video-inline-fields">
                      <label className="video-field video-field-grow">
                        <span className="field-label">Sensitivity</span>
                        <select
                          value={silencePreset}
                          disabled={busy || !selected.hasAudio}
                          onChange={(event) => setSilencePreset(event.target.value)}
                        >
                          <option value="gentle">Gentle — only obvious pauses</option>
                          <option value="normal">Normal</option>
                          <option value="aggressive">Aggressive — tight cuts</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn video-analyze-btn"
                        disabled={busy || !selected.hasAudio}
                        onClick={handleAnalyze}
                      >
                        {analysis ? "Check again" : "Find pauses"}
                      </button>
                    </div>
                    {!selected.hasAudio && <p className="video-hint">This clip has no audio track to analyze.</p>}
                    {analysis && (
                      <p className="video-hint">
                        {analysis.removedSeconds
                          ? `${analysis.removedSeconds}s of silence can be removed. The exact cut is made on export.`
                          : "No long pauses found with this setting."}
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className="video-card">
                <div className="video-card-head">
                  <Captions size={16} aria-hidden="true" />
                  <h3>AI captions</h3>
                </div>
                {!selected ? (
                  <p className="video-muted">Available after a video is imported.</p>
                ) : (
                  <>
                    <div className="video-inline-fields">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || !selected.hasAudio}
                        onClick={handleCaptions}
                      >
                        <Sparkles size={14} aria-hidden="true" />
                        {captions?.segments?.length ? "Regenerate" : "Generate captions"}
                      </button>
                      {captions?.segments?.length ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => downloadText(captions.srt, `${outputName || "captions"}.srt`)}
                        >
                          <Download size={14} aria-hidden="true" />
                          .srt
                        </button>
                      ) : null}
                    </div>
                    {!selected.hasAudio && <p className="video-hint">This clip has no audio to transcribe.</p>}
                    {captions?.segments?.length ? (
                      <p className="video-hint">
                        {captions.segments.length} caption line{captions.segments.length === 1 ? "" : "s"}
                        {captions.language && captions.language !== "auto" ? ` · ${captions.language}` : ""} · Whisper on this machine.
                      </p>
                    ) : (
                      <p className="video-hint">Uses the same local Whisper model as Transcribe.</p>
                    )}
                    <label className="video-switch">
                      <input
                        type="checkbox"
                        checked={captionsEnabled}
                        onChange={(event) => setCaptionsEnabled(event.target.checked)}
                      />
                      <span>Add captions to the export</span>
                    </label>
                    {captionsEnabled && (
                      <>
                        <label className="video-switch">
                          <input
                            type="checkbox"
                            checked={captionBurn}
                            onChange={(event) => setCaptionBurn(event.target.checked)}
                          />
                          <span>Burn into the picture (otherwise a separate .srt)</span>
                        </label>
                        {captionBurn && (
                          <div className="video-inline-fields video-caption-style">
                            <label className="video-field video-field-grow">
                              <span className="field-label">Size</span>
                              <select value={captionSize} onChange={(event) => setCaptionSize(event.target.value)}>
                                <option value="s">Small</option>
                                <option value="m">Medium</option>
                                <option value="l">Large</option>
                              </select>
                            </label>
                            <label className="video-field video-field-grow">
                              <span className="field-label">Placement</span>
                              <select value={captionPosition} onChange={(event) => setCaptionPosition(event.target.value)}>
                                <option value="bottom">Bottom</option>
                                <option value="middle">Middle</option>
                                <option value="top">Top</option>
                              </select>
                            </label>
                            <label className="video-field video-field-color">
                              <span className="field-label">Colour</span>
                              <input
                                type="color"
                                value={captionColor}
                                onChange={(event) => setCaptionColor(event.target.value)}
                              />
                            </label>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </section>

              <section className="video-card">
                <div className="video-card-head">
                  <Mic size={16} aria-hidden="true" />
                  <h3>AI voiceover</h3>
                </div>
                {installedModels.length === 0 ? (
                  <p className="video-hint">Download a Kokoro voice model on the Models screen first.</p>
                ) : (
                  <>
                    <textarea
                      className="video-narration-text"
                      value={narrationText}
                      maxLength={MAX_CHARS}
                      placeholder="Write narration for this clip. Kokoro speaks it on this machine."
                      onChange={(event) => setNarrationText(event.target.value)}
                      disabled={narrationBusy}
                    />
                    <div className="video-inline-fields">
                      <label className="video-field video-field-grow">
                        <span className="field-label">Voice</span>
                        <select value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)}>
                          {voices.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voice.name || voice.id}{voice.language ? ` · ${voice.language}` : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      {installedModels.length > 1 && (
                        <label className="video-field video-field-grow">
                          <span className="field-label">Model</span>
                          <select value={ttsModel} onChange={(event) => setTtsModel(event.target.value)}>
                            {installedModels.map((model) => (
                              <option key={model.filename} value={model.filename}>{model.name || model.filename}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="video-inline-fields">
                      <label className="video-field video-field-grow">
                        <span className="field-label">Speaking speed <b>{Number(ttsSpeed).toFixed(2)}×</b></span>
                        <input
                          type="range"
                          min={0.5}
                          max={2}
                          step={0.05}
                          value={ttsSpeed}
                          onChange={(event) => setTtsSpeed(Number(event.target.value))}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-primary video-narrate-btn"
                        disabled={narrationBusy || !narrationText.trim()}
                        onClick={handleNarration}
                      >
                        {narrationBusy ? <LoaderCircle size={14} className="video-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                        {narrationBusy ? "Speaking…" : "Generate voiceover"}
                      </button>
                    </div>
                    {narration && (
                      <div className="video-narration-result">
                        <div className="video-narration-row">
                          <Volume2 size={15} aria-hidden="true" />
                          <span className="video-narration-name">{selectedVoice?.name || narration.voice || "Voiceover"}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => setNarration(null)}
                            title="Remove voiceover"
                            aria-label="Remove voiceover"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <audio controls src={narration.url} preload="metadata" className="video-narration-audio" />
                        <div className="video-inline-fields">
                          <label className="video-field video-field-grow">
                            <span className="field-label">Mix volume <b>{Math.round(narrationVolume * 100)}%</b></span>
                            <input
                              type="range"
                              min={0}
                              max={2}
                              step={0.05}
                              value={narrationVolume}
                              onChange={(event) => setNarrationVolume(Number(event.target.value))}
                            />
                          </label>
                          <label className="video-field video-field-grow">
                            <span className="field-label">Start after <b>{narrationDelay.toFixed(1)}s</b></span>
                            <input
                              type="range"
                              min={0}
                              max={Math.max(0, effectiveDuration)}
                              step={0.1}
                              value={narrationDelay}
                              onChange={(event) => setNarrationDelay(Number(event.target.value))}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>

              <section className="video-card video-export-card">
                <div className="video-card-head">
                  <Clapperboard size={16} aria-hidden="true" />
                  <h3>Export</h3>
                </div>
                <label className="video-field">
                  <span className="field-label">File name</span>
                  <input
                    type="text"
                    value={outputName}
                    placeholder="video"
                    disabled={busy}
                    onChange={(event) => setOutputName(event.target.value)}
                  />
                </label>
                <p className="video-hint">
                  Estimated length {formatClock(effectiveDuration)} · H.264 video with AAC audio · saved in app/video/exports.
                </p>
                <button
                  type="button"
                  className="btn btn-primary video-export-btn"
                  disabled={busy || !selected}
                  onClick={handleExport}
                >
                  <Download size={15} aria-hidden="true" />
                  {job?.active && job.kind === "render" ? "Exporting…" : "Export MP4"}
                </button>
              </section>
            </aside>
          </div>

          <section className="video-exports">
            <div className="video-section-head">
              <span className="video-section-title">Exports</span>
              <span className="video-section-count">{outputs.length}</span>
            </div>
            {lastExport && (
              <div className="video-last-export" role="status">
                <Download size={16} aria-hidden="true" />
                <span>Latest: {lastExport.displayName || lastExport.filename}</span>
                <a className="btn" href={lastExport.url} download={lastExport.displayName || lastExport.filename}>
                  Download
                </a>
              </div>
            )}
            {outputs.length === 0 ? (
              <p className="video-muted">Finished videos will show up here.</p>
            ) : (
              <ul className="row-list video-output-list">
                {outputs.map((output) => (
                  <li key={output.filename} className="row-item">
                    <Film size={18} aria-hidden="true" className="video-output-icon" />
                    <div className="row-item-main">
                      <div className="row-item-title">{output.displayName || output.filename}</div>
                      <div className="row-item-meta">
                        {output.width}×{output.height} · {output.duration ? clockSeconds(output.duration) : ""} · {output.size}
                        {output.createdAt ? ` · ${new Date(output.createdAt).toLocaleString()}` : ""}
                      </div>
                    </div>
                    <div className="row-item-actions">
                      {output.srtUrl && (
                        <a className="btn" href={output.srtUrl} download={`${output.id}.srt`}>SRT</a>
                      )}
                      <a className="btn btn-primary" href={output.url} download={output.displayName || output.filename}>
                        <Download size={14} aria-hidden="true" />
                        Download
                      </a>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => handleDeleteOutput(output)}
                        aria-label="Delete export"
                        title="Delete export"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
