"""
RecallMe — Backend Server
================================================
Run this Python server locally, then open http://localhost:5050 in your browser
(or open RecallMe_v2.html directly).

Handles local Whisper transcription, downloads video/audio links (yt-dlp), and
proxies calls to the Groq API (chat + cloud transcription) so the Groq API key
never has to live in the browser-side script.js.

SETUP (one time):
    python -m pip install -r requirements.txt

    # For GPU support (optional, much faster Whisper):
    python -m pip install torch torchvision torchaudio

    # Whisper needs ffmpeg on PATH to read ANY audio/video file:
    # Windows: https://ffmpeg.org/download.html  (add to PATH)
    # Mac:     brew install ffmpeg
    # Linux:   sudo apt install ffmpeg

    # Required for AI chat / Groq cloud transcription — get a free key at
    # https://console.groq.com/keys, then set it as an environment variable:
    #   Windows (PowerShell):  $env:GROQ_API_KEY = "your-key-here"
    #   Mac/Linux:             export GROQ_API_KEY="your-key-here"

    # Optional — if you host the web page somewhere (e.g. Vercel), allow that site:
    #   Windows (PowerShell):  $env:ALLOWED_ORIGINS = "https://your-app.vercel.app"

RUN:
    python server.py

Then open http://localhost:5050 in your browser.
"""

import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback

import requests
from flask import Flask, abort, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

# ── Lazy-load Whisper so startup is fast ──────────────────────────────────────
_whisper_model = None
_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()   # one Whisper job at a time — parallel jobs just fight over CPU/RAM
MODEL_SIZE = "base"   # tiny | base | small | medium | large
                       # tiny  = fastest, least accurate (~1GB RAM)
                       # base  = good balance (~1GB RAM)
                       # small = better accuracy (~2GB RAM)
                       # medium= very good    (~5GB RAM)


def get_model():
    global _whisper_model
    if _whisper_model is None:
        with _model_lock:
            if _whisper_model is None:
                print(f"[Whisper] Loading '{MODEL_SIZE}' model… (first request only)")
                import whisper
                _whisper_model = whisper.load_model(MODEL_SIZE)
                print(f"[Whisper] Model ready ✓")
    return _whisper_model


# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)

FRONTEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_FILES = {"RecallMe_v2.html", "script.js", "tailwind.css"}   # served as-is; nothing else in the folder is

# ── Who may call this server ──────────────────────────────────────────────────
# Browsers send an Origin header with requests from web pages. Only these pages may use the
# server (and with it your Groq key): the HTML opened as a file (Origin "null"), pages served
# from this computer on any port, and the sites listed in ALLOWED_ORIGINS (comma-separated).
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
EXTRA_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}
_warned_origins = set()


def origin_allowed(origin):
    return origin == "null" or bool(LOCAL_ORIGIN.match(origin)) or origin in EXTRA_ORIGINS


CORS(app, origins=[LOCAL_ORIGIN, "null", *EXTRA_ORIGINS])


@app.before_request
def reject_foreign_origins():
    # CORS headers only stop a foreign page from *reading* the reply — it could still *send*
    # a plain form upload — so refuse those requests outright.
    origin = request.headers.get("Origin")
    if origin and not origin_allowed(origin):
        if origin not in _warned_origins:
            _warned_origins.add(origin)
            print(f"[Blocked] requests from {origin} — if that's your site, add it to ALLOWED_ORIGINS")
        return jsonify({"error": f"This server doesn't accept requests from {origin}."}), 403


# ── Errors → JSON ─────────────────────────────────────────────────────────────
class ApiError(Exception):
    """An error whose message is meant for the user; sent as {"error": message, **extra}."""

    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify({"error": str(e), **e.extra}), e.status


@app.errorhandler(Exception)
def handle_unexpected_error(e):
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description}), e.code
    traceback.print_exc()
    return jsonify({"error": str(e)}), 500


# ── Uploads ───────────────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {
    "mp3", "mp4", "wav", "m4a", "ogg", "flac", "webm",
    "mov", "avi", "mkv", "aac", "wma", "opus"
}
MAX_FILE_MB = 500   # hard limit
MB = 1024 * 1024


def allowed(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def save_upload(workdir):
    """Validate the multipart field 'file' and save it into workdir. Returns its path."""
    if "file" not in request.files:
        raise ApiError("No file uploaded. Send as multipart field 'file'.")
    f = request.files["file"]
    if not f.filename:
        raise ApiError("Empty filename.")
    if not allowed(f.filename):
        raise ApiError(f"Unsupported format '{f.filename.rsplit('.', 1)[-1]}'. "
                       f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}", 415)

    path = os.path.join(workdir, "upload." + f.filename.rsplit(".", 1)[-1].lower())
    f.save(path)
    size_mb = os.path.getsize(path) / MB
    if size_mb > MAX_FILE_MB:
        raise ApiError(f"File too large ({size_mb:.1f} MB). Max: {MAX_FILE_MB} MB.", 413)
    print(f"[Upload] '{f.filename}'  {size_mb:.1f} MB")
    return path


def require_ffmpeg():
    # Whisper shells out to ffmpeg for every format (even WAV); without it the
    # error is a cryptic "[WinError 2] The system cannot find the file specified".
    if not shutil.which("ffmpeg"):
        raise ApiError(
            "ffmpeg is not installed or not on PATH — it's needed to read audio. "
            "Install it from https://ffmpeg.org/download.html, add it to PATH, "
            "then restart server.py.", 500)


# ── Local Whisper ─────────────────────────────────────────────────────────────
def run_whisper(path, language=None, task="transcribe"):
    require_ffmpeg()
    model = get_model()

    options = {"task": task, "verbose": False}
    if language:
        options["language"] = language

    with _transcribe_lock:
        print(f"[Whisper] Transcribing…  lang={language}  task={task}")
        start = time.time()
        result = model.transcribe(path, **options)
        elapsed = time.time() - start
    print(f"[Whisper] Done in {elapsed:.1f}s — {len(result['text'])} chars")

    segments = [
        {
            "id":    s["id"],
            "start": round(s["start"], 2),
            "end":   round(s["end"],   2),
            "text":  s["text"].strip()
        }
        for s in result.get("segments", [])
    ]
    return {
        "text":      result["text"].strip(),
        "language":  result.get("language", "unknown"),
        "duration":  segments[-1]["end"] if segments else 0,
        "segments":  segments,
        "model":     MODEL_SIZE,
        "elapsed_s": round(elapsed, 2)
    }


# ── Groq proxy config ──────────────────────────────────────────────────────────
# The key lives ONLY here, server-side. script.js never sees it.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_CHAT_MODEL = "openai/gpt-oss-120b"
# gpt-oss is a reasoning model and its hidden reasoning counts against max_tokens,
# so keep the reasoning short to leave room for the actual answer.
GROQ_REASONING_EFFORT = "low"
GROQ_MAX_TOKENS = 4096        # upper bound on what the browser may request per reply
MAX_HISTORY_MESSAGES = 20     # earlier chat turns forwarded with each question
GROQ_MAX_UPLOAD_MB = 25       # Groq's free-tier limit per audio file
GROQ_AUDIO_TYPES = {"flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "opus", "wav", "webm"}


def require_groq_key():
    if not GROQ_API_KEY:
        raise ApiError(
            "GROQ_API_KEY is not set on the server. Get a free key at "
            "https://console.groq.com/keys and set it as an environment "
            "variable before starting server.py.", 503)


def raise_groq_error(r, prefix=""):
    """Raise ApiError for a failed Groq response (JSON or plain text).
    Rate limits are passed on as 429 with retry_after (seconds) so the browser can wait and retry."""
    try:
        body = r.json()
    except ValueError:
        body = None
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        err = err.get("message")
    message = prefix + (err or f"Groq API returned HTTP {r.status_code}")
    if r.status_code == 429:
        try:
            retry_after = float(r.headers.get("retry-after", 10))
        except ValueError:
            retry_after = 10.0
        raise ApiError(message, 429, retry_after=retry_after)
    raise ApiError(message, 502)


def compact_audio(src, workdir):
    """Re-encode to 16 kHz mono Opus (~11 MB per hour of speech — Whisper works at 16 kHz anyway).
    Long lectures then fit Groq's 25 MB limit, and anything ffmpeg reads (MOV, MKV, AVI, AAC…) works.
    This is also much faster than extracting the audio in the browser, which plays the video in real time."""
    out = os.path.join(workdir, "compact.ogg")
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", out],
        capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        detail = (p.stderr.strip().splitlines() or ["ffmpeg failed"])[-1]
        raise ApiError("Could not read the audio in this file: " + detail, 415)
    return out


def groq_transcribe(path, workdir):
    """Transcribe an audio/video file with Groq's cloud Whisper. Returns the text."""
    require_groq_key()
    if shutil.which("ffmpeg"):
        path = compact_audio(path, workdir)
    elif path.rsplit(".", 1)[-1].lower() not in GROQ_AUDIO_TYPES:
        raise ApiError("Groq can't read this format directly. Install ffmpeg (see README) so the "
                       "server can convert it, or use an MP3/WAV/M4A/WebM file.", 415)

    size_mb = os.path.getsize(path) / MB
    if size_mb > GROQ_MAX_UPLOAD_MB:
        raise ApiError(f"This audio is too long for Groq's free tier ({size_mb:.0f} MB, max "
                       f"{GROQ_MAX_UPLOAD_MB} MB — about 2 hours). Use Whisper (Local) instead.", 413)

    print(f"[Groq] Transcribing {size_mb:.1f} MB…")
    with open(path, "rb") as f:
        r = requests.post(
            GROQ_TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (os.path.basename(path), f)},
            data={"model": "whisper-large-v3", "response_format": "text"},
            timeout=300,
        )
    if not r.ok:
        raise_groq_error(r, "Groq Whisper: ")

    # response_format=text → the body is the transcript itself (errors are JSON, handled above).
    # Don't json-parse it: a transcript like "42" or "true" would turn into a number/bool.
    r.encoding = "utf-8"
    transcript = r.text.strip()
    if not transcript:
        raise ApiError("No transcription returned from Groq Whisper.", 502)
    return transcript


# ── Links (YouTube, Vimeo, direct files… anything yt-dlp supports) ─────────────
ANSI_CODES = re.compile(r"\x1b\[[0-9;]*m")


def download_audio(url, workdir):
    """Download the best audio track of a link with yt-dlp. Returns (path, title)."""
    try:
        import yt_dlp
    except ImportError:
        raise ApiError("Transcribing links needs yt-dlp. Run  python -m pip install -r requirements.txt  "
                       "and restart server.py.", 500)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(workdir, "download.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "max_filesize": MAX_FILE_MB * MB,
        # YouTube needs a JavaScript runtime. yt-dlp only looks for Deno by default,
        # so also let it use Node.js — whichever of the two is installed.
        "js_runtimes": {"deno": {}, "node": {}},
    }
    print(f"[Download] {url}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
            if info.get("_type") in ("playlist", "multi_video"):
                raise ApiError("That link is a playlist — paste the link of a single video.", 422)
            info = ydl.process_ie_result(info, download=True)
    except yt_dlp.utils.DownloadError as e:
        message = ANSI_CODES.sub("", str(e)).strip().removeprefix("ERROR:").strip()
        raise ApiError("Could not download that link: " + message, 422)

    files = [d.get("filepath") for d in info.get("requested_downloads") or []]
    path = next((p for p in files if p and os.path.exists(p)), None)
    if not path:
        raise ApiError("Could not download that link — nothing was saved "
                       f"(it may be larger than {MAX_FILE_MB} MB).", 422)
    print(f"[Download] '{info.get('title')}'  {os.path.getsize(path) / MB:.1f} MB")
    return path, info.get("title") or "Lecture"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/", methods=["GET"])
def index():
    return send_from_directory(FRONTEND_DIR, "RecallMe_v2.html")


@app.route("/<name>", methods=["GET"])
def frontend_file(name):
    if name not in FRONTEND_FILES:
        abort(404)
    return send_from_directory(FRONTEND_DIR, name)


@app.route("/api", methods=["GET"])
def api_info():
    return jsonify({
        "status": "ok",
        "service": "RecallMe Backend Server",
        "model": MODEL_SIZE,
        "endpoints": {
            "GET  /":                    "The RecallMe web app",
            "POST /transcribe":          "Upload audio/video file → local Whisper transcript",
            "POST /transcribe-url":      "Video/audio link → transcript (local Whisper or Groq)",
            "POST /api/transcribe-groq": "Upload audio/video file → Groq Whisper transcript (proxied)",
            "POST /api/chat":            "Chat with Letta via Groq (proxied)",
            "GET  /health":              "Server health check",
            "GET  /model":               "Current model info"
        }
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "ts": time.time()})


@app.route("/model", methods=["GET"])
def model_info():
    return jsonify({
        "loaded": _whisper_model is not None,
        "size": MODEL_SIZE,
        "sizes_available": ["tiny", "base", "small", "medium", "large"]
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Accepts a multipart/form-data POST with:
      - file:     the audio or video file
      - language: (optional) e.g. "en", "ur", "ar"  — default: auto-detect
      - task:     (optional) "transcribe" or "translate"  — default: transcribe

    Returns JSON:
      { "text": "...", "language": "en", "segments": [...], "duration": 12.3 }
    """
    require_ffmpeg()
    language = request.form.get("language") or None   # None = auto-detect
    task = request.form.get("task", "transcribe")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as workdir:
        return jsonify(run_whisper(save_upload(workdir), language, task))


@app.route("/transcribe-url", methods=["POST"])
def transcribe_url():
    """
    Downloads a video/audio link and transcribes it.
    Body: { "url": "https://...", "engine": "whisper" | "groq" }
    Returns: { "text": "...", "title": "...", "language": "en" (whisper only) }
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    url = str(data.get("url") or "").strip()
    engine = data.get("engine", "whisper")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise ApiError("Please paste a full link starting with http:// or https://.")
    if engine not in ("whisper", "groq"):
        raise ApiError("'engine' must be 'whisper' or 'groq'.")
    # Check what's needed before spending time on the download
    if engine == "groq":
        require_groq_key()
    else:
        require_ffmpeg()

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as workdir:
        path, title = download_audio(url, workdir)
        if engine == "groq":
            return jsonify({"text": groq_transcribe(path, workdir), "title": title})
        result = run_whisper(path)
        return jsonify({"text": result["text"], "title": title, "language": result["language"]})


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """
    Proxies chat requests to Groq so the API key never reaches the browser.
    Body: { "system": "...", "message": "...", "max_tokens": 900,
            "history": [{"role": "user"|"assistant", "content": "..."}] }   (history optional)
    Returns: { "text": "...", "truncated": false }
      truncated = the reply hit max_tokens and was cut off
    """
    require_groq_key()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    system = data.get("system", "")
    message = data.get("message", "")
    try:
        max_tokens = max(1, min(int(data.get("max_tokens", 900)), GROQ_MAX_TOKENS))
    except (TypeError, ValueError):
        raise ApiError("'max_tokens' must be a number.")
    if not message:
        raise ApiError("Missing 'message'.")

    history = data.get("history")
    if not isinstance(history, list):
        history = []
    history = [
        {"role": m["role"], "content": m["content"]}
        for m in history[-MAX_HISTORY_MESSAGES:]
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
    ]

    r = requests.post(
        GROQ_CHAT_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GROQ_API_KEY}",
        },
        json={
            "model": GROQ_CHAT_MODEL,
            "max_tokens": max_tokens,
            "reasoning_effort": GROQ_REASONING_EFFORT,
            "messages": [
                {"role": "system", "content": system},
                *history,
                {"role": "user", "content": message},
            ],
        },
        timeout=60,
    )
    if not r.ok:
        raise_groq_error(r)

    choice = (r.json().get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    truncated = choice.get("finish_reason") == "length"
    if not text:
        if truncated:
            raise ApiError("The AI used up its token limit before answering. Try a shorter request.", 502)
        raise ApiError("Empty response from Groq.", 502)
    return jsonify({"text": text, "truncated": truncated})


@app.route("/api/transcribe-groq", methods=["POST"])
def api_transcribe_groq():
    """
    Proxies transcription to Groq's cloud Whisper so the API key never reaches
    the browser. Body: multipart field 'file' (audio or video).
    Returns: { "text": "..." }
    """
    require_groq_key()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as workdir:
        return jsonify({"text": groq_transcribe(save_upload(workdir), workdir)})


# ── Startup ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", 5050))
    # Only this computer by default — the server spends your Groq key, so don't expose it
    # to the whole network. Set HOST=0.0.0.0 to allow other devices on your network.
    HOST = os.environ.get("HOST", "127.0.0.1")
    has_ffmpeg = shutil.which("ffmpeg") is not None
    has_ytdlp = importlib.util.find_spec("yt_dlp") is not None
    print("=" * 60)
    print("  RecallMe Backend Server")
    print("=" * 60)
    print(f"  Open in browser : http://localhost:{PORT}")
    print(f"  Whisper model   : {MODEL_SIZE}")
    print(f"  Groq API key    : {'set ✓' if GROQ_API_KEY else 'NOT SET — AI chat & Groq transcription will fail'}")
    print(f"  ffmpeg          : {'found ✓' if has_ffmpeg else 'NOT FOUND — local Whisper transcription will fail'}")
    print(f"  yt-dlp          : {'found ✓' if has_ytdlp else 'NOT FOUND — transcribing video links will fail'}")
    if EXTRA_ORIGINS:
        print(f"  Extra origins   : {', '.join(sorted(EXTRA_ORIGINS))}")
    print()
    if not GROQ_API_KEY:
        print("  ⚠ Set GROQ_API_KEY as an environment variable to enable")
        print("    AI chat and Groq cloud transcription (free key at")
        print("    https://console.groq.com/keys).")
        print()
    if not has_ffmpeg:
        print("  ⚠ Install ffmpeg and add it to PATH so Whisper can read")
        print("    audio/video files (https://ffmpeg.org/download.html).")
        print()
    if not has_ytdlp:
        print("  ⚠ Run  python -m pip install -r requirements.txt  to")
        print("    enable transcribing YouTube/Vimeo/web links.")
        print()
    print("  Tip: Change MODEL_SIZE at the top of this file to")
    print("  'small' or 'medium' for better Whisper accuracy.")
    print("=" * 60)
    print()

    # Pre-load model in background so first request is fast
    threading.Thread(target=get_model, daemon=True).start()

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
