/**
 * vadManager.js — Thin wrapper around @ricky0123/vad-web (Silero VAD).
 *
 * Provides start/pause/resume/destroy lifecycle and accepts callbacks
 * for speech events. Runs the Silero ONNX model locally in the browser
 * via WebAssembly for ~1ms speech detection latency.
 */
import { MicVAD } from "@ricky0123/vad-web";
import * as ort from "onnxruntime-web";

// Configure ONNX Runtime to load WASM files from the public root directory
ort.env.wasm.wasmPaths = "/";

/**
 * @typedef {Object} VADCallbacks
 * @property {() => void}              onSpeechStart  - Fires the instant voice is detected.
 * @property {(audio: Float32Array) => void} onSpeechEnd - Fires when silence follows speech.
 *           `audio` contains the complete utterance PCM at 16 kHz mono.
 * @property {(probs: {isSpeech: number}) => void} [onFrameProcessed] - Every ~32ms frame.
 */

export class VADManager {
  /** @param {VADCallbacks} callbacks */
  constructor(callbacks) {
    this.callbacks = callbacks;
    /** @type {MicVAD | null} */
    this.vad = null;
    this.paused = false;
  }

  /**
   * Request mic permission and start the VAD pipeline.
   * Resolves once the mic stream is active.
   */
  async start() {
    this.vad = await MicVAD.new({
      model: "v5",
      modelURL: "/silero_vad_v5.onnx",
      workletURL: "/vad.worklet.bundle.min.js",
      // ── Detection thresholds ───────────────────────────────────
      positiveSpeechThreshold: 0.75,
      negativeSpeechThreshold: 0.15,
      minSpeechMs: 160,             // require 160ms of speech (filters clicks/pops)
      preSpeechPadMs: 256,          // capture 256ms before speech detected (no clipped words)
      redemptionMs: 3000,           // 3 seconds of patience for telephone-style 'thinking pauses'

      // ── Audio constraints ──────────────────────────────────────
      getStream: async () => {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 16000,
          },
        });
      },

      // ── Callbacks ──────────────────────────────────────────────
      onSpeechStart: () => {
        if (!this.paused) {
          this.callbacks.onSpeechStart();
        }
      },

      onSpeechEnd: (audio) => {
        if (!this.paused) {
          this.callbacks.onSpeechEnd(audio);
        }
      },

      onFrameProcessed: (probs) => {
        if (!this.paused && this.callbacks.onFrameProcessed) {
          this.callbacks.onFrameProcessed(probs);
        }
      },
    });

    this.vad.start();
  }

  /** Temporarily ignore VAD events (e.g. while AI is speaking). */
  pause() {
    this.paused = true;
  }

  /** Resume listening for VAD events. */
  resume() {
    this.paused = false;
  }

  /** Fully tear down the VAD pipeline and release the microphone. */
  destroy() {
    if (this.vad) {
      this.vad.destroy();
      this.vad = null;
    }
    this.paused = false;
  }
}
