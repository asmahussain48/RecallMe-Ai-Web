# RecallMe — Run Instructions

This repository contains a small Flask backend (`server.py`) that runs OpenAI Whisper for transcription and a web UI (`RecallMe_v2.html`). Follow the steps below to run locally on Windows (PowerShell). The server listens on http://localhost:5050 by default.

**Prerequisites**
- Python 3.8+ installed
- (Optional) `ffmpeg` on PATH for mp3/mp4 support — install from https://ffmpeg.org and add to PATH
- (Optional) GPU: install appropriate `torch`/`torchaudio` builds for your GPU to speed up transcription

**1) Activate the provided virtual environment (PowerShell)**
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& .\recallme_env\Scripts\Activate.ps1
```

If you don't want to use the included virtualenv, create one and activate it instead:
```powershell
python -m venv .venv
& .\.venv\Scripts\Activate.ps1
```

**2) Install dependencies**
From the project root run:
```powershell
pip install -r requirements.txt
# Optional (GPU / faster): pip install torch torchvision torchaudio
```

**3) (Optional) Install ffmpeg**
- Windows: download a static build from https://ffmpeg.org/download.html and add `ffmpeg/bin` to your PATH.

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
- Open `RecallMe_v2.html` in your browser (double-click or `Ctrl+O` in the browser). The page uses the backend at http://localhost:5050.

**Verify endpoints**
- Health check (browser or curl):
```bash
curl http://localhost:5050/health
```
- Transcribe example (replace `audio.mp3`):
```bash
curl -F "file=@audio.mp3" http://localhost:5050/transcribe
```

**Notes & Troubleshooting**
- If you see import errors for `whisper`, install `openai-whisper` (`pip install openai-whisper`).
- If the model fails to load due to memory, lower `MODEL_SIZE` to `tiny` or `base`.
- For better accuracy, use `small` or `medium` (more RAM / GPU recommended).

Files:
- `server.py` — Flask backend that serves the transcription API
- `RecallMe_v2.html` — web UI that uploads audio/video to the server

If you want, I can: (A) run these commands in your terminal now, (B) install the packages, or (C) start the server for you. Tell me which option you prefer.
