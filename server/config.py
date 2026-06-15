# Application configuration — loads environment variables with sensible defaults.

import os
from pathlib import Path
from dotenv import load_dotenv

_server_dir = Path(__file__).resolve().parent
load_dotenv(_server_dir / ".env")


class Settings:
    """Typed settings pulled from environment variables."""

    SARVAM_API_KEY: str = os.getenv("SARVAM_API_KEY", "")

    SARVAM_TTS_VOICE: str = os.getenv("SARVAM_TTS_VOICE", "anushka")
    SARVAM_TTS_LANGUAGE: str = os.getenv("SARVAM_TTS_LANGUAGE", "en-IN")
    SARVAM_TTS_MODEL: str = os.getenv("SARVAM_TTS_MODEL", "bulbul:v2")
    SARVAM_TTS_SAMPLE_RATE: int = int(os.getenv("SARVAM_TTS_SAMPLE_RATE", "22050"))

    SARVAM_STT_LANGUAGE: str = os.getenv("SARVAM_STT_LANGUAGE", "en-IN")
    SARVAM_STT_MODEL: str = os.getenv("SARVAM_STT_MODEL", "saaras:v3")

    GOOGLE_API_KEY: str = os.getenv("GOOGLE_API_KEY", "")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "gemini-2.5-flash")
    LLM_SYSTEM_PROMPT: str = os.getenv(
        "LLM_SYSTEM_PROMPT",
        "You are a helpful, friendly AI assistant. Keep responses concise "
        "and conversational — aim for 1-3 sentences unless the user asks for detail.",
    )

    # ── Server ───────────────────────────────────────────────────
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "http://localhost:5173")


settings = Settings()
