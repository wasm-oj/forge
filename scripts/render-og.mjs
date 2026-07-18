import { chromium } from "playwright";
import path from "node:path";

const output = path.resolve("public/og.png");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
      body {
        color: #f4f3ea;
        background:
          radial-gradient(circle at 84% 18%, rgba(174, 226, 84, .13), transparent 27%),
          radial-gradient(circle at 9% 89%, rgba(174, 226, 84, .08), transparent 31%),
          #090b09;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .grid {
        position: absolute; inset: 0;
        background-image:
          linear-gradient(rgba(245, 244, 234, .035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(245, 244, 234, .035) 1px, transparent 1px);
        background-size: 42px 42px;
        mask-image: linear-gradient(90deg, #000 0%, rgba(0,0,0,.3) 58%, transparent 100%);
      }
      .frame { position: relative; display: grid; grid-template-columns: 1.08fr .92fr; gap: 62px; height: 100%; padding: 68px 70px; }
      .eyebrow { display: flex; align-items: center; gap: 12px; color: #b3e35d; font: 700 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; }
      .mark { display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid rgba(179,227,93,.65); border-radius: 9px; box-shadow: inset 0 0 20px rgba(179,227,93,.08); }
      .mark::before { content: "F"; font: 800 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { max-width: 650px; margin: 35px 0 20px; font-size: 72px; line-height: .96; letter-spacing: -.055em; }
      h1 span { color: #b3e35d; }
      .lead { max-width: 560px; margin: 0; color: #c3c4bb; font-size: 23px; line-height: 1.45; letter-spacing: -.015em; }
      .badges { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 38px; }
      .badge { border: 1px solid #30342d; border-radius: 999px; padding: 10px 14px; color: #dedfd5; background: rgba(18,21,17,.8); font: 600 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .badge.accent { color: #b3e35d; border-color: rgba(179,227,93,.42); }
      .terminal { align-self: center; position: relative; border: 1px solid #34382f; border-radius: 18px; overflow: hidden; background: rgba(14, 17, 13, .94); box-shadow: 0 32px 90px rgba(0,0,0,.42); transform: translateY(6px); }
      .terminal::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 1px rgba(255,255,255,.045); pointer-events: none; }
      .bar { display: flex; align-items: center; gap: 7px; height: 48px; padding: 0 17px; border-bottom: 1px solid #2b2e28; background: #111410; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #454a40; }
      .dot:nth-child(3) { background: #b3e35d; }
      .bar-label { margin-left: auto; color: #70766a; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      pre { min-height: 313px; margin: 0; padding: 28px 27px; color: #d6d8cf; font: 15px/1.85 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
      .muted { color: #747a6f; } .green { color: #b3e35d; } .gold { color: #e4bb62; }
      .accepted { display: flex; align-items: center; gap: 14px; padding: 22px 27px; border-top: 1px solid #2b2e28; color: #b3e35d; background: rgba(179,227,93,.035); font: 800 23px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
      .check { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid #b3e35d; border-radius: 50%; font-size: 23px; }
      .footer { position: absolute; left: 70px; bottom: 31px; color: #747a6f; font: 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; }
    </style>
  </head>
  <body>
    <div class="grid"></div>
    <main class="frame">
      <section>
        <div class="eyebrow"><span class="mark"></span>WASM OJ</div>
        <h1>Forge code.<br><span>Judge locally.</span></h1>
        <p class="lead">A deterministic compiler and online-judge library that runs entirely in the browser.</p>
        <div class="badges">
          <span class="badge">C · C++ · Rust</span>
          <span class="badge">Python · JS · TS</span>
          <span class="badge accent">WASI P1 · WASIX</span>
        </div>
      </section>
      <section class="terminal">
        <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="bar-label">forge.local</span></div>
        <pre><span class="muted">01</span>  <span class="gold">const</span> artifact = <span class="gold">await</span> forge.compile(project)
<span class="muted">02</span>  <span class="gold">const</span> result = <span class="gold">await</span> forge.run(artifact, {
<span class="muted">03</span>    target: <span class="green">"wasip1"</span>,
<span class="muted">04</span>    randomSeed: <span class="green">42</span>,
<span class="muted">05</span>    instructionBudget: <span class="green">10_000_000</span>
<span class="muted">06</span>  })

<span class="muted">07</span>  <span class="green">✓ deterministic</span>  <span class="green">✓ zero uploads</span></pre>
        <div class="accepted"><span class="check">✓</span>ACCEPTED</div>
      </section>
      <div class="footer">20 ORIGINAL CHALLENGES · WASMER-POWERED TOOLCHAINS</div>
    </main>
  </body>
</html>`);
  await page.screenshot({ path: output, type: "png" });
} finally {
  await browser.close();
}

process.stdout.write(`${output}\n`);
