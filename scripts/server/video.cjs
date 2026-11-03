// video.cjs — local AI video editing for Monami
//
// Runs entirely on this machine: FFmpeg does the cutting/encoding, the existing
// Whisper backend turns speech into captions, and Kokoro TTS (via the Voice
// screen) supplies narration. No cloud service and no extra model downloads.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pipeline, Transform } = require("stream");

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".flv",
  ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".3gp", ".ogv",
]);

const SILENCE_PRESETS = {
  gentle: { noiseDb: -30, minDuration: 1.0 },
  normal: { noiseDb: -35, minDuration: 0.6 },
  aggressive: { noiseDb: -40, minDuration: 0.35 },
};

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".3gp": "video/3gpp",
  ".ogv": "video/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function withStatus(error, statusCode) {
  error.statusCode = statusCode;
  return error;
}

function lastLines(text, count = 6) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" | ")
    .slice(0, 800);
}

module.exports = function createVideoFeature(deps) {
  const {
    ROOT,
    TTS_OUTPUTS,
    MIME,
    json,
    readJsonBody,
    pathInside,
    safeOutputName,
    transcribeWavBuffer,
  } = deps;

  const VIDEO_DIR = path.join(ROOT, "app", "video");
  const UPLOADS_DIR = path.join(VIDEO_DIR, "uploads");
  const EXPORTS_DIR = path.join(VIDEO_DIR, "exports");
  const POSTERS_DIR = path.join(VIDEO_DIR, "posters");
  const META_DIR = path.join(VIDEO_DIR, "meta");
  const TMP_DIR = path.join(VIDEO_DIR, "tmp");

  for (const dir of [VIDEO_DIR, UPLOADS_DIR, EXPORTS_DIR, POSTERS_DIR, META_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let ffmpegInfo = null;
  let job = null;
  let currentProc = null;
  let cancelRequested = false;

  // ── FFmpeg discovery ────────────────────────────────────────────────

  function executableName(base) {
    return process.platform === "win32" ? `${base}.exe` : base;
  }

  function folderHasFfmpeg(dir) {
    try {
      return fs.existsSync(path.join(dir, executableName("ffmpeg"))) &&
        fs.existsSync(path.join(dir, executableName("ffprobe")));
    } catch (_) {
      return false;
    }
  }

  function findFfmpeg(force = false) {
    if (ffmpegInfo?.available && !force) return ffmpegInfo;

    const candidates = [];
    if (process.env.FFMPEG_DIR) candidates.push(String(process.env.FFMPEG_DIR));
    candidates.push(
      path.join(ROOT, "app", "tools", "ffmpeg", "bin"),
      path.join(ROOT, "app", "tools", "ffmpeg"),
    );

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        const wingetPackages = path.join(localAppData, "Microsoft", "WinGet", "Packages");
        try {
          for (const entry of fs.readdirSync(wingetPackages)) {
            if (!/^Gyan\.FFmpeg/i.test(entry)) continue;
            const packageDir = path.join(wingetPackages, entry);
            for (const child of fs.readdirSync(packageDir)) {
              const binDir = path.join(packageDir, child, "bin");
              if (folderHasFfmpeg(binDir)) candidates.push(binDir);
            }
          }
        } catch (_) {}
      }
      candidates.push("C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin");
    }

    let ffmpeg = "";
    let ffprobe = "";
    for (const dir of candidates) {
      if (folderHasFfmpeg(dir)) {
        ffmpeg = path.join(dir, executableName("ffmpeg"));
        ffprobe = path.join(dir, executableName("ffprobe"));
        break;
      }
    }

    if (!ffmpeg) {
      // Fall back to whatever is on PATH (system install / Homebrew / apt)
      try {
        const locator = process.platform === "win32" ? "where" : "which";
        const ffmpegWhere = spawnSync(locator, ["ffmpeg"], { encoding: "utf8", windowsHide: true });
        const ffprobeWhere = spawnSync(locator, ["ffprobe"], { encoding: "utf8", windowsHide: true });
        if (ffmpegWhere.status === 0 && ffprobeWhere.status === 0) {
          ffmpeg = String(ffmpegWhere.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
          ffprobe = String(ffprobeWhere.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
        }
      } catch (_) {}
    }

    if (!ffmpeg || !ffprobe) {
      ffmpegInfo = {
        available: false,
        ffmpeg: "",
        ffprobe: "",
        version: "",
        error: "FFmpeg was not found on this computer.",
      };
      return ffmpegInfo;
    }

    let version = "";
    try {
      const result = spawnSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true });
      const firstLine = String(result.stdout || "").split(/\r?\n/)[0] || "";
      version = firstLine.replace(/^ffmpeg version\s*/i, "").split(" ")[0] || "";
    } catch (_) {}

    ffmpegInfo = { available: true, ffmpeg, ffprobe, version, error: "" };
    return ffmpegInfo;
  }

  // ── Video metadata ──────────────────────────────────────────────────

  function probeVideo(filePath) {
    const info = findFfmpeg();
    if (!info.available) throw withStatus(new Error(info.error), 503);

    const result = spawnSync(info.ffprobe, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });

    if (result.status !== 0) {
      throw new Error(`FFprobe could not read this video. ${lastLines(result.stderr)}`);
    }

    let data;
    try {
      data = JSON.parse(result.stdout || "{}");
    } catch (_) {
      throw new Error("FFprobe returned unreadable video information.");
    }

    const streams = Array.isArray(data.streams) ? data.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === "video");
    if (!videoStream) throw new Error("That file does not contain a video track.");

    const audioStream = streams.find((stream) => stream.codec_type === "audio");
    const format = data.format || {};
    const duration = Number(format.duration) || Number(videoStream.duration) || 0;
    const frameRate = String(videoStream.avg_frame_rate || videoStream.r_frame_rate || "0/1");
    const [num, den] = frameRate.split("/").map(Number);
    const fps = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? Math.round((num / den) * 100) / 100 : 0;

    return {
      duration: Math.round(duration * 1000) / 1000,
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
      fps,
      videoCodec: videoStream.codec_name || "",
      audioCodec: audioStream?.codec_name || "",
      hasAudio: Boolean(audioStream),
      sizeBytes: Number(format.size) || 0,
    };
  }

  function makePoster(videoPath, posterPath, duration) {
    const info = findFfmpeg();
    if (!info.available) return;
    const seek = Math.max(0, Math.min(1, (duration || 2) * 0.1));
    const result = spawnSync(info.ffmpeg, [
      "-y",
      "-ss", String(seek),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale='min(720,iw)':-2",
      "-q:v", "3",
      posterPath,
    ], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
      try { fs.unlinkSync(posterPath); } catch (_) {}
    }
  }

  // ── Sources ─────────────────────────────────────────────────────────

  function videoMetaPath(videoId) {
    return path.join(META_DIR, `${path.basename(String(videoId || ""))}.json`);
  }

  function resolveVideo(videoId) {
    const id = path.basename(String(videoId || ""));
    if (!id) return null;
    const metaPath = videoMetaPath(id);
    if (!fs.existsSync(metaPath)) return null;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (_) {
      return null;
    }
    const videoPath = path.join(UPLOADS_DIR, path.basename(String(meta.storedFilename || "")));
    if (!pathInside(videoPath, UPLOADS_DIR) || !fs.existsSync(videoPath)) return null;
    return { ...meta, id, path: videoPath };
  }

  function publicVideo(meta) {
    const info = {
      id: meta.id,
      name: meta.originalName || meta.storedFilename,
      originalName: meta.originalName || meta.storedFilename,
      storedFilename: meta.storedFilename,
      createdAt: meta.createdAt,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      sizeBytes: meta.sizeBytes,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      url: `/video-media/uploads/${encodeURIComponent(meta.storedFilename)}`,
      posterUrl: meta.posterFilename ? `/video-media/posters/${encodeURIComponent(meta.posterFilename)}` : "",
    };
    return info;
  }

  function listVideos() {
    try {
      return fs.readdirSync(META_DIR)
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .map((file) => {
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
            const resolved = resolveVideo(meta.id || path.basename(file, ".json"));
            return resolved ? publicVideo(resolved) : null;
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    } catch (_) {
      return [];
    }
  }

  function streamBodyToFile(req, destination, limitBytes) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      let settled = false;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limitBytes) {
            const err = new Error(`Video is too large. The limit is ${Math.round(limitBytes / (1024 ** 3))} GB.`);
            err.code = "LIMIT";
            callback(err);
            return;
          }
          callback(null, chunk);
        },
      });
      pipeline(req, limiter, fs.createWriteStream(destination), (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try { fs.unlinkSync(destination); } catch (_) {}
          reject(err);
          return;
        }
        resolve(bytes);
      });
    });
  }

  // ── Jobs ────────────────────────────────────────────────────────────

  function publicJob() {
    if (!job) return { active: false, kind: "", phase: "", progress: 0, speed: "", error: null, result: null };
    const { id, kind, phase, progress, speed, error, result, active, videoId, startedAt } = job;
    return { id, kind, phase, progress, speed, error, result, active, videoId, startedAt };
  }

  function startJob(kind, videoId, runner) {
    if (job?.active) {
      throw withStatus(new Error("Another video task is already running. Wait for it to finish or cancel it."), 409);
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    job = {
      id,
      kind,
      videoId: videoId || "",
      active: true,
      phase: "Starting…",
      progress: 0,
      speed: "",
      error: null,
      result: null,
      startedAt: new Date().toISOString(),
    };
    cancelRequested = false;

    Promise.resolve()
      .then(runner)
      .then((result) => {
        if (!job || job.id !== id) return;
        job = { ...job, active: false, phase: "Complete", progress: 100, speed: "", result };
      })
      .catch((err) => {
        if (!job || job.id !== id) return;
        const cancelled = cancelRequested;
        job = {
          ...job,
          active: false,
          phase: cancelled ? "Cancelled" : "Failed",
          speed: "",
          error: cancelled ? "" : (err?.message || String(err)),
        };
      })
      .finally(() => {
        if (job?.id === id) currentProc = null;
      });

    return job.id;
  }

  function runFfmpeg(args, options = {}) {
    const info = findFfmpeg();
    if (!info.available) return Promise.reject(withStatus(new Error(info.error), 503));
    const expectedSec = Number(options.expectedSec) || 0;

    return new Promise((resolve, reject) => {
      const proc = spawn(info.ffmpeg, ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], {
        cwd: options.cwd,
        windowsHide: true,
      });
      currentProc = proc;
      let stderrTail = "";
      let stdoutBuffer = "";

      const handleLine = (line) => {
        const value = line.trim();
        if (!value) return;
        const timeMatch = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(value);
        if (timeMatch && expectedSec > 0 && job) {
          const seconds = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
          job.progress = Math.max(0, Math.min(99, Math.round((seconds / expectedSec) * 100)));
        }
        const speedMatch = /^speed=(.+)$/.exec(value);
        if (speedMatch && job) {
          const speed = speedMatch[1].trim();
          job.speed = speed && speed !== "N/A" ? speed : "";
        }
        if (value === "progress=end" && job) job.progress = 99;
      };

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) handleLine(line);
      });
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-6000);
        if (process.env.VIDEO_DEBUG === "1") process.stdout.write(text);
      });
      proc.on("error", (err) => {
        if (currentProc === proc) currentProc = null;
        reject(new Error(`Could not start FFmpeg: ${err.message}`));
      });
      proc.on("close", (code, signal) => {
        if (currentProc === proc) currentProc = null;
        if (cancelRequested && (signal || code !== 0)) {
          reject(new Error("Cancelled"));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`FFmpeg failed (${code ?? signal}). ${lastLines(stderrTail)}`));
      });
    });
  }

  // ── Silence detection ───────────────────────────────────────────────

  function detectSilences(video, presetName) {
    const preset = SILENCE_PRESETS[presetName] || SILENCE_PRESETS.normal;
    return new Promise((resolve, reject) => {
      const info = findFfmpeg();
      if (!info.available) {
        reject(withStatus(new Error(info.error), 503));
        return;
      }
      const args = [
        "-i", video.path,
        "-vn",
        "-af", `silencedetect=noise=${preset.noiseDb}dB:d=${preset.minDuration}`,
        "-f", "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ];
      const proc = spawn(info.ffmpeg, ["-hide_banner", ...args], { windowsHide: true });
      currentProc = proc;
      let stderr = "";
      const starts = [];
      const silences = [];
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-20000);
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
          if (startMatch) starts.push(Math.max(0, Number(startMatch[1])));
          const endMatch = /silence_end:\s*(-?[\d.]+)/.exec(line);
          if (endMatch && starts.length) {
            const end = Number(endMatch[1]);
            const start = starts.shift();
            if (Number.isFinite(end) && end > start) silences.push({ start, end });
          }
        }
      });
      proc.on("error", (err) => {
        if (currentProc === proc) currentProc = null;
        reject(new Error(`Could not start FFmpeg: ${err.message}`));
      });
      proc.on("close", (code, signal) => {
        if (currentProc === proc) currentProc = null;
        if (cancelRequested && (signal || code !== 0)) {
          reject(new Error("Cancelled"));
          return;
        }
        if (code !== 0 && !silences.length) {
          reject(new Error(`Silence detection failed (${code ?? signal}). ${lastLines(stderr)}`));
          return;
        }
        for (const start of starts) {
          if (video.duration > start) silences.push({ start, end: video.duration });
        }
        const merged = [];
        for (const silence of silences.sort((a, b) => a.start - b.start)) {
          const last = merged[merged.length - 1];
          if (last && silence.start <= last.end + 0.05) {
            last.end = Math.max(last.end, silence.end);
          } else {
            merged.push({ ...silence });
          }
        }
        let total = 0;
        for (const silence of merged) total += silence.end - silence.start;
        resolve({
          silences: merged.map((silence) => ({
            start: Math.round(silence.start * 1000) / 1000,
            end: Math.round(silence.end * 1000) / 1000,
          })),
          removedSeconds: Math.round(total * 100) / 100,
          preset: presetName in SILENCE_PRESETS ? presetName : "normal",
          noiseDb: preset.noiseDb,
          minDuration: preset.minDuration,
          createdAt: new Date().toISOString(),
        });
      });
    });
  }

  function tmpDirFor(videoId) {
    const dir = path.join(TMP_DIR, path.basename(String(videoId)));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function analysisPath(videoId) {
    return path.join(tmpDirFor(videoId), "analysis.json");
  }

  function readCachedAnalysis(videoId) {
    try {
      return JSON.parse(fs.readFileSync(analysisPath(videoId), "utf8"));
    } catch (_) {
      return null;
    }
  }

  async function analyzeVideo(video, presetName) {
    if (job) {
      job.phase = "Listening for silence…";
      job.progress = 5;
    }
    const analysis = await detectSilences(video, presetName);
    try {
      fs.writeFileSync(analysisPath(video.id), JSON.stringify(analysis, null, 2), "utf8");
    } catch (_) {}
    return analysis;
  }

  // ── Captions ────────────────────────────────────────────────────────

  function captionsPath(videoId) {
    return path.join(tmpDirFor(videoId), "captions.json");
  }

  function readCachedCaptions(videoId) {
    try {
      return JSON.parse(fs.readFileSync(captionsPath(videoId), "utf8"));
    } catch (_) {
      return null;
    }
  }

  function normalizeSegments(raw, fallbackDuration) {
    const list = Array.isArray(raw?.transcription) ? raw.transcription : [];
    const segments = [];
    for (const item of list) {
      const text = String(item?.text || "").trim();
      if (!text) continue;
      const start = Number(item?.offsets?.from ?? 0) / 1000;
      const end = Number(item?.offsets?.to ?? 0) / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      segments.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
    }
    if (!segments.length && raw?.text) {
      segments.push({ start: 0, end: Math.max(1, fallbackDuration || 1), text: String(raw.text).trim() });
    }
    return segments;
  }

  function srtTimestamp(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    const millis = Math.round((total - Math.floor(total)) * 1000);
    const pad = (value, size = 2) => String(value).padStart(size, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
  }

  function assTimestamp(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value, size = 2) => String(value).padStart(size, "0");
    return `${hours}:${pad(minutes)}:${pad(secs.toFixed(2), 5)}`;
  }

  function buildSrt(segments) {
    return segments
      .map((segment, index) => `${index + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n${segment.text}\n`)
      .join("\n");
  }

  function assColor(hex, alpha = "00") {
    const value = String(hex || "#ffffff").replace("#", "");
    const r = value.slice(0, 2) || "ff";
    const g = value.slice(2, 4) || "ff";
    const b = value.slice(4, 6) || "ff";
    return `&H${alpha}${b}${g}${r}`.toUpperCase();
  }

  function escapeAssText(text) {
    return String(text || "")
      .replace(/\r?\n+/g, " ")
      .replace(/[{}]/g, "")
      .replace(/\\/g, "\\\\")
      .trim();
  }

  function buildAss(segments, options) {
    const width = Math.max(2, Math.round(options.width || 1920));
    const height = Math.max(2, Math.round(options.height || 1080));
    const size = options.size === "s" ? 0.035 : options.size === "l" ? 0.058 : 0.045;
    const fontSize = Math.max(16, Math.round(height * size));
    const alignment = options.position === "top" ? 8 : options.position === "middle" ? 5 : 2;
    const marginV = options.position === "bottom"
      ? Math.max(20, Math.round(height * 0.055))
      : Math.max(20, Math.round(height * 0.04));
    const primary = assColor(options.color || "#ffffff");
    const outline = Math.max(1, Math.round(fontSize * 0.055));

    const header = [
      "[Script Info]",
      "Title: Monami AI captions",
      "ScriptType: v4.00+",
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,Arial,${fontSize},${primary},&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},1,${alignment},40,40,${marginV},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];

    for (const segment of segments) {
      header.push(`Dialogue: 0,${assTimestamp(segment.start)},${assTimestamp(segment.end)},Default,,0,0,0,,${escapeAssText(segment.text)}`);
    }
    return header.join("\n");
  }

  async function transcribeVideo(video, options = {}) {
    const dir = tmpDirFor(video.id);
    const wavPath = path.join(dir, "speech.wav");
    if (job) {
      job.phase = "Extracting the audio track…";
      job.progress = 5;
    }
    await runFfmpeg([
      "-y",
      "-i", video.path,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      wavPath,
    ], { expectedSec: video.duration });

    if (job) {
      job.phase = "Transcribing speech on this machine…";
      job.progress = 35;
      job.speed = "";
    }

    const buffer = fs.readFileSync(wavPath);
    let result;
    try {
      result = await transcribeWavBuffer(buffer, {
        save: false,
        language: options.language || "auto",
        filename: `${video.originalName || video.id}.wav`,
        threads: options.threads,
        backendPreference: options.backendPreference,
      });
    } finally {
      try { fs.unlinkSync(wavPath); } catch (_) {}
    }

    const segments = normalizeSegments(result.raw, video.duration);
    if (!segments.length) {
      throw new Error("No speech was detected in this video, so there are no captions to add.");
    }

    const captions = {
      videoId: video.id,
      language: options.language || "auto",
      model: result.model || "",
      segments,
      text: segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim(),
      srt: buildSrt(segments),
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(captionsPath(video.id), JSON.stringify(captions, null, 2), "utf8");
    } catch (_) {}
    return captions;
  }

  // ── Render ──────────────────────────────────────────────────────────

  function atempoChain(speed) {
    const parts = [];
    let remaining = speed;
    while (remaining > 2) {
      parts.push("atempo=2");
      remaining /= 2;
    }
    while (remaining < 0.5) {
      parts.push("atempo=0.5");
      remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 0.001) parts.push(`atempo=${remaining.toFixed(4)}`);
    return parts;
  }

  function rotateFilters(degrees) {
    const value = ((Number(degrees) % 360) + 360) % 360;
    if (value === 90) return ["transpose=1"];
    if (value === 180) return ["transpose=1", "transpose=1"];
    if (value === 270) return ["transpose=2"];
    return [];
  }

  function mapSegmentsToTimeline(segments, { trimStart, trimEnd, speed, removedRanges, outputDuration }) {
    const mapRaw = (rawTime) => {
      let removed = 0;
      for (const range of removedRanges) {
        if (rawTime >= range.end) removed += range.end - range.start;
        else if (rawTime > range.start) removed += rawTime - range.start;
      }
      return Math.max(0, (rawTime - removed) / speed);
    };

    const mapped = [];
    for (const segment of segments) {
      const rawStart = segment.start - trimStart;
      const rawEnd = Math.min(segment.end, trimEnd) - trimStart;
      if (rawEnd <= 0) continue;
      const start = mapRaw(Math.max(0, rawStart));
      const end = Math.min(outputDuration, mapRaw(rawEnd));
      if (end - start < 0.12) continue;
      mapped.push({ start, end, text: segment.text });
    }
    return mapped;
  }

  function sanitizeStem(name) {
    return safeOutputName(String(name || "video").replace(/\.[^.]+$/, "")) || "video";
  }

  async function renderVideo(body) {
    const video = resolveVideo(body.videoId);
    if (!video) throw withStatus(new Error("That video is no longer available. Import it again."), 404);

    const totalDuration = Number(video.duration) || 0;
    const trimStart = clamp(body.trimStart ?? 0, 0, Math.max(0, totalDuration - 0.2));
    const trimEnd = clamp(body.trimEnd ?? totalDuration, trimStart + 0.2, totalDuration);
    const speed = clamp(body.speed ?? 1, 0.25, 4);
    const rotate = clamp(body.rotate ?? 0, 0, 359);
    const flipH = body.flipH === true;
    const flipV = body.flipV === true;
    const volume = clamp(body.volume ?? 1, 0, 2);
    const resolution = ["480", "720", "1080", "1440"].includes(String(body.resolution)) ? String(body.resolution) : "source";
    const removeSilence = body.removeSilence === true;
    const silencePreset = SILENCE_PRESETS[body.silencePreset] ? body.silencePreset : "normal";

    if (job) {
      job.phase = "Preparing the timeline…";
      job.progress = 2;
    }

    // Silence analysis (cached, so exporting twice is instant)
    let analysis = null;
    let removedRanges = [];
    if (removeSilence) {
      analysis = readCachedAnalysis(video.id);
      if (!analysis || analysis.preset !== silencePreset) {
        if (job) { job.phase = "Listening for silence…"; job.progress = 3; }
        analysis = await detectSilences(video, silencePreset);
        try { fs.writeFileSync(analysisPath(video.id), JSON.stringify(analysis, null, 2), "utf8"); } catch (_) {}
      }
      removedRanges = analysis.silences
        .map((silence) => ({
          start: Math.max(0, silence.start - trimStart),
          end: Math.min(trimEnd - trimStart, silence.end - trimStart),
        }))
        .filter((range) => range.end - range.start > 0.05);
    }

    const removedTotal = removedRanges.reduce((sum, range) => sum + (range.end - range.start), 0);
    const trimmedDuration = Math.max(0.2, trimEnd - trimStart - removedTotal);
    const outputDuration = Math.max(0.2, trimmedDuration / speed);
    const keptDuration = trimEnd - trimStart - removedTotal;
    if (keptDuration < 0.5) {
      throw new Error("That edit would remove almost the whole clip. Loosen the trim or the silence preset.");
    }

    // Captions
    const captionsRequested = body.captions?.enabled === true;
    let assName = "";
    let srtText = "";
    let mappedSegments = [];
    if (captionsRequested) {
      const cached = readCachedCaptions(video.id);
      if (!cached?.segments?.length) {
        throw new Error("Generate AI captions for this video before exporting with captions.");
      }
      const style = body.captions?.style || {};
      const sourceWidth = Number(video.width) || 0;
      const sourceHeight = Number(video.height) || 0;
      const rotated = rotate === 90 || rotate === 270;
      const baseWidth = rotated ? sourceHeight : sourceWidth;
      const baseHeight = rotated ? sourceWidth : sourceHeight;
      let outHeight = baseHeight;
      let outWidth = baseWidth;
      if (resolution !== "source") {
        outHeight = Number(resolution);
        outWidth = baseHeight ? Math.round((baseWidth * outHeight) / baseHeight / 2) * 2 : outHeight;
      }
      mappedSegments = mapSegmentsToTimeline(cached.segments, {
        trimStart,
        trimEnd,
        speed,
        removedRanges,
        outputDuration,
      });
      if (!mappedSegments.length) {
        throw new Error("The captions fall outside the trimmed part of the video.");
      }
      srtText = buildSrt(mappedSegments);
      if (body.captions?.burn !== false) {
        assName = "captions.ass";
        const dir = tmpDirFor(video.id);
        fs.writeFileSync(path.join(dir, assName), buildAss(mappedSegments, {
          width: outWidth,
          height: outHeight,
          size: style.size,
          color: style.color,
          position: style.position,
        }), "utf8");
      }
    }

    // Narration
    let narrationPath = "";
    const narration = body.narration;
    if (narration?.file) {
      const filename = path.basename(String(narration.file));
      const candidate = path.join(TTS_OUTPUTS, filename);
      if (!filename || !pathInside(candidate, TTS_OUTPUTS) || !fs.existsSync(candidate)) {
        throw new Error("The selected voiceover clip could not be found. Generate it again in the narration panel.");
      }
      narrationPath = candidate;
    }
    const narrationVolume = clamp(narration?.volume ?? 1, 0, 2);
    const narrationDelay = clamp(narration?.delay ?? 0, 0, 3600);

    // Build the FFmpeg graph
    const removedExpr = removedRanges.length
      ? removedRanges.slice(0, 300).map((range) => `not(between(t,${range.start.toFixed(3)},${range.end.toFixed(3)}))`).join("*")
      : "";

    const videoFilters = [];
    if (removedExpr) {
      videoFilters.push(`select='${removedExpr}'`, "setpts=N/FRAME_RATE/TB");
    }
    if (Math.abs(speed - 1) > 0.001) videoFilters.push(`setpts=PTS/${speed}`);
    videoFilters.push(...rotateFilters(rotate));
    if (flipH) videoFilters.push("hflip");
    if (flipV) videoFilters.push("vflip");
    if (resolution !== "source") {
      videoFilters.push(`scale=-2:${resolution}:flags=lanczos`);
    } else {
      videoFilters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    }
    if (assName) videoFilters.push(`subtitles=filename=${assName}`);

    const graph = [`[0:v]${videoFilters.join(",")}[vout]`];
    const maps = ["-map", "[vout]"];

    const hasBaseAudio = video.hasAudio !== false;
    const narrationEnabled = Boolean(narrationPath);
    if (hasBaseAudio) {
      const audioFilters = [];
      if (removedExpr) audioFilters.push(`aselect='${removedExpr}'`, "asetpts=N/SR/TB");
      audioFilters.push(...atempoChain(speed));
      audioFilters.push(`volume=${volume.toFixed(3)}`);
      graph.push(`[0:a]${audioFilters.join(",")}[aorig]`);
      if (narrationEnabled) {
        const delay = narrationDelay > 0 ? `adelay=${Math.round(narrationDelay * 1000)}:all=1,` : "";
        graph.push(`[1:a]${delay}volume=${narrationVolume.toFixed(3)}[anar]`);
        graph.push("[aorig][anar]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]");
        maps.push("-map", "[aout]");
      } else {
        maps.push("-map", "[aorig]");
      }
    } else if (narrationEnabled) {
      const delay = narrationDelay > 0 ? `adelay=${Math.round(narrationDelay * 1000)}:all=1,` : "";
      graph.push(`[1:a]${delay}volume=${narrationVolume.toFixed(3)},apad=whole_dur=${outputDuration.toFixed(3)}[aout]`);
      maps.push("-map", "[aout]");
    } else {
      maps.push("-an");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const originalStem = sanitizeStem(body.outputName || video.originalName);
    const outputFilename = `video-${stamp}-${originalStem}.mp4`;
    const outputPath = path.join(EXPORTS_DIR, outputFilename);
    const baseName = path.basename(outputFilename, ".mp4");

    const args = [
      "-y",
      "-ss", trimStart.toFixed(3),
      "-to", trimEnd.toFixed(3),
      "-i", video.path,
    ];
    if (narrationPath) args.push("-i", narrationPath);
    args.push(
      "-filter_complex", graph.join(";"),
      ...maps,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
    );
    if (hasBaseAudio || narrationEnabled) {
      args.push("-c:a", "aac", "-b:a", "160k");
    }
    args.push(
      "-movflags", "+faststart",
      "-metadata", `title=${originalStem}`,
      outputPath,
    );

    if (job) {
      job.phase = "Rendering the final video…";
      job.progress = removeSilence ? 8 : 4;
      job.speed = "";
    }

    await runFfmpeg(args, {
      cwd: captionsRequested && assName ? tmpDirFor(video.id) : undefined,
      expectedSec: outputDuration,
    });

    if (captionsRequested) {
      const srtFilename = `${baseName}.srt`;
      fs.writeFileSync(path.join(EXPORTS_DIR, srtFilename), srtText, "utf8");
    }

    const stat = fs.statSync(outputPath);
    const rotated = rotate === 90 || rotate === 270;
    const sourceWidth = rotated ? Number(video.height) || 0 : Number(video.width) || 0;
    const sourceHeight = rotated ? Number(video.width) || 0 : Number(video.height) || 0;
    const outHeight = resolution !== "source" ? Number(resolution) : sourceHeight;
    const outWidth = resolution !== "source"
      ? (sourceHeight ? Math.round((sourceWidth * outHeight) / sourceHeight / 2) * 2 : outHeight)
      : sourceWidth;

    const metadata = {
      id: baseName,
      filename: outputFilename,
      displayName: `${originalStem}.mp4`,
      sourceName: video.originalName,
      sourceId: video.id,
      createdAt: new Date().toISOString(),
      duration: Math.round(outputDuration * 1000) / 1000,
      width: outWidth,
      height: outHeight,
      sizeBytes: stat.size,
      settings: {
        trimStart: Math.round(trimStart * 1000) / 1000,
        trimEnd: Math.round(trimEnd * 1000) / 1000,
        speed,
        rotate,
        flipH,
        flipV,
        resolution,
        volume,
        removeSilence,
        silencePreset,
        removedSeconds: Math.round(removedTotal * 100) / 100,
        captions: captionsRequested
          ? { burned: Boolean(assName), style: body.captions?.style || {}, lines: mappedSegments.length }
          : null,
        narration: narrationEnabled ? { file: path.basename(narrationPath), volume: narrationVolume } : null,
      },
      srtFile: captionsRequested ? `${baseName}.srt` : "",
    };
    fs.writeFileSync(path.join(EXPORTS_DIR, `${baseName}.json`), JSON.stringify(metadata, null, 2), "utf8");

    // Clean up the temporary subtitle script, keep the cached captions/analysis
    try {
      const dir = tmpDirFor(video.id);
      for (const file of fs.readdirSync(dir)) {
        if (file === "captions.ass") fs.unlinkSync(path.join(dir, file));
      }
    } catch (_) {}

    return publicOutput(metadata);
  }

  function publicOutput(metadata) {
    const file = String(metadata.filename || "");
    return {
      ...metadata,
      url: file ? `/video-exports/${encodeURIComponent(file)}` : "",
      srtUrl: metadata.srtFile ? `/video-exports/${encodeURIComponent(metadata.srtFile)}` : "",
      size: formatSize(metadata.sizeBytes),
    };
  }

  function formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }

  function listOutputs() {
    try {
      return fs.readdirSync(EXPORTS_DIR)
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .map((file) => {
          try {
            const metadata = JSON.parse(fs.readFileSync(path.join(EXPORTS_DIR, file), "utf8"));
            if (!metadata.filename || !fs.existsSync(path.join(EXPORTS_DIR, metadata.filename))) return null;
            return publicOutput(metadata);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    } catch (_) {
      return [];
    }
  }

  // ── File serving (with HTTP range support for video seeking) ────────

  function serveRangeFile(req, res, filePath, contentType) {
    if (!fs.existsSync(filePath)) {
      json(res, 404, { ok: false, error: "File not found." });
      return;
    }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    const headers = {
      "Content-Type": contentType || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    };

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, stat.size - Number(match[2]));
        end = stat.size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  }

  function mediaType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] || MIME[ext] || "application/octet-stream";
  }

  // ── Request handling ────────────────────────────────────────────────

  async function handle(req, res) {
    let parsed;
    try {
      parsed = new URL(req.url, "http://localhost");
    } catch (_) {
      return false;
    }
    const pathname = parsed.pathname;

    // Media (uploads, posters, exports) — handled by the video feature, not the SPA fallback
    if (req.method === "GET" && pathname.startsWith("/video-media/")) {
      const rest = decodeURIComponent(pathname.slice("/video-media/".length));
      const [kind, ...nameParts] = rest.split("/");
      const filename = path.basename(nameParts.join("/"));
      const root = kind === "uploads" ? UPLOADS_DIR : kind === "posters" ? POSTERS_DIR : "";
      if (!root || !filename) {
        json(res, 404, { ok: false, error: "Media not found." });
        return true;
      }
      const filePath = path.join(root, filename);
      if (!pathInside(filePath, root)) {
        json(res, 403, { ok: false, error: "Invalid media path." });
        return true;
      }
      serveRangeFile(req, res, filePath, mediaType(filePath));
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/video-exports/")) {
      const filename = path.basename(decodeURIComponent(pathname.slice("/video-exports/".length)));
      const filePath = path.join(EXPORTS_DIR, filename);
      if (!filename || !pathInside(filePath, EXPORTS_DIR)) {
        json(res, 403, { ok: false, error: "Invalid export path." });
        return true;
      }
      serveRangeFile(req, res, filePath, mediaType(filePath));
      return true;
    }

    if (!pathname.startsWith("/api/video/")) return false;

    if (pathname === "/api/video/status" && req.method === "GET") {
      const info = findFfmpeg(parsed.searchParams.get("refresh") === "1");
      json(res, 200, {
        ok: true,
        available: info.available,
        ffmpeg: info.ffmpeg,
        ffprobe: info.ffprobe,
        version: info.version,
        error: info.error,
        job: publicJob(),
        hints: info.available ? [] : [
          "Windows: run winget install Gyan.FFmpeg (or put ffmpeg.exe and ffprobe.exe in app/tools/ffmpeg/bin), then press Recheck.",
          "macOS: run brew install ffmpeg.",
          "Linux: install ffmpeg with your package manager.",
        ],
      });
      return true;
    }

    if (pathname === "/api/video/videos" && req.method === "GET") {
      json(res, 200, { ok: true, videos: listVideos() });
      return true;
    }

    if (pathname === "/api/video/outputs" && req.method === "GET") {
      json(res, 200, { ok: true, outputs: listOutputs() });
      return true;
    }

    if (pathname === "/api/video/job-status" && req.method === "GET") {
      json(res, 200, { ok: true, job: publicJob() });
      return true;
    }

    if (pathname === "/api/video/analysis" && req.method === "GET") {
      const video = resolveVideo(parsed.searchParams.get("videoId"));
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      return json(res, 200, { ok: true, analysis: readCachedAnalysis(video.id) }), true;
    }

    if (pathname === "/api/video/captions" && req.method === "GET") {
      const video = resolveVideo(parsed.searchParams.get("videoId"));
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      return json(res, 200, { ok: true, captions: readCachedCaptions(video.id) }), true;
    }

    if (pathname === "/api/video/import" && req.method === "POST") {
      const info = findFfmpeg();
      if (!info.available) return json(res, 503, { ok: false, error: info.error }), true;

      const originalName = path.basename(String(parsed.searchParams.get("filename") || "video.mp4"));
      const extension = path.extname(originalName).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) {
        return json(res, 400, { ok: false, error: `That file type is not supported. Choose ${[...VIDEO_EXTENSIONS].join(", ")}.` }), true;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const stem = sanitizeStem(originalName);
      const storedFilename = `video-${stamp}-${stem}${extension}`;
      const destination = path.join(UPLOADS_DIR, storedFilename);

      try {
        await streamBodyToFile(req, destination, MAX_UPLOAD_BYTES);
      } catch (err) {
        return json(res, err.code === "LIMIT" ? 413 : 500, {
          ok: false,
          error: err.code === "LIMIT" ? err.message : `Could not save the video: ${err.message}`,
        }), true;
      }

      let probe;
      try {
        probe = probeVideo(destination);
      } catch (err) {
        try { fs.unlinkSync(destination); } catch (_) {}
        return json(res, 400, { ok: false, error: err.message }), true;
      }

      const id = path.basename(storedFilename, extension);
      const posterFilename = `${id}.jpg`;
      makePoster(destination, path.join(POSTERS_DIR, posterFilename), probe.duration);

      const metadata = {
        id,
        originalName,
        storedFilename,
        posterFilename: fs.existsSync(path.join(POSTERS_DIR, posterFilename)) ? posterFilename : "",
        createdAt: new Date().toISOString(),
        ...probe,
      };
      fs.writeFileSync(videoMetaPath(id), JSON.stringify(metadata, null, 2), "utf8");

      return json(res, 200, { ok: true, video: publicVideo({ ...metadata, id }) }), true;
    }

    if (pathname === "/api/video/analyze" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const video = resolveVideo(body.videoId);
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      try {
        const jobId = startJob("analyze", video.id, async () => {
          const analysis = await analyzeVideo(video, body.preset || "normal");
          return { ...analysis, videoId: video.id };
        });
        return json(res, 200, { ok: true, jobId }), true;
      } catch (err) {
        return json(res, err.statusCode || 500, { ok: false, error: err.message }), true;
      }
    }

    if (pathname === "/api/video/captions" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const video = resolveVideo(body.videoId);
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      try {
        const jobId = startJob("captions", video.id, async () => {
          const captions = await transcribeVideo(video, {
            language: body.language,
            threads: body.threads,
            backendPreference: body.backendPreference,
          });
          return { ...captions, videoId: video.id };
        });
        return json(res, 200, { ok: true, jobId }), true;
      } catch (err) {
        return json(res, err.statusCode || 500, { ok: false, error: err.message }), true;
      }
    }

    if (pathname === "/api/video/render" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const video = resolveVideo(body.videoId);
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      try {
        const jobId = startJob("render", video.id, () => renderVideo(body));
        return json(res, 200, { ok: true, jobId }), true;
      } catch (err) {
        return json(res, err.statusCode || 500, { ok: false, error: err.message }), true;
      }
    }

    if (pathname === "/api/video/cancel" && req.method === "POST") {
      if (!job?.active) return json(res, 200, { ok: true, message: "No video task is running." }), true;
      cancelRequested = true;
      try { currentProc?.kill("SIGKILL"); } catch (_) {}
      return json(res, 200, { ok: true, message: "Cancelling…" }), true;
    }

    if (pathname === "/api/video/delete-video" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const video = resolveVideo(body.videoId);
      if (!video) return json(res, 404, { ok: false, error: "Video not found." }), true;
      if (job?.active && job.videoId === video.id) {
        return json(res, 409, { ok: false, error: "Wait for the running video task to finish first." }), true;
      }
      try {
        for (const target of [
          path.join(UPLOADS_DIR, path.basename(video.storedFilename)),
          video.posterFilename ? path.join(POSTERS_DIR, path.basename(video.posterFilename)) : "",
          videoMetaPath(video.id),
        ]) {
          if (target && fs.existsSync(target)) fs.unlinkSync(target);
        }
        fs.rmSync(path.join(TMP_DIR, video.id), { recursive: true, force: true });
        return json(res, 200, { ok: true }), true;
      } catch (err) {
        return json(res, 500, { ok: false, error: `Could not delete the video: ${err.message}` }), true;
      }
    }

    if (pathname === "/api/video/delete-output" && req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const filename = path.basename(String(body.filename || ""));
      const filePath = path.join(EXPORTS_DIR, filename);
      if (!filename || !pathInside(filePath, EXPORTS_DIR)) {
        return json(res, 400, { ok: false, error: "Invalid filename." }), true;
      }
      try {
        const baseName = path.basename(filename, path.extname(filename));
        const targets = [
          filePath,
          path.join(EXPORTS_DIR, `${baseName}.json`),
          path.join(EXPORTS_DIR, `${baseName}.srt`),
        ];
        for (const target of targets) {
          if (fs.existsSync(target)) fs.unlinkSync(target);
        }
        return json(res, 200, { ok: true }), true;
      } catch (err) {
        return json(res, 500, { ok: false, error: `Could not delete the export: ${err.message}` }), true;
      }
    }

    json(res, 404, { ok: false, error: "Unknown video endpoint." });
    return true;
  }

  function stop() {
    cancelRequested = true;
    try { currentProc?.kill("SIGKILL"); } catch (_) {}
    currentProc = null;
  }

  return { handle, stop, getStatus: () => findFfmpeg(true) };
};
