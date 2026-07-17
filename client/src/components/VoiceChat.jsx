/**
 * VoiceChat — Always-on voice conversation component.
 *
 * Hybrid VAD Architecture:
 *   Client Silero VAD (barge-in) → Continuous audio stream → Server
 *   Server: Deepgram STT (endpointing) → LLM → Sarvam TTS → Client audio
 *
 * No buttons needed — speech is detected automatically via client-side
 * Voice Activity Detection. Supports instant barge-in interruption.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Orb } from "./Orb";
import { VADManager } from "../utils/vadManager";
import { AudioPlayer } from "../utils/audioPlayer";

const STATUS_LABEL = {
  idle: "Starting…",
  listening: "Listening…",
  recording: "Hearing you…",
  processing: "Thinking…",
  speaking: "Speaking… (talk to interrupt)",
};

// Per-status orb palette (darker, lighter) — muted pastels à la ElevenLabs.
const ORB_COLORS = {
  idle:       ["#90A4AE", "#CFD8DC"],
  listening:  ["#A0B9D1", "#CADCFC"],
  recording:  ["#F0A8B8", "#FBD5DC"],
  processing: ["#B4A7E5", "#DDD6FE"],
  speaking:   ["#8FD3C7", "#C9F2E9"],
};

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/voice`;

// Pre-speech ring buffer: ~500ms of audio frames for capturing speech onset
const RING_BUFFER_FRAMES = 15; // 15 frames × 32ms = ~480ms

export default function VoiceChat({ onEnd }) {
  // ── State ──────────────────────────────────────────────────────────
  const [status, setStatus] = useState("idle"); // idle|listening|recording|processing|speaking
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // ── Refs (survive re-renders, avoid stale closures) ────────────────
  const wsRef = useRef(null);
  const vadRef = useRef(null);
  const playerRef = useRef(new AudioPlayer());
  const audioElRef = useRef(null); // Hidden <audio> element for AEC
  const currentResponseRef = useRef("");
  const llmDoneTextRef = useRef("");
  const statusRef = useRef("idle");

  // Orb reactivity: live mic loudness, fed to the Orb's volume callbacks.
  const micLevelRef = useRef(0);

  // ── Streaming control refs ─────────────────────────────────────────

  const audioRingBufferRef = useRef([]);      // ring buffer for pre-speech capture

  // Keep statusRef in sync
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ── Orb volume callbacks (polled every frame by the Orb's render loop) ─
  // Input = your mic RMS; output = live TTS playback RMS. Voice RMS is small,
  // so boost into the orb's 0..1 range. The orb smooths internally.
  const getInputVolume = useCallback(() => {
    micLevelRef.current *= 0.95; // decay so a silent mic relaxes the orb
    return Math.min(1, micLevelRef.current * 4);
  }, []);

  const getOutputVolume = useCallback(() => {
    if (statusRef.current === "processing") {
      // No audio while thinking — gentle synthetic pulse instead.
      return 0.35 + 0.2 * Math.sin(performance.now() / 250);
    }
    return Math.min(1, playerRef.current.getLevel() * 2.5);
  }, []);

  // ── Helper: convert Float32 frame → PCM16 and send via WebSocket ──
  const frameCountRef = useRef(0);
  
  const sendAudioFrame = useCallback((frame) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const pcm16 = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(pcm16.buffer);
    
    frameCountRef.current++;
    if (frameCountRef.current === 1) {
      console.log("Started sending audio frames to server!");
    } else if (frameCountRef.current % 100 === 0) {
      console.log(`Sent ${frameCountRef.current} audio frames so far...`);
    }
  }, []);

  // ── Resume listening (called after TTS finishes) ──────────────────
  const resumeListening = useCallback(() => {
    statusRef.current = "listening";
    setStatus("listening");

    setInterimTranscript("");
  }, []);

  // ── WebSocket message handler ──────────────────────────────────────
  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case "processing":
        setStatus("processing");
        statusRef.current = "processing";
        break;

      case "stt.interim":
        // Real-time partial transcript — show as ghost text
        setInterimTranscript(data.text);
        if (statusRef.current === "listening") {
          setStatus("recording");
          statusRef.current = "recording";
        }
        break;

      case "stt.final":
        // Finalized segment (but utterance may continue)
        setInterimTranscript(data.text);
        break;

      case "stt.result":
        // Deepgram utterance_end — final transcript, stop streaming
        setInterimTranscript("");
        statusRef.current = "processing";
        setStatus("processing");
        break;

      // ── LLM events ────────────────────────────────────────────
      case "llm.token":
        currentResponseRef.current += data.text;
        break;

      case "llm.done":
        llmDoneTextRef.current = data.text || "";
        break;

      // ── TTS events ────────────────────────────────────────────
      case "tts.start":
        setStatus("speaking");
        statusRef.current = "speaking";
        // Reset player for fresh playback session
        playerRef.current.stop();
        if (data.sampleRate) {
          playerRef.current.setSampleRate(data.sampleRate);
        }
        break;

      case "tts.done": {
        // Flush any remaining pre-buffered audio chunks
        playerRef.current.flushAndPlay();

        currentResponseRef.current = "";
        llmDoneTextRef.current = "";

        // Wait for audio to finish playing, then resume listening.
        // If a barge-in happens meanwhile, status leaves "speaking" and we
        // must NOT overwrite the new state back to "listening".
        const checkDone = () => {
          // "speaking" = normal flow; "processing" = TTS produced no audio.
          // Anything else (e.g. "recording" after a barge-in) owns the state.
          if (statusRef.current !== "speaking" && statusRef.current !== "processing") return;
          if (playerRef.current.isActive()) {
            setTimeout(checkDone, 200);
          } else {
            resumeListening();
          }
        };
        checkDone();
        break;
      }

      // ── Control events ────────────────────────────────────────
      case "error":
        console.error("Server error:", data.message);
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        resumeListening();
        break;

      case "interrupted":
        playerRef.current.stop();
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        setInterimTranscript("");
        // Don't resume listening — the barge-in speech is still active
        break;

      default:
        break;
    }
  }, [resumeListening]);

  // ── WebSocket connection (with auto-reconnect) ─────────────────────
  useEffect(() => {
    let ws;
    let reconnectTimer;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (closed) return;
        console.log("WS connected");
        setIsConnected(true);
        setStatus("listening");
        statusRef.current = "listening";
      };

      ws.onmessage = (event) => {
        if (closed) return;
        if (typeof event.data === "string") {
          try {
            handleMessage(JSON.parse(event.data));
          } catch (err) {
            console.error("Failed to parse WS message:", err);
          }
        } else if (event.data instanceof ArrayBuffer) {
          // Binary audio from TTS — queue for playback
          playerRef.current.playChunk(event.data);
        }
      };

      ws.onclose = () => {
        console.log("WS disconnected");
        if (closed) return; // Prevent state corruption from unmounted StrictMode components
        
        setIsConnected(false);
        setStatus("idle");
        statusRef.current = "idle";
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        if (closed) return;
        console.error("WS error:", err);
        ws.close();
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [handleMessage]);

  // ── VAD lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isConnected) return;

    const vad = new VADManager({
      onSpeechStart: () => {
        const currentStatus = statusRef.current;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // Guard: ignore if already recording or processing
        if (currentStatus === "recording" || currentStatus === "processing") return;

        // Barge-in: if AI is speaking, interrupt it first
        if (currentStatus === "speaking") {
          playerRef.current.stop();
          ws.send(JSON.stringify({ type: "interrupt" }));
          
          // Since we weren't streaming while speaking, flush the ring buffer
          // to Deepgram so it catches the words that triggered the barge-in
          for (const bufferedFrame of audioRingBufferRef.current) {
            sendAudioFrame(bufferedFrame);
          }
        }
        
        audioRingBufferRef.current = [];

        // Update ref synchronously BEFORE async React setState
        statusRef.current = "recording";
        
        // Let server know VAD thinks speech started (optional, since Deepgram handles it, but good for logs/UI)
        ws.send(JSON.stringify({ type: "speech.start" }));
        setStatus("recording");
        setInterimTranscript("");
      },

      onSpeechEnd: () => {
        // In the hybrid architecture, we do NOT stop streaming here.
        // Deepgram handles end-of-turn detection on the server.
        // Just update the UI indicator as a visual hint.
        if (statusRef.current === "recording") {
          // Keep streaming! Don't set isStreamingRef to false.
          // Deepgram needs to "hear" the silence to fire utterance_end.
        }
      },

      onFrameProcessed: (probs, frame) => {
        if (!frame) return;

        // Feed the orb: RMS of this mic frame (only while we're the speaker).
        const cs = statusRef.current;
        if (cs === "listening" || cs === "recording") {
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          micLevelRef.current = Math.sqrt(sum / frame.length);
        }

        // Keep a rolling buffer of ~500ms
        audioRingBufferRef.current.push(new Float32Array(frame));
        if (audioRingBufferRef.current.length > RING_BUFFER_FRAMES) {
          audioRingBufferRef.current.shift();
        }

        const currentStatus = statusRef.current;
        if (audioRingBufferRef.current.length === 1) {
           console.log("VAD is processing frames! Current status:", currentStatus);
        }
        
        // In the hybrid architecture, we stream microphone audio to Deepgram
        // as long as we are listening/recording. Deepgram handles VAD server-side.
        if (currentStatus === "listening" || currentStatus === "recording") {
          sendAudioFrame(frame);
        }
      },
    });

    vadRef.current = vad;

    // Start VAD (requests mic permission)
    vad.start().then(() => {
      console.log("VAD started — listening for speech");
      // Resume AudioContext (needs user gesture)
      playerRef.current.resume();

      // Bind AudioPlayer output to hidden <audio> element for AEC
      const stream = playerRef.current.getOutputStream();
      if (audioElRef.current && stream) {
        audioElRef.current.srcObject = stream;
      }
    }).catch((err) => {
      console.error("VAD start failed:", err);
      alert("Microphone permission is required for voice chat.");
    });

    return () => {
      vad.destroy();
      vadRef.current = null;
      audioRingBufferRef.current = [];
    };
  }, [isConnected, sendAudioFrame]);

  // ── End session ──────────────────────────────────────────────────────
  // Unmounting runs both effect cleanups below: the WS effect sets its local
  // `closed` flag (so it won't auto-reconnect) and closes the socket, and the
  // VAD effect destroys the VAD instance and releases the microphone.
  const handleEndSession = () => {
    playerRef.current.stop();
    onEnd?.();
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className={`voice-chat stage ${status}`}>
      <div className={`conn-dot ${isConnected ? "connected" : ""}`} title={isConnected ? "Connected" : "Disconnected"} />
      <button className="clear-btn" onClick={handleEndSession} title="End conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
      </button>

      {/* ── The reactive orb (ElevenLabs UI, volume-driven) ──────────── */}
      <div className="orb-wrap">
        <Orb
          colors={ORB_COLORS[status] || ORB_COLORS.idle}
          volumeMode="manual"
          getInputVolume={getInputVolume}
          getOutputVolume={getOutputVolume}
        />
      </div>

      <div className="stage-label">{STATUS_LABEL[status] || STATUS_LABEL.idle}</div>

      {/* Interim transcription — the only text on screen, as a caption bubble */}
      {interimTranscript && <div className="caption">{interimTranscript}</div>}

      {/* Hidden <audio> element for AEC (Acoustic Echo Cancellation). */}
      <audio ref={audioElRef} autoPlay style={{ display: "none" }} />
    </div>
  );
}
