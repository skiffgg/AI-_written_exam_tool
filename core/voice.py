"""
Handles Speech-to-Text (STT) functionality supporting both Google Cloud STT and OpenAI Whisper via HTTP API.
"""
import logging
from pathlib import Path
from typing import Optional

from core.settings import settings
import openai
from openai import OpenAI

# Initialize OpenAI client (v1 interface)
_openai_client = OpenAI()
from google.cloud import speech
from google.api_core.exceptions import GoogleAPIError

log = logging.getLogger(__name__)

# 默认语音识别语言
DEFAULT_LANGUAGE_CODE = "zh-CN"

def transcribe_audio(audio_path: Path, language_code: str = DEFAULT_LANGUAGE_CODE) -> Optional[str]:
    """
    Transcribes the given audio file using the provider specified in settings.stt_provider.

    - If settings.stt_provider == 'whisper', uses OpenAI Whisper HTTP API.
    - Otherwise, defaults to Google Cloud Speech-to-Text.

    Returns the transcribed text, or None if no transcription is available.
    Raises exceptions for critical failures.
    """
    if not audio_path.is_file():
        log.error(f"Audio file not found: {audio_path}")
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    provider = getattr(settings, "stt_provider", "google").lower()

    if provider == "whisper":
        try:
            log.info(f"Transcribing {audio_path.name} with OpenAI Whisper HTTP API...")
            with open(audio_path, "rb") as f:
                resp = _openai_client.audio.transcriptions.create(
                    model="whisper-1",
                    file=f
                )
                                    # Extract text field
            text = resp.text.strip()
            log.info(f"Whisper API transcription: '{text[:100]}...'")
            return text or None
        except Exception:
            log.exception("Error during Whisper API transcription")
            raise

    # Fallback to Google Cloud Speech-to-Text
    try:
        client = speech.SpeechClient()
        log.info(f"Transcribing {audio_path.name} with Google Cloud Speech-to-Text...")
        content = audio_path.read_bytes()
        audio = speech.RecognitionAudio(content=content)
        config = speech.RecognitionConfig(
            language_code=language_code,
            enable_automatic_punctuation=True,
        )
        response = client.recognize(config=config, audio=audio)
        if response.results:
            text = response.results[0].alternatives[0].transcript
            log.info(f"Google STT result: '{text[:100]}...'")
            return text
        log.warning(f"No results from Google STT for {audio_path.name}")
        return None
    except GoogleAPIError:
        log.exception("Google Cloud Speech API error")
        raise
    except Exception:
        log.exception("Unexpected error in Google STT")
        raise
