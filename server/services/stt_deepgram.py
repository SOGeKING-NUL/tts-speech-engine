"""
Deepgram streaming STT — WebSocket real-time transcription.

We stream raw PCM-16 audio in; Deepgram streams JSON results back:
  - "Results" messages carry a transcript, either interim (still changing
    while the user speaks) or final (that segment won't change anymore).
  - "UtteranceEnd" fires after enough silence — the user is done talking.

Because Deepgram decides end-of-turn on the server, the client just streams
audio continuously and never has to guess when the user stopped speaking.
"""

import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets

from config import settings

logger = logging.getLogger("services.stt")

# Callback type: async function receiving a transcript string.
TranscriptCallback = Callable[[str], Awaitable[None]]


class DeepgramStreamingSTT:
    """Stream audio → text via the Deepgram Nova-3 WebSocket API."""

    WS_URL = "wss://api.deepgram.com/v1/listen"

    def __init__(self) -> None:
        self.ws: Optional[websockets.ClientConnection] = None
        self._receive_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        # Final segments pile up here until UtteranceEnd flushes them.
        self._transcript = ""
        # Falls back to whatever we've seen (final + partial) if UtteranceEnd
        # fires before the last segment ever gets marked is_final.
        self._last_seen = ""
        self._on_interim: Optional[TranscriptCallback] = None
        self._on_final: Optional[TranscriptCallback] = None
        self._on_utterance_end: Optional[TranscriptCallback] = None

    async def connect(
        self,
        *,
        on_interim: Optional[TranscriptCallback] = None,
        on_final: Optional[TranscriptCallback] = None,
        on_utterance_end: Optional[TranscriptCallback] = None,
    ) -> None:
        """Open the streaming connection and start the background receiver."""
        if self.ws is not None:
            await self.close()

        params = urlencode({
            "model": settings.DEEPGRAM_MODEL,
            "language": settings.DEEPGRAM_LANGUAGE,
            "encoding": "linear16",      # raw PCM-16, matches client mic capture
            "sample_rate": "16000",
            "channels": "1",
            "endpointing": str(settings.DEEPGRAM_ENDPOINTING_MS),
            "utterance_end_ms": str(settings.DEEPGRAM_UTTERANCE_END_MS),
            "interim_results": "true",   # send partial transcripts for live UI
            "vad_events": "true",
            "smart_format": "true",
            "punctuate": "true",
        })
        self.ws = await websockets.connect(
            f"{self.WS_URL}?{params}",
            additional_headers={"Authorization": f"Token {settings.DEEPGRAM_API_KEY}"},
            ping_interval=20,
            ping_timeout=10,
        )
        self._on_interim = on_interim
        self._on_final = on_final
        self._on_utterance_end = on_utterance_end
        self._transcript = ""

        self._receive_task = asyncio.create_task(self._receive_loop())
        # Deepgram closes any connection that receives no audio for ~10s.
        # The client stops streaming while the AI thinks/speaks, so we must
        # send KeepAlive messages or the socket dies mid-conversation.
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        logger.info("Deepgram connected  model=%s  lang=%s",
                    settings.DEEPGRAM_MODEL, settings.DEEPGRAM_LANGUAGE)

    async def _keepalive_loop(self) -> None:
        """Ping Deepgram every 5s so silence doesn't kill the connection."""
        try:
            while self.ws is not None:
                await asyncio.sleep(5)
                await self.ws.send(json.dumps({"type": "KeepAlive"}))
        except (asyncio.CancelledError, Exception):
            pass  # socket closed — the receive loop logs it

    async def close(self) -> None:
        """Stop the background tasks and close the WebSocket."""
        for task in (self._receive_task, self._keepalive_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._receive_task = None
        self._keepalive_task = None

        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None

        self._transcript = ""
        self._last_seen = ""
        logger.info("Deepgram STT closed")

    def reset_transcript(self) -> None:
        """Drop accumulated text (called when a new utterance starts)."""
        self._transcript = ""
        self._last_seen = ""

    async def send_audio(self, pcm_chunk: bytes) -> None:
        """Forward a raw PCM-16 chunk to Deepgram."""
        if self.ws is not None:
            try:
                await self.ws.send(pcm_chunk)
                self._drop_logged = False
            except Exception:
                # Connection closed — drop the chunk, but say so once so a
                # dead STT socket doesn't fail silently.
                if not getattr(self, "_drop_logged", False):
                    self._drop_logged = True
                    logger.warning("Dropping audio: Deepgram socket is closed")

    async def _receive_loop(self) -> None:
        """Background task: parse Deepgram messages and fire the callbacks."""
        try:
            async for msg in self.ws:
                data = json.loads(msg)
                msg_type = data.get("type")

                if msg_type == "Results":
                    alts = data.get("channel", {}).get("alternatives", [])
                    text = alts[0].get("transcript", "") if alts else ""
                    if not text:
                        continue

                    if data.get("is_final"):
                        # This segment is locked in — append it.
                        self._transcript += text + " "
                        self._last_seen = self._transcript
                        if self._on_final:
                            await self._on_final(self._transcript.strip())
                    else:
                        # Still changing — show accumulated + live part in UI.
                        self._last_seen = (self._transcript + text).strip()
                        if self._on_interim:
                            await self._on_interim(self._last_seen)

                elif msg_type == "UtteranceEnd":
                    # Silence threshold reached — hand off the full utterance.
                    # Prefer locked-in final text, but fall back to the last
                    # interim we saw: Deepgram can fire UtteranceEnd before the
                    # trailing segment is ever marked is_final, and without this
                    # fallback that speech is silently dropped (no log, no
                    # pipeline run — looks like the app "does nothing").
                    transcript = self._transcript.strip() or self._last_seen.strip()
                    logger.info(
                        "STT utterance_end → %r  (final=%r interim_fallback=%r)",
                        transcript, self._transcript.strip(), self._last_seen.strip(),
                    )
                    self._transcript = ""
                    self._last_seen = ""
                    if transcript and self._on_utterance_end:
                        await self._on_utterance_end(transcript)

        except websockets.exceptions.ConnectionClosed:
            logger.warning("Deepgram WebSocket closed")
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("Deepgram receive error: %s", exc)
