// Speech-to-text that runs on this PC: Whisper large-v3 turbo through transformers.js.
// Uses the graphics card (WebGPU) when available, otherwise the CPU (WASM, multi-threaded).
// The model is downloaded once (~1 GB) and cached by the app; after that it works offline.
import { pipeline, env } from '../../node_modules/@huggingface/transformers/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
// Load the ONNX runtime from the app itself, not from a CDN.
env.backends.onnx.wasm.wasmPaths = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

const state = { status: 'idle', device: null, progress: 0, error: null, model: null };
let pipe = null;
let loading = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn({ ...state }); } catch (_) {} });

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) return 'webgpu';
    }
  } catch (_) { /* no GPU */ }
  return 'wasm';
}

/** Load (and on first use download) the model. Safe to call many times. */
function load(model = 'onnx-community/whisper-large-v3-turbo') {
  if (pipe && state.model === model) return Promise.resolve(pipe);
  if (loading) return loading;
  loading = (async () => {
    state.status = 'loading'; state.error = null; state.progress = 0; state.model = model; notify();
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        state.progress = total ? Math.round((loaded / total) * 100) : 0;
        notify();
      }
    };
    const tryLoad = async (device) => {
      const dtype = device === 'webgpu'
        ? { encoder_model: 'fp16', decoder_model_merged: 'q4' }
        : { encoder_model: 'q8', decoder_model_merged: 'q8' };
      return pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
    };
    let device = await pickDevice();
    try {
      pipe = await tryLoad(device);
    } catch (e) {
      if (device !== 'webgpu') throw e;
      device = 'wasm';
      pipe = await tryLoad(device);
    }
    state.device = device; state.status = 'ready'; state.progress = 100; notify();
    return pipe;
  })().catch((e) => {
    state.status = 'error'; state.error = String((e && e.message) || e); notify();
    pipe = null;
    throw e;
  }).finally(() => { loading = null; });
  return loading;
}

/**
 * Transcribe 16 kHz mono Float32 PCM.
 * language: 'ar' | 'en' | 'auto'
 */
async function transcribe(pcm, { language = 'auto', model } = {}) {
  const p = await load(model || state.model || undefined);
  const opts = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
  if (language === 'ar') opts.language = 'arabic';
  else if (language === 'en') opts.language = 'english';
  const t0 = performance.now();
  const out = await p(pcm, opts);
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
  return { text: cleanup(text), ms: Math.round(performance.now() - t0), device: state.device };
}

// Whisper sometimes "hears" stock phrases in silence; drop those.
const HALLUCINATIONS = [/^(شكرا|شكراً)( لكم)?( على المشاهدة)?\.?$/, /^اشترك(وا)? في القناة\.?$/, /^thank(s| you)( for watching)?[.!]?$/i, /^\[?(music|موسيقى)\]?$/i, /^\.+$/];
function cleanup(t) {
  const s = t.replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.some((re) => re.test(s)) ? '' : s;
}

window.ASR = {
  load, transcribe,
  status: () => ({ ...state }),
  onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};
window.dispatchEvent(new Event('asr-ready'));
