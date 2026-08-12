## Summary

- link the public WASM OJ Forge judge from the README
- document how Codex with GPT-5.6 supported the Build Week rebuild
- add a deterministic, copy-paste judge test for reviewers
- state browser, Node.js, and native-server platform requirements

## Why

OpenAI Build Week requires a README that explains setup and evaluation, highlights Codex and GPT-5.6 usage, and gives judges a way to test a developer tool without rebuilding it. This change keeps that path concise and executable while leaving the deeper library documentation intact.

## Validation

- `pnpm run docs:verify`
- live Chromium run: problem 01, C/WASIP1, Build → Self Test → Submit
- observed result: Accepted, 4/4 cases, 100/100 points
