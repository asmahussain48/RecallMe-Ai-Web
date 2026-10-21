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
    let currentLecture = null; // library entry of the open session (null for the sample)
    let sessionGen = 0;        // bumped on every session change, so late AI replies/timers can tell they're stale
    let uid = 0;

    // Ids stay unique across page reloads (the library is saved) and within the same millisecond
    function newId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + (++uid); }

    // Groq's free tier allows ~8k tokens per minute, so prompts carry at most this much text (~4 chars per token)
    const CHAT_TRANSCRIPT_CHARS = 8000;
    const NOTES_TRANSCRIPT_CHARS = 20000;
    const CHAT_HISTORY_CHARS = 6000;   // recent chat turns sent back so follow-up questions have context
    const GRAMMAR_CHUNK_WORDS = 600;   // long transcripts are corrected piece by piece so replies aren't cut off

    // setTimeout that is dropped if the user has switched sessions in the meantime
    function later(fn, ms) {
      const gen = sessionGen;
      setTimeout(() => { if (gen === sessionGen) fn(); }, ms);
    }

    // ═══════════════════════════════════════════════
    //  UI HELPERS — visibility, icons, badges, theme
    //  (Tailwind class names below are kept as full literal strings so the CSS build can see them)
    // ═══════════════════════════════════════════════
    // Uses the HTML `hidden` attribute (Tailwind's preflight makes it display:none !important),
    // so it works regardless of any flex/grid display class on the element.
    function setShown(el, shown) { if (el) el.hidden = !shown; }

    // SVG icon from the sprite at the top of RecallMe_v2.html
    function icon(name, cls = 'size-4') {
      return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    }

    const BADGE_BASE = 'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold';
    const BADGE_STYLES = {
      video: 'border-primary-500/20 bg-primary-soft text-brand',
      mic: 'border-accent-500/25 bg-accent-soft text-accent-fg',
      live: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
      fixed: 'border-accent-500/25 bg-accent-soft text-accent-fg'
    };
    function setBadge(blockId, variant, label) {
      const badge = document.getElementById(blockId + '_badge');
      if (!badge) return;
      badge.className = BADGE_BASE + ' ' + BADGE_STYLES[variant];
      const lead = variant === 'live' ? '<span class="size-1.5 animate-pulse rounded-full bg-red-500"></span>'
        : variant === 'fixed' ? icon('check', 'size-3') : '';
      badge.innerHTML = lead + escH(label);
    }

    function toggleTheme() {
      const dark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', dark);
      try { localStorage.setItem('recallme-theme', dark ? 'dark' : 'light'); } catch (e) { }
      const meta = document.getElementById('metaTheme');
      if (meta) meta.setAttribute('content', dark ? '#0a0d16' : '#f6f7fb');
    }

    // ═══════════════════════════════════════════════
    //  PAGE ROUTING
    // ═══════════════════════════════════════════════
    function showLibrary() { stopRec(); sessionGen++; show('pg-library'); hide('pg-session'); window.scrollTo(0, 0); }
    function show(id) { document.getElementById(id).hidden = false; }
    function hide(id) { document.getElementById(id).hidden = true; }

    // Notes / Chat switcher used on screens narrower than the two-column breakpoint
    function setSessionTab(tab) {
      document.getElementById('sessLayout').dataset.tab = tab;
      document.getElementById('stab-notes').setAttribute('aria-selected', String(tab === 'notes'));
      document.getElementById('stab-chat').setAttribute('aria-selected', String(tab === 'chat'));
      if (tab === 'chat') {
        setShown(document.getElementById('chatDot'), false);
        const chat = document.getElementById('chatScroll');
        chat.scrollTop = chat.scrollHeight;
      }
    }
    // Dot on the "Chat" tab when Letta posts while the Notes tab is showing
    function markChatUnread() {
      const layout = document.getElementById('sessLayout');
      if (layout && layout.dataset.tab === 'notes') setShown(document.getElementById('chatDot'), true);
    }

    // `lecture` is a library entry; its transcript blocks and notes are restored and kept up to date
    function openSession(title, type, fileName, lecture = null) {
      sessionGen++;
      currentLecture = lecture;
      hist = []; notesDone = false; busy = false;
      transcriptBlocks = lecture ? lecture.blocks : [];
      finalTxStr = ''; liveBlockId = null;
      document.getElementById('sessTitle').textContent = title || 'Lecture';
      document.getElementById('txBlocks').innerHTML = '';
      transcriptBlocks.forEach(renderBlock);
      document.getElementById('notesScroll').scrollTop = 0;
      setShown(document.getElementById('txPlaceholder'), !transcriptBlocks.length);
      document.getElementById('chatScroll').replaceChildren(
        document.getElementById('tpl-chat-empty').content.cloneNode(true));
      setShown(document.getElementById('chatDot'), false);
      if (lecture && lecture.notes.length) { hideEmpty(); lecture.notes.forEach(renderNotes); }
      document.getElementById('fixBtn').disabled = !transcriptBlocks.length;
      document.getElementById('fixBtnTxt').textContent = 'Fix Grammar';
      document.getElementById('sendBtn').disabled = false;
      setShown(document.getElementById('recStatusBar'), false);
      setSessionTab('notes');
      hide('pg-library'); show('pg-session');
      if (type === 'sample') later(loadSample, 350);
      else if (transcriptBlocks.length && !lecture.notes.length) later(() => generateNotes(getAllText()), 900);
    }

    function loadSample() {
      const tx = `and maybe talk louder please give me a sec already yeah so how this platform works in real time audio streaming you can see that as im talking the information what im saying is being transcribed right here on the text and there are definitions in the class you can see that its compiling the important points of what the professor would be saying into notes from there looking through this lets just say i have a question in this its like what was the suggestion for speaking louder for example i could go in type that its okay i dont think it has but i could go in and type that in here and as its transcribing notes it can also handle suppose this is what i said in the recording on and all got written now it generated auto notes like how the platform works platform enables real time audio streaming and live transcription spoken words appear instantly as text on screen system compiles professor key points into organized notes`;
      addTranscriptBlock('video', 'The 10 Stages of AI.mp4', tx);
      later(() => generateNotes(getAllText()), 900);
    }

    // ═══════════════════════════════════════════════
    //  MODALS
    // ═══════════════════════════════════════════════
    let modalOpener = null;
    function openModal(id) {
      const overlay = document.getElementById(id);
      modalOpener = document.activeElement;
      setShown(overlay, true);
      document.documentElement.classList.add('overflow-hidden');
      overlay.firstElementChild.focus();
    }
    function closeModal(id) {
      setShown(document.getElementById(id), false);
      document.documentElement.classList.remove('overflow-hidden');
      if (modalOpener && modalOpener.focus) modalOpener.focus();
      modalOpener = null;
    }
    function closeOnBg(e, id) { if (e.target === e.currentTarget) closeModal(id); }

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      ['modal-upload', 'modal-record'].forEach(id => {
        if (!document.getElementById(id).hidden) closeModal(id);
      });
    });

    function switchTab(t) {
      setShown(document.getElementById('pane-url'), t === 'url');
      setShown(document.getElementById('pane-file'), t === 'file');
      document.getElementById('tab-url').setAttribute('aria-selected', String(t === 'url'));
      document.getElementById('tab-file').setAttribute('aria-selected', String(t === 'file'));
    }

    function handleDrop(e) {
      e.preventDefault();
      document.getElementById('dropZone').dataset.drag = 'false';
      const f = e.dataTransfer.files[0];
      if (f) setSelectedFile(f);
    }
    function onFileSelect(e) { if (e.target.files[0]) setSelectedFile(e.target.files[0]); }
    function setSelectedFile(f) {
      selFile = f;
      document.getElementById('fileDisplayName').textContent = f.name + ' (' + (f.size / 1024 / 1024).toFixed(1) + ' MB)';
      setShown(document.getElementById('fileDisplay'), true);
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
      const label = document.getElementById('whisperLabel');
      try {
        const r = await fetch(WHISPER_URL + '/health', { signal: AbortSignal.timeout(2000) });
        await r.json();
        whisperOnline = r.ok;
      } catch (e) { whisperOnline = false; }

      if (pill) {
        pill.dataset.state = whisperOnline ? 'online' : 'offline';
        label.textContent = whisperOnline ? 'Server online' : 'Server offline';
      }
      return whisperOnline;
    }

    // Poll every 10 seconds
    setInterval(checkWhisperServer, 10000);
    setTimeout(checkWhisperServer, 800);

    // ── Method toggle ─────────────────────────────────────────────────────────────
    function setMethod(m) {
      uploadMethod = m;
      document.getElementById('methodWhisper').setAttribute('aria-checked', String(m === 'whisper'));
      document.getElementById('methodClaude').setAttribute('aria-checked', String(m === 'claude'));
      setShown(document.getElementById('whisperNote'), m === 'whisper');
      setShown(document.getElementById('claudeNote'), m === 'claude');
      document.getElementById('dropzoneHint').textContent = m === 'whisper'
        ? 'MP3, MP4, WAV, M4A, MOV, WebM — any size, any language'
        : 'MP3, MP4, WAV, M4A, MOV, WebM — up to about 2 hours';
      document.getElementById('uploadBtnTxt').textContent = m === 'whisper'
        ? 'Transcribe with Whisper'
        : 'Transcribe with Groq AI';
    }

    // ── Main entry: processUpload sends the link or file to the chosen engine ────
    async function processUpload() {
      const fromUrl = !document.getElementById('pane-url').hidden;
      const url = document.getElementById('vidUrl').value.trim();
      if (fromUrl && !url) { showToast('Please enter a video URL.', 'error'); return; }
      if (!fromUrl && !selFile) { showToast('Please select a file first.', 'error'); return; }
      const btn = document.getElementById('uploadBtn');
      btn.disabled = true; document.getElementById('uploadBtnTxt').textContent = 'Processing…';
      const pw = document.getElementById('progressWrap');
      const pb = document.getElementById('progressBar');
      const pl = document.getElementById('progressLabel');
      setShown(pw, true); setShown(pl, true);
      pl.dataset.state = 'idle';
      pl.textContent = 'Starting…'; pb.style.width = '4%';

      const source = fromUrl ? url : selFile.name;
      const onProgress = (pct, label) => {
        pb.style.width = pct + '%';
        pl.textContent = label;
      };

      try {
        // Both engines run through the local server (Groq calls are proxied so the key stays there)
        const up = await checkWhisperServer();
        if (!up) {
          throw new Error(
            'The backend server is offline.\n\n' +
            'Steps to start it:\n' +
            '1. Open a terminal / command prompt\n' +
            '2. Run:  python server.py\n' +
            '3. Wait for "Model ready ✓" message\n' +
            '4. Then try again.'
          );
        }
        const result = fromUrl ? await transcribeUrl(url, onProgress)
          : uploadMethod === 'whisper' ? await transcribeWithWhisper(selFile, onProgress)
            : await transcribeWithClaude(selFile, onProgress);

        pb.style.width = '100%';
        pl.textContent = '✓ Transcription complete!';
        pl.dataset.state = 'success';

        const title = document.getElementById('vidName').value.trim() || result.title;
        setTimeout(() => {
          closeModal('modal-upload');
          // The transcript goes straight into the library entry; openSession shows it and generates notes
          const lecture = addLibraryCard(title, fromUrl ? 'url' : 'video', source,
            [newBlock('video', result.source, result.text)]);
          openSession(title, lecture.type, source, lecture);
          resetUploadForm();
        }, 800);

      } catch (err) {
        pl.textContent = err.message;
        pl.dataset.state = 'error';
        btn.disabled = false;
        setMethod(uploadMethod);
      }
    }

    function resetUploadForm() {
      selFile = null;
      document.getElementById('fileIn').value = ''; // so picking the same file again still fires onchange
      document.getElementById('vidName').value = '';
      document.getElementById('vidUrl').value = '';
      setShown(document.getElementById('fileDisplay'), false);
      setShown(document.getElementById('progressWrap'), false);
      setShown(document.getElementById('progressLabel'), false);
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('uploadBtn').disabled = false;
      setMethod(uploadMethod); // restore button label
    }

    // POST to the local server: upload progress first, then a ticking "still working" label until it answers.
    // Resolves with the JSON reply; rejects with the server's error message.
    function postToServer(path, body, onProgress, workingLabel) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const mb = n => Math.round(n / 1024 / 1024 * 10) / 10;
        let ticker = null;
        const startTicker = () => {
          if (ticker) return;
          const started = Date.now();
          const tick = () => onProgress(55, `${workingLabel}… ${Math.round((Date.now() - started) / 1000)}s`);
          tick(); ticker = setInterval(tick, 1000);
        };

        xhr.open('POST', WHISPER_URL + path);
        xhr.timeout = 60 * 60 * 1000; // long lectures can take a while on a CPU
        if (body instanceof FormData) {
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) onProgress(8 + Math.round((e.loaded / e.total) * 40), `Uploading… ${mb(e.loaded)} MB / ${mb(e.total)} MB`);
          };
          xhr.upload.onload = startTicker;
        } else {
          xhr.setRequestHeader('Content-Type', 'application/json');
          body = JSON.stringify(body);
          startTicker();
        }

        xhr.onload = () => {
          clearInterval(ticker);
          let data;
          try { data = JSON.parse(xhr.responseText); } catch (e) {
            reject(new Error('Invalid server response: ' + xhr.responseText.slice(0, 200)));
            return;
          }
          if (xhr.status !== 200 || data.error) reject(new Error(data.error || `Server error ${xhr.status}`));
          else resolve(data);
        };
        xhr.onerror = () => {
          clearInterval(ticker);
          reject(new Error('Cannot reach the backend server at ' + WHISPER_URL + '.\nMake sure "python server.py" is running.'));
        };
        xhr.ontimeout = () => { clearInterval(ticker); reject(new Error('The server took over an hour to answer — try a shorter recording.')); };
        xhr.send(body);
      });
    }

    // Each engine resolves with { title, source, text } — text starts with a source header line
    // ── ENGINE 1: Whisper via local Python server ─────────────────────────────────
    async function transcribeWithWhisper(file, onProgress) {
      onProgress(8, 'Uploading file to Whisper server…');
      const form = new FormData();
      form.append('file', file, file.name);
      // auto-detect language; to force a language: form.append('language', 'en');
      const data = await postToServer('/transcribe', form, onProgress, 'Whisper is transcribing');
      onProgress(95, `Whisper transcribed ${data.duration ? Math.round(data.duration) + 's' : ''} of audio in ${data.elapsed_s}s ✓`);
      return {
        title: file.name.replace(/\.[^.]+$/, ''), source: file.name,
        text: `[WHISPER EXTRACT: ${file.name}] (lang: ${data.language || 'auto'})\n\n${data.text}`
      };
    }

    // ── ENGINE 2: Groq Whisper cloud transcription (free, fast) ──────────────────
    // Proxied through server.py so the Groq API key stays server-side. The server also
    // shrinks the audio with ffmpeg first, so videos and long lectures fit Groq's 25 MB limit.
    async function transcribeWithClaude(file, onProgress) {
      onProgress(8, 'Uploading file…');
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await postToServer('/api/transcribe-groq', form, onProgress, 'Groq Whisper is transcribing');
      return { title: file.name.replace(/\.[^.]+$/, ''), source: file.name, text: `[VIDEO EXTRACT: ${file.name}]\n\n${data.text.trim()}` };
    }

    // ── Links: the server downloads the audio (yt-dlp), then runs the chosen engine ──
    async function transcribeUrl(url, onProgress) {
      const engine = uploadMethod === 'whisper' ? 'whisper' : 'groq';
      const data = await postToServer('/transcribe-url', { url, engine }, onProgress, 'Downloading and transcribing');
      const header = engine === 'whisper'
        ? `[WHISPER EXTRACT: ${data.title}] (lang: ${data.language || 'auto'})`
        : `[VIDEO EXTRACT: ${data.title}]`;
      return { title: data.title, source: data.title, text: header + '\n\n' + data.text.trim() };
    }

    // ═══════════════════════════════════════════════
    //  TRANSCRIPT BLOCK SYSTEM
    // ═══════════════════════════════════════════════
    function newBlock(type, source, text) {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { id: newId('blk'), type, source, text, corrected: null, time };
    }

    function addTranscriptBlock(type, source, text) {
      const b = newBlock(type, source, text);
      transcriptBlocks.push(b);
      saveLibrary();
      setShown(document.getElementById('txPlaceholder'), false);
      document.getElementById('fixBtn').disabled = false;
      renderBlock(b);
      // Live recordings follow the newest text; an uploaded transcript stays at its start.
      if (type !== 'video' || transcriptBlocks.length > 1) document.getElementById('notesScroll').scrollTop = 99999;
      return b.id;
    }

    function renderBlock(b) {
      const block = document.createElement('div');
      block.id = b.id;
      block.className = 'border-b border-line px-4 py-5 last:border-b-0 sm:px-5 motion-safe:animate-fade-up';
      const isVideo = b.type === 'video';
      const iconTint = isVideo ? 'bg-primary-soft text-brand' : 'bg-accent-soft text-accent-fg';
      block.innerHTML = `
    <div class="mb-4 flex items-center gap-3 border-b border-line pb-4">
      <span class="grid size-9 shrink-0 place-items-center rounded-lg ${iconTint}">${icon(isVideo ? 'video' : 'mic')}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">${escH(b.source)}</div>
        <div class="mt-0.5 text-xs text-ink-3">${b.time} · ${isVideo ? 'Audio extracted' : 'Live recording'}</div>
      </div>
      <span id="${b.id}_badge" class="${BADGE_BASE} ${BADGE_STYLES[b.type]}">${isVideo ? 'Video extract' : 'Live recording'}</span>
    </div>
    <div id="${b.id}_text" class="whitespace-pre-wrap break-words text-[15px] leading-7 text-ink">${escH(b.corrected || b.text)}</div>`;
      document.getElementById('txBlocks').appendChild(block);
      if (b.corrected) setBadge(b.id, 'fixed', 'Grammar fixed');
    }

    function getAllText() { return transcriptBlocks.map(b => b.corrected || b.text).join('\n\n').trim(); }
    // Drop the "[WHISPER EXTRACT: file] (lang: en)" / "[VIDEO EXTRACT: file]" source labels before text goes to the AI
    function stripHeaders(tx) { return tx.replace(/\[(?:VIDEO|WHISPER) EXTRACT:[^\]]*\](?:[ \t]*\(lang:[^)]*\))?/g, '').trim(); }

    function copyTranscript() {
      const tx = getAllText();
      if (!tx) { showToast('No transcript yet.'); return; }
      navigator.clipboard.writeText(tx).then(() => showToast('Copied to clipboard!')).catch(() => alert(tx));
    }

    function clearTranscript() {
      if (!confirm('Clear all transcript content?')) return;
      transcriptBlocks.length = 0; // emptied in place: it is the open lecture's saved block list
      saveLibrary();
      finalTxStr = ''; notesDone = false;
      document.getElementById('txBlocks').innerHTML = '';
      setShown(document.getElementById('txPlaceholder'), true);
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
      if (!SR_ENGINE) { showToast('Use Google Chrome or Edge for live recording.', 'error'); return; }
      isRec = true;
      recRestartAttempts = 0;
      finalTxStr = '';
      liveBlockId = null;
      notesDone = false;

      document.getElementById('recBtn').dataset.recording = 'true';
      document.getElementById('recBtnTxt').textContent = 'Stop Recording';
      setShown(document.getElementById('txPlaceholder'), false);
      document.getElementById('fixBtn').disabled = false;
      document.getElementById('recWordCount').textContent = '0 words';
      setShown(document.getElementById('recStatusBar'), true);
      startWave();

      liveBlockId = addTranscriptBlock('mic', 'Live Recording', '');
      setBadge(liveBlockId, 'live', 'Live');

      _spawnRecognition();
    }

    function _spawnRecognition() {
      if (!isRec) return;
      clearTimeout(recRestartTimer);

      try { if (recog) { recog.abort(); recog = null; } } catch (e) { }

      recog = new SR_ENGINE();
      recog.continuous = true;
      recog.interimResults = true;
      recog.lang = recLang;
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
              if (block) { block.text = finalTxStr; saveLibrary(); }
            }
            // Update word count
            const wc = finalTxStr.trim().split(/\s+/).filter(w => w.length > 0).length;
            const wcel = document.getElementById('recWordCount');
            if (wcel) wcel.textContent = wc + ' words';

            // Auto-generate notes after enough words
            if (wc > 30 && !notesDone) {
              notesDone = true;
              later(() => generateNotes(getAllText()), 1200);
            }
          } else {
            interimText = t;
          }
        }

        // Show interim text with italic styling
        if (liveBlockId && interimText) {
          const el = document.getElementById(liveBlockId + '_text');
          if (el) el.innerHTML = escH(finalTxStr) + `<span class="italic text-ink-3"> ${escH(interimText)}</span>`;
        }
        document.getElementById('notesScroll').scrollTop = 99999;
      };

      recog.onerror = (e) => {
        const err = e ? e.error : '';
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          showToast('Microphone access denied. Please allow microphone in browser settings.', 'error');
          stopRec();
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
      const wasRec = isRec;
      isRec = false;
      clearTimeout(recRestartTimer);
      try { if (recog) { recog.abort(); recog = null; } } catch (e) { }
      _resetRecUI();

      // Finalize the block: drop any half-recognized (interim) words and the "Live" badge.
      // Only right after a recording — later calls (e.g. leaving the session) must not undo a grammar fix.
      if (wasRec && liveBlockId) {
        const el = document.getElementById(liveBlockId + '_text');
        if (el) el.textContent = finalTxStr;
        setBadge(liveBlockId, 'mic', 'Live recording');
      }
    }

    function _resetRecUI() {
      const btn = document.getElementById('recBtn');
      if (btn) btn.dataset.recording = 'false';
      const txt = document.getElementById('recBtnTxt');
      if (txt) txt.textContent = 'Start Recording';
      setShown(document.getElementById('recStatusBar'), false);
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
        b.className = 'wbar w-[3px] rounded-full bg-accent-500';
        wf.appendChild(b);
      }
    }
    function startWave() {
      buildWave();
      setShown(document.getElementById('waveform'), true);
      setShown(document.getElementById('audioWait'), false);
      setShown(document.getElementById('audioLbl'), true);
      setShown(document.getElementById('recLangWrap'), false);

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
      if (wf) { setShown(wf, false); wf.innerHTML = ''; }
      setShown(document.getElementById('audioWait'), true);
      setShown(document.getElementById('audioLbl'), false);
      setShown(document.getElementById('recLangWrap'), true);
    }

    // Live speech-recognition language (BCP-47 codes understood by Chrome/Edge); Whisper uploads auto-detect instead
    const REC_LANGS = [
      ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['ar-SA', 'Arabic'],
      ['bn-BD', 'Bengali'], ['zh-CN', 'Chinese (Mandarin)'], ['fr-FR', 'French'], ['de-DE', 'German'],
      ['hi-IN', 'Hindi'], ['id-ID', 'Indonesian'], ['it-IT', 'Italian'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
      ['fa-IR', 'Persian'], ['pt-BR', 'Portuguese (Brazil)'], ['ru-RU', 'Russian'], ['es-ES', 'Spanish'],
      ['tr-TR', 'Turkish'], ['ur-PK', 'Urdu']
    ];
    const REC_LANG_SELECTS = ['recLang', 'recLangSession'];
    let recLang = 'en-US';

    function initRecLang() {
      let saved = null;
      try { saved = localStorage.getItem('recallme-rec-lang'); } catch (e) { }
      const codes = REC_LANGS.map(l => l[0]);
      const browser = navigator.language || '';
      recLang = codes.includes(saved) ? saved
        : codes.find(c => c === browser) || codes.find(c => c.split('-')[0] === browser.split('-')[0]) || 'en-US';
      REC_LANG_SELECTS.forEach(id => {
        const sel = document.getElementById(id);
        sel.innerHTML = REC_LANGS.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
        sel.value = recLang;
      });
    }
    function setRecLang(code) {
      recLang = code;
      REC_LANG_SELECTS.forEach(id => { document.getElementById(id).value = code; });
      try { localStorage.setItem('recallme-rec-lang', code); } catch (e) { }
    }

    // ═══════════════════════════════════════════════
    //  GROQ CHAT (free)
    //  Proxied through server.py — the API key stays server-side.
    // ═══════════════════════════════════════════════

    // history: earlier { role, content } turns. requireComplete: treat a reply cut off at maxTokens as an error.
    // Rate-limit errors carry err.retryAfter (seconds).
    async function callClaude(system, userMsg, maxTokens = 900, { history = [], requireComplete = false } = {}) {
      let res;
      try {
        res = await fetch(WHISPER_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system, message: userMsg, history, max_tokens: maxTokens })
        });
      } catch (e) {
        throw new Error('Cannot reach the backend server. Make sure "python server.py" is running.');
      }
      const data = await res.json();
      if (data.error) {
        const err = new Error(data.error);
        if (data.retry_after) err.retryAfter = data.retry_after;
        throw err;
      }
      if (!data.text) throw new Error('Empty response from server.');
      if (requireComplete && data.truncated) throw new Error('The AI reply was cut off before it finished.');
      return data.text;
    }

    // ═══════════════════════════════════════════════
    //  AUTO NOTES GENERATION
    // ═══════════════════════════════════════════════
    async function generateNotes(tx) {
      const gen = sessionGen;
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
- Smart section titles: "Key Concepts", "How It Works", "Platform Features", "Student Questions", "Important Points", "Action Items"`,
          `Analyze this transcript:\n"${stripHeaders(tx).substring(0, NOTES_TRANSCRIPT_CHARS)}"`
        );
        if (gen !== sessionGen) return; // user moved to another session meanwhile
        removeEl(tid);
        const match = answer.replace(/```json\n?/g, '').replace(/```\n?/g, '').match(/\{[\s\S]*\}/);
        if (match) { try { showNotes(JSON.parse(match[0]).sections); } catch (e) { smartFallback(tx); } }
        else smartFallback(tx);
      } catch (e) { if (gen !== sessionGen) return; removeEl(tid); smartFallback(tx); }
    }

    // Render a new notes card and keep it with the lecture so reopening shows it again
    function showNotes(sections) {
      if (!renderNotes(sections)) return;
      if (currentLecture) { currentLecture.notes.push(sections); saveLibrary(); }
      markChatUnread();
    }

    function renderNotes(sections) {
      if (!sections || !sections.some(s => s.points && s.points.length)) return false;
      const p = document.getElementById('chatScroll');
      const card = document.createElement('div');
      card.className = 'rounded-2xl border border-line bg-surface-2 p-4 sm:p-5 motion-safe:animate-fade-up';
      let html = `<div class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand">${icon('sparkles')}Auto-generated notes</div><div class="space-y-5">`;
      sections.forEach(s => {
        if (!s.points || !s.points.length) return;
        html += `<section><h3 class="mb-2 flex items-center gap-2 text-sm font-semibold"><span class="h-4 w-1 rounded-full bg-primary-500"></span>${escH(s.title)}</h3><ul class="space-y-1.5">${s.points.map(pt => `<li class="relative pl-4 text-sm leading-relaxed text-ink-2 before:absolute before:left-0 before:top-2 before:size-1.5 before:rounded-full before:bg-primary-500/60">${escH(pt)}</li>`).join('')}</ul></section>`;
      });
      html += '</div>';
      card.innerHTML = html;
      p.appendChild(card); p.scrollTop = 99999;
      return true;
    }

    function smartFallback(tx) {
      const clean = stripHeaders(tx);
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
      showNotes(sections);
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
      const gen = sessionGen;
      const tid = addTyping(); busy = true;
      document.getElementById('sendBtn').disabled = true;

      const sys = buildLettaSystemPrompt(tx);

      try {
        const answer = await callClaude(sys, q, 1400, { history: recentHistory() });
        if (gen !== sessionGen) return; // the new session has already reset busy / the send button
        removeEl(tid);
        addMsg('ai', answer);
        hist.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
      } catch (e) {
        if (gen !== sessionGen) return;
        removeEl(tid);
        console.error('Letta API error:', e);
        addMsg('ai', `⚠️ **Letta could not respond.**\n\nReason: ${e.message}\n\n*Check that the backend server is running and you have an internet connection.*`);
      }

      busy = false;
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('chatIn').focus();
    }

    // The newest chat turns that fit in CHAT_HISTORY_CHARS, oldest first
    function recentHistory() {
      const out = [];
      let size = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        size += hist[i].content.length;
        if (size > CHAT_HISTORY_CHARS) break;
        out.unshift(hist[i]);
      }
      return out;
    }

    function buildLettaSystemPrompt(tx) {
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      return `You are Letta, an intelligent AI assistant inside RecallMe — a real-time lecture transcription and note-taking app. Today's date is ${today}.

${tx ? `LECTURE TRANSCRIPT (primary source — always reference this):
"${stripHeaders(tx).substring(0, CHAT_TRANSCRIPT_CHARS)}"

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
    const GRAMMAR_PROMPT = `You are a grammar and spelling correction specialist.
RULES:
- Fix ALL grammar, spelling, punctuation and capitalization errors
- Fix contractions: im→I'm, dont→don't, cant→can't, its→it's, ive→I've, id→I'd etc.
- Capitalize every sentence start and the word "I"
- Add missing periods, commas, apostrophes
- Do NOT change meaning or rephrase — only fix language errors
- The text may be one part of a longer transcript: never add, drop or summarize content
- Keep [VIDEO EXTRACT: ...] and [WHISPER EXTRACT: ...] header lines exactly as-is
- Return ONLY the corrected text, no explanation`;

    // Every transcript block is corrected on its own (so blocks never get merged or duplicated),
    // in pieces of ~GRAMMAR_CHUNK_WORDS so no reply is cut off. Pieces the AI can't fix get the local fix.
    async function correctGrammar() {
      if (isRec) { showToast('Stop recording before fixing grammar.', 'error'); return; }
      const blocks = transcriptBlocks.filter(b => (b.corrected || b.text).trim().length >= 10);
      if (!blocks.length) return;
      const btn = document.getElementById('fixBtn');
      const btnTxt = document.getElementById('fixBtnTxt');
      const gen = sessionGen;
      btn.disabled = true; btnTxt.textContent = 'Fixing…';

      const jobs = blocks.map(b => ({ b, chunks: chunkText(b.corrected || b.text, GRAMMAR_CHUNK_WORDS) }));
      const total = jobs.reduce((n, j) => n + j.chunks.length, 0);
      let done = 0, aiFixed = 0, lastErr = null;
      for (const { b, chunks } of jobs) {
        const parts = [];
        for (const chunk of chunks) {
          const label = total > 1 ? `Fixing ${++done}/${total}…` : 'Fixing…';
          btnTxt.textContent = label;
          try {
            parts.push(await fixChunkWithAI(chunk, waiting => {
              if (gen === sessionGen) btnTxt.textContent = waiting ? 'Waiting for Groq…' : label;
            }));
            aiFixed++;
          } catch (e) {
            lastErr = e;
            parts.push(localGrammarFix(chunk));
          }
          if (gen !== sessionGen) return; // user left the session; it resets the button itself
        }
        // Rejoin with the whitespace (e.g. paragraph breaks) that separated the pieces
        b.corrected = parts.map((p, i) => p.trim() + chunks[i].match(/\s*$/)[0]).join('').trim();
        saveLibrary();
        const el = document.getElementById(b.id + '_text');
        if (el) el.textContent = b.corrected;
        setBadge(b.id, 'fixed', 'Grammar fixed');
      }

      hideEmpty();
      const reason = lastErr ? `\n\n*Reason: ${lastErr.message}*` : '';
      if (aiFixed === total) {
        addMsg('ai', `✅ **Grammar corrected!**\n\nI fixed:\n- Missing apostrophes (don't, I'm, it's, we're)\n- Sentence capitalization\n- Punctuation and periods\n- Common speech-to-text errors\n\nThe corrected text is now showing in the Notes panel.`);
      } else if (aiFixed === 0) {
        addMsg('ai', '✅ **Grammar fixed locally.** Basic corrections applied — apostrophes, capitalization, and punctuation corrected.' + reason);
      } else {
        addMsg('ai', `✅ **Grammar fixed.** ${aiFixed} of ${total} parts were corrected by AI; the other ${total - aiFixed} got basic local fixes (apostrophes, capitalization, punctuation).` + reason);
      }
      btn.disabled = false; btnTxt.textContent = 'Fix Grammar';
    }

    // One AI grammar request. Groq's free tier allows ~8k tokens/min, so rate limits are waited out a few times.
    async function fixChunkWithAI(chunk, onWait) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callClaude(GRAMMAR_PROMPT, `Fix grammar:\n\n${chunk}`, 2400, { requireComplete: true });
        } catch (e) {
          if (!e.retryAfter || attempt >= 3) throw e;
          onWait(true);
          await new Promise(r => setTimeout(r, Math.min(e.retryAfter, 60) * 1000 + 250));
          onWait(false);
        }
      }
    }

    // Split text into pieces of about maxWords, ending at a sentence end when possible.
    // Each piece keeps its trailing whitespace, so joining them gives back the original text.
    function chunkText(text, maxWords) {
      const words = text.match(/\S+\s*/g) || [];
      const chunks = [];
      let cur = '', n = 0;
      for (const w of words) {
        cur += w; n++;
        if (n >= maxWords * 1.5 || (n >= maxWords && /[.!?]["')\]]*\s*$/.test(w))) { chunks.push(cur); cur = ''; n = 0; }
      }
      if (cur) chunks.push(cur);
      return chunks;
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
    //  LIBRARY — saved in this browser's localStorage, so it survives reloads
    // ═══════════════════════════════════════════════
    const LIBRARY_KEY = 'recallme-library';
    let lectures = []; // { id, title, type, source, created, blocks, notes }
    let storageWarned = false;

    function loadLibrary() {
      try { lectures = JSON.parse(localStorage.getItem(LIBRARY_KEY)) || []; } catch (e) { lectures = []; }
      if (!Array.isArray(lectures)) lectures = [];
      lectures = lectures.filter(l => l && typeof l.title === 'string');
      lectures.forEach(l => {
        if (!Array.isArray(l.blocks)) l.blocks = [];
        if (!Array.isArray(l.notes)) l.notes = [];
        renderLibraryCard(l);
      });
      updateLibCount();
    }

    // Called after every change to a lecture (cheap: the library is plain text)
    function saveLibrary() {
      try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(lectures)); } catch (e) {
        if (!storageWarned) {
          storageWarned = true;
          showToast("Browser storage is full or blocked — library changes won't survive a reload.", 'error');
        }
      }
    }

    function fmtDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toDateString() === new Date().toDateString() ? 'Today'
        : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    }

    const THUMB_GRADIENTS = [
      'from-primary-500 to-primary-800',
      'from-accent-500 to-accent-800',
      'from-sky-500 to-primary-700',
      'from-violet-500 to-primary-800',
      'from-teal-500 to-primary-700'
    ];
    const CARD_LABELS = { video: 'Video', url: 'Link', mic: 'Audio' };
    // Returns the new lecture entry; its transcript blocks and notes come back whenever the card is opened
    function addLibraryCard(title, type, source, blocks = []) {
      const lecture = { id: newId('lec'), title, type, source, created: Date.now(), blocks, notes: [] };
      lectures.push(lecture);
      saveLibrary();
      renderLibraryCard(lecture);
      updateLibCount();
      return lecture;
    }

    function deleteLecture(lecture, card) {
      if (!confirm(`Delete "${lecture.title}" and its transcript?`)) return;
      lectures = lectures.filter(l => l !== lecture);
      saveLibrary();
      card.remove();
      updateLibCount();
    }

    function renderLibraryCard(lecture) {
      const { title, type } = lecture;
      const wrap = document.createElement('div');
      wrap.className = 'group/card relative transition duration-200 hover:-translate-y-1 motion-safe:animate-fade-up';
      const grad = THUMB_GRADIENTS[[...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % THUMB_GRADIENTS.length];
      const short = title.length > 40 ? title.substring(0, 38) + '…' : title;
      const kind = type === 'mic' ? 'mic' : 'video';
      wrap.innerHTML = `
  <button type="button" class="group relative block h-full w-full overflow-hidden rounded-2xl border border-line bg-surface text-left shadow-sm transition duration-200 hover:border-primary-500/40 hover:shadow-lg">
    <span class="relative block h-36 overflow-hidden bg-linear-to-br ${grad} sm:h-40">
      <span class="absolute -right-6 -top-6 size-28 rounded-full bg-white/10"></span>
      <span class="absolute -bottom-10 -left-6 size-32 rounded-full bg-white/10"></span>
      <span class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-white">
        <span class="grid size-11 place-items-center rounded-xl bg-white/15 backdrop-blur">${icon(kind, 'size-6')}</span>
        <span class="line-clamp-2 text-sm font-semibold leading-snug">${escH(short)}</span>
      </span>
      <span class="absolute inset-0 grid place-items-center bg-slate-950/0 opacity-0 transition duration-200 group-hover:bg-slate-950/30 group-hover:opacity-100">
        <span class="grid size-11 place-items-center rounded-full bg-white/95 text-primary-700 shadow-lg">${icon('play', 'size-5 translate-x-px')}</span>
      </span>
      <span class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">${icon(kind, 'size-3.5')}${CARD_LABELS[type] || 'Video'}</span>
    </span>
    <span class="block p-4">
      <span class="block truncate text-sm font-semibold">${escH(title)}</span>
      <span class="mt-1 block text-xs text-ink-3">${fmtDate(lecture.created)}</span>
    </span>
  </button>
  <button type="button" aria-label="Delete ${escH(title)}" title="Delete lecture"
    class="absolute left-2.5 top-2.5 grid size-8 place-items-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur transition duration-200 hover:bg-red-600 focus-visible:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100">${icon('trash')}</button>`;
      const [openBtn, deleteBtn] = wrap.querySelectorAll('button');
      openBtn.onclick = () => openSession(title, type, lecture.source, lecture);
      deleteBtn.onclick = () => deleteLecture(lecture, wrap);
      document.getElementById('lectureGrid').appendChild(wrap);
    }
    function updateLibCount() {
      const count = document.getElementById('lectureGrid').children.length;
      document.getElementById('libCount').textContent = count + (count === 1 ? ' lecture' : ' lectures');
    }
    function startRecordSession() {
      closeModal('modal-record');
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const title = 'Live Recording · ' + time;
      openSession(title, 'mic', '', addLibraryCard(title, 'mic', ''));
      later(startRec, 400);
    }

    // ═══════════════════════════════════════════════
    //  UI HELPERS
    // ═══════════════════════════════════════════════
    function hideEmpty() {
      setShown(document.getElementById('chatEmpty'), false);
    }
    function addMsg(role, text) {
      const p = document.getElementById('chatScroll');
      const isUser = role === 'user';
      const d = document.createElement('div');
      d.className = 'flex flex-col gap-1 motion-safe:animate-fade-up ' + (isUser ? 'items-end' : 'items-start');
      const w = document.createElement('div');
      w.className = 'flex items-center gap-1.5 px-1 text-xs font-semibold ' + (isUser ? 'text-ink-3' : 'text-brand');
      w.innerHTML = isUser ? 'You' : icon('sparkles', 'size-3.5') + 'Letta';
      const b = document.createElement('div');
      if (isUser) {
        b.className = 'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm';
        b.textContent = text;
      } else {
        b.className = 'max-w-full break-words rounded-2xl rounded-tl-md border border-line bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink sm:max-w-[95%]';
        b.innerHTML = renderMd(text);
      }
      d.appendChild(w); d.appendChild(b); p.appendChild(d); p.scrollTop = 99999;
      if (!isUser) markChatUnread();
    }
    function addTyping() {
      const p = document.getElementById('chatScroll');
      const id = newId('ty');
      const d = document.createElement('div');
      d.id = id;
      d.className = 'flex flex-col items-start gap-1 motion-safe:animate-fade-in';
      d.innerHTML = `
    <div class="flex items-center gap-1.5 px-1 text-xs font-semibold text-brand">${icon('sparkles', 'size-3.5')}Letta</div>
    <div class="flex w-fit items-center gap-1.5 rounded-2xl rounded-tl-md border border-line bg-surface-2 px-4 py-3.5" role="status" aria-label="Letta is typing">
      <span class="size-1.5 animate-typing rounded-full bg-brand"></span>
      <span class="size-1.5 animate-typing rounded-full bg-brand [animation-delay:150ms]"></span>
      <span class="size-1.5 animate-typing rounded-full bg-brand [animation-delay:300ms]"></span>
    </div>`;
      p.appendChild(d); p.scrollTop = 99999;
      return id;
    }
    function removeEl(id) { const e = document.getElementById(id); if (e) e.remove(); }
    function escH(t) {
      return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // Tailwind classes for rendered markdown (kept as literal strings so the CSS build can see them)
    const MD = {
      p: 'mb-2 last:mb-0',
      h: 'mb-1.5 mt-3 font-bold tracking-tight text-ink first:mt-0',
      ul: 'my-2 list-disc space-y-1 pl-5 marker:text-brand',
      ol: 'my-2 list-decimal space-y-1 pl-5 marker:font-semibold marker:text-brand',
      code: 'rounded bg-primary-soft px-1.5 py-0.5 font-mono text-[0.85em] text-brand',
      pre: 'my-2 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100',
      hr: 'my-3 border-line',
      strong: 'font-semibold text-ink',
      tableWrap: 'my-2 overflow-x-auto rounded-lg border border-line',
      table: 'w-full border-collapse text-left text-xs',
      th: 'bg-surface px-3 py-2 font-semibold text-ink',
      td: 'border-t border-line px-3 py-2 align-top'
    };

    // Inline markdown: `code`, **bold**, *italic* / _italic_. Everything is HTML-escaped first.
    function mdInline(s) {
      return String(s).split(/(`[^`\n]+`)/).map((part, i) => {
        if (i % 2 === 1) return `<code class="${MD.code}">${escH(part.slice(1, -1))}</code>`;
        return escH(part)
          .replace(/\*\*(.+?)\*\*/g, `<strong class="${MD.strong}">$1</strong>`)
          .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
          .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
      }).join('');
    }

    // Block markdown → safe HTML: headings, lists, tables, code fences, rules, paragraphs
    function renderMd(src) {
      const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
      const listRe = /^\s*(?:[-*•]|\d+[.)])\s+/;
      const fenceRe = /^\s*```/;
      const headRe = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
      const hrRe = /^\s*([-*_])(\s*\1){2,}\s*$/;
      const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
      const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const out = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        if (fenceRe.test(line)) {
          const buf = [];
          i++;
          while (i < lines.length && !fenceRe.test(lines[i])) buf.push(lines[i++]);
          i++;
          out.push(`<pre class="${MD.pre}"><code>${escH(buf.join('\n'))}</code></pre>`);
          continue;
        }

        const h = line.match(headRe);
        if (h) {
          out.push(`<h3 class="${MD.h} ${h[1].length <= 2 ? 'text-base' : 'text-sm'}">${mdInline(h[2])}</h3>`);
          i++;
          continue;
        }

        if (hrRe.test(line)) { out.push(`<hr class="${MD.hr}">`); i++; continue; }

        if (line.includes('|') && i + 1 < lines.length && sepRe.test(lines[i + 1]) && lines[i + 1].includes('-')) {
          const head = cells(line);
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
          out.push(`<div class="${MD.tableWrap}"><table class="${MD.table}"><thead><tr>${head.map(c => `<th class="${MD.th}">${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td class="${MD.td}">${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
          continue;
        }

        if (listRe.test(line)) {
          const ordered = /^\s*\d/.test(line);
          const start = ordered ? parseInt(line.match(/\d+/)[0], 10) : 1;
          const items = [];
          while (i < lines.length && listRe.test(lines[i])) items.push(lines[i++].replace(listRe, ''));
          const tag = ordered ? 'ol' : 'ul';
          out.push(`<${tag} class="${ordered ? MD.ol : MD.ul}"${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map(t => `<li>${mdInline(t)}</li>`).join('')}</${tag}>`);
          continue;
        }

        const buf = [];
        while (i < lines.length && lines[i].trim() && !fenceRe.test(lines[i]) && !headRe.test(lines[i]) && !listRe.test(lines[i]) && !hrRe.test(lines[i])) buf.push(lines[i++]);
        if (!buf.length) { i++; continue; }
        out.push(`<p class="${MD.p}">${buf.map(mdInline).join('<br>')}</p>`);
      }
      return out.join('');
    }

    function showToast(msg, type = 'success') {
      const t = document.getElementById('_toast');
      t.textContent = msg;
      t.dataset.type = type;
      t.dataset.show = 'true';
      clearTimeout(t._t);
      t._t = setTimeout(() => { t.dataset.show = 'false'; }, type === 'error' ? 4000 : 2200);
    }
    buildWave();
    initRecLang();
    loadLibrary();
