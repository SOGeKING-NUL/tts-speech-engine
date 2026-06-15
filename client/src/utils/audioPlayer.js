/**
 * AudioPlayer — gapless PCM-16 playback via the Web Audio API.
 *
 * Implements the techniques from the Seamless TTS Streaming Guide:
 *   1. Direct PCM → Float32 conversion (no decode overhead)
 *   2. Pre-buffering: waits for MIN_BUFFER_CHUNKS before starting
 *   3. Look-ahead scheduling: nextStartTime pattern for sample-accurate chaining
 *   4. Proper cleanup and memory management
 */
export class AudioPlayer {
  constructor(sampleRate = 22050) {
    this.audioContext = null;
    this.sampleRate = sampleRate;
    this.nextStartTime = 0;
    this.sources = [];
    this.isPlaying = false;

    // Pre-buffering: accumulate a few chunks before starting playback
    // to absorb network jitter and prevent gaps
    this.pendingBuffers = [];
    this.MIN_BUFFER_CHUNKS = 2; // Wait for 2 chunks before starting
    this.playbackStarted = false;
  }

  /** Create the AudioContext lazily (must happen after a user gesture). */
  _ensureContext() {
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext();
      
      // Start a continuous silent oscillator to keep the audio hardware awake.
      // This prevents the OS/Bluetooth DAC from going to sleep and clipping the first 0.5s of audio.
      this.silentOscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 0; // Pure silence
      this.silentOscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      this.silentOscillator.start();
    }
  }

  /** Resume a suspended context (required by browsers after first gesture). */
  async resume() {
    this._ensureContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  /** Update the expected sample rate of incoming audio. */
  setSampleRate(rate) {
    this.sampleRate = rate;
  }

  /**
   * Convert PCM-16 ArrayBuffer to an AudioBuffer.
   * @param {ArrayBuffer} pcm16Buf  Raw signed-16-bit little-endian mono.
   * @returns {AudioBuffer}
   */
  _pcmToAudioBuffer(pcm16Buf) {
    const int16 = new Int16Array(pcm16Buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const buffer = this.audioContext.createBuffer(
      1,
      float32.length,
      this.sampleRate,
    );
    buffer.getChannelData(0).set(float32);
    return buffer;
  }

  /**
   * Schedule an AudioBuffer for playback at the correct time.
   * Uses the nextStartTime pattern for gapless chaining.
   * @param {AudioBuffer} audioBuffer
   */
  _scheduleBuffer(audioBuffer) {
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    this.sources.push(source);

    // Schedule: if we've fallen behind, jump to now + look-ahead
    const now = this.audioContext.currentTime;
    if (this.nextStartTime <= now) {
      this.nextStartTime = now + 0.05; // 50ms look-ahead
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.isPlaying = true;

    source.onended = () => {
      const idx = this.sources.indexOf(source);
      if (idx !== -1) this.sources.splice(idx, 1);
      source.disconnect();
      if (this.sources.length === 0) {
        this.isPlaying = false;
      }
    };
  }

  /**
   * Flush all pending buffers into the scheduler.
   */
  _flushPendingBuffers() {
    while (this.pendingBuffers.length > 0) {
      const buf = this.pendingBuffers.shift();
      this._scheduleBuffer(buf);
    }
  }

  /**
   * Decode a PCM-16 ArrayBuffer and schedule it for gapless playback.
   * Uses pre-buffering: accumulates MIN_BUFFER_CHUNKS before starting
   * playback to absorb initial network jitter.
   *
   * @param {ArrayBuffer} pcm16Buf  Raw signed-16-bit little-endian mono.
   */
  playChunk(pcm16Buf) {
    if (!pcm16Buf || pcm16Buf.byteLength === 0) return;

    this._ensureContext();

    const audioBuffer = this._pcmToAudioBuffer(pcm16Buf);

    if (!this.playbackStarted) {
      // Pre-buffering phase: accumulate chunks
      this.pendingBuffers.push(audioBuffer);

      if (this.pendingBuffers.length >= this.MIN_BUFFER_CHUNKS) {
        // We have enough buffer — start playback
        this.playbackStarted = true;
        this._flushPendingBuffers();
      }
    } else {
      // Already playing — schedule immediately (any pending get flushed too)
      if (this.pendingBuffers.length > 0) {
        this._flushPendingBuffers();
      }
      this._scheduleBuffer(audioBuffer);
    }
  }

  /**
   * Force-start playback even if we haven't hit the pre-buffer threshold.
   * Called when we know no more chunks are coming (tts.done).
   */
  flushAndPlay() {
    if (!this.playbackStarted && this.pendingBuffers.length > 0) {
      this._ensureContext();
      this.playbackStarted = true;
      this._flushPendingBuffers();
    }
  }

  /** Immediately stop all scheduled audio and reset the timeline. */
  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextStartTime = 0;
    this.isPlaying = false;
    this.pendingBuffers = [];
    this.playbackStarted = false;
  }

  /** True while queued audio is still playing. */
  isActive() {
    return this.isPlaying || this.pendingBuffers.length > 0;
  }
}
