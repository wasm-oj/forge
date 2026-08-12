# Narration validation

The revised narration uses the user-supplied 12.072-second voice reference recorded at:

`/Users/jacoblincool/Library/Application Support/Video Studio MLX/Voices/21C4D7D1-68B2-476D-9BE4-F94478C974F7.mp3`

It was normalized to 24 kHz mono PCM16 before cloning. Independent ASR matched the supplied reference transcript exactly.

Unlike the first version, each complete sentence is generated separately with the same locked reference. The sentences are then joined with a controlled 180 ms silent interval. This prevents a long multi-sentence request from choosing its own mid-clause breathing points while retaining one speaker across the video.

| Scene | Sentences | Duration | Weighted WER |
| --- | ---: | ---: | ---: |
| Intro | 6 | 28.85 s | 0.0% |
| Architecture | 5 | 30.07 s | 1.7% |
| Compile | 6 | 26.29 s | 2.0% |
| Self test | 5 | 21.46 s | 4.2% |
| Judge | 5 | 22.95 s | 0.0% |
| Codex and GPT-5.6 | 7 | 36.88 s | 1.4% |

All 34 sentences passed the configured ASR gate. Total narration duration is 166.49 seconds before scene padding and transitions.
