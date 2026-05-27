/**
 * VoiceChat — main component that wires together:
 *   WebSocket  ↔  AudioRecorder  ↔  AudioPlayer  ↔  UI
 */
import { useState, useEffect, useRef, useCallback } from "react";
import ChatMessage from "./ChatMessage";
import MicButton from "./MicButton";
import { AudioRecorder } from "../utils/audioRecorder";
import { AudioPlayer } from "../utils/audioPlayer";

const WS_URL =
  import.meta.env.VITE_WS_URL || "ws://localhost:8000/ws/voice";

export default function VoiceChat() {
  // ── State ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("ready"); // ready|recording|processing|speaking
  const [currentResponse, setCurrentResponse] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // ── Refs (survive re-renders, avoid stale closures) ────────────────
  const wsRef = useRef(null);
  const recorderRef = useRef(null);
  const playerRef = useRef(new AudioPlayer());
  const currentResponseRef = useRef("");
  const llmDoneTextRef = useRef("");
  const messagesEndRef = useRef(null);
  const statusRef = useRef("ready");

  // Keep statusRef in sync
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ── Auto-scroll ────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentResponse]);

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

        // Wait for audio to finish playing before setting ready
        const checkDone = () => {
          if (playerRef.current.isActive()) {
            setTimeout(checkDone, 200);
          } else {
            setStatus("ready");
          }
        };
        checkDone();
        break;
      }

      case "error":
        console.error("Server error:", data.message);
        // Save any partial response
        if (currentResponseRef.current) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: currentResponseRef.current, error: true },
          ]);
        }
        setCurrentResponse("");
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        setStatus("ready");
        break;

      case "interrupted":
        playerRef.current.stop();
        setCurrentResponse("");
        currentResponseRef.current = "";
        llmDoneTextRef.current = "";
        setStatus("ready");
        break;

      case "history_cleared":
        setMessages([]);
        break;

      default:
        break;
    }
  }, []);

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
      };

      ws.onclose = () => {
        console.log("WS disconnected");
        setIsConnected(false);
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

  // ── Mic button handler ─────────────────────────────────────────────
  const handleMicClick = async () => {
    const s = statusRef.current;

    if (s === "recording") {
      // ── Stop recording → send audio ──────────────────────────────
      const result = recorderRef.current?.stop();
      recorderRef.current = null;

      if (result?.data?.byteLength > 0) {
        setStatus("processing");
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "audio.start",
              sampleRate: result.sampleRate,
            }),
          );
          ws.send(result.data);
          ws.send(JSON.stringify({ type: "audio.end" }));
        }
      } else {
        setStatus("ready");
      }
    } else if (s === "ready") {
      // ── Start recording ──────────────────────────────────────────
      try {
        const recorder = new AudioRecorder();
        await recorder.start();
        recorderRef.current = recorder;
        setStatus("recording");
        await playerRef.current.resume(); // needs user gesture
      } catch (err) {
        console.error("Mic access failed:", err);
        alert("Microphone permission is required.");
      }
    } else if (s === "speaking") {
      // ── Interrupt ────────────────────────────────────────────────
      playerRef.current.stop();
      wsRef.current?.send(JSON.stringify({ type: "interrupt" }));
    }
  };

  // ── Clear history handler ──────────────────────────────────────────
  const handleClearHistory = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear_history" }));
    }
    setMessages([]);
  };

  // ── Render ─────────────────────────────────────────────────────────
  const statusText = {
    ready: "Tap to speak",
    recording: "Listening…",
    processing: "Thinking…",
    speaking: "Speaking… tap to interrupt",
  }[status];

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
            <p className="empty-text">Tap the microphone to start a conversation</p>
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

      {/* ── Controls ───────────────────────────────────────────────── */}
      <footer className="controls">
        <div className="status-text">{statusText}</div>
        <MicButton
          status={status}
          onClick={handleMicClick}
          disabled={!isConnected || status === "processing"}
        />
      </footer>
    </div>
  );
}
