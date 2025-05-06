# core/voice.py
"""
Handles Speech-to-Text (STT) functionality using Google Cloud Speech API.
"""
import logging
from pathlib import Path
from typing import Optional

from google.cloud import speech
from google.api_core.exceptions import GoogleAPIError

log = logging.getLogger(__name__)

# Consider making language_code configurable via settings.py if needed
DEFAULT_LANGUAGE_CODE = "zh-CN" # Or "en-US", etc.

def transcribe_audio(audio_path: Path, language_code: str = DEFAULT_LANGUAGE_CODE) -> Optional[str]:
    """
    Transcribes the audio file at the given path using Google Cloud Speech-to-Text.

    Args:
        audio_path: Path object pointing to the audio file.
        language_code: The language code for transcription (e.g., "zh-CN", "en-US").

    Returns:
        The transcribed text as a string, or None if transcription fails or returns no result.

    Raises:
        FileNotFoundError: If the audio file does not exist.
        GoogleAPIError: If there's an issue calling the Google API (after logging).
        Exception: For other unexpected errors during processing.
    """
    if not audio_path.is_file():
        log.error(f"Audio file not found at path: {audio_path}")
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    try:
        client = speech.SpeechClient() # Assumes GOOGLE_APPLICATION_CREDENTIALS is set
        log.debug(f"Reading audio file for transcription: {audio_path}")
        with open(audio_path, "rb") as audio_file:
            content = audio_file.read()

        audio = speech.RecognitionAudio(content=content)

        # Configure recognition based on expected audio format
        # TODO: You might need to determine the audio encoding and sample rate dynamically
        #       or ensure all uploaded audio conforms to a standard format (like WAV).
        config = speech.RecognitionConfig(
            # encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16, # Often needed for WAV
            # sample_rate_hertz=16000, # Specify if not standard WAV or using other encodings
            language_code=language_code,
            enable_automatic_punctuation=True,
        )

        log.info(f"Calling Google Cloud Speech-to-Text API (Language: {language_code})...")
        response = client.recognize(config=config, audio=audio) # Blocking call
        log.debug("Google STT API response received.")

        if response.results:
            # Get the most likely transcript
            transcript = response.results[0].alternatives[0].transcript
            log.info(f"STT successful: '{transcript[:100]}...'")
            return transcript
        else:
            log.warning(f"STT returned no results for {audio_path.name}")
            return None # Indicate no result found

    except GoogleAPIError as api_err:
        log.exception(f"Google Cloud Speech API error during transcription of {audio_path.name}")
        # Re-raise specific API errors if needed, or handle them
        raise api_err # Let the calling task handle it
    except Exception as e:
        log.exception(f"Unexpected error during transcription of {audio_path.name}")
        raise e # Re-raise other errors

# --- Optional: Add a simple test block ---
if __name__ == '__main__':
    # This part only runs when executing voice.py directly
    # Requires a test audio file and credentials set up
    print("Testing voice.py...")
    logging.basicConfig(level=logging.DEBUG) # Enable DEBUG for testing
    # Create a dummy audio file path for testing structure (replace with a real path)
    # test_file_path = Path("./path/to/your/test_audio.wav")
    # if test_file_path.exists():
    #     try:
    #         result = transcribe_audio(test_file_path)
    #         if result:
    #             print(f"\nTranscription Result:\n---\n{result}\n---")
    #         else:
    #             print("\nTranscription returned no result.")
    #     except Exception as test_err:
    #         print(f"\nError during test transcription: {test_err}")
    # else:
    #     print(f"\nTest audio file not found at: {test_file_path}. Skipping transcription test.")
    print("Voice module loaded.")