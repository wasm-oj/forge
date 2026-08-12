# WASM OJ — OpenAI Build Week submission packet

## Project profile

- **Project name:** WASM OJ
- **Tagline:** A distributed online judge that compiles in the browser or on the server and runs anywhere with deterministic WASI execution—making results reproducible and complexity easier to study.
- **Category:** Education
- **Submitter type:** Individual
- **Country:** Taiwan
- **Public demo:** https://wasm-oj-forge.jacoblincool.chatgpt.site/
- **Repository:** https://github.com/wasm-oj/forge
- **README PR:** https://github.com/wasm-oj/forge/pull/16
- **Codex `/feedback` Session ID:** `019f6847-6b91-7f01-9dcb-3e708f0034a0`

## Built with

Codex, GPT-5.6, WebAssembly, WASI, WASIX, Wasmer, Rust, TypeScript, React, Monaco Editor, C, C++, Python, JavaScript, Go, OpenAI Sites

## Project URL and judge instructions

Open the public demo in a current desktop Chromium browser. No account or installation is required. Choose problem 01 with C/WASIP1, paste the verified solution from the repository README's “Judge quick test,” select **Build**, run **Self Test** with the prefilled sample, and select **Submit**. The expected result is **Accepted**, 4/4 cases, and 100/100 points. Compilation, execution, test data, artifacts, and verdicts remain on the device.

## Developer-tool installation and testing

Judges can test the complete product at the public demo without rebuilding it. The browser deployment requires a current desktop Chromium browser with WebAssembly, Web Workers, `SharedArrayBuffer`, and cross-origin isolation. For package evaluation, install Node.js 22.13 or newer, clone the repository, run `corepack enable`, `pnpm install`, and `pnpm build`, then follow the README's “Run locally” section. The native server build is continuously verified on Ubuntu 24.04. Browser and server hosts implement the same versioned `wasm-oj-forge-v1` contract.

## Demo video

- **YouTube title:** WASM OJ Forge — Scale the Judge, Not the Server | OpenAI Build Week
- **Visibility:** Public
- **Maximum duration:** Under 3 minutes
- **Video file:** `video/demo/wasm-oj-forge-demo.mp4`
- **Final duration:** 2:54.7
- **Voice reference:** User-supplied Video Studio MLX voice `21C4D7D1-68B2-476D-9BE4-F94478C974F7`; 34 sentence-level generations with controlled pauses
- **YouTube URL:** _Add after upload_

### YouTube description

WASM OJ Forge turns the learner's browser into a complete, private, and reproducible programming judge. Real language toolchains compile locally to portable WebAssembly, then Wasmer executes each test under deterministic limits for instruction cost, logical time, memory, output, and the virtual filesystem.

In this OpenAI Build Week demo, see a C solution compile entirely in the browser, run a custom self-test, and pass all four judge cases with inspectable resource evidence. The video also explains how Codex with GPT-5.6 supported the Build Week rebuild—from architecture and shared browser/server contracts to seven language toolchains, isolation debugging, conformance tests, and evidence-backed performance decisions.

Live demo: https://wasm-oj-forge.jacoblincool.chatgpt.site/

Source: https://github.com/wasm-oj/forge

### Chapters

- `00:00` Scale the judge, not the server
- `00:31` Local-first architecture
- `01:02` Compile real C in the browser
- `01:29` Self-test with deterministic metrics
- `01:51` Submit and inspect the verdict
- `02:15` Built with Codex and GPT-5.6

## Image gallery

1. `assets/01-judge-workspace.png` — Complete bilingual judge workspace with 45 problems, progressive scoring, seven language toolchains, and Monaco.
2. `assets/02-browser-execution.png` — A custom input executed locally with stdout and deterministic instruction-cost, memory, and logical-time evidence.
3. `assets/03-accepted-verdict.png` — Accepted submission: 4/4 cases and 100/100 points, with per-case resource evidence.
4. `assets/04-browser-architecture.png` — The product's local-first data and execution boundary, explained inside the app.
5. `assets/05-workflow.png` — The learner workflow: read, code, test, and submit inside one browser tab.

## Final submission checklist

- [x] Working public project
- [x] Public repository
- [ ] README with setup, test path, Codex/GPT-5.6 usage, and key decisions — complete in draft PR #16; merge is blocked until fresh browser/server conformance evidence binds the new source tree
- [x] Project description
- [x] Submitter type, country, and category
- [x] Repository URL
- [x] Public project URL and judge instructions
- [x] `/feedback` Session ID
- [x] Developer-tool testing and supported-platform instructions
- [x] Five 1920×1080 screenshots and a 1200×630 project thumbnail
- [ ] Five screenshots added to the optional Devpost image gallery
- [ ] Public YouTube URL added to Devpost
- [ ] Final Devpost submission confirmation
