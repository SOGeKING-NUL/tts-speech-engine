"""
TTS Speech Engine — FastAPI server.

Single WebSocket endpoint ``/ws/voice`` orchestrates:
    Client audio → STT → LLM (streaming) → TTS (streaming) → Client audio
"""

import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from services.stt import SarvamSTT
from services.tts import SarvamTTS
from services.llm import GeminiLLM

# ── Logging ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("engine")

# ── App & middleware ─────────────────────────────────────────────────────
app = FastAPI(title="TTS Speech Engine", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.CORS_ORIGINS.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Services ───────────────────────────────────────────────────────────────
stt_service = SarvamSTT()
llm_service = GeminiLLM()

# ── Sentence-boundary characters ────────────────────────────────────────
_SENTENCE_ENDERS = frozenset(".!?।;:")


# ═════════════════════════════════════════════════════════════════════════
#  Helper
# ═════════════════════════════════════════════════════════════════════════
async def _send_json(ws: WebSocket, data: dict) -> None:
    """Send a JSON text frame — silently ignores closed connections."""
    try:
        await ws.send_json(data)
    except Exception:  # noqa: BLE001
        pass


# ═════════════════════════════════════════════════════════════════════════
#  Voice pipeline
# ═════════════════════════════════════════════════════════════════════════
async def run_voice_pipeline(
    ws: WebSocket,
    audio_data: bytes,
    sample_rate: int,
    conversation_history: list[dict],
    tts_service: SarvamTTS,
) -> None:
    """
    Full STT → LLM → TTS cascade for one user turn.

    The function is designed to be run via ``asyncio.create_task`` so the
    WebSocket receive loop can still handle ``interrupt`` messages.
    """

    # ── Phase 1: Speech-to-Text ──────────────────────────────────────────
    await _send_json(ws, {"type": "processing", "stage": "stt"})

    try:
        transcript = await stt_service.transcribe(audio_data, sample_rate)
    except Exception as exc:
        await _send_json(ws, {"type": "error", "message": f"Speech recognition failed: {exc}"})
        return

    if not transcript or not transcript.strip():
        await _send_json(ws, {"type": "error", "message": "Could not understand the audio. Please try again."})
        return

    await _send_json(ws, {"type": "stt.result", "text": transcript})

    # ── Phase 2: LLM + TTS (concurrent) ─────────────────────────────────
    await _send_json(ws, {"type": "processing", "stage": "llm"})

    sentence_queue: asyncio.Queue[str | None] = asyncio.Queue()
    full_response_parts: list[str] = []

    # ── Task A: stream LLM → buffer sentences → push to queue ───────────
    async def _llm_to_sentences() -> None:
        sentence_buf = ""
        try:
            async for token in llm_service.stream_response(transcript, conversation_history):
                await _send_json(ws, {"type": "llm.token", "text": token})
                sentence_buf += token
                full_response_parts.append(token)

                stripped = sentence_buf.strip()
                if stripped and len(stripped) > 5 and stripped[-1] in _SENTENCE_ENDERS:
                    await sentence_queue.put(sentence_buf)
                    sentence_buf = ""

            # Flush leftover text
            if sentence_buf.strip():
                await sentence_queue.put(sentence_buf)

        except Exception as exc:
            logger.error("LLM streaming error: %s", exc)
            await _send_json(ws, {"type": "error", "message": f"AI response failed: {exc}"})
        finally:
            # Signal TTS that no more sentences are coming
            await sentence_queue.put(None)

            # Send full response to client
            full_text = "".join(full_response_parts)
            await _send_json(ws, {"type": "llm.done", "text": full_text})

            # Update conversation history (in-memory, per session)
            if full_text:
                conversation_history.append({"role": "user", "parts": [transcript]})
                conversation_history.append({"role": "model", "parts": [full_text]})

    # ── Task B: read sentences → TTS → stream audio to client ───────────
    async def _tts_to_client() -> None:
        first_audio = True
        chunk_count = 0
        total_bytes = 0

        async def _sentence_gen():
            """Async generator that drains the sentence queue."""
            while True:
                sentence = await sentence_queue.get()
                if sentence is None:
                    logger.info("TTS sentence queue exhausted (None sentinel)")
                    break
                logger.info("TTS sentence dequeued: %.80s", sentence.strip())
                yield sentence

        try:
            async for audio_chunk in tts_service.stream_tts(_sentence_gen()):
                if first_audio:
                    logger.info("First TTS audio chunk received (%d bytes)", len(audio_chunk))
                    await _send_json(ws, {
                        "type": "tts.start",
                        "sampleRate": settings.SARVAM_TTS_SAMPLE_RATE,
                    })
                    first_audio = False
                chunk_count += 1
                total_bytes += len(audio_chunk)
                await ws.send_bytes(audio_chunk)

            logger.info("TTS streaming complete: %d chunks, %d bytes total", chunk_count, total_bytes)

        except Exception as exc:
            logger.error("TTS streaming error: %s", exc, exc_info=True)
            await _send_json(ws, {"type": "error", "message": f"Speech synthesis failed: {exc}"})
        finally:
            if chunk_count == 0:
                logger.warning("No audio chunks were produced by TTS")
            await _send_json(ws, {"type": "tts.done"})

    # ── Run both tasks concurrently ──────────────────────────────────────
    await asyncio.gather(_llm_to_sentences(), _tts_to_client())


# ═════════════════════════════════════════════════════════════════════════
#  WebSocket endpoint
# ═════════════════════════════════════════════════════════════════════════
@app.websocket("/ws/voice")
async def voice_websocket(ws: WebSocket) -> None:
    """Handle a full-duplex voice conversation session."""
    await ws.accept()
    logger.info("Client connected")

    conversation_history: list[dict] = []
    audio_buffer = bytearray()
    recording_sample_rate = 48000
    is_recording = False
    pipeline_task: asyncio.Task | None = None
    session_tts = SarvamTTS()

    try:
        while True:
            message = await ws.receive()

            # ── Connection closed ────────────────────────────────────
            if message["type"] == "websocket.disconnect":
                break

            # ── JSON control messages ────────────────────────────────
            if   "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type", "")

                if msg_type == "audio.start":
                    # KICKOFF TTS CONNECT
                    asyncio.create_task(session_tts.connect())
                    
                    audio_buffer = bytearray()
                    recording_sample_rate = data.get("sampleRate", 48000)
                    is_recording = True
                    logger.info("Recording started  rate=%d", recording_sample_rate)

                elif msg_type == "audio.end":
                    is_recording = False
                    logger.info("Recording ended  bytes=%d", len(audio_buffer))

                    if len(audio_buffer) > 0:
                        # Cancel any running pipeline
                        if pipeline_task and not pipeline_task.done():
                            pipeline_task.cancel()
                            try:
                                await pipeline_task
                            except (asyncio.CancelledError, Exception):
                                pass

                        audio_bytes = bytes(audio_buffer)
                        pipeline_task = asyncio.create_task(
                            run_voice_pipeline(
                                ws, audio_bytes, recording_sample_rate, conversation_history, session_tts
                            )
                        )
                    else:
                        await _send_json(ws, {"type": "error", "message": "No audio received"})

                elif msg_type == "interrupt":
                    logger.info("Interrupt requested")
                    if pipeline_task and not pipeline_task.done():
                        pipeline_task.cancel()
                        try:
                            await pipeline_task
                        except (asyncio.CancelledError, Exception):
                            pass
                    await _send_json(ws, {"type": "interrupted"})

                elif msg_type == "clear_history":
                    conversation_history.clear()
                    await _send_json(ws, {"type": "history_cleared"})
                    logger.info("Conversation history cleared")

                elif msg_type == "ping":
                    await _send_json(ws, {"type": "pong"})

            # ── Binary audio frames ──────────────────────────────────
            elif "bytes" in message:
                if is_recording:
                    audio_buffer.extend(message["bytes"])

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
    finally:
        if pipeline_task and not pipeline_task.done():
            pipeline_task.cancel()
        await session_tts.close()
        logger.info("Connection cleaned up")


# ═════════════════════════════════════════════════════════════════════════
#  Health check
# ═════════════════════════════════════════════════════════════════════════
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "tts-speech-engine"}


# ═════════════════════════════════════════════════════════════════════════
#  Entrypoint
# ═════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True,
        log_level="info",
    )
