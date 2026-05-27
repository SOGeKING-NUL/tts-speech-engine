"""
Sarvam AI Speech-to-Text service — REST API integration.

Endpoint : POST https://api.sarvam.ai/speech-to-text
Auth     : api-subscription-key header
Input    : multipart/form-data with WAV file + config fields
Output   : {"transcript": "..."}
"""

import logging

import aiohttp

from config import settings
from utils import pcm16_to_wav

logger = logging.getLogger(__name__)


class SarvamSTT:
    """Transcribe audio via the Sarvam Saaras REST API."""

    BASE_URL = "https://api.sarvam.ai"

    def __init__(self) -> None:
        self.api_key = settings.SARVAM_API_KEY
        self.model = settings.SARVAM_STT_MODEL
        self.language = settings.SARVAM_STT_LANGUAGE

    # ------------------------------------------------------------------ #
    async def transcribe(self, audio_pcm16: bytes, sample_rate: int = 16000) -> str:
        """
        Send raw PCM-16 audio to Sarvam STT and return the transcript.

        Parameters
        ----------
        audio_pcm16 : bytes
            Raw PCM-16 mono audio.
        sample_rate : int
            Sample rate of *audio_pcm16* (usually 44100 or 48000 from browsers).

        Returns
        -------
        str   The transcribed text (empty string on silence).
        """
        wav_data = pcm16_to_wav(audio_pcm16, sample_rate=sample_rate)

        headers = {"api-subscription-key": self.api_key}

        form = aiohttp.FormData()
        form.add_field(
            "file", wav_data, filename="audio.wav", content_type="audio/wav"
        )
        form.add_field("language_code", self.language)
        form.add_field("model", self.model)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.BASE_URL}/speech-to-text",
                    headers=headers,
                    data=form,
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.error("STT API %s: %s", resp.status, body)
                        raise RuntimeError(f"STT API error {resp.status}: {body}")

                    result = await resp.json()
                    transcript = result.get("transcript", "")
                    logger.info("STT → %s", transcript[:120])
                    return transcript

        except aiohttp.ClientError as exc:
            logger.error("STT connection error: %s", exc)
            raise RuntimeError(f"STT service unavailable: {exc}") from exc
