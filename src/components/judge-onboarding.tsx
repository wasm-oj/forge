"use client";

import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cloud,
  Code2,
  Cpu,
  Gauge,
  HardDrive,
  Laptop,
  ListChecks,
  Play,
  Scale,
  Send,
  ShieldCheck,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProblemLocale } from "@/src/judge/problem-model";

export {
  completeJudgeOnboarding,
  isJudgeOnboardingComplete,
  JUDGE_ONBOARDING_STORAGE_KEY,
} from "./judge-onboarding-storage";

interface JudgeOnboardingProps {
  locale: ProblemLocale;
  onClose(): void;
}

interface OnboardingStep {
  shortLabel: string;
  title: string;
  icon: LucideIcon;
}

const VERDICTS = [
  {
    code: "AC",
    name: "Accepted",
    tone: "accepted",
    zh: "所有測資的輸出都正確。若也通過所有資源政策，才算完整解出題目。",
    en: "Every case produced correct output. The problem is fully solved only when every resource policy also passes.",
  },
  {
    code: "WA",
    name: "Wrong Answer",
    tone: "wrong-answer",
    zh: "程式正常結束，但至少一組輸出與預期不符；從 case 詳情比較 Expected 與 Actual。",
    en: "The program exited normally, but at least one output differed. Compare Expected and Actual in the case details.",
  },
  {
    code: "CE",
    name: "Compile Error",
    tone: "compile-error",
    zh: "原始碼未成功編譯；到 Diagnostics 查看檔案、行列與編譯器訊息。",
    en: "The source did not compile. Open Diagnostics for the file, location, and compiler message.",
  },
  {
    code: "RE",
    name: "Runtime Error",
    tone: "runtime-error",
    zh: "執行時崩潰、非零結束，或超過記憶體、輸出、可寫檔案系統限制。",
    en: "The run crashed, exited non-zero, or exceeded memory, output, or writable-filesystem limits.",
  },
  {
    code: "TLE",
    name: "Time Limit",
    tone: "time-limit",
    zh: "超過指令成本、邏輯時間或緊急 wall deadline；這裡不只看電腦跑了幾秒。",
    en: "Instruction cost, logical time, or the emergency wall deadline was exceeded—not merely elapsed seconds.",
  },
  {
    code: "JE",
    name: "Judge Error",
    tone: "judge-error",
    zh: "判題器、題目資料或執行環境發生錯誤，通常不是答案本身的判定。",
    en: "The judge, problem data, or runtime failed; this is normally not a verdict on the solution itself.",
  },
  {
    code: "—",
    name: "Cancelled",
    tone: "cancelled",
    zh: "你按下「停止」中斷了建置、測試或判題，這不是答案正確性的結果。",
    en: "You pressed Stop during building, testing, or judging. This says nothing about solution correctness.",
  },
] as const;

function WelcomeStep({ zh }: { zh: boolean }) {
  return (
    <div className="onboarding-step-body onboarding-welcome">
      <div className="onboarding-hero-mark"><Terminal size={26} /></div>
      <p className="onboarding-eyebrow">{zh ? "3 分鐘快速導覽" : "3-MINUTE ORIENTATION"}</p>
      <h2 tabIndex={-1}>{zh ? "先認識這個不太一樣的 Online Judge" : "Meet an Online Judge that works differently"}</h2>
      <p className="onboarding-lead">
        {zh
          ? "Online Judge（OJ）會用多組測資執行你的程式，再依輸出與資源使用量給出判定。FORGE 保留熟悉的解題流程，但把編譯器、執行環境與 Judge 全部搬進你的瀏覽器。"
          : "An Online Judge (OJ) runs your program against multiple cases and evaluates its output and resource use. FORGE keeps that familiar workflow while moving the compiler, runtime, and judge into your browser."}
      </p>
      <div className="onboarding-audience-grid">
        <article>
          <BookOpen size={18} />
          <div>
            <strong>{zh ? "第一次使用 OJ？" : "New to Online Judges?"}</strong>
            <p>{zh ? "把題目想成一份輸入／輸出契約：讀懂規格、寫程式、先用自己的輸入測試，再提交給完整測資。" : "Treat each problem as an input/output contract: understand it, write code, test with your own inputs, then submit against the full cases."}</p>
          </div>
        </article>
        <article>
          <Scale size={18} />
          <div>
            <strong>{zh ? "用過其他 OJ？" : "Used another OJ?"}</strong>
            <p>{zh ? "題目、編輯器、測試與提交都很熟悉；差別在於本機 WASM 執行、可重現資源計量，以及輸出正確後的累進得分政策。" : "Problems, editing, tests, and submissions are familiar. The differences are local WASM execution, reproducible metering, and progressive scoring after output correctness."}</p>
          </div>
        </article>
      </div>
      <div className="onboarding-flow" aria-label={zh ? "基本解題流程" : "Basic solving flow"}>
        {[zh ? "讀題" : "Read", zh ? "寫程式" : "Code", zh ? "自行測試" : "Test", zh ? "提交判題" : "Submit"].map((label, index) => (
          <div key={label}><span>{index + 1}</span><strong>{label}</strong>{index < 3 && <i aria-hidden="true">→</i>}</div>
        ))}
      </div>
    </div>
  );
}

function BrowserJudgeStep({ zh }: { zh: boolean }) {
  return (
    <div className="onboarding-step-body">
      <p className="onboarding-eyebrow">{zh ? "FORGE 的核心差異" : "THE FORGE DIFFERENCE"}</p>
      <h2 tabIndex={-1}>{zh ? "從原始碼到結果，都在這個分頁完成" : "From source code to verdict, inside this tab"}</h2>
      <p className="onboarding-lead">{zh ? "網路只用來下載並驗證題庫與工具鏈；你的原始碼、自行測試輸入、執行輸出、判題結果與建置產物不會上傳。" : "The network only downloads and verifies problem bundles and toolchains. Your source, custom inputs, output, verdicts, and build artifacts are not uploaded."}</p>

      <div className="onboarding-pipeline">
        <div><Code2 size={18} /><span>{zh ? "你的原始碼" : "Your source"}</span></div>
        <i>→</i>
        <div><Cpu size={18} /><span>{zh ? "瀏覽器內工具鏈" : "In-browser toolchain"}</span></div>
        <i>→</i>
        <div><HardDrive size={18} /><span>WASI / WASIX</span></div>
        <i>→</i>
        <div><Play size={18} /><span>{zh ? "本機 Wasmer Judge" : "Local Wasmer judge"}</span></div>
      </div>

      <div className="onboarding-feature-grid">
        <article><Laptop size={18} /><strong>{zh ? "本機編譯與執行" : "Local compile and run"}</strong><p>{zh ? "真實語言工具鏈在 Worker 中產生 WASI／WASIX 程式，再由瀏覽器內的 Wasmer runtime 執行。" : "Real language toolchains produce WASI/WASIX programs in workers, then the in-browser Wasmer runtime executes them."}</p></article>
        <article><ShieldCheck size={18} /><strong>{zh ? "可驗證的下載" : "Verified downloads"}</strong><p>{zh ? "題庫依 SHA-256 bundle 驗證，工具鏈與快取也有明確版本，不會用來源不明的替代內容。" : "Problem bundles are SHA-256 verified, while toolchains and caches are explicitly versioned—no unknown substitutes."}</p></article>
        <article><Gauge size={18} /><strong>{zh ? "可重現的資源界線" : "Reproducible limits"}</strong><p>{zh ? "Judge 計量指令成本、邏輯時間、記憶體、輸出與 VFS；相同程式的結果較不受裝置快慢影響。" : "The judge meters instruction cost, logical time, memory, output, and VFS, reducing dependence on device speed."}</p></article>
      </div>

      <div className="onboarding-boundary-note">
        <CircleAlert size={18} />
        <div><strong>{zh ? "重要邊界：這是練習與自我驗證工具" : "Important boundary: this is for practice and self-verification"}</strong><p>{zh ? "完整測資必須存在瀏覽器內，因此有能力的使用者可以檢視它們。FORGE 重視隱私與可重現性，但不宣稱能像伺服器競賽 Judge 一樣防作弊。" : "The full cases must exist in the browser, so a capable user can inspect them. FORGE prioritizes privacy and reproducibility; it does not claim server-competition anti-cheat properties."}</p></div>
      </div>
    </div>
  );
}

function WorkflowStep({ zh }: { zh: boolean }) {
  const items = [
    { icon: BookOpen, title: zh ? "1. 選題並讀懂契約" : "1. Choose a problem and read the contract", text: zh ? "左側選題；中間查看輸入、輸出、限制與範例。先確認格式，再開始寫程式。" : "Choose on the left; read input, output, constraints, and examples in the center. Confirm the format before coding." },
    { icon: Code2, title: zh ? "2. 選語言並編寫程式" : "2. Choose a language and write code", text: zh ? "上方可切換語言與 WASI／WASIX 目標。編輯器會保存在本機，背景預編譯可縮短等待。" : "Choose a language and WASI/WASIX target above. The editor saves locally, and background precompilation reduces waiting." },
    { icon: Play, title: zh ? "3. 先用「自行測試」" : "3. Use Self Test first", text: zh ? "自行建立輸入，直接查看 stdout、stderr、exit code 與資源指標。它不會決定題目是否解出。" : "Create your own inputs and inspect stdout, stderr, exit code, and metrics. This does not decide whether the problem is solved." },
    { icon: Send, title: zh ? "4. 再按「提交判題」" : "4. Then Submit", text: zh ? "Judge 會在本機依序跑完整測資。下方「判題結果」會顯示總判定、各 case、差異與得分政策。" : "The local judge runs the full cases. Judge Results shows the overall verdict, each case, diffs, and scoring policies." },
  ];
  return (
    <div className="onboarding-step-body">
      <p className="onboarding-eyebrow">{zh ? "第一次解題" : "YOUR FIRST SOLUTION"}</p>
      <h2 tabIndex={-1}>{zh ? "最短路徑：讀題 → 寫程式 → 測試 → 提交" : "The shortest path: read → code → test → submit"}</h2>
      <p className="onboarding-lead">{zh ? "「建置」只負責編譯；「自行測試」使用你提供的輸入；只有「提交判題」會跑題目的完整 cases 並計分。" : "Build only compiles. Self Test uses inputs you provide. Only Submit runs the problem's full cases and scores the solution."}</p>
      <div className="onboarding-workflow-list">
        {items.map(({ icon: Icon, title, text }) => <article key={title}><span><Icon size={18} /></span><div><strong>{title}</strong><p>{text}</p></div></article>)}
      </div>
      <div className="onboarding-tip"><CheckCircle2 size={17} /><span>{zh ? "建議：先用題目範例確認 I/O 格式，再補邊界案例；出錯時先看失敗 case 的 Expected、Actual 與 stderr。" : "Tip: validate I/O with the examples, then add edge cases. On failure, inspect Expected, Actual, and stderr for the failed case."}</span></div>
    </div>
  );
}

function VerdictStep({ zh }: { zh: boolean }) {
  return (
    <div className="onboarding-step-body">
      <p className="onboarding-eyebrow">{zh ? "判定結果速查" : "VERDICT REFERENCE"}</p>
      <h2 tabIndex={-1}>{zh ? "每一種結果，真正代表什麼" : "What every result actually means"}</h2>
      <p className="onboarding-lead">{zh ? "判題中（Running）是暫時狀態；完成後會得到下列結果之一。各 case 可展開查看細節。" : "Running is a temporary state. When judging finishes, it produces one of the results below. Open each case for details."}</p>
      <div className="onboarding-verdict-grid">
        {VERDICTS.map((verdict) => (
          <article className={verdict.tone} key={verdict.name}>
            <span>{verdict.code}</span>
            <div><strong>{verdict.name}</strong><p>{zh ? verdict.zh : verdict.en}</p></div>
          </article>
        ))}
      </div>
      <div className="onboarding-score-note">
        <Gauge size={18} />
        <div><strong>{zh ? "FORGE 特有：Accepted 不一定是滿分" : "FORGE-specific: Accepted may not mean full points"}</strong><p>{zh ? "輸出全部正確時仍是 Accepted，但每個 case 還會依累進資源政策計分。若只通過較寬鬆的成本或記憶體門檻，會顯示「輸出正確 · 部分得分」；通過全部政策才會標記為 solved。" : "Correct output still yields Accepted, but each case is also scored against cumulative resource policies. Passing only looser cost or memory tiers shows Correct Output · Partial Score; all policies must pass to mark the problem solved."}</p></div>
      </div>
    </div>
  );
}

function ComparisonStep({ zh }: { zh: boolean }) {
  const rows = zh ? [
    ["編譯與執行", "通常在遠端伺服器", "在你的瀏覽器 Worker 與 Wasmer 內"],
    ["程式碼與結果", "提交到平台", "留在目前裝置，不上傳"],
    ["時間限制", "常以伺服器 wall time 為主", "指令成本＋邏輯時間；wall deadline 僅緊急終止"],
    ["測資保密", "保留在伺服器，可用於正式競賽", "下載到瀏覽器，可被檢視，不以防作弊為目標"],
    ["計分方式", "常見全對或子任務計分", "輸出正確後，再依累進資源政策取得分數"],
    ["適合情境", "比賽、排名、受控評測", "練習、教學、自我驗證、可重現實驗"],
  ] : [
    ["Compile & run", "Usually on remote servers", "In your browser workers and Wasmer"],
    ["Code & results", "Submitted to the platform", "Stay on this device; never uploaded"],
    ["Time limits", "Often based on server wall time", "Instruction cost + logical time; wall deadline is emergency-only"],
    ["Hidden cases", "Remain server-side; suitable for contests", "Downloaded to the browser; inspectable and not anti-cheat"],
    ["Scoring", "Often all-or-nothing or subtasks", "Output correctness plus cumulative resource policies"],
    ["Best suited for", "Contests, rankings, controlled evaluation", "Practice, teaching, self-checking, reproducible experiments"],
  ];
  return (
    <div className="onboarding-step-body">
      <p className="onboarding-eyebrow">{zh ? "建立正確預期" : "SET THE RIGHT EXPECTATIONS"}</p>
      <h2 tabIndex={-1}>{zh ? "FORGE 與一般伺服器 Judge 的差異" : "FORGE versus a typical server-side judge"}</h2>
      <p className="onboarding-lead">{zh ? "操作方式相似，但信任邊界、資源計量與使用目的不同。了解這張表，就不會用錯誤的方式解讀結果。" : "The interaction is familiar, but the trust boundary, metering, and intended use differ. This table prevents misreading the results."}</p>
      <div className="onboarding-comparison" role="table" aria-label={zh ? "Judge 差異比較" : "Judge comparison"}>
        <div className="onboarding-comparison-head" role="row"><span role="columnheader">{zh ? "面向" : "Aspect"}</span><span role="columnheader"><Cloud size={14} />{zh ? "一般伺服器 OJ" : "Typical server OJ"}</span><span role="columnheader"><Laptop size={14} />FORGE</span></div>
        {rows.map(([aspect, traditional, forge]) => <div role="row" key={aspect}><strong role="cell">{aspect}</strong><span role="cell">{traditional}</span><span role="cell">{forge}</span></div>)}
      </div>
      <div className="onboarding-ready-card">
        <CheckCircle2 size={21} />
        <div><strong>{zh ? "你已經可以開始了" : "You are ready"}</strong><p>{zh ? "先選一題入門題，確認輸入／輸出格式，使用自行測試，最後提交。之後隨時可按右上角的「？」重新開啟這份導覽。" : "Choose an introductory problem, confirm its I/O, use Self Test, then Submit. Reopen this guide anytime from the ? button in the top right."}</p></div>
      </div>
    </div>
  );
}

export function JudgeOnboarding({ locale, onClose }: JudgeOnboardingProps) {
  const zh = locale === "zh-TW";
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const steps = useMemo<OnboardingStep[]>(() => [
    { shortLabel: zh ? "歡迎" : "Welcome", title: zh ? "認識 Online Judge" : "Meet the Online Judge", icon: BookOpen },
    { shortLabel: zh ? "特色" : "Local", title: zh ? "瀏覽器內判題" : "In-browser judging", icon: Cpu },
    { shortLabel: zh ? "流程" : "Workflow", title: zh ? "完成第一次提交" : "Make your first submission", icon: ListChecks },
    { shortLabel: zh ? "結果" : "Verdicts", title: zh ? "看懂判定結果" : "Understand verdicts", icon: CircleAlert },
    { shortLabel: zh ? "比較" : "Compare", title: zh ? "與其他 Judge 的差異" : "Compare with other judges", icon: Scale },
  ], [zh]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    headingRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [step]);

  const content = [
    <WelcomeStep zh={zh} key="welcome" />,
    <BrowserJudgeStep zh={zh} key="browser" />,
    <WorkflowStep zh={zh} key="workflow" />,
    <VerdictStep zh={zh} key="verdicts" />,
    <ComparisonStep zh={zh} key="comparison" />,
  ][step];

  return (
    <div className="onboarding-backdrop">
      <div
        className="onboarding-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="judge-onboarding-title"
        tabIndex={-1}
      >
        <header className="onboarding-header">
          <div><span className="brand-mark"><Terminal size={16} /></span><div><strong id="judge-onboarding-title">FORGE Judge</strong><span>{zh ? "新手導覽" : "Getting started"}</span></div></div>
          <div className="onboarding-progress" aria-label={zh ? "導覽進度" : "Tutorial progress"}>{steps.map((item, index) => <span className={index <= step ? "active" : ""} key={item.shortLabel} />)}</div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={zh ? "關閉導覽" : "Close tutorial"}><X size={16} /></button>
        </header>

        <div className="onboarding-layout">
          <nav className="onboarding-nav" aria-label={zh ? "導覽章節" : "Tutorial chapters"}>
            <span>{zh ? "快速開始" : "QUICK START"}</span>
            {steps.map(({ shortLabel, title, icon: Icon }, index) => (
              <button type="button" className={index === step ? "active" : ""} onClick={() => setStep(index)} aria-current={index === step ? "step" : undefined} key={shortLabel}>
                <i>{index < step ? <CheckCircle2 size={15} /> : <Icon size={15} />}</i>
                <span><small>{String(index + 1).padStart(2, "0")} · {shortLabel}</small><strong>{title}</strong></span>
              </button>
            ))}
            <div className="onboarding-nav-note"><ShieldCheck size={14} /><span>{zh ? "所有操作與結果留在目前裝置" : "Your work and results stay on this device"}</span></div>
          </nav>
          <section className="onboarding-content" ref={headingRef} aria-live="polite">{content}</section>
        </div>

        <footer className="onboarding-footer">
          <button type="button" className="onboarding-skip" onClick={onClose}>{zh ? "略過，之後可從「？」重看" : "Skip—reopen later from ?"}</button>
          <span>{step + 1} / {steps.length}</span>
          <div>
            {step > 0 && <button type="button" className="onboarding-back" onClick={() => setStep((current) => current - 1)}><ChevronLeft size={15} />{zh ? "上一步" : "Back"}</button>}
            {step < steps.length - 1
              ? <button type="button" className="onboarding-next" onClick={() => setStep((current) => current + 1)}>{zh ? "下一步" : "Next"}<ChevronRight size={15} /></button>
              : <button type="button" className="onboarding-next" onClick={onClose}>{zh ? "開始解題" : "Start solving"}<ChevronRight size={15} /></button>}
          </div>
        </footer>
      </div>
    </div>
  );
}
