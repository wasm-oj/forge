#!/usr/bin/env python3
"""Generate sentence-level, voice-cloned narration with controlled pauses."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path


def post(base: str, path: str, payload: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(response.read())


def read_pcm(path: Path) -> tuple[tuple[int, int, int, str, str], bytes, int]:
    with wave.open(str(path), "rb") as audio:
        signature = (
            audio.getnchannels(),
            audio.getsampwidth(),
            audio.getframerate(),
            audio.getcomptype(),
            audio.getcompname(),
        )
        frames = audio.readframes(audio.getnframes())
        return signature, frames, audio.getnframes()


def write_pcm(path: Path, signature: tuple[int, int, int, str, str], frames: bytes) -> None:
    channels, sample_width, sample_rate, compression, compression_name = signature
    temporary = path.with_suffix(".tmp.wav")
    with wave.open(str(temporary), "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(sample_width)
        audio.setframerate(sample_rate)
        audio.setcomptype(compression, compression_name)
        audio.writeframes(frames)
    os.replace(temporary, path)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(
            "usage: generate_sentence_narration.py <storyboard.json> [scene ...]"
        )

    storyboard_path = Path(sys.argv[1]).resolve()
    config = json.loads(storyboard_path.read_text())
    base = config.get("server", "http://127.0.0.1:8100")
    reference_audio = config.get("ref_audio")
    reference_text = config.get("ref_text")
    if not reference_audio or not reference_text:
        raise RuntimeError("A verified ref_audio and exact ref_text are required.")

    output_root = storyboard_path.parent / config.get("output_dir", "demo") / "narration"
    parts_root = output_root / "parts"
    parts_root.mkdir(parents=True, exist_ok=True)
    pause_ms = int(config.get("sentence_pause_ms", 180))
    language = config.get("language", "English")
    selected_scenes = set(sys.argv[2:])
    known_scenes = {scene["name"] for scene in config["scenes"]}
    unknown_scenes = selected_scenes - known_scenes
    if unknown_scenes:
        raise RuntimeError(f"Unknown scenes: {', '.join(sorted(unknown_scenes))}")
    manifest_path = output_root / "manifest.json"
    if selected_scenes:
        if not manifest_path.exists():
            raise RuntimeError("Selective regeneration requires an existing manifest.")
        manifest: dict[str, object] = json.loads(manifest_path.read_text())
        missing_scenes = known_scenes - manifest.keys() - selected_scenes
        if missing_scenes:
            raise RuntimeError(
                "Existing manifest is incomplete: " + ", ".join(sorted(missing_scenes))
            )
    else:
        manifest = {}

    for scene in config["scenes"]:
        parts = scene.get("narration_parts")
        if not parts:
            continue
        scene_name = scene["name"]
        if selected_scenes and scene_name not in selected_scenes:
            continue
        scene_words: list[dict[str, object]] = []
        transcripts: list[str] = []
        validations: list[bool] = []
        weighted_error = 0.0
        weighted_words = 0
        signature: tuple[int, int, int, str, str] | None = None
        assembled = bytearray()
        elapsed_seconds = 0.0
        started = time.time()

        for index, sentence in enumerate(parts, start=1):
            part_path = parts_root / f"{scene_name}-{index:02d}.wav"
            source_path = parts_root / f"{scene_name}-{index:02d}.source.wav"
            result = post(base, "/studio/tts", {
                "text": sentence,
                "language": language,
                "max_word_error_rate": config.get("max_word_error_rate", 0.18),
                "max_attempts": config.get("max_attempts", 5),
                "output": str(source_path),
                "ref_audio": reference_audio,
                "ref_text": reference_text,
            })
            passed = bool(result["validation_passed"])
            validations.append(passed)
            if not passed:
                raise RuntimeError(
                    f"Narration validation failed for {scene_name} sentence {index}: "
                    f"{result.get('transcript', '')}"
                )

            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(source_path),
                "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
                str(part_path),
            ], check=True)

            current_signature, frames, frame_count = read_pcm(part_path)
            if signature is None:
                signature = current_signature
                if signature[:3] != (1, 2, 24000) or signature[3] != "NONE":
                    raise RuntimeError(f"Unexpected narration WAV format: {signature}")
            elif current_signature != signature:
                raise RuntimeError(
                    f"Narration WAV format drift in {scene_name} sentence {index}: "
                    f"{current_signature} != {signature}"
                )

            for item in result.get("items") or []:
                scene_words.append({
                    "text": item["text"],
                    "start": round(elapsed_seconds + float(item["start"]), 6),
                    "end": round(elapsed_seconds + float(item["end"]), 6),
                })
            transcripts.append(str(result.get("transcript") or ""))
            word_count = max(1, len(sentence.split()))
            weighted_error += float(result["word_error_rate"]) * word_count
            weighted_words += word_count
            assembled.extend(frames)
            elapsed_seconds += frame_count / signature[2]

            if index < len(parts):
                pause_frames = round(signature[2] * pause_ms / 1000)
                assembled.extend(b"\x00" * pause_frames * signature[0] * signature[1])
                elapsed_seconds += pause_frames / signature[2]

        if signature is None:
            raise RuntimeError(f"Scene {scene_name} produced no narration audio.")
        scene_path = output_root / f"{scene_name}.wav"
        write_pcm(scene_path, signature, bytes(assembled))
        manifest[scene_name] = {
            "text": " ".join(parts),
            "path": str(scene_path),
            "duration_s": round(elapsed_seconds, 6),
            "passed": all(validations),
            "wer": round(weighted_error / weighted_words, 3),
            "transcript": " ".join(transcripts),
            "words": scene_words,
            "parts": len(parts),
            "sentence_pause_ms": pause_ms,
        }
        print(
            f"[{scene_name}] {len(parts)} sentences, {elapsed_seconds:.2f}s, "
            f"wer={manifest[scene_name]['wer']} ({time.time() - started:.1f}s)"
        )

    temporary_manifest = manifest_path.with_suffix(".tmp.json")
    temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    os.replace(temporary_manifest, manifest_path)
    total = sum(float(scene["duration_s"]) for scene in manifest.values())
    print(f"\n{len(manifest)} scenes, {total:.2f}s narration -> {manifest_path}")


if __name__ == "__main__":
    main()
