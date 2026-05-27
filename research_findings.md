# Research Findings: Seamless Real-Time Voice Chatbot Engine

> Deep research into how industry leaders achieve gap-free, real-time voice conversation systems.

---

## Table of Contents

1. [Your Guide Analysis](#guide-analysis)
2. [ElevenLabs Deep-Dive](#elevenlabs)
3. [Competing TTS Engines](#competitors)
4. [Web Audio API: The Real Story](#web-audio)
5. [STT Pipeline & VAD](#stt-pipeline)
6. [End-to-End Pipeline Coordination](#pipeline)
7. [Interrupt Handling / Barge-In](#barge-in)
8. [WebSocket Protocol Design](#protocol)
9. [Critical Architectural Decisions](#decisions)
10. [Recommended Architecture](#recommendation)

---

## 1. Your Guide Analysis {#guide-analysis}

Your [SEAMLESS_TTS_STREAMING_GUIDE.md](file:///c:/Users/Lenovo/Documents/Projects/tts-speech-engine/SEAMLESS_TTS_STREAMING_GUIDE.md) is a solid foundation. Here's what it gets right and what needs correction/augmentation:

### ✅ What the Guide Gets Right
- The "Five Pillars" (parallel processing, pre-buffering, precise scheduling, look-ahead timing, adaptive optimization) are sound
- Web Audio API is correctly identified as the right tool for conversational AI
- The `nextStartTime` scheduling pattern is industry-standard
- Performance targets (<500ms TTFA, <50ms gaps) are realistic
- The `ProductionSeamlessTTS` class is a good starting skeleton

### ⚠️ Critical Gaps & Corrections

> [!CAUTION]
> **MP3 + `decodeAudioData` is NOT suitable for gapless streaming.** The guide's main code examples use MP3 chunks with `decodeAudioData`, but research reveals this is fundamentally flawed for seamless playback. See [Section 4](#web-audio) for details.

> [!IMPORTANT]
> **AudioWorklet is the modern standard**, not `AudioBufferSourceNode` scheduling. The guide's approach of creating/scheduling individual `BufferSourceNode` instances is the 2020-era pattern. Modern (2025+) implementations use `AudioWorklet` + `SharedArrayBuffer` ring buffers for truly glitch-free streaming.

> [!WARNING]
> **The guide covers only TTS playback.** Your project requires a full STT → LLM → TTS pipeline with VAD, interrupt handling, and bidirectional WebSocket — none of which are addressed in the guide.

---

## 2. ElevenLabs Deep-Dive {#elevenlabs}

### WebSocket Streaming Protocol

**Endpoint:** `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`

#### Client → Server Messages
```json
// Send text chunk
{"text": "Hello, this is a chunk.", "voice_settings": {...}, "flush": false}

// Force synthesis of buffered text immediately
{"text": "end of sentence.", "flush": true}

// End of Sequence (done sending text)
{"text": ""}

// Multi-Context (for voice agents with interruptions)
{"text": "Hello", "context_id": "conv_1", "flush": true}

// Close specific context without killing connection
{"type": "closeContextClient", "context_id": "conv_1"}
```

#### Server → Client Messages
```json
{
  "audio": "UklGRiQAAABXQVZFZm10...",  // base64-encoded audio
  "isFinal": false,
  "normalizedAlignment": {
    "char_start_times_ms": [0, 3, 7, 9, 11],
    "chars_durations_ms": [3, 4, 2, 2, 1],
    "chars": ["H", "e", "l", "l", "o"]
  }
}
```

### The `chunk_length_schedule` — ElevenLabs' Key Innovation

This is the **primary latency-vs-quality knob**:

```
chunk_length_schedule: [120, 160, 250]
```

| Setting | 1st chunk chars | Effect |
|---------|----------------|--------|
| `[50, 80, 120]` | 50 chars | Ultra-low latency, worse prosody |
| `[120, 160, 250]` | 120 chars | Balanced (recommended) |
| `[200, 300, 500]` | 200 chars | Higher latency, best prosody |

The model waits for the specified number of characters before synthesizing each successive chunk. First value = first chunk threshold, giving you control over Time-to-First-Audio.

### The `flush` Mechanism — Solving the Tail Gap Problem

Without flushing, text sits in the buffer waiting to reach the next `chunk_length_schedule` threshold. The `flush: true` flag forces immediate synthesis of all buffered text — **critical at sentence boundaries**.

```
Best practice: Detect sentence boundaries in LLM token stream → flush at each one.
```

### Audio Format Recommendations

| Format | Value | Best For |
|--------|-------|----------|
| **PCM** | `pcm_22050`, `pcm_24000` | ✅ **Lowest latency** — no decoding overhead, no MP3 padding |
| **Opus** | `opus_48000_32` | Good compression, no padding issues |
| **MP3** | `mp3_44100_128` | ❌ Introduces silent padding at frame boundaries |

> [!TIP]
> **PCM is the recommended format** for real-time streaming. MP3 introduces silent padding at the start/end of each frame (LAME encoder delay ~576 samples), making true gapless playback with `decodeAudioData` extremely difficult.

### Multi-Context WebSocket API (For Barge-In)

A single WebSocket manages up to **5 concurrent contexts**:
- Each context = independent audio generation stream
- **Barge-in pattern:** Close current context → open new context → start synthesizing interruption response
- Avoids WebSocket reconnection overhead
- Contexts timeout at 20 seconds (configurable to 180s)

### Flash v2.5 Performance

| Metric | Value |
|--------|-------|
| Model inference | ~75ms |
| TTFA (production) | 200-500ms (adds network, scheduling, buffering) |
| Languages | 32 |
| Architecture | Optimized for speed over maximum expressiveness |

### Conversational AI Pipeline Architecture
```
User Mic → [WebRTC] → STT → LLM → TTS (Flash v2.5) → [WebRTC] → Speaker
```
- **Streaming cascade:** LLM tokens pipe directly to TTS WebSocket
- **Speculative turn-taking:** Pre-triggers LLM response during user silence
- **WebRTC transport:** Built-in echo cancellation, noise removal, jitter buffering
- **Filler phrases:** "Hmm...", "Let me think..." if LLM is slow (configurable)

---

## 3. Competing TTS Engines {#competitors}

### OpenAI Realtime API

| Aspect | Detail |
|--------|--------|
| **Architecture** | End-to-end voice pipeline (STT → LLM → TTS) in single session |
| **Transport** | WebSocket (server) / WebRTC (client) |
| **Audio Format** | PCM16, 24kHz, mono. Also G.711 for telephony |
| **Chunk Size** | 20-50ms audio per chunk (480-1200 samples) |
| **Latency** | WebSocket: 100-300ms / WebRTC: 50-100ms |
| **VAD** | Built-in server-side: `server_vad` (silence-based) + `semantic_vad` (understands utterance completion) |
| **Key Advantage** | Single round-trip, no multi-API orchestration overhead |

**Protocol Events:**
- Client sends: `input_audio_buffer.append` (Base64 audio)
- Server sends: `response.audio.delta` (Base64 audio chunks)
- Interruption: automatic `conversation.interrupted` event

### Deepgram Aura TTS

| Aspect | Detail |
|--------|--------|
| **Transport** | WebSocket (persistent, bidirectional) |
| **Audio Format** | Raw linear16 PCM (no container headers), 24kHz or 16kHz |
| **Latency** | Sub-200ms TTFB; Aura-2: ~90ms TTFB |
| **Key Feature** | Conversational control: stop, flush, cancel mid-synthesis for barge-in |
| **Text Chunking** | 50-100 chars for voice agents; 200-400 for long-form |

> [!NOTE]
> Deepgram outputs **raw audio without WAV headers**. Browser playback requires prepending WAV headers manually. This is important for implementation.

### Google Cloud TTS Streaming

| Aspect | Detail |
|--------|--------|
| **Transport** | Bidirectional gRPC (`StreamingSynthesize`) over HTTP/2 |
| **Audio Format** | LINEAR16, MP3, OGG Opus |
| **Latency** | Target <300ms TTFB |
| **Requirement** | Only **Chirp 3: HD voices** support streaming |
| **Key Feature** | HTTP/2 multiplexing for concurrent streams |

### Azure Neural TTS

| Aspect | Detail |
|--------|--------|
| **Transport** | Managed via Azure Speech SDK (WebSocket under the hood) |
| **Audio Format** | PCM, MP3, OGG/Opus |
| **Key Feature** | Full SSML prosody control (rate, pitch, volume, emphasis, breaks, speaking styles) |
| **SDK Pattern** | `StartSpeakingTextAsync` + `Synthesizing` event callbacks |
| **Best Practice** | Pre-connection warm-up with silent preambles; reuse `SpeechSynthesizer` instances |

### Sarvam.ai (Bulbul)

| Aspect | Detail |
|--------|--------|
| **Transport** | WebSocket (`wss://api.sarvam.ai/text-to-speech/ws`) |
| **Audio Format** | wav, mp3, aac, opus, flac, linear16, mulaw, alaw |
| **Latency** | Sub-250ms TTFB |
| **Languages** | 11 (10 Indian + English with Indian accent) |
| **Key Feature** | Native code-switching (Hinglish), contextual Indian names/places |

### Comparative Summary

| Provider | TTFB | Transport | Audio Format | Streaming Text Input |
|----------|------|-----------|-------------|---------------------|
| **ElevenLabs** | ~200-500ms | WebSocket | PCM/Opus/MP3 | ✅ Token-level + flush |
| **OpenAI Realtime** | 50-300ms | WebSocket/WebRTC | PCM16 24kHz | ✅ End-to-end (no text step) |
| **Deepgram** | ~90ms | WebSocket | Raw PCM | ✅ Speak + Flush |
| **Google Cloud** | <300ms | gRPC | LINEAR16/Opus | ✅ Incremental |
| **Azure** | Variable | SDK (WebSocket) | PCM/MP3/Opus | ✅ Via SDK |
| **Sarvam.ai** | <250ms | WebSocket | Multiple | ✅ Text + flush |

---

## 4. Web Audio API: The Real Story {#web-audio}

### The MP3 + `decodeAudioData` Problem

> [!CAUTION]
> **This is a critical finding that contradicts the main approach in your guide.**

`decodeAudioData()` has fundamental limitations for streaming:

1. **Designed for complete files**, not arbitrary fragments. It's an all-or-nothing operation.
2. **MP3 encoder delay is NOT trimmed.** LAME adds ~576 samples of silence at the start of every MP3 file. `decodeAudioData` does NOT read or respect LAME's gapless info tags.
3. **MP3 frames have bit reservoir dependencies.** Cutting at arbitrary byte positions can produce decode errors.
4. **Each decoded chunk has leading/trailing silence**, causing audible gaps even with perfect scheduling.

### The Real Solution: Two Viable Approaches

#### Approach A: AudioWorklet + SharedArrayBuffer (Modern, Recommended)

This is the **2025+ industry standard** for real-time TTS streaming:

```
WebSocket → Main Thread → SharedArrayBuffer (Ring Buffer) → AudioWorklet → Speakers
                              ↑                                    ↓
                         Web Worker                          128-frame quantum
                    (decoding if needed)                    (pulls from ring buffer)
```

**How it works:**
1. TTS engine sends **raw PCM** (not MP3) over WebSocket
2. Main thread writes PCM samples into a `SharedArrayBuffer` ring buffer
3. `AudioWorkletProcessor.process()` pulls exactly 128 samples per quantum
4. Ring buffer decouples arrival timing from playback timing → **zero gaps**

**Key implementation details:**
- Requires Cross-Origin Isolation headers: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
- Use `Atomics` for lock-free coordination between threads
- **Never allocate memory inside `process()`** — causes GC pauses → audio glitches
- Handle underflow gracefully (output silence/zeros until data arrives)

```javascript
// AudioWorkletProcessor sketch
class TTSProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer initialized via SharedArrayBuffer
    this.ringBuffer = null;
    this.port.onmessage = (e) => {
      if (e.data.type === 'init') {
        this.ringBuffer = new Float32Array(e.data.sharedBuffer);
        this.readIndex = e.data.readIndex;   // Atomics-backed
        this.writeIndex = e.data.writeIndex; // Atomics-backed
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0][0]; // mono channel
    const available = Atomics.load(this.writeIndex, 0) - Atomics.load(this.readIndex, 0);

    if (available >= 128) {
      // Pull 128 samples from ring buffer
      const readPos = Atomics.load(this.readIndex, 0) % this.ringBuffer.length;
      for (let i = 0; i < 128; i++) {
        output[i] = this.ringBuffer[(readPos + i) % this.ringBuffer.length];
      }
      Atomics.add(this.readIndex, 0, 128);
    } else {
      // Underflow: output silence
      output.fill(0);
    }
    return true;
  }
}
```

#### Approach B: `AudioBufferSourceNode` Scheduling with PCM (Simpler, Good Enough)

If you use **PCM (not MP3)** from TTS, the `nextStartTime` pattern in your guide works well:

```javascript
// This works IF and ONLY IF you use PCM/Opus, NOT MP3
const source = audioContext.createBufferSource();
source.buffer = pcmAudioBuffer;  // Already decoded, no padding issues
source.connect(audioContext.destination);
source.start(nextStartTime);
nextStartTime += pcmAudioBuffer.duration;
```

**This approach works because:**
- PCM has no encoder delay/padding
- `AudioBufferSourceNode.start()` is sample-accurate
- Chaining via `nextStartTime = prev + duration` produces zero mathematical gaps

**Limitations vs AudioWorklet:**
- Creates/destroys many `BufferSourceNode` objects (GC pressure)
- Scheduling happens on main thread (can be blocked by JS execution)
- Slightly higher latency due to look-ahead requirement

### MediaSource Extensions (MSE) — When to Use It

| Criteria | Web Audio API | MSE |
|----------|-------------|-----|
| **Latency** | Lowest (<100ms) | Higher (browser buffering) |
| **Control** | Full (sample-level) | Limited (browser manages) |
| **Gapless MP3** | ❌ (padding issues) | ✅ (handles metadata) |
| **Best for** | Real-time voice agents | Long-form content, podcasts |
| **Complexity** | Very high | High |

**Verdict:** For conversational AI, use Web Audio API with PCM. MSE is for audiobooks/podcasts.

### iOS Safari Quirks
- `AudioContext` must be created/resumed from a user gesture (click/tap)
- Auto-suspends when tab is hidden
- `SharedArrayBuffer` requires Cross-Origin Isolation headers
- Some older versions have `AudioWorklet` bugs — test thoroughly

---

## 5. STT Pipeline & VAD {#stt-pipeline}

### Streaming STT Comparison

| Provider | Streaming | Latency | Interim Results | Best For |
|----------|-----------|---------|-----------------|----------|
| **Deepgram Nova-3** | ✅ Native WebSocket | 200-300ms | ✅ `is_final` flag | Real-time voice agents |
| **AssemblyAI** | ✅ Real-time | ~300ms+ | ✅ Yes | Speech intelligence |
| **Google Cloud Speech** | ✅ Streaming | 500ms-1s+ | ✅ Yes | Multilingual (125+ langs) |
| **Azure Speech** | ✅ Streaming | Moderate | ✅ Yes | Enterprise |
| **OpenAI Whisper** | ❌ **NOT streaming** | N/A | ❌ No | Batch processing only |

> [!WARNING]
> **Whisper is NOT suitable for real-time streaming natively.** It's a batch model. Using it requires VAD + audio chunking wrappers, adding significant complexity and latency.

### Self-Hosted STT Options

| Model | Streaming | Hardware | Notes |
|-------|-----------|----------|-------|
| **Vosk** | ✅ Native | CPU (even Raspberry Pi) | Good accuracy, lacks punctuation |
| **faster-whisper** | ⚠️ Via wrappers | GPU (CUDA) | Whisper-quality, needs `whisper_streaming` wrapper |
| **whisper.cpp** | ⚠️ Via server mode | CPU/GPU/Apple Silicon | Portable, Whisper-quality |

### VAD (Voice Activity Detection) Comparison

| VAD | Technology | Noise Robustness | Latency | CPU |
|-----|-----------|-------------------|---------|-----|
| **Silero VAD** | Deep Learning | ✅ High | <1ms/chunk | Very Low |
| **WebRTC VAD** | Signal Processing (GMM) | ⚠️ Struggles with noise | Near Zero | Extremely Low |
| **Picovoice Cobra** | Commercial | ✅ Very High | Very Low | Low |

**Winner: Silero VAD** — modern standard for voice AI.

### Silero VAD Configuration
```python
# Key parameters
threshold = 0.5          # Speech probability threshold (0.0-1.0)
min_silence_duration_ms = 300  # Silence needed to confirm end-of-speech
speech_pad_ms = 30       # Padding to avoid clipping first/last consonant
```

**Best practices:**
1. **Hysteresis:** Higher threshold to start speech detection, lower to end (prevents jittery toggling)
2. **Pre-roll buffer:** Keep ~100ms buffer to prepend when VAD triggers (prevents clipping first consonant)
3. **Input format:** 16kHz, mono, PCM16

---

## 6. End-to-End Pipeline Coordination {#pipeline}

### The Streaming Cascade Pattern

The critical insight: **never wait for any stage to fully complete before starting the next.** All stages overlap.

```
User speaks ──► Audio chunks ──► STT (streaming) ──► Partial transcripts
                                                          │
                                                    VAD detects silence
                                                          │
                                                    Final transcript
                                                          │
                                                     LLM (streaming)
                                                          │
                                                    Token stream
                                                          │
                                                Sentence buffer/chunker
                                                          │
                                                TTS (streaming per sentence)
                                                          │
                                                Audio chunks ──► Client playback
```

### Latency Budget (Target: <600ms)

| Stage | Budget | Notes |
|-------|--------|-------|
| Network (ingress + egress) | 30-80ms | WebSocket or WebRTC |
| VAD + Turn-taking | 150-300ms | **Largest variable** — tune aggressively |
| STT (streaming) | 50-150ms | Streaming eliminates full-utterance wait |
| LLM (TTFT) | 150-400ms | **Primary bottleneck** — Time-to-First-Token |
| TTS (TTFA) | 70-200ms | Start synthesis from first LLM tokens |
| **Total** | **~500-800ms** | Optimized systems aim for <600ms |

### Sentence-Level Chunking (LLM → TTS Bridge)

```python
async def stream_llm_to_tts(llm_stream, tts_ws):
    sentence_buffer = ""
    async for token in llm_stream:
        sentence_buffer += token
        # Detect sentence boundaries
        if token.rstrip().endswith(('.', '!', '?', ':', ';')):
            await tts_ws.send(json.dumps({
                "text": sentence_buffer,
                "flush": True  # Force immediate synthesis
            }))
            sentence_buffer = ""
    # Flush remaining text
    if sentence_buffer:
        await tts_ws.send(json.dumps({"text": sentence_buffer, "flush": True}))
```

### Concurrency Model (Python asyncio)

Three concurrent tasks running simultaneously:

1. **STT Consumer:** Receives audio from client → feeds to STT → waits for final transcript
2. **LLM → TTS Bridge:** Takes transcript → streams to LLM → buffers sentences → sends to TTS with `flush: true`
3. **TTS → Client Streamer:** Receives TTS audio chunks → streams binary to client WebSocket

```python
async def handle_conversation(client_ws):
    stt_ws = await connect_stt()
    tts_ws = await connect_tts()

    async def stt_consumer():
        """Receive audio from client, feed to STT, get transcript"""
        async for message in client_ws:
            if isinstance(message, bytes):
                await stt_ws.send(message)  # Forward audio to STT

    async def llm_tts_bridge(transcript):
        """Stream LLM response to TTS with sentence chunking"""
        llm_stream = get_llm_stream(transcript)
        await stream_llm_to_tts(llm_stream, tts_ws)

    async def tts_client_streamer():
        """Receive TTS audio and forward to client"""
        async for audio_chunk in tts_ws:
            await client_ws.send(audio_chunk)  # Binary audio

    await asyncio.gather(stt_consumer(), tts_client_streamer())
```

### Clause-Level Buffering (Hybrid Approach)

Instead of waiting for full sentences, buffer to **clause boundaries** (commas, semicolons):

| Strategy | Latency | Prosody Quality |
|----------|---------|----------------|
| Token-by-token | Ultra-low | ❌ Poor (robotic) |
| Clause-level | Low-medium | ✅ Good (70% of sentence quality) |
| Sentence-level | Medium | ✅✅ Best (full context) |
| Full paragraph | High | ✅✅✅ Perfect |

**Recommendation:** Start with sentence-level, then experiment with clause-level for lower latency.

---

## 7. Interrupt Handling / Barge-In {#barge-in}

### The Problem
When the user starts speaking while the AI is still outputting audio, you must:
1. Detect the interruption immediately
2. Stop TTS generation
3. Clear the audio playback buffer
4. Cancel the in-flight LLM response
5. Start the new STT → LLM → TTS cycle

### OpenAI Realtime (Built-in)
- Server-side VAD detects user speech during model output
- Sends `conversation.interrupted` event automatically
- Client must immediately clear local audio buffer
- Model automatically handles context reset

### Custom Pipeline (ElevenLabs + LLM)
Must be built manually:

```
1. Client-side Silero VAD detects speech while TTS is playing
      ↓
2. Client sends {"type": "control.interrupt"} to server
      ↓
3. Server: Cancel LLM generation (abort stream)
      ↓
4. Server: Close ElevenLabs context (Multi-Context API)
      ↓
5. Server: Send {"type": "control.clear_buffer"} to client
      ↓
6. Client: Stop all AudioBufferSourceNodes / flush AudioWorklet ring buffer
      ↓
7. New audio from user → STT → LLM → TTS pipeline restarts
```

> [!IMPORTANT]
> **The most common broken barge-in is the agent continuing to speak after the user starts.** The buffer must be cleared instantly — even 200ms of residual playback feels unnatural.

### ElevenLabs Multi-Context for Barge-In
```json
// Close current context (stops current synthesis)
{"type": "closeContextClient", "context_id": "conv_turn_3"}

// Immediately start new context (no WebSocket reconnection needed)
{"text": "New response", "context_id": "conv_turn_4", "flush": true}
```

---

## 8. WebSocket Protocol Design {#protocol}

### Recommended Protocol for Your Engine

**Principles:**
- **Binary frames** for audio data (avoids ~33% Base64 overhead)
- **Text frames (JSON)** for control signals and metadata
- **Single persistent `wss://` connection** per session

### Client → Server Messages

```json
// 1. Session initialization
{"type": "session.init", "config": {
  "sample_rate": 16000,
  "encoding": "pcm16",
  "channels": 1,
  "tts_voice": "voice_id",
  "tts_model": "flash_v2.5",
  "vad_threshold": 0.5,
  "min_silence_ms": 300
}}

// 2. Audio data → sent as BINARY WebSocket frame
// Raw PCM16 bytes, 20ms chunks (640 bytes for 16kHz mono)

// 3. Control events
{"type": "input.speech_start"}     // Client VAD detected speech
{"type": "input.speech_end"}       // Client VAD detected silence
{"type": "control.interrupt"}      // User barge-in
{"type": "control.cancel"}         // Cancel current response
```

### Server → Client Messages

```json
// 1. Session confirmation
{"type": "session.created", "session_id": "abc123"}

// 2. STT results (for UI display)
{"type": "stt.partial", "text": "Hello how are", "is_final": false}
{"type": "stt.final", "text": "Hello how are you?", "is_final": true}

// 3. LLM tokens (for text display, optional)
{"type": "llm.token", "text": "I'm"}
{"type": "llm.done"}

// 4. TTS audio → sent as BINARY WebSocket frame
// Raw PCM audio bytes

// 5. Control events
{"type": "tts.start"}
{"type": "tts.done"}
{"type": "control.clear_buffer"}   // On barge-in: client must stop playback
{"type": "error", "code": "...", "message": "..."}
```

### Audio Frame Protocol

Use binary WebSocket frames for all audio. To distinguish input vs output audio (both binary):
- **Direction-based:** All binary from client = input audio, all binary from server = output audio
- **Header-based (alternative):** Prepend 1-byte type header: `0x01` = input, `0x02` = output

### Connection Lifecycle

```
1. Client connects to wss://your-server/voice
2. Client sends session.init with config
3. Server responds with session.created
4. Client streams binary audio (microphone PCM16, 20ms chunks)
5. Server streams:
   - stt.partial / stt.final (text results)
   - llm.token (response text, optional)
   - Binary audio (TTS output)
   - tts.start / tts.done (lifecycle)
6. On barge-in:
   - Client sends control.interrupt
   - Server cancels LLM + TTS, sends control.clear_buffer
   - Client clears playback buffer
7. Ping/pong every 30s for keepalive
```

---

## 9. Critical Architectural Decisions {#decisions}

### Decision 1: Audio Format

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **PCM16** | ✅ **Recommended** | Zero decoding overhead, no padding issues, gapless by nature |
| **Opus** | ✅ Good alternative | Efficient compression, no MP3 padding, but needs decode step |
| **MP3** | ❌ **Avoid** | Encoder delay/padding makes gapless playback extremely difficult |

### Decision 2: Client-Side Playback

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **AudioWorklet + SharedArrayBuffer** | ✅ **Best for production** | Lowest latency, zero GC pauses, dedicated audio thread |
| **AudioBufferSourceNode scheduling** | ✅ Good for MVP | Simpler to implement, works well with PCM, your guide's approach |
| **MediaSource Extensions** | ❌ Not for real-time | Too much browser buffering latency |
| **HTML Audio element** | ❌ Never | No scheduling control whatsoever |

> [!TIP]
> **Start with AudioBufferSourceNode + PCM** for an MVP, then upgrade to AudioWorklet for production. The `nextStartTime` pattern works fine if you're using PCM format.

### Decision 3: STT Provider

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **Deepgram Nova-3** | ✅ **Best for production** | 200-300ms streaming, `is_final` flag, reliable |
| **faster-whisper + Silero VAD** | ✅ Good self-hosted | Whisper accuracy, needs GPU, more complex |
| **OpenAI Realtime API** | ✅ If you want end-to-end | Eliminates pipeline coordination, but vendor lock-in |
| **Vosk** | ⚠️ Edge/embedded only | CPU-friendly but lower accuracy |

### Decision 4: TTS Provider

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **ElevenLabs Flash v2.5** | ✅ **Best quality/speed balance** | ~75ms inference, excellent voices, WebSocket streaming |
| **Deepgram Aura** | ✅ Lowest latency | ~90ms TTFB, good quality |
| **OpenAI Realtime** | ✅ Integrated | No separate TTS call needed |

### Decision 5: Pipeline Framework

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| **Custom Python asyncio** | ✅ **Full control** | Maximum flexibility, matches your guide's approach |
| **Pipecat** | ✅ Production alternative | Open-source, provider-agnostic, frame-based pipeline |
| **LiveKit Agents** | ✅ If you need WebRTC infra | Production-grade, multi-user, SIP/telephony |

### Decision 6: Sentence vs. Token Streaming to TTS

| Strategy | Latency Added | Prosody Quality | Recommendation |
|----------|--------------|-----------------|----------------|
| Token-by-token | 0ms | ❌ Robotic | ❌ Don't use |
| Clause-level | ~200-400ms | ✅ Good | ✅ For speed-critical apps |
| Sentence-level | ~400-800ms | ✅✅ Natural | ✅ **Default choice** |
| Full paragraph | 1-3s | ✅✅✅ Perfect | ❌ Too slow for conversation |

---

## 10. Recommended Architecture {#recommendation}

Based on all research, here is the recommended architecture for your real-time voice chatbot engine:

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Microphone ──► VAD (Silero-wasm) ──► PCM16 chunks ──► WebSocket  │
│                                                            │         │
│   Speaker ◄── AudioWorklet ◄── Ring Buffer ◄── WebSocket  │         │
│                                (SharedArrayBuffer)         │         │
│                                                            │         │
│   UI ◄── JSON messages (stt.partial, llm.token, etc.)     │         │
│                                                            │         │
└────────────────────────────────────────────────────────────│─────────┘
                                                             │
                                            WebSocket (wss://)
                                             Binary + JSON
                                                             │
┌────────────────────────────────────────────────────────────│─────────┐
│                     SERVER (Python/FastAPI)                 │         │
├────────────────────────────────────────────────────────────│─────────┤
│                                                            │         │
│   WebSocket Handler ◄─────────────────────────────────────┘         │
│        │                                                             │
│        ├──► STT Task (asyncio)                                      │
│        │      │  Audio chunks ──► Deepgram WebSocket                │
│        │      │  ◄── Partial + Final transcripts                    │
│        │      │                                                      │
│        ├──► LLM→TTS Bridge Task (asyncio)                           │
│        │      │  Final transcript ──► LLM (streaming)               │
│        │      │  LLM tokens ──► Sentence Buffer                    │
│        │      │  Complete sentence ──► ElevenLabs WS (flush: true)  │
│        │      │                                                      │
│        ├──► TTS→Client Task (asyncio)                               │
│        │      │  ElevenLabs audio chunks ──► Client WS (binary)     │
│        │      │                                                      │
│        └──► Interrupt Handler                                       │
│               │  On barge-in: cancel LLM + close ElevenLabs context │
│               │  Send control.clear_buffer to client                │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Server framework** | Python + FastAPI + WebSocket | async-native, clean, fast |
| **STT** | Deepgram Nova-3 (streaming WebSocket) | Fastest, reliable, `is_final` |
| **VAD (server)** | Silero VAD | <1ms, robust to noise |
| **VAD (client)** | Silero VAD (WASM/ONNX) | For barge-in detection |
| **LLM** | Any streaming model (OpenAI, Claude, etc.) | Optimize for TTFT |
| **TTS** | ElevenLabs Flash v2.5 (WebSocket) | Best quality/speed, sentence flush |
| **Audio format** | PCM16 @ 24kHz | Zero decode overhead, gapless |
| **Client transport** | WebSocket (binary + JSON) | Simple, effective |
| **Client playback (MVP)** | AudioBufferSourceNode + nextStartTime | Simpler, proven pattern |
| **Client playback (Prod)** | AudioWorklet + SharedArrayBuffer | Lowest latency, glitch-free |
| **Client recording** | getUserMedia + AudioWorklet | Direct PCM access |

### Performance Targets

| Metric | Target | Stretch Goal |
|--------|--------|-------------|
| **VAD → Final STT** | <400ms | <250ms |
| **LLM TTFT** | <300ms | <150ms |
| **TTS TTFA** | <300ms | <150ms |
| **End-to-end (user stops → hears response)** | <800ms | <500ms |
| **Audio gap duration** | 0ms | 0ms |
| **Barge-in response** | <200ms | <100ms |

### Existing Frameworks to Consider

| Framework | What It Does | When to Use |
|-----------|-------------|-------------|
| **Pipecat** | Python pipeline: frame-based STT→LLM→TTS orchestration | If you want pre-built pipeline management |
| **LiveKit Agents** | WebRTC infra + agent framework | If you need multi-user rooms, SIP/telephony |
| **RealtimeTTS** | Python: sentence chunking + TTS coordination | As a reference for chunking logic |
| **whisper_streaming** | Python: faster-whisper streaming wrapper | If self-hosting STT |

---

## Open Questions for Your Review

> [!IMPORTANT]
> **1. STT Choice:** Will you use a cloud STT (Deepgram recommended) or self-host (faster-whisper + Silero VAD)? This affects latency budget and infrastructure significantly.

> [!IMPORTANT]
> **2. TTS Provider:** ElevenLabs is recommended for quality, but Deepgram Aura has lower TTFB (~90ms). Which matters more — voice quality or raw speed?

> [!IMPORTANT]
> **3. Client Playback Strategy:** Start with AudioBufferSourceNode (simpler, matches your guide) or go directly to AudioWorklet (harder, but production-grade)? I recommend starting with the simpler approach.

> [!IMPORTANT]
> **4. Pipeline Framework:** Build custom with Python asyncio (full control) or use Pipecat (faster to prototype, provider-agnostic)? Both are viable.

> [!IMPORTANT]
> **5. Audio Format:** Your guide uses MP3 throughout, but research strongly suggests **PCM16 or Opus** for gapless streaming. Should we update the guide's approach to PCM?

> [!IMPORTANT]
> **6. Scope:** Is this a web-only application, or do you need mobile/desktop support (Electron, React Native)? This affects the AudioWorklet/WebRTC decisions.
