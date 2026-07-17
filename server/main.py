"""
TTS Speech Engine — FastAPI server.

One WebSocket endpoint (/ws/voice) runs the whole voice loop:

    client mic audio ──▶ Deepgram STT ──▶ Gemini LLM ──▶ Sarvam TTS ──▶ client speaker

How a turn works:
  1. The client streams raw PCM-16 audio continuously; we forward it to Deepgram.
  2. Deepgram sends back interim/final transcripts, and an "utterance end"
     event when the speaker goes silent (server-side end-of-turn detection).
  3. On utterance end we stream the transcript through the LLM, cut the LLM
     output into sentences, and feed each sentence to TTS as soon as it is
     complete — so speech starts before the LLM has finished writing.
  4. Barge-in: the client's local Silero VAD detects the user speaking over
     the AI and sends {"type": "interrupt"}; we cancel the running pipeline.
"""

import asyncio
import json
import logging
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from services.stt_deepgram import DeepgramStreamingSTT
from services.tts import SarvamTTS
from services.llm import OpenRouterLLM

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("engine")

app = FastAPI(title="TTS Speech Engine", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.CORS_ORIGINS.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The LLM client is stateless, so one instance is shared by all connections.
llm_service = OpenRouterLLM()

# Characters that end a sentence (includes Devanagari danda "।").
_SENTENCE_ENDERS = frozenset(".!?।;:")


class TurnTimer:
    """
    Records latency marks for one user turn and logs a breakdown.

    t0 is the moment the pipeline starts (Deepgram's utterance_end). Every
    mark is stored as milliseconds since t0; `mark()` is idempotent so the
    first-token / first-audio marks can be called freely and only the first
    (the one we care about) is kept.
    """

    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.marks: dict[str, float] = {}

    def mark(self, name: str) -> None:
        if name not in self.marks:
            ms = (time.perf_counter() - self.t0) * 1000
            self.marks[name] = ms
            logger.info("[timing] %-20s %7.0f ms", name, ms)

    def summary(self, stt_ms: float | None) -> None:
        """Log a per-stage breakdown once the turn is fully done."""
        m = self.marks
        lines = ["", "-------- turn latency breakdown --------"]
        if stt_ms is not None:
            lines.append(f"  STT   speech -> end-of-turn     {stt_ms:7.0f} ms")
        if "llm_first_token" in m:
            lines.append(f"  LLM   -> first token            {m['llm_first_token']:7.0f} ms")
        if "llm_first_sentence" in m:
            lines.append(f"  LLM   -> first sentence         {m['llm_first_sentence']:7.0f} ms")
        if "tts_first_audio" in m:
            # TTS round-trip: time from handing TTS the first sentence to the
            # first audio bytes coming back. This is the "after LLM" latency.
            ttfb = m["tts_first_audio"] - m.get("llm_first_sentence", 0.0)
            lines.append(f"  TTS   first sentence -> audio   {ttfb:7.0f} ms")
            lines.append(f"  >>    utterance -> first audio  {m['tts_first_audio']:7.0f} ms")
            if stt_ms is not None:
                total = stt_ms + m["tts_first_audio"]
                lines.append(f"  **    speech -> first audio out {total:7.0f} ms  <- perceived latency")
        if "llm_done" in m:
            lines.append(f"  LLM   total (-> done)           {m['llm_done']:7.0f} ms")
        if "tts_done" in m:
            lines.append(f"  TTS   total (-> done)           {m['tts_done']:7.0f} ms")
        lines.append("----------------------------------------")
        logger.info("\n".join(lines))


async def _send_json(ws: WebSocket, data: dict) -> None:
    """Send a JSON frame; ignore errors if the client already disconnected."""
    try:
        await ws.send_json(data)
    except Exception:  # noqa: BLE001
        pass


async def run_voice_pipeline(
    ws: WebSocket,
    transcript: str,
    conversation_history: list[dict],
    tts_service: SarvamTTS,
    timer: TurnTimer,
    stt_ms: float | None,
) -> None:
    """
    LLM → TTS cascade for one user turn.

    Two tasks run concurrently, connected by a queue of sentences:
      producer: streams LLM tokens, groups them into sentences, puts them
                on the queue (None = no more sentences).
      consumer: pulls sentences off the queue, sends them to TTS, and
                streams the resulting PCM audio back to the client.

    This overlap is what makes the assistant start speaking while the LLM
    is still generating the rest of its answer.

    `timer` is stamped at each stage so we can log where the latency goes;
    `stt_ms` is how long Deepgram took (speech → end-of-turn) for the summary.
    """
    await _send_json(ws, {"type": "processing", "stage": "llm"})

    sentence_queue: asyncio.Queue[str | None] = asyncio.Queue()
    full_response_parts: list[str] = []

    async def _llm_to_sentences() -> None:
        """Producer: LLM tokens → complete sentences → queue."""
        sentence_buf = ""
        try:
            async for token in llm_service.stream_response(transcript, conversation_history):
                timer.mark("llm_first_token")  # first token = LLM "thinking" time
                await _send_json(ws, {"type": "llm.token", "text": token})
                sentence_buf += token
                full_response_parts.append(token)

                # A sentence is ready once it ends in punctuation and isn't
                # trivially short (avoids sending "Dr." or "1." alone to TTS).
                stripped = sentence_buf.strip()
                if len(stripped) > 5 and stripped[-1] in _SENTENCE_ENDERS:
                    timer.mark("llm_first_sentence")  # first sentence handed to TTS
                    await sentence_queue.put(sentence_buf)
                    sentence_buf = ""

            if sentence_buf.strip():  # flush whatever is left
                timer.mark("llm_first_sentence")  # (no-op if already marked)
                await sentence_queue.put(sentence_buf)

        except Exception as exc:
            logger.error("LLM streaming error: %s", exc)
            await _send_json(ws, {"type": "error", "message": f"AI response failed: {exc}"})
        finally:
            timer.mark("llm_done")
            await sentence_queue.put(None)  # tell the consumer we're done

            full_text = "".join(full_response_parts)
            await _send_json(ws, {"type": "llm.done", "text": full_text})

            # Remember this turn so the LLM has context next time.
            if full_text:
                conversation_history.append({"role": "user", "content": transcript})
                conversation_history.append({"role": "assistant", "content": full_text})

    async def _tts_to_client() -> None:
        """Consumer: sentences → TTS → binary audio frames to the client."""

        async def _sentence_gen():
            while True:
                sentence = await sentence_queue.get()
                if sentence is None:
                    break
                yield sentence

        first_audio = True
        try:
            async for audio_chunk in tts_service.stream_tts(_sentence_gen()):
                if first_audio:
                    timer.mark("tts_first_audio")  # first playable audio bytes
                    # Tell the client audio is coming and at what sample rate.
                    await _send_json(ws, {
                        "type": "tts.start",
                        "sampleRate": settings.SARVAM_TTS_SAMPLE_RATE,
                    })
                    first_audio = False
                await ws.send_bytes(audio_chunk)

        except Exception as exc:
            logger.error("TTS streaming error: %s", exc, exc_info=True)
            await _send_json(ws, {"type": "error", "message": f"Speech synthesis failed: {exc}"})
        finally:
            timer.mark("tts_done")
            await _send_json(ws, {"type": "tts.done"})

    await asyncio.gather(_llm_to_sentences(), _tts_to_client())
    timer.summary(stt_ms)


@app.websocket("/ws/voice")
async def voice_websocket(ws: WebSocket) -> None:
    """Handle one full-duplex voice conversation session."""
    await ws.accept()
    logger.info("Client connected")

    # Per-session state. History lives in memory and dies with the connection.
    conversation_history: list[dict] = []
    pipeline_task: asyncio.Task | None = None
    # perf_counter when the client's VAD first heard speech this turn — used
    # to measure how long Deepgram takes to reach end-of-turn.
    t_speech_start: float | None = None

    # Each session gets its own upstream connections.
    session_tts = SarvamTTS()
    session_stt = DeepgramStreamingSTT()

    async def _cancel_pipeline(reconnect_tts: bool = True) -> None:
        """Stop a running LLM→TTS pipeline and drop its queued TTS audio."""
        nonlocal pipeline_task
        if pipeline_task and not pipeline_task.done():
            pipeline_task.cancel()
            try:
                await pipeline_task
            except (asyncio.CancelledError, Exception):
                pass
            # Reconnect TTS so audio from the cancelled turn is discarded.
            # (Skipped during final cleanup — the socket is about to close.)
            await session_tts.close()
            if reconnect_tts:
                await session_tts.connect()

    # ── Deepgram callbacks (closures over the session state above) ───────

    async def on_interim(text: str) -> None:
        """Partial transcript — shown live in the UI while the user speaks."""
        await _send_json(ws, {"type": "stt.interim", "text": text})

    async def on_final(text: str) -> None:
        """A finalized transcript segment (the utterance may still continue)."""
        await _send_json(ws, {"type": "stt.final", "text": text})

    async def on_utterance_end(transcript: str) -> None:
        """Deepgram decided the user finished speaking — run the pipeline."""
        nonlocal pipeline_task, t_speech_start
        logger.info("Utterance complete → %s", transcript)
        await _send_json(ws, {"type": "stt.result", "text": transcript})

        # How long Deepgram took from speech onset to end-of-turn (includes
        # the user's speaking time plus the endpointing silence window).
        stt_ms = (time.perf_counter() - t_speech_start) * 1000 if t_speech_start else None
        t_speech_start = None
        timer = TurnTimer()  # t0 = now (end-of-turn); pipeline latency starts here

        await _cancel_pipeline()  # in case a previous turn is still speaking
        pipeline_task = asyncio.create_task(
            run_voice_pipeline(ws, transcript, conversation_history, session_tts, timer, stt_ms)
        )

    async def _connect_stt() -> None:
        await session_stt.connect(
            on_interim=on_interim,
            on_final=on_final,
            on_utterance_end=on_utterance_end,
        )

    # ── Main receive loop ─────────────────────────────────────────────────
    try:
        # Both upstream sockets are opened eagerly: STT because audio streams
        # continuously, TTS so the first response has no connection delay.
        await session_tts.connect()
        await _connect_stt()
        logger.info("STT & TTS ready — waiting for speech")

        while True:
            message = await ws.receive()

            if message["type"] == "websocket.disconnect":
                break

            # JSON control messages from the client
            if "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type", "")

                if msg_type == "speech.start":
                    # Client VAD heard speech — start the transcript fresh and
                    # start the clock for this turn's end-to-end latency.
                    logger.info("Speech started (VAD)")
                    t_speech_start = time.perf_counter()
                    session_stt.reset_transcript()

                elif msg_type == "interrupt":
                    # User spoke over the AI (barge-in): kill the pipeline and
                    # reconnect Deepgram so stale partial transcripts are gone.
                    logger.info("Interrupt (barge-in)")
                    await _cancel_pipeline()
                    await session_stt.close()
                    await _connect_stt()
                    await _send_json(ws, {"type": "interrupted"})

                elif msg_type == "ping":
                    await _send_json(ws, {"type": "pong"})

            # Binary frames are raw PCM-16 mic audio → forward to Deepgram.
            elif "bytes" in message:
                await session_stt.send_audio(message["bytes"])

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
    finally:
        await _cancel_pipeline(reconnect_tts=False)
        await asyncio.gather(session_stt.close(), session_tts.close())
        logger.info("Connection cleaned up")


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "tts-speech-engine"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=True)
