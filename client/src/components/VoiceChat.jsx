/**
 * VoiceChat — Always-on voice conversation component.
 *
 * Wires together:
 *   VADManager (Silero)  →  WebSocket  →  AudioPlayer  →  UI
 *
 * No buttons needed — speech is detected automatically via client-side
 * Voice Activity Detection. Supports barge-in interruption.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import ChatMessage from "./ChatMessage";
import StatusIndicator from "./StatusIndicator";
import { VADManager } from "../utils/vadManager";
import { AudioPlayer } from "../utils/audioPlayer";

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/voice`;

export default function VoiceChat() {
  // ── State ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("idle"); // idle|listening|recording|processing|speaking
  const [currentResponse, setCurrentResponse] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // ── Refs (survive re-renders, avoid stale closures) ────────────────
  const wsRef = useRef(null);
  const vadRef = useRef(null);
  const playerRef = useRef(new AudioPlayer());
  const currentResponseRef = useRef("");
  const llmDoneTextRef = useRef("");
  const messagesEndRef = useRef(null);
  const statusRef = useRef("idle");

  // Keep statusRef in sync
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ── Auto-scroll ────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentResponse]);

  // ── Resume VAD listening (called after TTS finishes or interrupt) ──
  const resumeListening = useCallback(() => {
    setStatus("listening");
    vadRef.current?.resume();
  }, []);

  // ── WebSocket message handler ──────────────────────────────────────
  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case "processing":
        setStatus("processing");
        break;

      case "stt.result":
        setMessages((prev) => [...prev, { role: "user", text: data.text }]);
        break;

      case "llm.token":
        setCurrentResponse((prev) => {
          const next = prev + data.text;
          currentResponseRef.current = next;
          return next;
        });
        break;

      case "llm.done":
        llmDoneTextRef.current = data.text || "";
        break;

      case "tts.start":
        setStatus("speaking");
        // Reset player for fresh playback session
        playerRef.current.stop();
        if (data.sampleRate) {
          playerRef.current.setSampleRate(data.sampleRate);
        }
        
        // Resume VAD so barge-in can be detected while AI speaks
        vadRef.current?.resume();
        break;

      case "tts.done": {
        // Flush any remaining pre-buffered audio chunks
        playerRef.current.flushAndPlay();

        const text = llmDoneTextRef.current || currentResponseRef.current;
        if (text) {
          setMessages((prev) => [...prev, { role: "assistant", text }]);
        }
        setCurrentResponse("");
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";

        // Wait for audio to finish playing, then resume listening
        const checkDone = () => {
          if (playerRef.current.isActive()) {
            setTimeout(checkDone, 200);
          } else {
            resumeListening();
          }
        };
        checkDone();
        break;
      }

      case "error":
        console.error("Server error:", data.message);
        if (currentResponseRef.current) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: currentResponseRef.current, error: true },
          ]);
        }
        setCurrentResponse("");
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        resumeListening();
        break;

      case "interrupted":
        playerRef.current.stop();
        setCurrentResponse("");
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        // Don't resume listening here — the new speech that triggered
        // the barge-in is still being captured by VAD
        break;

      case "history_cleared":
        setMessages([]);
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
        console.log("WS connected");
        setIsConnected(true);
        setStatus("listening");
      };

      ws.onclose = () => {
        console.log("WS disconnected");
        setIsConnected(false);
        setStatus("idle");
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (e) => console.error("WS error", e);

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          playerRef.current.playChunk(event.data);
        } else {
          try {
            handleMessage(JSON.parse(event.data));
          } catch (err) {
            console.error("Bad JSON from server", err);
          }
        }
      };

      wsRef.current = ws;
    };

    connect();

    // Keepalive ping every 25 s
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingInterval);
      ws?.close();
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

        // Barge-in: if AI is speaking, interrupt it first
        if (currentStatus === "speaking") {
          playerRef.current.stop();
          ws.send(JSON.stringify({ type: "interrupt" }));
        }

        // Tell server speech has started
        ws.send(JSON.stringify({ type: "speech.start" }));
        setStatus("recording");
      },

      onSpeechEnd: (audio) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // Convert Float32 (16kHz mono from VAD) → PCM-16 bytes
        const pcm16 = new Int16Array(audio.length);
        for (let i = 0; i < audio.length; i++) {
          const s = Math.max(-1, Math.min(1, audio[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send the complete utterance audio as binary
        ws.send(pcm16.buffer);

        // Tell server speech has ended
        ws.send(JSON.stringify({ type: "speech.end" }));
        setStatus("processing");

        // Pause VAD while server processes (re-enabled on tts.start or tts.done)
        vadRef.current?.pause();
      },

      onFrameProcessed: (_probs) => {
        // Could be used for visual volume indicators in the future
      },
    });

    vadRef.current = vad;

    // Start VAD (requests mic permission)
    vad.start().then(() => {
      console.log("VAD started — listening for speech");
      // Resume AudioContext (needs user gesture — handled by the launch button in App.jsx)
      playerRef.current.resume();
    }).catch((err) => {
      console.error("VAD start failed:", err);
      alert("Microphone permission is required for voice chat.");
    });

    return () => {
      vad.destroy();
      vadRef.current = null;
    };
  }, [isConnected]);

  // ── Clear history handler ──────────────────────────────────────────
  const handleClearHistory = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear_history" }));
    }
    setMessages([]);
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="voice-chat">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-content">
          <h1 className="title">Voice AI</h1>
          <p className="subtitle">Speak naturally, get intelligent answers</p>
          <div className={`status-dot ${isConnected ? "connected" : ""}`} />
          {messages.length > 0 && (
            <button
              className="clear-btn"
              onClick={handleClearHistory}
              title="Clear conversation"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {/* ── Messages ───────────────────────────────────────────────── */}
      <main className="messages" id="messages-container">
        {messages.length === 0 && !currentResponse && (
          <div className="empty-state">
            <div className="empty-icon">🎙️</div>
            <p className="empty-text">Just start speaking — I'm listening</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}

        {currentResponse && (
          <ChatMessage
            message={{ role: "assistant", text: currentResponse }}
            streaming
          />
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* ── Status Indicator ─────────────────────────────────────────── */}
      <footer className="controls">
        <StatusIndicator status={status} />
      </footer>
    </div>
  );
}
