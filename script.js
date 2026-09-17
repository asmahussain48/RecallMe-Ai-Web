    // ═══════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════
    let transcriptBlocks = [];
    let selFile = null;
    let hist = [], busy = false;
    let isRec = false, recog = null, finalTxStr = '', notesDone = false;
    let waveInt = null, waveAnimFrame = null;
    let liveBlockId = null;
    let recRestartAttempts = 0;
    let recRestartTimer = null;

    // ═══════════════════════════════════════════════
    //  PAGE ROUTING
    // ═══════════════════════════════════════════════
    function showLibrary() { stopRec(); show('pg-library'); hide('pg-session'); }
    function show(id) { document.getElementById(id).classList.add('active'); }
    function hide(id) { document.getElementById(id).classList.remove('active'); }

    function openSession(title, type, fileName) {
      hist = []; notesDone = false; transcriptBlocks = [];
      finalTxStr = ''; liveBlockId = null;
      document.getElementById('txBlocks').innerHTML = '';
      document.getElementById('txPlaceholder').style.display = 'block';
      document.getElementById('chatScroll').innerHTML = `
    <div class="chat-empty" id="chatEmpty">
      <div class="chat-empty-orb">🎓</div>
      <div class="chat-empty-t">Letta is ready</div>
      <div class="chat-empty-s">Ask questions about your transcript and get instant AI-powered summaries, notes, and quizzes.</div>
    </div>`;
      document.getElementById('fixBtn').disabled = true;
      document.getElementById('recStatusBar').classList.remove('visible');
      hide('pg-library'); show('pg-session');
      if (type === 'sample') setTimeout(loadSample, 350);
    }

    function loadSample() {
      const tx = `and maybe talk louder please give me a sec already yeah so how this platform works in real time audio streaming you can see that as im talking the information what im saying is being transcribed right here on the text and there are definitions in the class you can see that its compiling the important points of what the professor would be saying into notes from there looking through this lets just say i have a question in this its like what was the suggestion for speaking louder for example i could go in type that its okay i dont think it has but i could go in and type that in here and as its transcribing notes it can also handle suppose this is what i said in the recording on and all got written now it generated auto notes like how the platform works platform enables real time audio streaming and live transcription spoken words appear instantly as text on screen system compiles professor key points into organized notes`;
      addTranscriptBlock('video', 'The 10 Stages of AI.mp4', tx);
      setTimeout(() => generateNotes(getAllText()), 900);
    }

    // ═══════════════════════════════════════════════
    //  MODALS
    // ═══════════════════════════════════════════════
    function openModal(id) { document.getElementById(id).classList.add('open'); }
    function closeModal(id) { document.getElementById(id).classList.remove('open'); }
    function closeOnBg(e, id) { if (e.target.classList.contains('overlay')) closeModal(id); }

    function switchTab(t) {
      document.getElementById('pane-url').style.display = t === 'url' ? 'block' : 'none';
      document.getElementById('pane-file').style.display = t === 'file' ? 'block' : 'none';
      document.getElementById('tab-url').classList.toggle('active', t === 'url');
      document.getElementById('tab-file').classList.toggle('active', t === 'file');
    }

    function addFromUrl() {
      const name = document.getElementById('vidName').value.trim();
      const url = document.getElementById('vidUrl').value.trim();
      if (!url) { alert('Please enter a video URL.'); return; }
      let title = name;
      if (!title) { try { title = new URL(url).hostname.replace('www.', ''); } catch (e) { title = 'Lecture'; } }
      addLibraryCard(title, 'url', url);
      closeModal('modal-upload');
      document.getElementById('vidName').value = '';
      document.getElementById('vidUrl').value = '';
    }

    function handleDrop(e) {
      e.preventDefault();
      document.getElementById('dropZone').classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) setSelectedFile(f);
    }
    function onFileSelect(e) { if (e.target.files[0]) setSelectedFile(e.target.files[0]); }
    function setSelectedFile(f) {
      selFile = f;
      const d = document.getElementById('fileDisplay');
      document.getElementById('fileDisplayName').textContent = '📎 ' + f.name + ' (' + (f.size / 1024 / 1024).toFixed(1) + ' MB)';
      d.style.display = 'flex';
    }

    // ═══════════════════════════════════════════════
    //  WHISPER + GROQ TRANSCRIPTION ENGINE
    //  (WHISPER_URL also serves as the backend proxy
    //   for Groq chat + cloud transcription — see server.py)
    // ═══════════════════════════════════════════════

    const WHISPER_URL = 'http://localhost:5050';
    let whisperOnline = false;
    let uploadMethod = 'whisper'; // 'whisper' | 'claude'

    // ── Whisper server health check ───────────────────────────────────────────────
    async function checkWhisperServer() {
      const pill = document.getElementById('whisperPill');
      const dot = document.getElementById('whisperDot');
      const label = document.getElementById('whisperLabel');
      try {
        const r = await fetch(WHISPER_URL + '/health', { signal: AbortSignal.timeout(2000) });
        const d = await r.json();
        whisperOnline = r.ok;
      } catch (e) { whisperOnline = false; }

      if (pill) {
        pill.className = 'whisper-pill ' + (whisperOnline ? 'online' : 'offline');
        label.textContent = whisperOnline ? 'Whisper ✓' : 'Whisper offline';
      }
      return whisperOnline;
    }

    // Poll every 10 seconds
    setInterval(checkWhisperServer, 10000);
    setTimeout(checkWhisperServer, 800);

    // ── Method toggle ─────────────────────────────────────────────────────────────
    function setMethod(m) {
      uploadMethod = m;
      document.getElementById('methodWhisper').className = 'method-btn' + (m === 'whisper' ? ' active green' : '');
      document.getElementById('methodClaude').className = 'method-btn' + (m === 'claude' ? ' active' : '');
      document.getElementById('whisperNote').style.display = m === 'whisper' ? '' : 'none';
      document.getElementById('claudeNote').style.display = m === 'claude' ? '' : 'none';
      document.getElementById('dropzoneHint').textContent = m === 'whisper'
        ? 'MP3, MP4, WAV, M4A, MOV, WebM — any size, any language'
        : 'MP3, WAV, M4A, WebM — max ~10 MB for best results';
      document.getElementById('uploadBtn').textContent = m === 'whisper'
        ? '🎙️ Transcribe with Whisper'
        : '🤖 Transcribe with Groq AI';
    }

    // ── Main entry: processUploadedFile decides which engine to use ───────────────
    async function processUploadedFile() {
      if (!selFile) { alert('Please select a file first.'); return; }
      const btn = document.getElementById('uploadBtn');
      btn.disabled = true; btn.textContent = 'Processing…';
      const pw = document.getElementById('progressWrap');
      const pb = document.getElementById('progressBar');
      const pl = document.getElementById('progressLabel');
      pw.style.display = 'block'; pl.style.display = 'block';
      pl.style.color = 'var(--t2)';
      pl.textContent = 'Starting…'; pb.style.width = '4%';

      const fileName = selFile.name;
      const title = fileName.replace(/\.[^.]+$/, '');

      const onProgress = (pct, label) => {
        pb.style.width = pct + '%';
        pl.textContent = label;
      };

      try {
        let transcript;
        if (uploadMethod === 'whisper') {
          // Check server is up first
          const up = await checkWhisperServer();
          if (!up) {
            throw new Error(
              'Whisper server is offline.\n\n' +
              'Steps to start it:\n' +
              '1. Open a terminal / command prompt\n' +
              '2. Run:  python server.py\n' +
              '3. Wait for "Model ready ✓" message\n' +
              '4. Then try uploading again.\n\n' +
              'Or switch to "Claude AI" mode above.'
            );
          }
          transcript = await transcribeWithWhisper(selFile, onProgress);
        } else {
          transcript = await transcribeWithClaude(selFile, onProgress);
        }

        pb.style.width = '100%';
        pl.textContent = '✓ Transcription complete!';
        pl.style.color = 'var(--green)';

        setTimeout(() => {
          closeModal('modal-upload');
          addLibraryCard(title, 'video', fileName);
          openSession(title, 'video', fileName);
          setTimeout(() => {
            addTranscriptBlock('video', fileName, transcript);
            setTimeout(() => generateNotes(getAllText()), 900);
          }, 300);
          selFile = null;
          document.getElementById('fileDisplay').style.display = 'none';
          pw.style.display = 'none'; pl.style.display = 'none';
          pb.style.width = '0%';
          btn.disabled = false;
          setMethod(uploadMethod); // restore button label
        }, 800);

      } catch (err) {
        pl.textContent = '✕ ' + err.message.split('\n')[0];
        pl.style.color = '#ff4d6d';
        if (err.message.includes('\n')) alert(err.message);
        btn.disabled = false;
        setMethod(uploadMethod);
      }
    }

    // ── ENGINE 1: Whisper via local Python server ─────────────────────────────────
    async function transcribeWithWhisper(file, onProgress) {
      onProgress(8, 'Uploading file to Whisper server…');

      const form = new FormData();
      form.append('file', file, file.name);
      // auto-detect language; to force a language: form.append('language', 'en');

      // Use XHR for upload progress
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', WHISPER_URL + '/transcribe');

        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 40);
            onProgress(8 + pct, `Uploading… ${Math.round(e.loaded / 1024 / 1024 * 10) / 10} MB / ${Math.round(e.total / 1024 / 1024 * 10) / 10} MB`);
          }
        };

        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status !== 200 || data.error) {
              reject(new Error(data.error || `Server error ${xhr.status}`));
              return;
            }
            onProgress(95, `Whisper transcribed ${data.duration ? Math.round(data.duration) + 's' : ''} of audio in ${data.elapsed_s}s ✓`);
            const header = `[WHISPER EXTRACT: ${file.name}] (lang: ${data.language || 'auto'})`;
            resolve(header + '\n\n' + data.text);
          } catch (e) {
            reject(new Error('Invalid server response: ' + xhr.responseText.slice(0, 200)));
          }
        };

        xhr.onerror = () => reject(new Error(
          'Cannot reach Whisper server at ' + WHISPER_URL + '.\n' +
          'Make sure "python server.py" is running.'
        ));
        xhr.ontimeout = () => reject(new Error('Whisper server timed out. Large files take a while — try again.'));
        xhr.timeout = 10 * 60 * 1000; // 10 min timeout for long videos

        xhr.send(form);
      });
    }

    // ── ENGINE 2: Groq Whisper cloud transcription (free, fast) ──────────────────
    // Proxied through server.py so the Groq API key stays server-side.
    async function transcribeWithClaude(file, onProgress) {
      const isAudio = /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file.name);
      const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(file.name);
      if (!isAudio && !isVideo) throw new Error('Unsupported file type.');

      onProgress(10, 'Reading audio data…');

      let audioBlob = file;

      // For video files, extract audio track first via MediaRecorder
      if (isVideo) {
        onProgress(12, 'Extracting audio from video…');
        audioBlob = await extractAudioFromVideo(file, onProgress);
      }

      onProgress(60, 'Sending to server for Groq Whisper transcription…');

      const form = new FormData();
      form.append('file', audioBlob, file.name.replace(/\.[^.]+$/, '.webm'));

      let res;
      try {
        res = await fetch(WHISPER_URL + '/api/transcribe-groq', { method: 'POST', body: form });
      } catch (e) {
        throw new Error('Cannot reach the backend server.\nMake sure "python server.py" is running.');
      }

      onProgress(90, 'Groq Whisper processing…');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.text) throw new Error('No transcription returned from Groq Whisper.');

      return `[VIDEO EXTRACT: ${file.name}]\n\n${data.text.trim()}`;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────
    async function extractAudioFromVideo(file, onProgress) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.src = url; video.muted = false;
        video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
        document.body.appendChild(video);

        video.addEventListener('canplaythrough', () => {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const dest = ctx.createMediaStreamDestination();
            const src = ctx.createMediaElementSource(video);
            src.connect(dest); src.connect(ctx.destination);

            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus' : 'audio/webm';
            const rec = new MediaRecorder(dest.stream, { mimeType: mime });
            const chunks = [];
            rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            rec.onstop = () => {
              cleanup();
              resolve(new Blob(chunks, { type: mime }));
            };
            rec.start(200);
            video.play();
            video.addEventListener('timeupdate', () => {
              const p = Math.round((video.currentTime / Math.max(video.duration, 1)) * 38);
              onProgress(12 + p, `Extracting audio… ${Math.round(video.currentTime)}s`);
            });
            video.onended = () => setTimeout(() => rec.stop(), 400);
            setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 600000);
          } catch (e) { cleanup(); reject(e); }
        });

        function cleanup() { try { video.pause(); URL.revokeObjectURL(url); video.remove(); } catch (e) { } }
        video.onerror = () => { cleanup(); reject(new Error('Cannot load video file.')); };
        video.load();
      });
    }
    // ═══════════════════════════════════════════════
    //  TRANSCRIPT BLOCK SYSTEM
    // ═══════════════════════════════════════════════
    function addTranscriptBlock(type, source, text) {
      const id = 'blk_' + Date.now();
      transcriptBlocks.push({ id, type, source, text, corrected: null });
      document.getElementById('txPlaceholder').style.display = 'none';
      document.getElementById('fixBtn').disabled = false;
      const container = document.getElementById('txBlocks');
      const block = document.createElement('div');
      block.id = id; block.className = 'tx-block';
      const icon = type === 'video' ? '📹' : '🎙️';
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      block.innerHTML = `
    <div class="tx-source-header">
      <div class="tx-src-icon ${type}">${icon}</div>
      <div class="tx-src-meta">
        <div class="tx-src-name">${source}</div>
        <div class="tx-src-sub">${now} · ${type === 'video' ? 'Audio extracted' : 'Live recording'}</div>
      </div>
      <div class="tx-src-badge ${type}" id="${id}_badge">${type === 'video' ? 'Video Extract' : 'Live Recording'}</div>
    </div>
    <div class="tx-text" id="${id}_text">${escH(text)}</div>`;
      container.appendChild(block);
      document.getElementById('notesScroll').scrollTop = 99999;
      return id;
    }

    function getLastBlockId() { return transcriptBlocks.length ? transcriptBlocks[transcriptBlocks.length - 1].id : null; }
    function getAllText() { return transcriptBlocks.map(b => b.corrected || b.text).join('\n\n').trim(); }

    function copyTranscript() {
      const tx = getAllText();
      if (!tx) { showToast('No transcript yet.'); return; }
      navigator.clipboard.writeText(tx).then(() => showToast('Copied to clipboard!')).catch(() => alert(tx));
    }

    function clearTranscript() {
      if (!confirm('Clear all transcript content?')) return;
      transcriptBlocks = []; finalTxStr = ''; notesDone = false;
      document.getElementById('txBlocks').innerHTML = '';
      document.getElementById('txPlaceholder').style.display = 'block';
      document.getElementById('fixBtn').disabled = true;
      stopRec();
    }

    // ═══════════════════════════════════════════════
    //  IMPROVED LIVE SPEECH RECOGNITION
    //  Fixes: continuous restart, word count display,
    //  no-hang approach using chunk-based accumulation
    // ═══════════════════════════════════════════════
    const SR_ENGINE = window.SpeechRecognition || window.webkitSpeechRecognition;

    function toggleRec() { isRec ? stopRec() : startRec(); }

    function startRec() {
      if (!SR_ENGINE) { alert('Use Google Chrome or Edge for live recording.'); return; }
      isRec = true;
      recRestartAttempts = 0;
      finalTxStr = '';
      liveBlockId = null;
      notesDone = false;

      document.getElementById('recBtn').classList.add('on');
      document.getElementById('recBtnTxt').textContent = 'Stop Recording';
      document.getElementById('txPlaceholder').style.display = 'none';
      document.getElementById('fixBtn').disabled = false;
      document.getElementById('recStatusBar').classList.add('visible');
      startWave();

      liveBlockId = addTranscriptBlock('mic', 'Live Recording', '');
      // Change badge to live
      const badge = document.getElementById(liveBlockId + '_badge');
      if (badge) { badge.className = 'tx-src-badge live'; badge.textContent = '🔴 LIVE'; }

      _spawnRecognition();
    }

    function _spawnRecognition() {
      if (!isRec) return;
      clearTimeout(recRestartTimer);

      try { if (recog) { recog.abort(); recog = null; } } catch (e) { }

      recog = new SR_ENGINE();
      recog.continuous = true;
      recog.interimResults = true;
      recog.lang = 'en-US';
      recog.maxAlternatives = 1;

      recog.onstart = () => { recRestartAttempts = 0; };

      recog.onresult = (e) => {
        if (!e || !e.results) return;
        let interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (!r || !r[0]) continue;
          const t = r[0].transcript;
          if (typeof t !== 'string') continue;

          if (r.isFinal) {
            // Append finalized text (add a space between chunks)
            finalTxStr += (finalTxStr && !finalTxStr.endsWith(' ') ? ' ' : '') + t.trim();
            // Update block
            if (liveBlockId) {
              const block = transcriptBlocks.find(b => b.id === liveBlockId);
              const el = document.getElementById(liveBlockId + '_text');
              if (el) el.textContent = finalTxStr;
              if (block) block.text = finalTxStr;
            }
            // Update word count
            const wc = finalTxStr.trim().split(/\s+/).filter(w => w.length > 0).length;
            const wcel = document.getElementById('recWordCount');
            if (wcel) wcel.textContent = wc + ' words';

            // Auto-generate notes after enough words
            if (wc > 30 && !notesDone) {
              notesDone = true;
              setTimeout(() => generateNotes(getAllText()), 1200);
            }
          } else {
            interimText = t;
          }
        }

        // Show interim text with italic styling
        if (liveBlockId && interimText) {
          const el = document.getElementById(liveBlockId + '_text');
          if (el) el.innerHTML = escH(finalTxStr) + `<span style="color:var(--t2);font-style:italic;opacity:.55"> ${escH(interimText)}</span>`;
        }
        document.getElementById('notesScroll').scrollTop = 99999;
      };

      recog.onerror = (e) => {
        const err = e ? e.error : '';
        if (err === 'not-allowed') {
          alert('Microphone access denied. Please allow microphone in browser settings.');
          isRec = false;
          _resetRecUI();
          return;
        }
        if (err === 'no-speech' || err === 'audio-capture' || err === 'network') {
          // These are transient — let onend handle restart
          return;
        }
        console.warn('Speech recognition error:', err);
      };

      recog.onend = () => {
        if (!isRec) return; // Stopped by user
        // Auto-restart to prevent hanging
        recRestartAttempts++;
        const delay = Math.min(300 * recRestartAttempts, 1500); // backoff up to 1.5s
        recRestartTimer = setTimeout(() => {
          if (isRec) _spawnRecognition();
        }, delay);
      };

      try {
        recog.start();
      } catch (ex) {
        console.error('Failed to start recognition:', ex);
        if (isRec) {
          recRestartTimer = setTimeout(() => { if (isRec) _spawnRecognition(); }, 800);
        }
      }
    }

    function stopRec() {
      isRec = false;
      clearTimeout(recRestartTimer);
      try { if (recog) { recog.abort(); recog = null; } } catch (e) { }
      _resetRecUI();

      // Finalize badge
      if (liveBlockId) {
        const badge = document.getElementById(liveBlockId + '_badge');
        if (badge) { badge.className = 'tx-src-badge mic'; badge.textContent = 'Live Recording'; }
      }
    }

    function _resetRecUI() {
      const btn = document.getElementById('recBtn');
      if (btn) btn.classList.remove('on');
      const txt = document.getElementById('recBtnTxt');
      if (txt) txt.textContent = 'Start Recording';
      const bar = document.getElementById('recStatusBar');
      if (bar) bar.classList.remove('visible');
      stopWave();
    }

    // ═══════════════════════════════════════════════
    //  WAVEFORM (canvas-style with RAF for smoothness)
    // ═══════════════════════════════════════════════
    function buildWave() {
      const wf = document.getElementById('waveform');
      wf.innerHTML = '';
      for (let i = 0; i < 28; i++) {
        const b = document.createElement('div');
        b.className = 'wbar';
        wf.appendChild(b);
      }
    }
    function startWave() {
      buildWave();
      document.getElementById('waveform').classList.add('live');
      document.getElementById('audioWait').style.display = 'none';
      document.getElementById('audioLbl').style.display = 'block';
      document.getElementById('audioLbl').textContent = '🎙️ Live microphone';

      let phase = 0;
      function animate() {
        if (!isRec) { stopWave(); return; }
        phase += 0.12;
        document.querySelectorAll('.wbar').forEach((b, i) => {
          const h = 3 + Math.abs(Math.sin(phase + i * 0.35)) * 22 + Math.random() * 4;
          b.style.height = h + 'px';
          b.style.opacity = 0.4 + Math.abs(Math.sin(phase + i * 0.2)) * 0.6;
        });
        waveAnimFrame = requestAnimationFrame(animate);
      }
      if (waveAnimFrame) cancelAnimationFrame(waveAnimFrame);
      animate();
    }
    function stopWave() {
      if (waveAnimFrame) { cancelAnimationFrame(waveAnimFrame); waveAnimFrame = null; }
      clearInterval(waveInt);
      const wf = document.getElementById('waveform');
      if (wf) { wf.classList.remove('live'); wf.innerHTML = ''; }
      const aw = document.getElementById('audioWait');
      if (aw) aw.style.display = 'flex';
      const al = document.getElementById('audioLbl');
      if (al) al.style.display = 'none';
    }

    // ═══════════════════════════════════════════════
    //  GROQ CHAT (free)
    //  Proxied through server.py — the API key stays server-side.
    // ═══════════════════════════════════════════════

    async function callClaude(system, userMsg, maxTokens = 900) {
      let res;
      try {
        res = await fetch(WHISPER_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system, message: userMsg, max_tokens: maxTokens })
        });
      } catch (e) {
        throw new Error('Cannot reach the backend server. Make sure "python server.py" is running.');
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.text) throw new Error('Empty response from server.');
      return data.text;
    }

    // ═══════════════════════════════════════════════
    //  AUTO NOTES GENERATION
    // ═══════════════════════════════════════════════
    async function generateNotes(tx) {
      hideEmpty();
      const tid = addTyping();
      try {
        const answer = await callClaude(
          `You are Letta, an intelligent AI note-taking assistant inside RecallMe, a lecture transcription app.
Analyze the transcript and produce smart structured study notes.
Respond ONLY with valid JSON, no markdown fences:
{"sections":[{"title":"Section Title","points":["concise paraphrased point max 12 words"]}]}

Rules:
- 3-5 thematic sections based on ACTUAL content
- Each point: max 12 words, must PARAPHRASE (never copy raw text verbatim)
- Ignore grammar errors in transcript — extract the MEANING
- Smart section titles: "Key Concepts", "How It Works", "Platform Features", "Student Questions", "Important Points", "Action Items"
- Do not include [VIDEO EXTRACT:...] header in your analysis`,
          `Analyze this transcript:\n"${tx.replace(/\[VIDEO EXTRACT:[^\]]*\]/g, '').trim()}"`
        );
        removeEl(tid);
        const match = answer.replace(/```json\n?/g, '').replace(/```\n?/g, '').match(/\{[\s\S]*\}/);
        if (match) { try { renderNotes(JSON.parse(match[0]).sections); } catch (e) { smartFallback(tx); } }
        else smartFallback(tx);
      } catch (e) { removeEl(tid); smartFallback(tx); }
    }

    function renderNotes(sections) {
      if (!sections || !sections.length) return;
      const p = document.getElementById('chatScroll');
      const card = document.createElement('div'); card.className = 'letta-card';
      let html = `<div class="letta-tag"><div class="ldot"></div>Auto-Generated Notes</div>`;
      sections.forEach(s => {
        if (!s.points || !s.points.length) return;
        html += `<div class="notes-sec"><div class="nsec-title">${escH(s.title)}</div><ul class="nsec-ul">${s.points.map(pt => `<li>${escH(pt)}</li>`).join('')}</ul></div>`;
      });
      card.innerHTML = html;
      p.appendChild(card); p.scrollTop = 99999;
    }

    function smartFallback(tx) {
      const clean = tx.replace(/\[VIDEO EXTRACT:[^\]]*\]/g, '');
      const sentences = clean.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 20);
      const trim = s => { const w = s.split(/\s+/); return w.length > 12 ? w.slice(0, 12).join(' ') + '...' : s; };
      const features = sentences.filter(s => /platform|works|streaming|transcribed|notes|compile|real.?time|recording|audio|video/.test(s.toLowerCase())).slice(0, 3);
      const questions = sentences.filter(s => /what|how|why|where|when|can i|could|should|\?/.test(s.toLowerCase())).slice(0, 3);
      const general = sentences.filter(s => !features.includes(s) && !questions.includes(s)).slice(0, 4);
      const sections = [];
      if (features.length) sections.push({ title: 'Platform Features', points: features.map(trim) });
      if (general.length) sections.push({ title: 'Key Points', points: general.map(trim) });
      if (questions.length) sections.push({ title: 'Questions Raised', points: questions.map(trim) });
      if (!sections.length) sections.push({ title: 'Lecture Notes', points: sentences.slice(0, 5).map(trim) });
      renderNotes(sections);
    }

    // ═══════════════════════════════════════════════
    //  INTELLIGENT CHAT — powered by Groq
    // ═══════════════════════════════════════════════
    function quickAsk(q) { document.getElementById('chatIn').value = q; sendChat(); }

    async function sendChat() {
      const inp = document.getElementById('chatIn');
      const q = inp.value.trim(); if (!q || busy) return;
      hideEmpty(); addMsg('user', q); inp.value = '';
      const tx = getAllText();
      hist.push({ role: 'user', content: q });
      const tid = addTyping(); busy = true;
      document.getElementById('sendBtn').disabled = true;

      const sys = buildLettaSystemPrompt(tx);

      try {
        const answer = await callClaude(sys, q, 1400);
        removeEl(tid);
        addMsg('ai', answer);
        hist.push({ role: 'assistant', content: answer });
      } catch (e) {
        removeEl(tid);
        console.error('Letta API error:', e);
        addMsg('ai', `⚠️ **Letta could not respond.**\n\nReason: ${e.message}\n\n*Check that the backend server is running and you have an internet connection.*`);
      }

      busy = false;
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('chatIn').focus();
    }

    function buildLettaSystemPrompt(tx) {
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      return `You are Letta, an intelligent AI assistant inside RecallMe — a real-time lecture transcription and note-taking app. Today's date is ${today}.

${tx ? `LECTURE TRANSCRIPT (primary source — always reference this):
"${tx.replace(/\[VIDEO EXTRACT:[^\]]*\]/g, '').substring(0, 2500)}"

When answering about lecture content:
- Ground your answer in the transcript first, and add general knowledge only to clarify or enrich it
- Clearly distinguish: "From your transcript: ..." vs general explanation
- Use **bold** for key terms
- Use bullet points for lists
- Create well-structured, study-quality responses` : 'No transcript yet — answer from general knowledge.'}

Additional capabilities:
- Create structured study notes
- Fix grammar/spelling errors
- Summarize key points
- Generate practice quiz questions
- Explain concepts clearly
- Answer questions based on lecture content + general knowledge

Keep responses under 300 words unless creating full notes. Be helpful, accurate, and educational.`;
    }

    // ═══════════════════════════════════════════════
    //  GRAMMAR CORRECTION
    // ═══════════════════════════════════════════════
    async function correctGrammar() {
      const btn = document.getElementById('fixBtn');
      btn.disabled = true; btn.innerHTML = '⏳ <span>Fixing...</span>';
      const tx = getAllText();
      if (!tx || tx.length < 10) { btn.disabled = false; btn.innerHTML = '✏️ <span>Fix Grammar</span>'; return; }
      try {
        const fixed = await callClaude(
          `You are a grammar and spelling correction specialist.
RULES:
- Fix ALL grammar, spelling, punctuation and capitalization errors
- Fix contractions: im→I'm, dont→don't, cant→can't, its→it's, ive→I've, id→I'd etc.
- Capitalize every sentence start and the word "I"
- Add missing periods, commas, apostrophes
- Do NOT change meaning or rephrase — only fix language errors
- Keep [VIDEO EXTRACT: ...] header lines exactly as-is
- Return ONLY the corrected text, no explanation`,
          `Fix grammar:\n\n${tx}`, 1500
        );
        const lastId = getLastBlockId();
        if (lastId) {
          const block = transcriptBlocks.find(b => b.id === lastId);
          const el = document.getElementById(lastId + '_text');
          const badge = document.getElementById(lastId + '_badge');
          if (block && el) { block.corrected = fixed; el.textContent = fixed; }
          if (badge) { badge.className = 'tx-src-badge fixed'; badge.textContent = 'Grammar Fixed ✓'; }
        }
        hideEmpty();
        addMsg('ai', `✅ **Grammar corrected!**\n\nI fixed:\n- Missing apostrophes (don't, I'm, it's, we're)\n- Sentence capitalization\n- Punctuation and periods\n- Common speech-to-text errors\n\nThe corrected text is now showing in the Notes panel.`);
      } catch (e) {
        const fixed = localGrammarFix(tx);
        const lastId = getLastBlockId();
        if (lastId) {
          const block = transcriptBlocks.find(b => b.id === lastId);
          const el = document.getElementById(lastId + '_text');
          const badge = document.getElementById(lastId + '_badge');
          if (block && el) { block.corrected = fixed; el.textContent = fixed; }
          if (badge) { badge.className = 'tx-src-badge fixed'; badge.textContent = 'Grammar Fixed ✓'; }
        }
        hideEmpty();
        addMsg('ai', '✅ **Grammar fixed locally.** Basic corrections applied — apostrophes, capitalization, and punctuation corrected.');
      }
      btn.disabled = false; btn.innerHTML = '✏️ <span>Fix Grammar</span>';
    }

    function localGrammarFix(text) {
      let t = text;
      const map = {
        '\\bim\\b': "I'm", '\\bdont\\b': "don't", '\\bcant\\b': "can't", '\\bwont\\b': "won't",
        '\\bive\\b': "I've", '\\bid\\b': "I'd", '\\bill\\b': "I'll", '\\byoure\\b': "you're",
        '\\btheyre\\b': "they're", '\\bcouldnt\\b': "couldn't", '\\bwouldnt\\b': "wouldn't",
        '\\bshouldnt\\b': "shouldn't", '\\bdoesnt\\b': "doesn't", '\\bhasnt\\b': "hasn't",
        '\\bhavent\\b': "haven't", '\\bwasnt\\b': "wasn't", '\\bthats\\b': "that's",
        '\\bwhats\\b': "what's", '\\bheres\\b': "here's", '\\btheres\\b': "there's",
        '\\bits the\\b': "it's the", '\\bits a\\b': "it's a", '\\bits been\\b': "it's been"
      };
      Object.entries(map).forEach(([p, r]) => { t = t.replace(new RegExp(p, 'gi'), r); });
      t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
      t = t.replace(/\bi\b/g, 'I');
      t = t.trim();
      if (t && !'.!?'.includes(t[t.length - 1])) t += '.';
      return t;
    }

    // ═══════════════════════════════════════════════
    //  LIBRARY CARD
    // ═══════════════════════════════════════════════
    const CARD_EMOJIS = ['🎓', '📘', '🔬', '💡', '🧠', '📡', '🎤', '📽️', '🖥️', '⚗️'];
    function addLibraryCard(title, type, source) {
      const grid = document.getElementById('lectureGrid');
      const c = document.createElement('div');
      c.className = 'lecture-card';
      c.onclick = () => openSession(title, type, source);
      const emoji = CARD_EMOJIS[Math.floor(Math.random() * CARD_EMOJIS.length)];
      const short = title.length > 22 ? title.substring(0, 20) + '…' : title;
      c.innerHTML = `
    <div class="lc-thumb" style="flex-direction:column;gap:6px">
      <div style="font-size:36px">${emoji}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.45);text-align:center;padding:0 8px;line-height:1.3">${short}</div>
      <div class="lc-play">▶</div>
    </div>
    <div class="lc-badge">${type === 'video' ? '📹' : '🎙️'} ${type === 'video' ? 'Video' : 'Audio'}</div>
    <div class="lc-info">
      <div class="lc-title">${title}</div>
      <div class="lc-date">Just added</div>
    </div>`;
      grid.appendChild(c);
      updateLibCount();
    }
    function updateLibCount() {
      const count = document.getElementById('lectureGrid').children.length;
      document.getElementById('libCount').textContent = count + (count === 1 ? ' lecture' : ' lectures');
    }
    function startRecordSession() {
      closeModal('modal-record');
      openSession('Live Recording', 'mic', '');
      setTimeout(startRec, 400);
    }

    // ═══════════════════════════════════════════════
    //  UI HELPERS
    // ═══════════════════════════════════════════════
    function hideEmpty() {
      const e = document.getElementById('chatEmpty');
      if (e) e.style.display = 'none';
    }
    function addMsg(role, text) {
      const p = document.getElementById('chatScroll');
      const d = document.createElement('div'); d.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
      const w = document.createElement('div'); w.className = 'msg-who'; w.textContent = role === 'user' ? 'You' : 'Letta';
      const b = document.createElement('div'); b.className = 'msg-b';
      b.innerHTML = role === 'ai' ? renderMd(text) : escH(text);
      d.appendChild(w); d.appendChild(b); p.appendChild(d); p.scrollTop = 99999;
    }
    function addTyping() {
      const p = document.getElementById('chatScroll');
      const id = 'ty_' + Date.now();
      const d = document.createElement('div'); d.id = id; d.className = 'msg ai';
      const w = document.createElement('div'); w.className = 'msg-who'; w.textContent = 'Letta';
      const t = document.createElement('div'); t.className = 'typing-row';
      t.innerHTML = '<div class="td"></div><div class="td"></div><div class="td"></div>';
      d.appendChild(w); d.appendChild(t); p.appendChild(d); p.scrollTop = 99999;
      return id;
    }
    function removeEl(id) { const e = document.getElementById(id); if (e) e.remove(); }
    function escH(t) { return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function renderMd(t) {
      let s = t;
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text)">$1</strong>');
      s = s.replace(/\*([^*\n]+?)\*/g, '<em style="color:var(--t2)">$1</em>');
      s = s.replace(new RegExp('\x60([^\x60]+)\x60', 'g'), '<code style="background:rgba(79,163,224,0.12);color:var(--note);padding:1px 5px;border-radius:3px;font-size:11.5px">$1</code>');
      const lines = s.split('\n'); const out = []; let inList = false;
      for (const l of lines) {
        const isBullet = /^[-•*]\s+/.test(l), isNum = /^\d+\.\s+/.test(l);
        if (isBullet || isNum) {
          if (!inList) { out.push('<ul style="list-style:none;padding:0;margin:7px 0">'); inList = true; }
          const c = l.replace(/^[-•*]\s+/, '').replace(/^\d+\.\s+/, '');
          out.push(`<li style="padding-left:17px;position:relative;margin-bottom:5px;color:var(--t2)"><span style="position:absolute;left:0;color:var(--note);font-size:9px;top:4px">●</span>${c}</li>`);
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          if (!l.trim()) out.push('<div style="height:5px"></div>');
          else out.push(`<p style="margin-bottom:5px;line-height:1.7">${l}</p>`);
        }
      }
      if (inList) out.push('</ul>');
      return out.join('');
    }
    function showToast(msg) {
      const t = document.getElementById('_toast');
      t.textContent = msg; t.style.opacity = '1';
      clearTimeout(t._t); t._t = setTimeout(() => t.style.opacity = '0', 2200);
    }
    buildWave();
