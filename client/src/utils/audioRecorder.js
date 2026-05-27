/**
 * AudioRecorder — captures microphone input as raw PCM-16 mono.
 *
 * Uses ScriptProcessorNode for broad browser compatibility.
 * Returns an ArrayBuffer of interleaved Int16 samples and the actual
 * sample rate the browser selected.
 */
export class AudioRecorder {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.chunks = [];
    this.sampleRate = 48000;
  }

  /** Request mic access and start capturing PCM-16 chunks. */
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext();
    this.sampleRate = this.audioContext.sampleRate;

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // 4096 frames ≈ 85 ms @ 48 kHz — good balance of latency vs overhead
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.chunks = [];

    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.chunks.push(new Uint8Array(pcm16.buffer));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  /**
   * Stop recording and return the captured audio.
   * @returns {{ data: ArrayBuffer, sampleRate: number }}
   */
  stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());

    const rate = this.sampleRate;

    // Concatenate all chunks into one ArrayBuffer
    const totalBytes = this.chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    // Teardown
    this.chunks = [];
    this.processor = null;
    this.source = null;
    this.stream = null;
    if (this.audioContext?.state !== "closed") {
      this.audioContext?.close();
    }
    this.audioContext = null;

    return { data: result.buffer, sampleRate: rate };
  }
}
