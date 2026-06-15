import asyncio
import base64
import os
import json
from dotenv import load_dotenv
from sarvamai import AsyncSarvamAI

load_dotenv()

async def test_stt_vad():
    api_key = os.getenv("SARVAM_API_KEY")
    client = AsyncSarvamAI(api_subscription_key=api_key)
    
    # Send a tiny bit of dummy audio to trigger the connection
    dummy_audio = bytes([0] * 16000 * 2) # 1 second of silence
    b64_audio = base64.b64encode(dummy_audio).decode("utf-8")
    
    print("Connecting...")
    async with client.speech_to_text_streaming.connect(
        model="saaras:v3",
        language_code="en-IN",
        vad_signals=True
    ) as ws:
        print("Connected. Sending silence...")
        await ws.transcribe(audio=b64_audio)
        
        for _ in range(3):
            try:
                response = await asyncio.wait_for(ws.recv(), timeout=2.0)
                print("Received:", response)
            except Exception as e:
                print("Error or timeout:", e)

if __name__ == "__main__":
    asyncio.run(test_stt_vad())
