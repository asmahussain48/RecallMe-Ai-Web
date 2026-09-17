"""
RecallMe — Backend Server
================================================
Run this Python server locally, then open RecallMe_v2.html in your browser.

Handles local Whisper transcription AND proxies calls to the Groq API
(chat + cloud transcription) so the Groq API key never has to live in
the browser-side script.js.

SETUP (one time):
    pip install -r requirements.txt

    # For GPU support (optional, much faster Whisper):
    pip install torch torchvision torchaudio

    # For MP3/MP4 support you also need ffmpeg:
    # Windows: https://ffmpeg.org/download.html  (add to PATH)
    # Mac:     brew install ffmpeg
    # Linux:   sudo apt install ffmpeg

    # Required for AI chat / Groq cloud transcription — get a free key at
    # https://console.groq.com/keys, then set it as an environment variable:
    #   Windows (PowerShell):  $env:GROQ_API_KEY = "your-key-here"
    #   Mac/Linux:             export GROQ_API_KEY="your-key-here"

RUN:
    python server.py

Then open RecallMe_v2.html in your browser.
The server runs on http://localhost:5050
"""

import json
import os
import tempfile
import threading
import time
import traceback

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

# ── Lazy-load Whisper so startup is fast ──────────────────────────────────────
_whisper_model = None
_model_lock = threading.Lock()
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
CORS(app, resources={r"/*": {"origins": "*"}})   # allow the HTML file to call us

ALLOWED_EXTENSIONS = {
    "mp3", "mp4", "wav", "m4a", "ogg", "flac", "webm",
    "mov", "avi", "mkv", "aac", "wma", "opus"
}
MAX_FILE_MB = 500   # hard limit


def allowed(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ── Groq proxy config ──────────────────────────────────────────────────────────
# The key lives ONLY here, server-side. script.js never sees it.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_CHAT_MODEL = "openai/gpt-oss-120b"


def require_groq_key():
    if not GROQ_API_KEY:
        raise RuntimeError(
            "GROQ_API_KEY is not set on the server. Get a free key at "
            "https://console.groq.com/keys and set it as an environment "
            "variable before starting server.py."
        )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "status": "ok",
        "service": "RecallMe Backend Server",
        "model": MODEL_SIZE,
        "endpoints": {
            "POST /transcribe":        "Upload audio/video file → local Whisper transcript",
            "POST /api/transcribe-groq": "Upload audio file → Groq Whisper transcript (proxied)",
            "POST /api/chat":           "Chat with Letta via Groq (proxied)",
            "GET  /health":             "Server health check",
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

    # ── validate file ──────────────────────────────────────────────────────────
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded. Send as multipart field 'file'."}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename."}), 400
    if not allowed(f.filename):
        return jsonify({
            "error": f"Unsupported format '{f.filename.rsplit('.',1)[-1]}'. "
                     f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        }), 415

    language = request.form.get("language", None)   # None = auto-detect
    task     = request.form.get("task", "transcribe")

    # ── save to temp file ──────────────────────────────────────────────────────
    suffix = "." + f.filename.rsplit(".", 1)[-1].lower()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
            f.save(tmp_path)

        size_mb = os.path.getsize(tmp_path) / (1024 * 1024)
        if size_mb > MAX_FILE_MB:
            return jsonify({"error": f"File too large ({size_mb:.1f} MB). Max: {MAX_FILE_MB} MB."}), 413

        print(f"[Transcribe] '{f.filename}'  {size_mb:.1f} MB  lang={language}  task={task}")

        # ── run Whisper ────────────────────────────────────────────────────────
        model = get_model()

        options = {"task": task, "verbose": False}
        if language:
            options["language"] = language

        start = time.time()
        result = model.transcribe(tmp_path, **options)
        elapsed = time.time() - start

        print(f"[Transcribe] Done in {elapsed:.1f}s — {len(result['text'])} chars")

        # Build a clean response
        segments = [
            {
                "id":    s["id"],
                "start": round(s["start"], 2),
                "end":   round(s["end"],   2),
                "text":  s["text"].strip()
            }
            for s in result.get("segments", [])
        ]

        duration = segments[-1]["end"] if segments else 0

        return jsonify({
            "text":      result["text"].strip(),
            "language":  result.get("language", "unknown"),
            "duration":  duration,
            "segments":  segments,
            "model":     MODEL_SIZE,
            "elapsed_s": round(elapsed, 2)
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """
    Proxies chat requests to Groq so the API key never reaches the browser.
    Body: { "system": "...", "message": "...", "max_tokens": 900 }
    Returns: { "text": "..." }
    """
    try:
        require_groq_key()
        data = request.get_json(silent=True) or {}
        system = data.get("system", "")
        message = data.get("message", "")
        max_tokens = int(data.get("max_tokens", 900))
        if not message:
            return jsonify({"error": "Missing 'message'."}), 400

        r = requests.post(
            GROQ_CHAT_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {GROQ_API_KEY}",
            },
            json={
                "model": GROQ_CHAT_MODEL,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": message},
                ],
            },
            timeout=60,
        )
        result = r.json()
        if "error" in result:
            return jsonify({"error": result["error"].get("message", "Groq API error")}), 502

        text = (result.get("choices") or [{}])[0].get("message", {}).get("content", "")
        if not text:
            return jsonify({"error": "Empty response from Groq."}), 502
        return jsonify({"text": text})

    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/transcribe-groq", methods=["POST"])
def api_transcribe_groq():
    """
    Proxies audio transcription to Groq's cloud Whisper so the API key
    never reaches the browser. Body: multipart field 'file'.
    Returns: { "text": "..." }
    """
    try:
        require_groq_key()
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded. Send as multipart field 'file'."}), 400
        f = request.files["file"]

        r = requests.post(
            GROQ_TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (f.filename, f.stream, f.mimetype)},
            data={"model": "whisper-large-v3", "response_format": "text"},
            timeout=120,
        )
        raw = r.text
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = raw

        if isinstance(parsed, dict) and parsed.get("error"):
            msg = parsed["error"]
            msg = msg.get("message", "unknown error") if isinstance(msg, dict) else str(msg)
            return jsonify({"error": "Groq Whisper: " + msg}), 502

        transcript = parsed if isinstance(parsed, str) else parsed.get("text", "")
        if not transcript or not transcript.strip():
            return jsonify({"error": "No transcription returned from Groq Whisper."}), 502
        return jsonify({"text": transcript.strip()})

    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── Startup ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", 5050))
    print("=" * 60)
    print("  RecallMe Backend Server")
    print("=" * 60)
    print(f"  Whisper model : {MODEL_SIZE}")
    print(f"  Port          : {PORT}")
    print(f"  URL           : http://localhost:{PORT}")
    print(f"  Groq API key  : {'set ✓' if GROQ_API_KEY else 'NOT SET — AI chat & Groq transcription will fail'}")
    print()
    if not GROQ_API_KEY:
        print("  ⚠ Set GROQ_API_KEY as an environment variable to enable")
        print("    AI chat and Groq cloud transcription (free key at")
        print("    https://console.groq.com/keys).")
        print()
    print("  Tip: Change MODEL_SIZE at the top of this file to")
    print("  'small' or 'medium' for better Whisper accuracy.")
    print("=" * 60)
    print()

    # Pre-load model in background so first request is fast
    threading.Thread(target=get_model, daemon=True).start()

    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
