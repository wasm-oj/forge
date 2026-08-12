# Demo video QA report

- **Final file:** `../wasm-oj-forge-demo.mp4`
- **Duration:** 174.700000 seconds
- **Video:** H.264, 1920×1080, 30 fps
- **Audio:** AAC, 48 kHz, mono
- **Integrated loudness:** −17.2 LUFS
- **True peak:** −1.4 dBFS
- **File size:** 37,148,722 bytes
- **SHA-256:** `4d40e76b233f62b9971b90f90f317183913697452db808960e245c4e08394bcf`
- **Narration:** 34 sentence-level generations using the user-supplied `21C4D7D1-68B2-476D-9BE4-F94478C974F7` reference, joined with controlled 180 ms pauses

## Visual verification

- One representative frame from each of the six scenes: `filmstrip.jpg`
- Narration-anchored compile focus frames: `focus-compile.png`
- Narration-anchored self-test focus frames: `focus-self-test.png`
- Narration-anchored judge focus frames: `focus-judge.png`
- All five transition midpoints plus the ending: `transitions.jpg`

The frame audit confirms complete opening typography, readable captions, the expected screen in every scene, focus rings on the named interface regions, clean transitions, and a non-black ending.

## Final-mux speech verification

Four slices were extracted from the final mux and transcribed independently:

- **00:01.0:** “Online judging has a resource problem. Every compilation and test consumes centralized server capacity.”
- **00:17.75:** “WASM OJ Forge asks, ‘How can we distribute execution without changing what the result means?’ Our answer measures reproducible computational work instead of machine speed.”
- **00:31.7:** “The design follows one clear boundary: the browser downloads and verifies problem bundles and pinned toolchains.”
- **02:15.6:** “Codex with GPT 5.6 was our engineering partner throughout Build Week. It helped us recover invariants from earlier.”

These slices confirm that the problem-first introduction, central question, architecture segment, and Codex/GPT-5.6 explanation land in their intended scenes after composition and encoding. Minor ASR normalization such as “pin” for “pinned” and spoken-number formatting does not change the intended words.
