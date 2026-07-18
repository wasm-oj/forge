"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_CONFORMANCE_CASES, FULL_CONFORMANCE_CASES } from "../conformance/cases";
import { runConformanceHost, type ConformanceSnapshot } from "../conformance/matrix";
import { Forge } from "../sdk/forge";

declare global {
  interface Window {
    __FORGE_CONFORMANCE__?: ConformanceSnapshot;
  }
}

export function ConformanceLab() {
  const [snapshot, setSnapshot] = useState<ConformanceSnapshot>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("No snapshot yet.");
  const autoStarted = useRef(false);

  const run = useCallback(async () => {
    setRunning(true);
    setStatus("Initializing browser Wasmer hosts…");
    setError(undefined);
    window.__FORGE_CONFORMANCE__ = undefined;
    let engine: Forge | undefined;
    let removeProgress: (() => void) | undefined;
    try {
      const search = new URLSearchParams(window.location.search);
      const repetitions = Number(search.get("repetitions") ?? "3");
      const requestedCases = search.get("cases")?.split(",").filter(Boolean);
      const suite = search.get("suite") === "full" ? FULL_CONFORMANCE_CASES : DEFAULT_CONFORMANCE_CASES;
      const cases = requestedCases?.length
        ? FULL_CONFORMANCE_CASES.filter((item) => requestedCases.includes(item.id))
        : suite;
      if (cases.length === 0) throw new Error("The cases query did not match a declared conformance case.");
      engine = await Forge.create({ assetBaseUrl: "/toolchains/", artifactCache: true });
      removeProgress = engine.onProgress((progress) => setStatus(progress.label));
      const next = await runConformanceHost({
        id: "browser-wasmer-js",
        compile: (input, options) => engine!.compile(input, options),
        run: (artifact, options) => engine!.run(artifact, options),
      }, cases, {
        repetitions,
        repeatCompile: true,
        onSample(sample, completed, total) {
          setStatus(`${completed}/${total} ${sample.caseId}: ${sample.success ? "pass" : "fail"}`);
        },
      });
      window.__FORGE_CONFORMANCE__ = next;
      setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      removeProgress?.();
      engine?.dispose();
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (new URLSearchParams(window.location.search).get("autorun") !== "1") return;
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  return (
    <main className="conformance-lab">
      <header>
        <div><span>FORGE</span><h1>Conformance &amp; efficiency matrix</h1></div>
        <button disabled={running} onClick={() => void run()}>{running ? "Running…" : "Run browser snapshot"}</button>
      </header>
      <p>This executes every declared language/target pair locally, performs two uncached builds, validates reproducible artifacts and expected results, then repeats deterministic runs. Net cost is the observed raw weighted cost minus the calibrated empty-program baseline for the exact artifact profile. Add <code>?suite=full</code> for the header-heavy libc++ efficiency case; compare the snapshot with <code>pnpm run conformance:server</code>.</p>
      {error && <pre className="conformance-error" data-testid="conformance-error">{error}</pre>}
      {!snapshot && !error && <div className="conformance-empty" data-testid="conformance-status">{running ? status : "No snapshot yet."}</div>}
      {snapshot && (
        <>
          <table data-testid="conformance-table">
            <thead><tr><th>Case</th><th>Status</th><th>First uncached</th><th>Repeat uncached</th><th>Median run</th><th>Artifact</th><th>Net cost</th><th>Raw cost</th><th>Baseline</th></tr></thead>
            <tbody>{snapshot.samples.map((sample) => <tr key={sample.caseId}><td>{sample.caseId}</td><td>{sample.success ? "pass" : sample.error ?? "fail"}</td><td>{milliseconds(sample.firstUncachedCompileMs)}</td><td>{milliseconds(sample.repeatUncachedCompileMs)}</td><td>{milliseconds(sample.runMedianMs)}</td><td>{bytes(sample.artifactBytes)}</td><td>{sample.transcript?.metrics.cost ?? "—"}</td><td>{sample.transcript?.metrics.rawCost ?? "—"}</td><td>{sample.transcript?.metrics.baselineCost ?? "—"}</td></tr>)}</tbody>
          </table>
          <textarea readOnly aria-label="Conformance snapshot JSON" value={JSON.stringify(snapshot, null, 2)} />
        </>
      )}
    </main>
  );
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}
