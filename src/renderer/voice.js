'use strict';
/* global window, navigator, AudioContext, OfflineAudioContext, MediaRecorder, speechSynthesis, SpeechSynthesisUtterance, Blob */
// Voice I/O for Majlis.
//   Recorder: microphone -> automatic end-of-speech detection -> 16 kHz mono PCM (for Whisper)
//   Speaker:  text -> system voices (Arabic or English picked per message)

const Voice = (() => {
  // ------------------------------------------------------------------ recording
  class Recorder {
    constructor({ onLevel = () => {}, silenceMs = 1500, maxMs = 120000, noSpeechMs = 9000 } = {}) {
      Object.assign(this, { onLevel, silenceMs, maxMs, noSpeechMs });
      this.stopped = null;
    }

    /** Resolves with { pcm: Float32Array|null, spoke: boolean } once recording ends. */
    async record() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const buf = new Float32Array(analyser.fftSize);
      const t0 = performance.now();
      let noise = 0.01, calibrated = false, spoke = false, lastVoice = t0;

      const done = new Promise((resolve) => {
        rec.onstop = async () => {
          this.cleanup();
          if (!spoke || !chunks.length) return resolve({ pcm: null, spoke });
          try { resolve({ pcm: await toPcm16k(new Blob(chunks, { type: rec.mimeType })), spoke }); }
          catch (e) { resolve({ pcm: null, spoke, error: e }); }
        };
      });
      this.stopped = () => { if (rec.state !== 'inactive') rec.stop(); };
      rec.start(250);

      const tick = () => {
        if (rec.state === 'inactive') return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (!calibrated) {
          noise = Math.max(noise * 0.8 + rms * 0.2, 0.004);
          if (now - t0 > 350) calibrated = true;
        }
        const threshold = Math.max(noise * 3, 0.018);
        if (calibrated && rms > threshold) { spoke = true; lastVoice = now; }
        this.onLevel(Math.min(1, rms / (threshold * 3)), spoke);
        if ((spoke && now - lastVoice > this.silenceMs) || (!spoke && now - t0 > this.noSpeechMs) || now - t0 > this.maxMs) {
          this.stopped();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return done;
    }

    /** Stop now (user pressed the button). Counts as spoken if anything was recorded. */
    stop() { if (this.stopped) this.stopped(); }

    cleanup() {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { this.ctx.close(); } catch (_) {}
    }
  }

  /** Decode any recorded/loaded audio and resample to 16 kHz mono Float32 (what Whisper expects). */
  async function toPcm16k(blob) {
    const bytes = await blob.arrayBuffer();
    const tmp = new AudioContext();
    const decoded = await tmp.decodeAudioData(bytes.slice(0));
    tmp.close();
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const s = off.createBufferSource();
    s.buffer = decoded;
    s.connect(off.destination);
    s.start();
    return (await off.startRendering()).getChannelData(0);
  }

  // ------------------------------------------------------------------ speaking
  const isArabic = (t) => /[؀-ۿ]/.test(t);

  function voices() { return speechSynthesis.getVoices(); }
  function voicesReady() {
    return new Promise((r) => {
      if (voices().length) return r(voices());
      speechSynthesis.onvoiceschanged = () => r(voices());
      setTimeout(() => r(voices()), 1500);
    });
  }
  function pickVoice(lang, preferred) {
    const all = voices();
    if (preferred) { const v = all.find((x) => x.name === preferred); if (v && v.lang.slice(0, 2) === lang) return v; }
    const prefs = lang === 'ar' ? ['ar-SA', 'ar-AE', 'ar-EG', 'ar'] : ['en-US', 'en-GB', 'en'];
    for (const p of prefs) {
      const list = all.filter((v) => v.lang.replace('_', '-').startsWith(p));
      const natural = list.find((v) => /natural|online|neural/i.test(v.name));
      if (natural || list[0]) return natural || list[0];
    }
    return null;
  }

  /** Turn a markdown answer into something pleasant to hear. */
  function speakable(md, lang) {
    const codeNote = lang === 'ar' ? ' (الكود معروض على الشاشة) ' : ' (the code is on screen) ';
    let t = String(md || '')
      .replace(/```[\s\S]*?```/g, codeNote)
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/[*_~>#|]/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 1400) t = t.slice(0, 1400).replace(/\S*$/, '') + (lang === 'ar' ? '… والباقي على الشاشة.' : '… the rest is on screen.');
    return t;
  }

  let speaking = null;
  /** Speak text; resolves when finished or stopped. */
  async function speak(md, { voiceName = '', rate = 1 } = {}) {
    stopSpeaking();
    await voicesReady();
    const lang = isArabic(md) ? 'ar' : 'en';
    const text = speakable(md, lang);
    if (!text) return { ok: true };
    const voice = pickVoice(lang, voiceName);
    if (!voice && lang === 'ar') return { ok: false, reason: 'no_arabic_voice' };
    // Long utterances get cut off by some engines: queue sentence-sized pieces.
    const parts = text.match(/[^.!?؟。\n]+[.!?؟。]?/g) || [text];
    const chunks = [];
    for (const p of parts) {
      const last = chunks[chunks.length - 1];
      if (last && last.length + p.length < 220) chunks[chunks.length - 1] = last + p; else chunks.push(p.trim());
    }
    return new Promise((resolve) => {
      let i = 0, cancelled = false;
      speaking = { cancel: () => { cancelled = true; speechSynthesis.cancel(); resolve({ ok: true, stopped: true }); } };
      const next = () => {
        if (cancelled) return;
        if (i >= chunks.length) { speaking = null; return resolve({ ok: true }); }
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
        u.rate = rate;
        u.onend = next;
        u.onerror = next;
        speechSynthesis.speak(u);
      };
      next();
    });
  }
  function stopSpeaking() { if (speaking) { const s = speaking; speaking = null; s.cancel(); } else speechSynthesis.cancel(); }
  function isSpeaking() { return !!speaking; }

  return { Recorder, toPcm16k, speak, stopSpeaking, isSpeaking, voicesReady, voices, speakable, pickVoice };
})();

window.Voice = Voice;
