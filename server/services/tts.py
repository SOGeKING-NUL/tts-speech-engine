"""
Sarvam AI Text-to-Speech — WebSocket streaming.

Endpoint : wss://api.sarvam.ai/text-to-speech/ws
Auth     : "api-subscription-key" header
Protocol (JSON messages over one persistent WebSocket):
  → {"type": "config", "data": {language, speaker, codec}}   sent once, first
  → {"type": "text",   "data": {"text": "…"}}                one per sentence
  → {"type": "flush"}                                        after each sentence
  ← {"type": "audio",  "data": {"audio": "<base64 PCM16>"}}  audio chunks
  ← {"type": "event",  "data": {"event_type": "final"}}      synthesis done

We request the "linear16" codec, so decoded audio is raw PCM-16 the client
can feed straight into the Web Audio API — no container parsing needed.
"""

import asyncio
import base64
import json
import logging
import time
from typing import AsyncGenerator
from urllib.parse import urlencode

import websockets

from config import settings

logger = logging.getLogger(__name__)


class SarvamTTS:
    """Stream text → speech via the Sarvam Bulbul WebSocket API."""

    WS_BASE = "wss://api.sarvam.ai/text-to-speech/ws"

    def __init__(self) -> None:
        self.ws: websockets.ClientConnection | None = None
        # Guards connect/close so concurrent callers don't open two sockets.
        self.lock = asyncio.Lock()

    def _is_connected(self) -> bool:
        return self.ws is not None and self.ws.state.name == "OPEN"

    async def connect(self) -> None:
        """Open the persistent WebSocket and send the one-time config message."""
        if self._is_connected():
            return

        async with self.lock:
            if self._is_connected():  # another task may have connected while we waited
                return

            params = urlencode({
                "model": settings.SARVAM_TTS_MODEL,
                "send_completion_event": "true",  # ask for the "final" event
            })
            self.ws = await websockets.connect(
                f"{self.WS_BASE}?{params}",
                additional_headers={"api-subscription-key": settings.SARVAM_API_KEY},
                ping_interval=30,
                ping_timeout=10,
            )

            # Config must be the first message on the socket.
            await self.ws.send(json.dumps({
                "type": "config",
                "data": {
                    "target_language_code": settings.SARVAM_TTS_LANGUAGE,
                    "speaker": settings.SARVAM_TTS_VOICE,
                    "output_audio_codec": "linear16",  # raw PCM-16, no container
                    # Must match the rate the client plays at (sent in tts.start),
                    # otherwise audio is pitch-shifted and stutters. Sarvam's
                    # default is NOT 24000, so never omit this.
                    "speech_sample_rate": settings.SARVAM_TTS_SAMPLE_RATE,
                },
            }))
            logger.info("TTS WS connected  voice=%s  model=%s",
                        settings.SARVAM_TTS_VOICE, settings.SARVAM_TTS_MODEL)

    async def close(self) -> None:
        """Close the WebSocket (used on barge-in to discard queued audio)."""
        async with self.lock:
            if self.ws is not None:
                if self.ws.state.name != "CLOSED":
                    await self.ws.close()
                self.ws = None
                logger.info("TTS WS closed")

    async def stream_tts(
        self, text_chunks: AsyncGenerator[str, None]
    ) -> AsyncGenerator[bytes, None]:
        """
        Feed sentences into the TTS socket and yield raw PCM-16 audio bytes.

        Sending and receiving run concurrently: a background task pushes
        each sentence (+ flush) as it arrives from the LLM, while this
        generator reads audio messages and yields them to the caller.
        """
        await self.connect()
        ws = self.ws
        if not ws:
            raise RuntimeError("TTS WebSocket is not connected.")

        text_done = asyncio.Event()  # set when all sentences have been sent
        # perf_counter when the first sentence's flush was sent — used to
        # measure Sarvam's round-trip latency (flush → first audio bytes).
        t_first_flush: float | None = None
        first_audio_logged = False

        async def _send_text() -> None:
            nonlocal t_first_flush
            try:
                async for sentence in text_chunks:
                    sentence = sentence.strip()
                    if not sentence:
                        continue
                    await ws.send(json.dumps({"type": "text", "data": {"text": sentence}}))
                    # flush tells Sarvam to synthesize now instead of buffering
                    await ws.send(json.dumps({"type": "flush"}))
                    if t_first_flush is None:
                        t_first_flush = time.perf_counter()
                        logger.info("TTS first sentence sent: %.60s", sentence)
            except Exception as exc:  # noqa: BLE001
                logger.error("TTS send error: %s", exc)
            finally:
                text_done.set()

        send_task = asyncio.create_task(_send_text())

        try:
            while True:
                try:
                    message = await asyncio.wait_for(ws.recv(), timeout=15.0)
                except asyncio.TimeoutError:
                    if text_done.is_set():
                        # All text sent and nothing arriving — assume done.
                        logger.warning("TTS timed out waiting for audio")
                        break
                    continue  # LLM is still producing sentences, keep waiting

                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "audio":
                    b64_audio = data.get("data", {}).get("audio", "")
                    if b64_audio:
                        if not first_audio_logged and t_first_flush is not None:
                            first_audio_logged = True
                            rtt = (time.perf_counter() - t_first_flush) * 1000
                            logger.info("TTS Sarvam round-trip (flush → first audio): %.0f ms", rtt)
                        yield base64.b64decode(b64_audio)

                elif msg_type == "event":
                    if data.get("data", {}).get("event_type") == "final":
                        logger.info("TTS synthesis complete")
                        break

                elif msg_type == "error":
                    logger.error("TTS error: %s", data)
                    break

        except websockets.exceptions.ConnectionClosed as exc:
            logger.warning("TTS WS closed: %s", exc)
        finally:
            send_task.cancel()
            try:
                await send_task
            except asyncio.CancelledError:
                pass
