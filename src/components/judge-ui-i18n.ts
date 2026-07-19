import { FORGE_CONTRACT_ID } from "../core/contract";
import type { BuiltinLanguage, ExecutionTermination, WorkerProgress } from "../core/types";
import {
  DEFAULT_PROBLEM_LOCALE,
  PROBLEM_LOCALES,
  type ProblemLocale,
} from "../judge/problem-model";

export const JUDGE_UI_LOCALE_STORAGE_KEY = `${FORGE_CONTRACT_ID}:judge-ui-locale:v1`;

type LocalizedShape<T> = T extends (...args: infer Arguments) => string
  ? (...args: Arguments) => string
  : T extends object
    ? { readonly [Key in keyof T]: LocalizedShape<T[Key]> }
    : string;

const ZH_TW = {
  localeName: "繁體中文",
  source: {
    owner: "GitHub 擁有者",
    repository: "儲存庫",
    ref: "分支／標籤／commit",
    index: "題庫索引",
    useDefault: "使用預設值",
    apply: "載入並驗證題庫",
    invalid: (detail: string) => `題庫來源設定無效：${detail}`,
  },
  loader: {
    loading: "正在載入並驗證題庫…",
    failed: "無法驗證設定的題庫",
    retry: "重試目前來源",
    sourceReadFailed: (detail: string) => `無法讀取題庫來源設定：${detail}`,
    sourceInvalid: (detail: string) => `儲存的題庫來源設定無效：${detail}`,
    loadFailed: (detail: string) => `題庫驗證失敗：${detail}`,
  },
  boot: "正在開啟本機 Judge 工作區",
  topbar: {
    interfaceLanguage: "介面與題目語言",
    solutionLanguage: "解題語言",
    compilationTarget: "編譯目標",
    openGuide: "開啟新手導覽",
    guide: "新手導覽",
    projectSettings: "專案設定",
    stop: "停止",
    build: "建置",
    selfTest: "自行測試",
    submit: "提交判題",
  },
  catalog: {
    heading: "題目",
    difficultyFilter: "題目難度篩選",
    all: "全部",
    searchPlaceholder: "搜尋題號、標題、標籤…",
    search: "搜尋題目",
    clearSearch: "清除搜尋",
    empty: "找不到符合條件的題目",
    verifiedOnline: "已驗證的線上來源",
    verifiedCache: "已驗證的快取",
  },
  difficulty: {
    easy: "入門",
    medium: "進階",
    hard: "挑戰",
  },
  statement: {
    problem: "題目",
    baselineCost: "基準指令成本",
    perCase: "每筆測資",
    costUnit: "指令成本",
    cases: (count: number) => `${count} 筆測資`,
    scoringPolicies: "累進計分政策",
    pointsShort: "分",
    statement: "題目敘述",
    editorial: "題解",
    askChatGptTitle: "以題目連結與目前語言模板詢問 ChatGPT",
    askChatGpt: "詢問 ChatGPT",
  },
  editor: {
    deleteFile: (path: string) => `刪除 ${path}`,
    deleteFileConfirm: (path: string) => `從本機專案刪除 ${path}？`,
    newFilePath: "新檔案路徑",
    createFile: "建立檔案",
    cancel: "取消",
    addFile: "新增檔案",
    openCompilationSettings: "開啟編譯設定",
    resizePanel: "調整編輯器與下方面板高度",
    resizePanelHint: "拖曳或使用方向鍵調整高度；雙擊重設",
  },
  panel: {
    judgeResults: "判題結果",
    selfTest: "自行測試",
    diagnostics: "編譯診斷",
    output: "輸出紀錄",
    compileScheduled: "背景編譯已排程",
    precompiling: "背景預編譯",
    waitingForFix: "等待修正",
    precompileReady: "預編譯完成",
    downloadArtifact: "下載產物",
  },
  judge: {
    ready: "準備提交",
    readyDescription: "程式只會送進此分頁內的 Wasmer runtime。",
    partialScore: "輸出正確 · 部分得分",
    casesAndPoints: (completed: number, total: number, points?: number, maximumPoints?: number) => (
      points === undefined || maximumPoints === undefined
        ? `${completed} / ${total} 筆測資`
        : `${completed} / ${total} 筆測資 · ${points.toFixed(2)} / ${maximumPoints} 分`
    ),
    viewDiagnostics: "查看編譯診斷 →",
    case: (number: number) => `測資 ${String(number).padStart(2, "0")}`,
    correctOutput: "輸出正確",
    pointsShort: "分",
    expected: "預期輸出",
    actual: "實際輸出",
    verdicts: {
      running: "判題中",
      accepted: "通過",
      "wrong-answer": "答案錯誤",
      "runtime-error": "執行錯誤",
      "time-limit": "超過時間限制",
      "judge-error": "Judge 錯誤",
      "compile-error": "編譯錯誤",
      cancelled: "已取消",
    },
  },
  selfTest: {
    inputRegion: "自行測試輸入",
    heading: "測試案例",
    description: "每筆輸入會使用相同的最新編譯產物依序執行",
    addSamples: "加入範例",
    add: "新增",
    runAll: "全部執行",
    sampleName: (number: number) => `範例 ${number}`,
    caseName: (number: number) => `案例 ${number}`,
    nameLabel: (number: number) => `測試案例 ${number} 名稱`,
    run: (name: string) => `執行 ${name}`,
    remove: (name: string) => `刪除 ${name}`,
    result: "結果",
    untitled: "未命名案例",
    exit: "結束碼",
    empty: "執行選取的案例後，在這裡查看輸出與資源用量",
    duration: "執行時間",
    instructionCost: "指令成本",
    peakMemory: "記憶體峰值",
    logicalTime: "邏輯時間",
    terminations: {
      exited: "正常結束",
      "instruction-limit": "超過指令限制",
      "logical-time-limit": "超過邏輯時間限制",
      "memory-limit": "超過記憶體限制",
      "output-limit": "超過輸出限制",
      "filesystem-limit": "超過檔案系統限制",
      "wall-time-limit": "超過緊急時間限制",
      trap: "執行陷阱",
    },
  },
  empty: {
    diagnostics: "沒有編譯診斷",
    output: "建置或執行後，在這裡查看完整輸出紀錄",
  },
  status: {
    localJudge: "本機 Judge",
    cached: (usage: string) => `${usage} 快取`,
    solved: (solved: number, total: number) => `${solved}/${total} 已解出`,
    cursor: (line: number, column: number) => `第 ${line} 行，第 ${column} 欄`,
  },
  settings: {
    ariaLabel: "本機 Judge 設定",
    eyebrow: "本機 JUDGE",
    title: "工作區設定",
    description: "編譯、執行與本機資料各自獨立設定。",
    close: "關閉設定",
    collectionEyebrow: "題庫",
    collectionTitle: "遠端題庫來源",
    collectionDescription: "只先載入索引；選題時才下載並驗證該題的 SHA-256 bundle。設定會保存在此瀏覽器。",
    compilationEyebrow: "編譯",
    compilationTitle: "編譯設定",
    compilationDescription: "選擇入口檔、目標 ABI 與最佳化方式。",
    entryFile: "入口檔案",
    targetAbi: "目標 ABI",
    profile: "最佳化設定",
    rustToolchainTitle: "完整 Rust 工具鏈",
    rustToolchainNote: (version: string) => `使用來源可追溯的 rustc ${version} WebC 與相符的標準函式庫，在 Wasmer 內直接產生 WASI P1；Cargo 可使用 Forge 統一 lock/cache API，但目前編輯器尚未把解析後的 crate 掛載進 rustc build。`,
    goToolchainTitle: "標準 Go／wasip1",
    goToolchainNote: (version: string) => `使用標準 Go ${version} 編譯器、linker 與相符的 349-package 標準函式庫，全程在 Wasmer 內產生 WASI P1；Go modules 可使用 Forge 統一 lock/cache API。`,
    executionEyebrow: "執行",
    executionTitle: "執行限制",
    executionDescription: "控制每次自行測試的可重現 runtime 資源邊界。",
    instructionBudget: "淨加權指令預算",
    logicalTimeBudget: "邏輯時間預算（ms）",
    linearMemory: "線性記憶體（MiB）",
    capturedOutput: "擷取輸出（MiB）",
    writableVfs: "可寫入 VFS（MiB）",
    writableVfsEntries: "可寫入 VFS 項目數",
    wallDeadline: "緊急 wall deadline（ms）",
    portableLimitsTitle: "可攜式限制",
    portableLimitsNote: "指令、邏輯時間、記憶體、輸出與 VFS 上限由 runtime 強制執行；wall deadline 只負責終止失控的 Worker。",
    determinismEyebrow: "可重現性",
    determinismTitle: "可重現環境",
    determinismDescription: "固定隨機來源與虛擬時鐘，讓相同輸入得到相同 transcript。",
    randomSeed: "隨機種子",
    clockStep: "時鐘步進（ns）",
    realtimeEpoch: "即時時鐘 epoch（Unix ms）",
    deterministicExecutionTitle: "可重現執行",
    deterministicExecutionNote: "sleep 與 clock poll 只會快轉虛擬時間，不等待 host；實際執行時間不屬於 deterministic transcript。",
    localDataEyebrow: "本機資料",
    localDataTitle: "本機資料與隱私",
    localDataDescription: "管理裝置上的工具鏈、題庫與建置快取。",
    noAntiCheatTitle: "不防作弊",
    noAntiCheatNote: "完全本機的測資一定能被檢視；這是刻意的隱私與教學取捨。",
    localCache: "本機快取",
    browserQuota: "瀏覽器配額",
    clearCache: "清除快取",
    privacyNote: "只下載經驗證的題庫與工具鏈；程式碼、自行測試輸入、判題結果與產物不會上傳。",
    toolchainNotes: {
      c: "透過 Clang 與 LLD 產生原生 wasip1 模組，可由 WASI 與 WASIX runtime 直接執行。",
      cpp: "產生 C++20／libc++ wasip1 模組，可由 WASI 與 WASIX runtime 直接執行。",
      rust: "真正的 rustc、相符的標準函式庫與全新的可重現 wasm-ld 階段，會在 Wasmer 中以同一個固定版本 WebC 執行。",
      python: "將專案預先編譯為 bytecode，並與從原始碼建置的 CPython wasm32-wasip1 直譯器及標準函式庫一起封裝。",
      javascript: "先由 TypeScript／WASI 檢查 JavaScript，再交給封裝的 QuickJS-ng／WASI runtime 執行。",
      typescript: "原生 TypeScript 編譯器與 QuickJS-ng runtime 都會以本機 WASI 模組執行。",
      go: "標準 Go 編譯器、linker 與固定版本的 wasip1 標準函式庫，會在 Wasmer 中以同一個 WebC 在本機執行。",
    },
  },
  logs: {
    onboardingSaveFailed: (detail: string) => `無法儲存新手導覽狀態：${detail}`,
    onboardingReadFailed: (detail: string) => `無法讀取新手導覽狀態：${detail}`,
    selfTestSaveFailed: (detail: string) => `無法儲存自行測試：${detail}`,
    buildStarted: (project: string, language: string, target: string) => `建置 ${project} · ${language} → ${target}`,
    buildFailed: (milliseconds: number) => `建置失敗 · ${milliseconds} ms`,
    cacheLoaded: (name: string, size: string) => `從本機建置快取載入 ${name} · ${size}`,
    buildComplete: (name: string, size: string, milliseconds: number) => `完成 ${name} · ${size} · ${milliseconds} ms`,
    runStarted: (name: string) => `執行 ${name}`,
    cancelled: "已取消操作並重啟 ForgeCompiler／ForgeRunner Workers",
    cachesCleared: "已清除本機題庫、工具鏈回應與建置產物快取",
    costUnavailable: "指令成本不可用",
    cost: (value: string) => `${value} 指令成本`,
  },
  progress: {
    startingWasmer: "正在啟動 Wasmer runtime",
    cacheHit: "命中建置快取",
    selfTest: (completed: number, total: number) => `自行測試 ${completed} / ${total}`,
    selfTestComplete: "自行測試完成",
    judgeCases: (completed: number, total: number) => `本機測資 ${completed} / ${total}`,
    phases: {
      initializing: "正在初始化本機執行環境",
      "restoring-cache": "正在還原快取",
      "loading-toolchain": "正在載入工具鏈",
      checking: "正在檢查專案",
      compiling: "正在編譯",
      linking: "正在連結",
      packaging: "正在封裝產物",
      running: "正在執行",
    },
  },
} as const;

const EN = {
  localeName: "English",
  source: {
    owner: "GitHub owner",
    repository: "Repository",
    ref: "Branch / tag / commit",
    index: "Collection index",
    useDefault: "Use defaults",
    apply: "Load and verify collection",
    invalid: (detail: string) => `Invalid problem collection settings: ${detail}`,
  },
  loader: {
    loading: "Loading and verifying problem collection…",
    failed: "Unable to verify the configured problem collection",
    retry: "Retry current source",
    sourceReadFailed: (detail: string) => `Unable to read the problem collection settings: ${detail}`,
    sourceInvalid: (detail: string) => `The saved problem collection settings are invalid: ${detail}`,
    loadFailed: (detail: string) => `Problem collection verification failed: ${detail}`,
  },
  boot: "Opening the local Judge workspace",
  topbar: {
    interfaceLanguage: "Interface and problem language",
    solutionLanguage: "Solution language",
    compilationTarget: "Compilation target",
    openGuide: "Open getting started guide",
    guide: "Getting started",
    projectSettings: "Project settings",
    stop: "Stop",
    build: "Build",
    selfTest: "Self Test",
    submit: "Submit",
  },
  catalog: {
    heading: "Challenges",
    difficultyFilter: "Problem difficulty filter",
    all: "All",
    searchPlaceholder: "Search number, title, or tag…",
    search: "Search problems",
    clearSearch: "Clear search",
    empty: "No matching problems",
    verifiedOnline: "verified online",
    verifiedCache: "verified cache",
  },
  difficulty: {
    easy: "Easy",
    medium: "Medium",
    hard: "Hard",
  },
  statement: {
    problem: "Problem",
    baselineCost: "Baseline cost",
    perCase: "per case",
    costUnit: "cost",
    cases: (count: number) => `${count} cases`,
    scoringPolicies: "Cumulative scoring policies",
    pointsShort: "pts",
    statement: "Statement",
    editorial: "Editorial",
    askChatGptTitle: "Ask ChatGPT with the problem link and current language template",
    askChatGpt: "Ask ChatGPT",
  },
  editor: {
    deleteFile: (path: string) => `Delete ${path}`,
    deleteFileConfirm: (path: string) => `Delete ${path} from the local project?`,
    newFilePath: "New file path",
    createFile: "Create file",
    cancel: "Cancel",
    addFile: "Add file",
    openCompilationSettings: "Open compilation settings",
    resizePanel: "Resize editor and bottom panel",
    resizePanelHint: "Drag or use arrow keys to resize; double-click to reset",
  },
  panel: {
    judgeResults: "Judge Results",
    selfTest: "Self Test",
    diagnostics: "Diagnostics",
    output: "Output",
    compileScheduled: "Background compile scheduled",
    precompiling: "Background precompile",
    waitingForFix: "Waiting for a fix",
    precompileReady: "Precompile ready",
    downloadArtifact: "Download artifact",
  },
  judge: {
    ready: "Ready to submit",
    readyDescription: "Your program only enters the Wasmer runtime in this tab.",
    partialScore: "Correct Output · Partial Score",
    casesAndPoints: (completed: number, total: number, points?: number, maximumPoints?: number) => (
      points === undefined || maximumPoints === undefined
        ? `${completed} / ${total} cases`
        : `${completed} / ${total} cases · ${points.toFixed(2)} / ${maximumPoints} points`
    ),
    viewDiagnostics: "View compiler diagnostics →",
    case: (number: number) => `Case ${String(number).padStart(2, "0")}`,
    correctOutput: "Correct output",
    pointsShort: "pts",
    expected: "EXPECTED",
    actual: "ACTUAL",
    verdicts: {
      running: "Running",
      accepted: "Accepted",
      "wrong-answer": "Wrong Answer",
      "runtime-error": "Runtime Error",
      "time-limit": "Time Limit",
      "judge-error": "Judge Error",
      "compile-error": "Compile Error",
      cancelled: "Cancelled",
    },
  },
  selfTest: {
    inputRegion: "Self-test input",
    heading: "Test Cases",
    description: "Each input runs sequentially against the same latest build artifact",
    addSamples: "Add samples",
    add: "Add",
    runAll: "Run all",
    sampleName: (number: number) => `Sample ${number}`,
    caseName: (number: number) => `Case ${number}`,
    nameLabel: (number: number) => `Test case ${number} name`,
    run: (name: string) => `Run ${name}`,
    remove: (name: string) => `Delete ${name}`,
    result: "RESULT",
    untitled: "Untitled case",
    exit: "exit",
    empty: "Run the selected case to inspect its output and resource usage here",
    duration: "Duration",
    instructionCost: "Instruction cost",
    peakMemory: "Peak memory",
    logicalTime: "Logical time",
    terminations: {
      exited: "exited",
      "instruction-limit": "instruction limit",
      "logical-time-limit": "logical time limit",
      "memory-limit": "memory limit",
      "output-limit": "output limit",
      "filesystem-limit": "filesystem limit",
      "wall-time-limit": "wall-time limit",
      trap: "trap",
    },
  },
  empty: {
    diagnostics: "No compiler diagnostics",
    output: "Build or run to view the complete output log here",
  },
  status: {
    localJudge: "Local judge",
    cached: (usage: string) => `${usage} cached`,
    solved: (solved: number, total: number) => `${solved}/${total} solved`,
    cursor: (line: number, column: number) => `Ln ${line}, Col ${column}`,
  },
  settings: {
    ariaLabel: "Local Judge settings",
    eyebrow: "LOCAL JUDGE",
    title: "Workspace Settings",
    description: "Configure compilation, execution, and local data independently.",
    close: "Close settings",
    collectionEyebrow: "PROBLEM COLLECTION",
    collectionTitle: "Remote problem collection",
    collectionDescription: "Only the index is loaded initially. Each problem's SHA-256 bundle is downloaded and verified when selected. These settings are saved in this browser.",
    compilationEyebrow: "COMPILATION",
    compilationTitle: "Compilation settings",
    compilationDescription: "Choose the entry file, target ABI, and optimization profile.",
    entryFile: "Entry file",
    targetAbi: "Target ABI",
    profile: "Profile",
    rustToolchainTitle: "Real Rust toolchain",
    rustToolchainNote: (version: string) => `Uses a provenance-traceable rustc ${version} WebC and matching standard library to produce WASI P1 directly inside Wasmer. Cargo can use Forge's unified lock/cache API, but the editor does not yet mount resolved crates into rustc builds.`,
    goToolchainTitle: "Standard Go / wasip1",
    goToolchainNote: (version: string) => `Uses the standard Go ${version} compiler, linker, and matching 349-package standard library to produce WASI P1 entirely inside Wasmer. Go modules can use Forge's unified lock/cache API.`,
    executionEyebrow: "EXECUTION",
    executionTitle: "Execution limits",
    executionDescription: "Control the reproducible runtime resource boundaries for each self-test.",
    instructionBudget: "Net weighted instruction budget",
    logicalTimeBudget: "Logical time budget (ms)",
    linearMemory: "Linear memory (MiB)",
    capturedOutput: "Captured output (MiB)",
    writableVfs: "Writable VFS (MiB)",
    writableVfsEntries: "Writable VFS entries",
    wallDeadline: "Emergency wall deadline (ms)",
    portableLimitsTitle: "Portable limits",
    portableLimitsNote: "Instruction, logical-time, memory, output, and VFS limits are enforced by the runtime. The wall deadline only terminates a runaway Worker.",
    determinismEyebrow: "DETERMINISM",
    determinismTitle: "Reproducible environment",
    determinismDescription: "Pin the random source and virtual clock so the same input produces the same transcript.",
    randomSeed: "Random seed",
    clockStep: "Clock step (ns)",
    realtimeEpoch: "Realtime epoch (Unix ms)",
    deterministicExecutionTitle: "Deterministic execution",
    deterministicExecutionNote: "Sleep and clock polling advance virtual time without waiting for the host. Actual execution time is excluded from the deterministic transcript.",
    localDataEyebrow: "LOCAL DATA",
    localDataTitle: "Local data and privacy",
    localDataDescription: "Manage toolchain, problem collection, and build caches on this device.",
    noAntiCheatTitle: "Not anti-cheat",
    noAntiCheatNote: "Fully local cases can always be inspected. This is an intentional privacy and teaching tradeoff.",
    localCache: "Local cache",
    browserQuota: "browser quota",
    clearCache: "Clear cache",
    privacyNote: "Only verified problem bundles and toolchains are downloaded. Source code, self-test inputs, judge results, and artifacts are never uploaded.",
    toolchainNotes: {
      c: "Native wasip1 module via Clang and LLD; directly executable by WASI and WASIX runtimes.",
      cpp: "C++20/libc++ wasip1 module; directly executable by WASI and WASIX runtimes.",
      rust: "Real rustc, its matching standard library, and a fresh deterministic wasm-ld stage execute as one pinned WebC under Wasmer.",
      python: "Byte-compiled project bundled with the source-built CPython wasm32-wasip1 interpreter and standard library.",
      javascript: "JavaScript checked by TypeScript/WASI, then executed by the bundled QuickJS-ng/WASI runtime.",
      typescript: "The native TypeScript compiler and QuickJS-ng runtime both execute as local WASI modules.",
      go: "The standard Go compiler, linker, and pinned wasip1 standard library execute locally as one WebC under Wasmer.",
    },
  },
  logs: {
    onboardingSaveFailed: (detail: string) => `Unable to save the getting started state: ${detail}`,
    onboardingReadFailed: (detail: string) => `Unable to read the getting started state: ${detail}`,
    selfTestSaveFailed: (detail: string) => `Unable to save self-tests: ${detail}`,
    buildStarted: (project: string, language: string, target: string) => `Build ${project} · ${language} → ${target}`,
    buildFailed: (milliseconds: number) => `Build failed · ${milliseconds} ms`,
    cacheLoaded: (name: string, size: string) => `Loaded ${name} from the local build cache · ${size}`,
    buildComplete: (name: string, size: string, milliseconds: number) => `Completed ${name} · ${size} · ${milliseconds} ms`,
    runStarted: (name: string) => `Run ${name}`,
    cancelled: "Cancelled the operation and restarted the ForgeCompiler / ForgeRunner Workers",
    cachesCleared: "Cleared local problem, toolchain response, and build artifact caches",
    costUnavailable: "instruction cost unavailable",
    cost: (value: string) => `${value} instruction cost`,
  },
  progress: {
    startingWasmer: "Starting Wasmer runtime",
    cacheHit: "Build cache hit",
    selfTest: (completed: number, total: number) => `Self Test ${completed} / ${total}`,
    selfTestComplete: "Self Test complete",
    judgeCases: (completed: number, total: number) => `Local cases ${completed} / ${total}`,
    phases: {
      initializing: "Initializing local runtime",
      "restoring-cache": "Restoring cache",
      "loading-toolchain": "Loading toolchain",
      checking: "Checking project",
      compiling: "Compiling",
      linking: "Linking",
      packaging: "Packaging artifact",
      running: "Running",
    },
  },
} satisfies LocalizedShape<typeof ZH_TW>;

export type JudgeUiText = LocalizedShape<typeof ZH_TW>;

const TEXT: Readonly<Record<ProblemLocale, JudgeUiText>> = {
  "zh-TW": ZH_TW,
  en: EN,
};

export function judgeUiText(locale: ProblemLocale): JudgeUiText {
  return TEXT[locale];
}

export function readJudgeUiLocale(storage: Pick<Storage, "getItem">): ProblemLocale {
  const value = storage.getItem(JUDGE_UI_LOCALE_STORAGE_KEY);
  return PROBLEM_LOCALES.includes(value as ProblemLocale)
    ? value as ProblemLocale
    : DEFAULT_PROBLEM_LOCALE;
}

export function writeJudgeUiLocale(storage: Pick<Storage, "setItem">, locale: ProblemLocale): void {
  storage.setItem(JUDGE_UI_LOCALE_STORAGE_KEY, locale);
}

export function verdictLabel(locale: ProblemLocale, verdict: keyof JudgeUiText["judge"]["verdicts"]): string {
  return judgeUiText(locale).judge.verdicts[verdict];
}

export function executionTerminationLabel(locale: ProblemLocale, termination: ExecutionTermination): string {
  return judgeUiText(locale).selfTest.terminations[termination];
}

export function toolchainNote(locale: ProblemLocale, language: BuiltinLanguage): string {
  return judgeUiText(locale).settings.toolchainNotes[language];
}

export function localizedWorkerProgress(progress: WorkerProgress, locale: ProblemLocale): string {
  if (locale === "en") return progress.label;

  const selfTest = /^Self Test (\d+) \/ (\d+)$/.exec(progress.label);
  if (selfTest) return ZH_TW.progress.selfTest(Number(selfTest[1]), Number(selfTest[2]));
  const judgeCases = /^Local cases (\d+) \/ (\d+)$/.exec(progress.label);
  if (judgeCases) return ZH_TW.progress.judgeCases(Number(judgeCases[1]), Number(judgeCases[2]));

  const exact = new Map<string, string>([
    [EN.progress.startingWasmer, ZH_TW.progress.startingWasmer],
    [EN.progress.cacheHit, ZH_TW.progress.cacheHit],
    [EN.progress.selfTestComplete, ZH_TW.progress.selfTestComplete],
  ]);
  return exact.get(progress.label) ?? ZH_TW.progress.phases[progress.phase];
}
