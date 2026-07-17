# Application configuration — loads environment variables with sensible defaults.

import os
from pathlib import Path
from dotenv import load_dotenv

# Load server/.env regardless of where the process was started from.
load_dotenv(Path(__file__).resolve().parent / ".env")


class Settings:
    """All tunable settings, read once at import time from environment variables."""

    # ── Sarvam TTS (text → speech) ────────────────────────────────
    SARVAM_API_KEY: str = os.getenv("SARVAM_API_KEY", "")
    SARVAM_TTS_VOICE: str = os.getenv("SARVAM_TTS_VOICE", "anushka")
    SARVAM_TTS_LANGUAGE: str = os.getenv("SARVAM_TTS_LANGUAGE", "en-IN")
    SARVAM_TTS_MODEL: str = os.getenv("SARVAM_TTS_MODEL", "bulbul:v2")
    SARVAM_TTS_SAMPLE_RATE: int = int(os.getenv("SARVAM_TTS_SAMPLE_RATE", "22050"))

    # ── Deepgram STT (speech → text, with end-of-turn detection) ──
    DEEPGRAM_API_KEY: str = os.getenv("DEEPGRAM_API_KEY", "")
    DEEPGRAM_MODEL: str = os.getenv("DEEPGRAM_MODEL", "nova-3")
    DEEPGRAM_LANGUAGE: str = os.getenv("DEEPGRAM_LANGUAGE", "multi")
    # Silence (ms) before Deepgram finalizes a transcript segment.
    DEEPGRAM_ENDPOINTING_MS: int = int(os.getenv("DEEPGRAM_ENDPOINTING_MS", "500"))
    # Silence (ms) before Deepgram declares the whole utterance finished.
    DEEPGRAM_UTTERANCE_END_MS: int = int(os.getenv("DEEPGRAM_UTTERANCE_END_MS", "1500"))

    # ── OpenRouter LLM ────────────────────────────────────────────
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
    OPENROUTER_MODEL: str = os.getenv("OPENROUTER_MODEL", "anthropic/claude-haiku-4.5")
    LLM_SYSTEM_PROMPT: str = os.getenv(
        "LLM_SYSTEM_PROMPT",
        "You are a helpful, friendly AI assistant. Keep responses concise "
        "and conversational — aim for 1-3 sentences unless the user asks for detail.",
    )

    # ── Server ────────────────────────────────────────────────────
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "http://localhost:5173")


settings = Settings()
