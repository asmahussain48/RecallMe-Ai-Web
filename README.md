# RecallMe — Run Instructions

This repository contains a small Flask backend (`server.py`) that runs OpenAI Whisper for transcription and a web UI (`RecallMe_v2.html`). Follow the steps below to run locally on Windows (PowerShell). The server listens on http://localhost:5050 by default, and only accepts connections from this computer (set `$env:HOST = "0.0.0.0"` before starting it to allow other devices on your network — note that anyone who can reach it can use your Groq key).

**Prerequisites**
- Python 3.10+ installed
- `ffmpeg` on PATH — **required** for local Whisper transcription of any file (even WAV); see step 3
- (For YouTube links) [Node.js](https://nodejs.org) or [Deno](https://deno.com) installed — yt-dlp needs a JavaScript runtime to read YouTube pages
- (Optional) GPU: install appropriate `torch`/`torchaudio` builds for your GPU to speed up transcription

**1) Create / activate a virtual environment (PowerShell)**
```powershell
python -m venv recallme_env          # skip if recallme_env already exists
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& .\recallme_env\Scripts\Activate.ps1
```

**2) Install dependencies**
From the project root run:
```powershell
python -m pip install -r requirements.txt
# Optional (GPU / faster): python -m pip install torch torchvision torchaudio
```
Use `python -m pip` rather than plain `pip`: if the virtual environment folder was created somewhere else and then moved/copied here, its `pip.exe` still points at the old location and fails, while `python -m pip` keeps working.

**3) Install ffmpeg (required for Whisper)**
- Windows: download a static build from https://ffmpeg.org/download.html and add `ffmpeg/bin` to your PATH, then open a new terminal. `server.py` prints whether it found ffmpeg when it starts.

**3b) Set your Groq API key (required for AI chat + Groq cloud transcription)**
`server.py` proxies all Groq API calls so the key never reaches the browser. Get a free key at https://console.groq.com/keys, then set it as an environment variable before starting the server:
```powershell
$env:GROQ_API_KEY = "your-key-here"
```
Without this, local Whisper transcription still works, but the "Chat with Letta" panel and the "Groq AI (Free)" upload method will return an error telling you the key is missing.

**4) Run the server**
```powershell
python server.py
```
The server will print the model size and URL. By default the model is controlled by the `MODEL_SIZE` constant at the top of `server.py` — change it to `small` or `medium` for better accuracy (requires more RAM).

**5) Open the web UI**
- Go to **http://localhost:5050** — the server also serves the page. This is the recommended way: the browser then remembers your microphone permission.
- Or open `RecallMe_v2.html` directly (double-click or `Ctrl+O` in the browser). The page uses the backend at http://localhost:5050 either way.

**What you can do**
- **Upload Video → Video URL**: paste a YouTube, Vimeo or direct video/audio link. The server downloads the audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and transcribes it with the engine you pick (Whisper on your computer, or Groq in the cloud). Only add videos you're allowed to download.
- **Upload Video → Upload File**: MP3, MP4, WAV, M4A, MOV, WebM, MKV, AVI… With "Groq AI", the server shrinks the audio with ffmpeg first, so anything up to about 2 hours fits Groq's 25 MB free-tier limit.
- **Record Audio**: live transcription in your browser (Chrome or Edge). Pick the speech language in the record dialog or next to the audio meter in a session.
- Your **lecture library** (transcripts, notes and grammar fixes) is saved in this browser and survives reloads. Hover a card and click the trash icon to delete it. It isn't synced to other browsers or devices, and clearing site data removes it.

**Verify endpoints**
- Health check (browser or curl):
```bash
curl http://localhost:5050/health
```
- Transcribe example (replace `audio.mp3`):
```bash
curl -F "file=@audio.mp3" http://localhost:5050/transcribe
```
- Transcribe a link (`engine` is `whisper` or `groq`):
```bash
curl -H "Content-Type: application/json" -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","engine":"whisper"}' http://localhost:5050/transcribe-url
```
- All endpoints: http://localhost:5050/api

**Notes & Troubleshooting**
- If you see import errors for `whisper`, install `openai-whisper` (`python -m pip install openai-whisper`).
- An error mentioning ffmpeg (or `[WinError 2] The system cannot find the file specified`) means ffmpeg isn't on PATH — see step 3.
- Groq's free tier allows about 8,000 tokens per minute. "Fix Grammar" on a long lecture works through it in pieces and waits out the limit, so it can take a few minutes; chat and auto-notes use the first part of very long transcripts.
- If the model fails to load due to memory, lower `MODEL_SIZE` to `tiny` or `base`.
- For better accuracy, use `small` or `medium` (more RAM / GPU recommended).
- If a YouTube link stops working, update yt-dlp (`python -m pip install -U "yt-dlp[default]"`) — YouTube changes often and yt-dlp keeps up.
- "Server offline" while the server is running, and the server prints `[Blocked] requests from https://…`: the page is hosted on a site the server doesn't trust yet — see *Hosting the page* below.

**Who can use the server**
The server spends your Groq key, so it only answers to:
- this computer (it listens on `127.0.0.1` unless you set `HOST`), and
- web pages opened as a file, or served from `localhost` / `127.0.0.1` on any port (e.g. VS Code Live Server).

Requests from any other website are refused. To allow your own hosted copy of the page, list its address before starting the server (comma-separate several):
```powershell
$env:ALLOWED_ORIGINS = "https://your-app.vercel.app"
python server.py
```

**Hosting the page (e.g. Vercel)**
The page can be deployed as a static site. `vercel.json` forces Vercel's "Other" (static) preset and publishes only `RecallMe_v2.html` (also as `index.html`), `script.js` and `tailwind.css`. Without it, Vercel spots the Flask app in `server.py` and tries to bundle Whisper + PyTorch into a serverless function, which fails ("Total bundle size … exceeds the maximum function size (500 MB)") — and Whisper needs ffmpeg and gigabytes of RAM anyway. The hosted page still talks to `http://localhost:5050`, so whoever opens it must run `server.py` on their own computer with `ALLOWED_ORIGINS` set to the site's address. Chrome will also ask once for permission to let the site reach devices on your local network — allow it.

**Styling (Tailwind CSS)**

The UI is styled with [Tailwind CSS](https://tailwindcss.com) v4. The compiled stylesheet `tailwind.css` is committed, so you can open the page or deploy it as a static site **without** running any build step.

You only need Node.js if you change the design (edit classes in `RecallMe_v2.html` / `script.js`, or the colors and fonts in `src/input.css`):
```powershell
npm install          # once
npm run dev:css      # rebuild tailwind.css automatically while you edit
npm run build:css    # one-off minified build (run this before committing)
```
Design tokens (primary indigo, accent emerald, neutral surface/ink colors for light and dark mode, fonts, animations) live at the top of `src/input.css`. Dark mode follows your system setting and can be toggled with the sun/moon button; the choice is remembered.

Files:
- `server.py` — Flask backend: serves the web UI, local Whisper transcription, video-link downloads (yt-dlp), Groq proxy (chat, cloud transcription)
- `RecallMe_v2.html` — the web UI (markup + Tailwind classes)
- `script.js` — UI logic (recording, transcription, chat, saved library)
- `vercel.json` / `.vercelignore` — static hosting setup for Vercel (publishes only the web page, never the Python backend)
- `src/input.css` — Tailwind entry file (theme tokens, dark mode, animations)
- `tailwind.css` — compiled stylesheet (generated by `npm run build:css`)
