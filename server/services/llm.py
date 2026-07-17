"""
OpenRouter LLM service — async streaming via the OpenAI-compatible API.
"""

import json
import logging
from typing import AsyncGenerator

import httpx

from config import settings

logger = logging.getLogger(__name__)


class OpenRouterLLM:
    """Stream chat completions from OpenRouter (SSE)."""

    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            base_url="https://openrouter.ai/api/v1",
            headers={"Authorization": f"Bearer {settings.OPENROUTER_API_KEY}"},
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        logger.info("OpenRouter LLM initialised  model=%s", settings.OPENROUTER_MODEL)

    # ------------------------------------------------------------------ #
    async def stream_response(
        self,
        user_message: str,
        conversation_history: list | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Stream LLM tokens for *user_message* (with optional history).

        Parameters
        ----------
        user_message : str
            The latest user utterance (from STT).
        conversation_history : list | None
            Previous turns in OpenAI ``[{"role": "user"|"assistant", "content": "…"}]`` format.

        Yields
        ------
        str   Text token strings as they arrive.
        """
        messages = [{"role": "system", "content": settings.LLM_SYSTEM_PROMPT}]
        messages += conversation_history or []
        messages.append({"role": "user", "content": user_message})

        logger.info("LLM prompt (%d turns) → %.100s…", len(messages), user_message)

        async with self.client.stream(
            "POST",
            "/chat/completions",
            json={
                "model": settings.OPENROUTER_MODEL,
                "messages": messages,
                "stream": True,
            },
        ) as response:
            if response.status_code != 200:
                body = (await response.aread()).decode(errors="replace")
                raise RuntimeError(f"OpenRouter error {response.status_code}: {body[:500]}")

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue  # skips OpenRouter ": PROCESSING" keep-alive comments
                data = line[6:]
                if data == "[DONE]":
                    break
                choices = json.loads(data).get("choices") or []
                if not choices:
                    continue  # final usage-only chunk
                token = choices[0].get("delta", {}).get("content")
                if token:
                    yield token
