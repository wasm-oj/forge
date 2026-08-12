import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "WASM-OJ Architecture v2｜Chief Architect Implementation Report",
  description:
    "WASM-OJ Architecture v2 的 P0／P1 修復證據、資料流、R2 生命週期、效能差異與正式切換狀態。",
};

type Repair = {
  readonly id: `R-${string}`;
  readonly priority: "P0" | "P1";
  readonly area: string;
  readonly problem: string;
  readonly impact: string;
  readonly cause: string;
  readonly solution: string;
  readonly proof: string;
  readonly evidence: readonly string[];
};

const repairs: readonly Repair[] = [
  {
    id: "R-01",
    priority: "P0",
    area: "Rejudge source identity",
    problem: "rejudge child 曾沿用原提交的 R2 key，卻以 child submission UUID 驗證，導致工作在進入 judge 前失效。",
    impact: "重判功能不可用，批次會落入 infrastructure error。",
    cause: "submission identity 與 immutable source identity 被錯誤綁成同一個 UUID。",
    solution: "source 獨立為 UUID；original 與所有 rejudge child 共用 source_id，Container 驗 source ID 與 digest。",
    proof: "來源只存一份，child 能通過 hydrate／container 契約；多代 lineage 測試共用同一 source。",
    evidence: ["migrations/core/0017_architecture_reset.sql", "worker/rejudge.ts", "worker/submission-workflow-context.ts", "worker/rejudge-lifecycle.test.ts"],
  },
  {
    id: "R-02",
    priority: "P0",
    area: "Account erasure",
    problem: "D1 匿名化與 R2 late PUT 曾存在 write-after-delete 競態。",
    impact: "刪帳完成後仍可能復活原始碼，並形成沒有 D1 pointer 的個資 orphan。",
    cause: "source writer 與 erasure 沒有共享 epoch、conditional-create 與固定 key tombstone。",
    solution: "admission 先保留 source；PUT 只准 conditional create；完成後重查 erasure epoch。刪帳覆寫同 key 為常數 tombstone，HEAD 驗證後才標 erased。",
    proof: "tombstone 先到時 late PUT 必敗；source 先到時 tombstone 最終覆寫。所有 crash ordering 以專門測試固定。",
    evidence: ["worker/submissions.ts", "worker/account-erasure.ts", "worker/account-erasure-tombstone.test.ts", "src/account-erasure-privacy.test.ts"],
  },
  {
    id: "R-03",
    priority: "P1",
    area: "Browser drafts",
    problem: "IndexedDB／quota 錯誤曾被 silent catch，快速切題或 unmount 可能丟掉最後 350ms 草稿。",
    impact: "使用者看見程式碼卻無法知道它尚未落盤，也缺乏人工復原路徑。",
    cause: "autosave 是 fire-and-forget timer，不是序列化的持久化狀態機。",
    solution: "新增 DraftPersistenceController，提供 dirty／saving／saved／error 與單調 version；切換前 flush，pagehide best effort，並提供 validated source-only 匯出／匯入。",
    proof: "quota rejection、快速切換、unmount、schema 升級與復原路徑都有 focused tests。",
    evidence: ["src/storage/draft-persistence.ts", "src/storage/draft-persistence.test.ts", "src/storage/draft-recovery.ts", "src/storage/draft-recovery.test.ts"],
  },
  {
    id: "R-04",
    priority: "P1",
    area: "Catalog authority",
    problem: "push notice／push-import 同時扮演同步提示與匯入觸發，會製造重複 side effect 與 latest 決策。",
    impact: "同一 GitHub delivery 可重複通知或匯入，平台也不必要地承擔題庫版本控制。",
    cause: "把 repository push 當作平台同步協定，而不是由使用者 explicit validate／publish。",
    solution: "完整移除 push notice schema、handler、API、UI 與 import webhook；只保留 installation／repository lifecycle webhook。",
    proof: "v2 router 只暴露 explicit validation、publication、activation；legacy modules 與測試已刪除。",
    evidence: ["worker/index.ts", "worker/catalog.ts", "migrations/core/0017_architecture_reset.sql", "src/features/organizer/components/organizer-platform.tsx"],
  },
  {
    id: "R-05",
    priority: "P1",
    area: "Submission scheduling",
    problem: "等待中的 Workflow 曾每 10 秒各自競爭容量，造成 thundering herd 且不保證 FIFO。",
    impact: "backlog 越大，D1 與 Workflow wakeup 浪費越多，真正判題吞吐卻不增加。",
    cause: "在建立 Workflow 後才排隊；容量 claim 分散在每一個等待者。",
    solution: "D1 queued rows 成為唯一 authority；shared dispatcher oldest-first claim，拿到 slot 後才建立 deterministic Workflow。",
    proof: "測試覆蓋 global active 50、global queued 500、per-user active 1／queued 3、rejudge active 10 與一般提交借用閒置 slot。",
    evidence: ["worker/dispatcher.ts", "worker/dispatcher.test.ts", "worker/submission-capacity.ts", "config/capacity.json"],
  },
  {
    id: "R-06",
    priority: "P1",
    area: "Verified browser cache",
    problem: "大型 toolchain 即使命中 Cache Storage，仍會完整 arrayBuffer 與重新 SHA-256。",
    impact: "71 MiB 級 Rust 資產的第二次載入仍有高記憶體峰值、CPU、GC 與耗電。",
    cause: "快取沒有可隨 cache generation 失效的 verified capability。",
    solution: "首次 network admission 才 hash；exact key + verified metadata 命中直接 stream。任何 mutation／version mismatch 使 token 失效並 fail closed。",
    proof: "測試以 digest spy 驗證同 lifecycle 第二次命中不再呼叫 digest；metadata 異常仍拒絕。",
    evidence: ["public/toolchain-cache-sw.js", "src/storage/toolchain-service-worker.test.ts", "src/storage/service-worker.ts"],
  },
  {
    id: "R-07",
    priority: "P1",
    area: "Retention",
    problem: "多類 terminal／ephemeral 資料沒有期限；maintenance 又依賴恰好在 00:00 執行。",
    impact: "錯過 cron 會延遲整天，不同 GC 互相阻塞，D1／R2 只增不減。",
    cause: "沒有 durable cursor、last_completed_at 與每種工作的獨立 quota。",
    solution: "以 elapsed time + keyset cursor 執行 bounded retention；events 7 天、catalog／webhook／outbox 30 天、auth 到期後 24 小時、orphan package 24 小時。",
    proof: "測試模擬 missed cron、分頁、小 quota 及 per-digest R2 delete fence，皆能最終完成。",
    evidence: ["worker/reconciler.ts", "worker/reconciler-cadence.test.ts", "worker/reconciler-retention.test.ts", "migrations/core/0017_architecture_reset.sql"],
  },
  {
    id: "R-08",
    priority: "P1",
    area: "Release cutover",
    problem: "破壞性 migration 與 release activation 曾缺少可驗證的單一切換邊界。",
    impact: "失敗可能留下零 active release，或舊 Worker／新 schema 的不相容窗口。",
    cause: "多條人工 SQL 與一般 migration path 混用，沒有 reset token、expected-current CAS 與 maintenance precondition。",
    solution: "release manifest 改為 immutable row，environment pointer 成為唯一 active authority，activation 採 expected-current CAS。Reset 仍須匹配 production secret、精確 R2 inventory、source tombstone receipt 與 drained confirmation；production smoke 走 maintenance-only token lane。",
    proof: "stale expected-current 會整批 rollback；staging／production 可安全指向不同 release；缺任一 receipt byte、digest 或 identity 時，0017 在 destructive DDL 前拒絕。",
    evidence: ["worker/release.ts", "worker/release-activation.test.ts", "worker/formal-mutations.ts", "worker/formal-mutations.test.ts", "scripts/architecture-reset-preflight.mjs", ".github/workflows/cloudflare-architecture-v2-cutover.yml"],
  },
  {
    id: "R-09",
    priority: "P0",
    area: "Static validation",
    problem: "validation 曾下載整份 archive、緩衝大型 payload、寫暫存 R2，並啟動 Container。",
    impact: "合法 128 MiB archive 可造成約 256 MiB 以上 Worker allocation，並浪費 R2 與 compute。",
    cause: "平台把題庫驗證誤當成 build／execution pipeline。",
    solution: "exact ref 只解析一次；讀一次 Git tree，再讀 declared blobs，做 schema／path／size／digest／canonical／redaction／Wasm 靜態檢查，只寫 bounded D1 summary。",
    proof: "validation path 沒有 archive、tarball、temporary R2、ValidationContainer、instantiate 或 execute。",
    evidence: ["worker/catalog-github.ts", "worker/catalog-workflows.ts", "worker/catalog.ts", "src/online-judge/trusted-judge-wasm.ts"],
  },
  {
    id: "R-10",
    priority: "P1",
    area: "Catalog admission",
    problem: "validation／publish 曾能在任何 global／organizer admission fence 前消耗 GitHub 與 Workflow 資源。",
    impact: "單一 Organizer 或重試風暴可放大 API fetch、活著的 Workflow 與 D1 work。",
    cause: "容量限制只放在最後端 compute，而非控制平面入口。",
    solution: "Catalog admission 在 GitHub fetch 前套用 global active 5／queued 50、per-organizer active 1／queued 3；同樣由 D1 dispatcher 派發。",
    proof: "超限先拒絕，queued row 是唯一 authority，不新增 Queue、Redis 或 validation service。",
    evidence: ["worker/catalog-dispatcher.ts", "worker/catalog.ts", "worker/catalog-workflows.ts", "config/capacity.json"],
  },
  {
    id: "R-11",
    priority: "P1",
    area: "Progress events",
    problem: "每個 case 都寫永久 D1 event，client 又固定每秒 polling。",
    impact: "case 數與觀看頁面數直接放大 D1 writes／reads；10,000 cases 可產生萬級事件。",
    cause: "細粒度 telemetry 與 durable state transition 沒有分層。",
    solution: "只記 first／final／百分比 bucket；每 attempt 最多 101 筆 progress。poll API 合併 summary + events，client 以 1→2→5→10 秒退避，terminal 停止。",
    proof: "10,000-case 測試精確得到 compile 1 + case progress 100；transport 與 unchanged polling backoff 均有測試。",
    evidence: ["container/progress.mjs", "container/progress.test.mjs", "worker/submission-events.ts", "src/online-judge/submission-event-polling.test.ts"],
  },
  {
    id: "R-12",
    priority: "P1",
    area: "Runtime resources",
    problem: "immutable runtime bytes 被多層掃描／hash／複製；Clang／Python eager init；Go stdlib 曾以 base64 JSON 重複傳輸。",
    impact: "cold start、記憶體峰值與 GC 隨大型 toolchain 放大，非相關語言也支付初始化成本。",
    cause: "缺少 process-local verified distribution 與 digest-bound compiler session。",
    solution: "Container inventory 一次產生 VerifiedDistribution；Clang graph、Python resolver lazy init；Go／Rust hydrate once + source delta，native child 使用 framed binary／readonly digest path。",
    proof: "factory 接受同一 verified capability；非 C/C++ 不讀 graph；Go session digest fail closed 並跨 build 重用 toolchain。",
    evidence: ["src/server/verified-distribution.ts", "src/server/factory.test.ts", "src/compiler/indexeddb-build-graph-cache.test.ts", "src/runtime/go-compiler-session.test.ts"],
  },
  {
    id: "R-13",
    priority: "P1",
    area: "Effective results",
    problem: "多代 rejudge、部分失敗與不同 leaderboard／profile 查詢曾可能各自選到不同結果。",
    impact: "A→B→C 後可能仍顯示 A／B，solved、榜單與 freeze 互相衝突。",
    cause: "沒有 origin_submission_id、canonical lineage head 與共用 effective-results view。",
    solution: "每個 original 固定 origin；batch 全 terminal 後以單一 transaction 把 lineage B→C；所有產品查詢共用 effective view。相同 semantic digest 直接 no-op。",
    proof: "多代、same-semantic no-op、失敗 child、leaderboard 與產品 projection 測試固定：管理版本到 C，結果採最深的有效 child；contest 顯示仍鎖原 publication。",
    evidence: ["migrations/core/0017_architecture_reset.sql", "worker/rejudge.ts", "worker/rejudge-lifecycle.test.ts", "src/online-judge/submission-projection.test.ts", "worker/leaderboards.test.ts"],
  },
  {
    id: "R-14",
    priority: "P1",
    area: "D1 immutability",
    problem: "已發布 revision、package、publication、problem version 若可原地 UPDATE／DELETE，digest 與歷史關聯就不可信。",
    impact: "相同管理 UUID 可能指向不同 bytes，重判與正式結果失去可重現性。",
    cause: "不可變 domain 與 lifecycle pointer 未在 schema 層分離。",
    solution: "immutable rows 採 INSERT-only；D1 triggers 拒絕 UPDATE／DELETE，activation 與 lifecycle state 另表管理。outbox 為 payloadless typed FK 且 exactly-one-target。",
    proof: "negative SQL tests 對 revision、revision problem、ready package、publication、problem version 的直接變更全部失敗。",
    evidence: ["migrations/core/0017_architecture_reset.sql", "scripts/architecture-reset-migration.test.mjs", "worker/release-activation.test.ts"],
  },
];

const flows = [
  {
    number: "01",
    name: "VALIDATE",
    title: "驗證只回答：這個 exact commit 能否安全發布？",
    nodes: ["D1 admission", "ref → 40-char SHA", "Git commit + tree", "declared blobs", "static validator", "D1 valid revision"],
    note: "不抓 archive、不寫 R2、不啟 Container、不編譯／執行 checker、interactor 或 reference。",
    evidence: "worker/catalog-workflows.ts",
  },
  {
    number: "02",
    name: "PUBLISH",
    title: "發布才把執行所需 bytes 固定成 runtime snapshot。",
    nodes: ["explicit request", "exact commit", "WOJJDG02 stream", "R2 conditional put", "checksum + metadata", "D1 immutable publication"],
    note: "所有 package ready 後才以單一 D1 batch 建立 publication／versions；activation 是另一個明確動作。",
    evidence: "worker/catalog-workflows.ts",
  },
  {
    number: "03",
    name: "SUBMIT",
    title: "先確立 D1 intent，再讓 source 與判題安全前進。",
    nodes: ["reserve source + submit", "conditional R2 put", "epoch recheck", "FIFO claim", "Submission Workflow", "no-network Container", "D1 terminal summary"],
    note: "Official Submit 不依賴 GitHub；GitHub outage 只會暫時影響題目顯示。",
    evidence: "worker/submissions.ts · worker/dispatcher.ts",
  },
  {
    number: "04",
    name: "REJUDGE",
    title: "產品版本先切換，結果 lineage 再原子前進。",
    nodes: ["activate C", "select effective B origins", "children share source_id", "terminal barrier", "transaction B → C", "shared effective view"],
    note: "相同 execution semantic digest 是 no-op；contest 僅在結束後允許 rejudge。",
    evidence: "worker/rejudge.ts · worker/leaderboards.ts",
  },
] as const;

const performance = [
  {
    area: "Validation payload",
    before: "128 MiB archive 先收 chunks 再複製；峰值約 ≥256 MiB",
    after: "不下載 archive；只讀 declared blobs，8／32 MiB 邊界 fail closed",
    basis: "前值＝程式路徑估算；後值＝結構性不變量",
  },
  {
    area: "Waiting queue",
    before: "450 waiting × 每 10 秒約 2 次 D1 操作 ≈ 90 ops/s",
    after: "等待者 0 次週期性 polling；dispatcher 在事件／每分鐘 reconciler 觸發",
    basis: "前值＝模型估算；後值＝程式路徑＋FIFO 測試",
  },
  {
    area: "10,000-case progress",
    before: "約 10,000 筆 case events，另加 compile／terminal",
    after: "101 筆 progress 上限（1 compile + 100 buckets）",
    basis: "前值＝舊 callback 次數估算；後值＝單元測試量測",
  },
  {
    area: "Verified cache hit",
    before: "71 MiB 級 Rust asset 每次 full buffer + SHA-256",
    after: "同 cache generation 命中時新增 digest 呼叫＝0，body 直接串流",
    basis: "前值＝資產尺寸／舊路徑；後值＝digest spy 量測",
  },
  {
    area: "R2 domain surface",
    before: "archive、snapshot、projection、report、audit、source、release／receipt 等多類物件",
    after: "2 類：judge-packages/v2/{digest}、submission-sources/v2/{sourceId}",
    basis: "schema／prefix inventory，非延遲 benchmark",
  },
  {
    area: "Runtime initialization",
    before: "重複 filesystem inventory；Clang／Python eager；Go immutable bytes 重送",
    after: "inventory 1 次；語言按需 lazy；Go digest-bound session hydrate once",
    basis: "capability／lifecycle tests，尚無 production P95",
  },
] as const;

const p2 = [
  ["Production SLI", "補 queue oldest age、slot occupancy、D1 latency、R2 bytes/hash、container startup 與 judge duration；用真實 P50／P95 決定下一步。"],
  ["Read models", "只有 leaderboard／profile query 被量測為瓶頸時，才加短 TTL／ETag 或 transactionally maintained best-result projection。"],
  ["Static delivery", "以 Cloudflare 指標確認 Worker static-asset CPU 成本後，再考慮把 immutable assets 更直接交給 asset layer。"],
  ["Compiler diagnostics", "若長 diagnostics 顯示非線性 allocation，再加入 incremental decoder、dirty generation 與無變化退避。"],
  ["Zero-downtime cutover", "目前正式採一次維護窗口；只有產品要求零停機時，才引入 expand／contract 與多版本 runtime。"],
] as const;

const dataModelGroups = [
  {
    label: "AUTHORING",
    tables: [
      ["problem_collections", "repo + index path", "題庫產品邊界"],
      ["collection_revisions", "exact commit + digest", "validated immutable revision"],
      ["collection_revision_problems", "revision + series", "唯一題目 metadata authority"],
      ["problem_series", "collection + slug", "跨版本產品延續身份"],
    ],
  },
  {
    label: "PUBLICATION",
    tables: [
      ["catalog_publications", "revision + mode", "成功發布的 immutable row"],
      ["problem_versions", "publication + series + semantic", "薄 identity link"],
      ["problem_version_details", "read-only view", "由 revision JOIN 還原內容欄位"],
      ["official_practice_heads", "series → version", "唯一 practice activation pointer"],
      ["judge_packages", "SHA-256", "R2 staging／ready／deleting fence"],
    ],
  },
  {
    label: "EXECUTION",
    tables: [
      ["submission_sources", "source UUID", "bytes authority + erasure queue"],
      ["submissions", "origin + version + semantic", "正式狀態與 terminal summary"],
      ["submission_attempts", "submission + attempt", "callback token／retry fence"],
      ["submission_events", "submission + cursor", "bounded progress log"],
    ],
  },
  {
    label: "CONTEST / REJUDGE",
    tables: [
      ["contests", "publication", "contest lifecycle"],
      ["contest_problems", "contest + series + pinned version", "顯示／freeze authority"],
      ["rejudge_batches", "old version → new version", "整批 atomic activation"],
      ["rejudge_jobs", "batch + origin", "deterministic child result"],
      ["problem_version_lineages", "predecessor → successor", "canonical effective chain"],
    ],
  },
  {
    label: "CONTROL PLANE",
    tables: [
      ["wasm_oj_releases", "immutable manifest", "release identity"],
      ["wasm_oj_active_releases", "environment → release", "唯一 active authority"],
      ["workflow_outbox", "exactly one typed target", "D1 ↔ Workflow crash fence"],
      ["maintenance_cursors", "retention kind", "elapsed-time keyset progress"],
    ],
  },
] as const;

const modelRelations = [
  "collection → revision → revision_problem ← series",
  "revision → publication → problem_version ← judge_package",
  "problem_version → submission ← submission_source",
  "publication → contest → contest_problem → pinned problem_version",
  "submission origin → rejudge_job ← batch → lineage",
  "release manifest → environment active pointer",
] as const;

function Evidence({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="evidence-list" aria-label="實作證據">
      {items.map((item) => <li key={item}><code>{item}</code></li>)}
    </ul>
  );
}

function RepairCard({ repair }: { readonly repair: Repair }) {
  return (
    <article className="repair-card" id={repair.id.toLowerCase()}>
      <header>
        <div className="repair-flags">
          <span className="repair-id">{repair.id}</span>
          <span className={`priority ${repair.priority.toLowerCase()}`}>{repair.priority}</span>
          <span className="required-tag">必要修改 · 已實作</span>
        </div>
        <p className="repair-area">{repair.area}</p>
      </header>
      <div className="repair-chain">
        <div><span>問題</span><p>{repair.problem}</p></div>
        <div><span>影響</span><p>{repair.impact}</p></div>
        <div><span>根因</span><p>{repair.cause}</p></div>
        <div className="solution"><span>實作方案</span><p>{repair.solution}</p></div>
        <div><span>驗證</span><p>{repair.proof}</p></div>
      </div>
      <details>
        <summary>查看實際 v2 證據路徑</summary>
        <Evidence items={repair.evidence} />
      </details>
    </article>
  );
}

function Flow({ flow }: { readonly flow: (typeof flows)[number] }) {
  return (
    <article className="flow-card">
      <header>
        <span>{flow.number}</span>
        <p>{flow.name}</p>
        <h3>{flow.title}</h3>
      </header>
      <ol className="flow-line" aria-label={`${flow.name} 資料流`}>
        {flow.nodes.map((node) => <li key={node}>{node}</li>)}
      </ol>
      <p className="flow-note">{flow.note}</p>
      <code className="flow-evidence">{flow.evidence}</code>
    </article>
  );
}

export default function Home() {
  return (
    <main id="top">
      <a className="skip-link" href="#content">跳到主要內容</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="回到報告頂端"><b>W</b><span>WASM-OJ / ARCHITECTURE v2</span></a>
        <nav aria-label="報告章節">
          <a href="#verdict">結論</a>
          <a href="#architecture">架構</a>
          <a href="#data-model">資料表</a>
          <a href="#flows">資料流</a>
          <a href="#repairs">R-01—14</a>
          <a href="#performance-lab">效能 Lab</a>
          <a href="#cutover">切換</a>
        </nav>
      </header>

      <header className="hero">
        <div className="hero-meta"><span>CHIEF ARCHITECT · IMPLEMENTATION REPORT</span><span>2026.08.12</span></div>
        <div className="hero-main">
          <div>
            <p className="kicker light">SYSTEM ARCHITECTURE v2</p>
            <h1>P0／P1<br /><em>已落地。</em></h1>
            <p className="hero-lead">題庫回歸 GitHub exact commit；D1 只管版本與狀態；R2 收斂為兩種不可替代的執行 bytes；Container 只在 Official Submit／rejudge 出場。</p>
          </div>
          <aside className="go-card" aria-label="首席架構師判定">
            <span>ARCHITECT VERDICT</span>
            <strong>GO</strong>
            <p>程式實作完成。正式環境須經受保護的單次維護窗口切換；在 smoke tests 通過前不解除 maintenance。</p>
          </aside>
        </div>
        <div className="hero-stats" aria-label="實作摘要">
          <div><strong>14 / 14</strong><span>必要修改已實作</span></div>
          <div><strong>2</strong><span>R2 正式物件類型</span></div>
          <div><strong>0</strong><span>Validation container</span></div>
          <div><strong>101</strong><span>每 attempt progress 上限</span></div>
          <div><strong>50 / 10</strong><span>Active / rejudge slots</span></div>
        </div>
      </header>

      <div id="content">
        <section className="section verdict-section" id="verdict">
          <div className="section-label"><span>01</span><p>EXECUTIVE VERDICT</p></div>
          <div className="section-content">
            <p className="kicker">OUTCOME FIRST</p>
            <h2>不是把舊系統補強；是把責任邊界重新切乾淨。</h2>
            <div className="verdict-grid">
              <div className="verdict-copy">
                <p className="lead">v2 已處理先前識別的 3 個 P0 與 11 個 P1。核心拓撲仍維持 Worker + D1 + R2 + Workflows + one-shot Container，沒有新增 Queue、Redis、warm pool、validation service 或第二套版本 authority。</p>
                <p>最大的簡化是：<strong>validation 不再執行題目，平台也不再複製整份題庫。</strong>GitHub 管 authoring history；D1 管 exact commit、semantic digest、UUID、關聯與狀態；R2 只保存 GitHub／D1 無法安全取代的 judge package 與使用者 source。</p>
              </div>
              <aside className="status-board">
                <div><span>Code</span><strong className="done">COMPLETE</strong></div>
                <div><span>R-01—R-14</span><strong className="done">IMPLEMENTED</strong></div>
                <div><span>Full regression</span><strong className="done">PASS</strong></div>
                <div><span>Production reset</span><strong className="pending">NOT RUN</strong></div>
                <div><span>Public site</span><strong className="pending">READY TO PUBLISH</strong></div>
                <p>「已實作」不等於「已切正式資料」。production reset、題庫重發與 smoke tests 仍必須在維護窗口執行。</p>
              </aside>
            </div>
            <div className="decision-strip">
              <span>必要修改</span>
              <p>R-01～R-14 全數進入 v2 implementation；正式切換前任何 failing full-regression、inventory mismatch、reset token mismatch 或 smoke failure 都是 hard stop。</p>
            </div>
          </div>
        </section>

        <section className="section" id="architecture">
          <div className="section-label"><span>02</span><p>CURRENT → TARGET</p></div>
          <div className="section-content">
            <p className="kicker">ARCHITECTURE DELTA</p>
            <h2>從「平台同步題庫」改成「平台保存精確指標與執行快照」。</h2>
            <p className="section-intro">左側是 v2 前已退役的資料流；右側是目前完成的目標實作。差異不在換技術，而在刪掉重複 authority 與不必要運算。</p>

            <div className="architecture-compare">
              <figure className="architecture-panel legacy">
                <figcaption><span>BEFORE</span><strong>舊路徑 · 已退役</strong></figcaption>
                <div className="arch-row"><b>GitHub push/latest</b><i>→</i><b>import + archive</b></div>
                <div className="arch-down">↓</div>
                <div className="arch-row"><b>temporary R2</b><i>→</i><b>Validation Container</b></div>
                <div className="arch-down">↓</div>
                <div className="arch-wide">snapshot · public projection · reports · audits · source</div>
                <ul>
                  <li>平台重複決定 latest／版本</li>
                  <li>validation 下載、緩衝並執行</li>
                  <li>R2 同時是 staging、projection、audit 與 source store</li>
                </ul>
              </figure>

              <figure className="architecture-panel target">
                <figcaption><span>AFTER</span><strong>Architecture v2 · 已實作</strong></figcaption>
                <div className="arch-source">GitHub exact commit <small>authoring authority</small></div>
                <div className="arch-split" aria-hidden="true"><span>↙</span><span>↓</span><span>↘</span></div>
                <div className="arch-three">
                  <b>Static<br />Validation</b>
                  <b>Public-content<br />Proxy</b>
                  <b>Explicit<br />Publish</b>
                </div>
                <div className="arch-split" aria-hidden="true"><span>↓</span><span>↓</span><span>↓</span></div>
                <div className="arch-three stores"><b>D1<br /><small>pointers + state</small></b><b>UI<br /><small>≤300s cache</small></b><b>R2<br /><small>judge package</small></b></div>
                <div className="judge-lane"><span>Official Submit</span><i>→</i><span>D1 FIFO</span><i>→</i><span>No-network Container</span></div>
              </figure>
            </div>

            <div className="authority-grid" aria-label="權責分工">
              <article><span>01</span><h3>GitHub</h3><p>題庫 authoring、版本歷史與 exact commit bytes。平台不輪詢 latest，也不複製整個 repository。</p></article>
              <article><span>02</span><h3>D1</h3><p>exact commit、content digest、管理 UUID、狀態、關聯、正式 head、queue 與 terminal summary。</p></article>
              <article><span>03</span><h3>R2</h3><p>只存 immutable judge packages 與 submission sources；不再存 public projection、audit、release manifest 或 erasure receipt。</p></article>
              <article><span>04</span><h3>Container</h3><p>只在 Official Submit／rejudge 編譯與執行；無網路、one-shot，不參與題庫 validation。</p></article>
            </div>
          </div>
        </section>

        <section className="section model-section" id="data-model">
          <div className="section-label"><span>03</span><p>SIMPLIFIED ER MODEL</p></div>
          <div className="section-content">
            <p className="kicker">ONE FACT · ONE AUTHORITY</p>
            <h2>主資料表保留必要身份；重複 projection 改成唯讀 JOIN。</h2>
            <p className="section-intro">這次不是為了追求最少 table，而是刪除同一事實的第二份權威。<code>problem_versions</code> 只保留 publication、series 與 execution semantic identity；顯示資料統一由 immutable revision view 投影。</p>

            <div className="relation-map" aria-label="主要資料表關係">
              {modelRelations.map((relation, index) => (
                <div key={relation}><span>{String(index + 1).padStart(2, "0")}</span><code>{relation}</code></div>
              ))}
            </div>

            <div className="model-groups">
              {dataModelGroups.map((group) => (
                <article className="model-group" key={group.label}>
                  <header>{group.label}</header>
                  <div>
                    {group.tables.map(([name, identity, role]) => (
                      <section className="model-table" key={name}>
                        <code>{name}</code>
                        <strong>{identity}</strong>
                        <p>{role}</p>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="schema-delta">
              <span>REMOVED DUPLICATION</span>
              <p><code>rejudge_results</code>、<code>maintenance_tasks</code>、<code>waiting-capacity</code>、release status、publication／revision 常數狀態，以及 version／contest 的 metadata mirror 已移除。Outbox 只保留三種 typed target；rejudge batch 與 source row 本身就是 durable queue。</p>
            </div>
          </div>
        </section>

        <section className="section dark-section" id="flows">
          <div className="section-label"><span>04</span><p>DATA FLOWS</p></div>
          <div className="section-content">
            <p className="kicker light">FOUR AUTHORITATIVE FLOWS</p>
            <h2>每個副作用只有一個 authority，每個大 bytes 流向都有界。</h2>
            <div className="flows-grid">{flows.map((flow) => <Flow key={flow.number} flow={flow} />)}</div>
          </div>
        </section>

        <section className="section" id="r2">
          <div className="section-label"><span>05</span><p>R2 LIFECYCLE</p></div>
          <div className="section-content">
            <p className="kicker">TWO BYTE CLASSES ONLY</p>
            <h2>R2 不再是第二個資料庫。</h2>
            <p className="section-intro">D1 保存可查詢的 identity、state 與關聯；R2 保存執行時真正需要、且不適合塞進 D1 的 bytes。所有 key 都可由不含個資的 identity 推導。</p>
            <div className="r2-compare">
              <div className="r2-before">
                <span>BEFORE · 多重責任</span>
                <div className="prefix-cloud">
                  {['imports/', 'canonical/', 'public-projections/', 'reports/', 'audits/', 'old sources/', 'release objects', 'erasure receipts'].map((item) => <code key={item}>{item}</code>)}
                </div>
                <p>切換後經 24 小時 late-write fence，才按精確 inventory／prefix 清理；禁止 bucket-wide delete。</p>
              </div>
              <div className="r2-after">
                <span>AFTER · 兩種 bytes</span>
                <article>
                  <code>judge-packages/v2/{'{semanticDigest}'}</code>
                  <h3>Immutable judge package</h3>
                  <div className="state-line"><b>staging</b><i>→</i><b>ready</b><i>→</i><b>deleting</b></div>
                  <p>WOJJDG02 exact bytes；相同 digest 可跨 repository 共用 object/cache。被 publication／submission 引用就保留；無引用 staging／orphan 24 小時後以 per-digest fence GC。</p>
                </article>
                <article>
                  <code>submission-sources/v2/{'{sourceId}'}</code>
                  <h3>Submission source</h3>
                  <div className="state-line"><b>reserved</b><i>→</i><b>ready</b><i>→</i><b>erasing</b><i>→</i><b>erased</b></div>
                  <p>不含 user／submission／digest。帳號刪除前永久；刪除時在同 key 無條件覆寫常數 tombstone，source tombstone 與 D1 receipt 永久保留。</p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="section repairs-section" id="repairs">
          <div className="section-label"><span>06</span><p>R-01—R-14</p></div>
          <div className="section-content">
            <p className="kicker">REPAIR MATRIX</p>
            <h2>問題 → 影響 → 根因 → 實作方案 → 驗證。</h2>
            <p className="section-intro">以下全部屬於本次必要修改，而不是建議清單。證據列指向 v2 實際程式、migration 或 focused test。</p>
            <div className="repair-index" aria-label="修復索引">
              {repairs.map((repair) => <a key={repair.id} href={`#${repair.id.toLowerCase()}`}>{repair.id}<small>{repair.priority}</small></a>)}
            </div>
            <div className="repairs-grid">{repairs.map((repair) => <RepairCard key={repair.id} repair={repair} />)}</div>
          </div>
        </section>

        <section className="section performance-section" id="performance">
          <div className="section-label"><span>07</span><p>RESOURCE DELTA</p></div>
          <div className="section-content">
            <p className="kicker">BEFORE / AFTER</p>
            <h2>已消除結構性浪費；production 數字仍必須實測。</h2>
            <p className="section-intro">為避免製造假精準度，下表把「程式路徑估算」「測試量測」「結構性不變量」分開。這不是 production latency benchmark。</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>面向</th><th>v1 / Before</th><th>v2 / After</th><th>證據性質</th></tr></thead>
                <tbody>{performance.map((row) => <tr key={row.area}><th>{row.area}</th><td>{row.before}</td><td>{row.after}</td><td><span className="basis">{row.basis}</span></td></tr>)}</tbody>
              </table>
            </div>
            <div className="perf-callout"><strong>Chief Architect reading</strong><p>v2 已把成本曲線從「隨等待者／case／大型 immutable bytes 重複增加」改成「有固定上限或只在 admission 發生一次」。下一輪最佳化不應再靠直覺；必須由 production SLI 觸發。</p></div>
          </div>
        </section>

        <section className="section performance-lab-section" id="performance-lab">
          <div className="section-label"><span>08</span><p>PERFORMANCE LAB</p></div>
          <div className="section-content">
            <p className="kicker">PRODUCT READ MODEL · NO NEW STORE</p>
            <h2>把判題成本變成可比較、可操作的最佳化路徑。</h2>
            <p className="section-intro">Performance Lab 直接讀 D1 的 effective results，不建立 leaderboard projection、分析資料庫或背景同步服務。每個 managed problem 都有相同介面：全域 Pareto 前緣、個人時間演進與選定提交的三層 policy 摘要。</p>

            <div className="lab-report-grid">
              <figure className="lab-report-preview">
                <figcaption><span>GLOBAL FRONTIER + OWNER EVOLUTION</span><strong>越靠左上越有效率</strong></figcaption>
                <div className="lab-report-plot" aria-label="分數、log1p 確定性成本與記憶體散佈圖示意">
                  <span className="lab-axis axis-y">SCORE</span><span className="lab-axis axis-x">LOG1P COST →</span>
                  <i className="lab-grid vertical one" /><i className="lab-grid vertical two" /><i className="lab-grid vertical three" />
                  <i className="lab-grid horizontal one" /><i className="lab-grid horizontal two" /><i className="lab-grid horizontal three" />
                  <i className="lab-segment frontier first" /><i className="lab-segment frontier second" />
                  <i className="lab-segment evolution first" /><i className="lab-segment evolution second" />
                  <span className="lab-dot rust point-a"><b>Rust</b></span>
                  <span className="lab-dot python point-b"><b>Python</b></span>
                  <span className="lab-dot go point-c"><b>Go</b></span>
                  <span className="lab-dot owner point-d"><b>#17</b></span>
                  <span className="lab-dot owner point-e"><b>#18</b></span>
                  <span className="lab-dot owner point-f"><b>#19</b></span>
                </div>
                <div className="lab-report-legend"><span><i className="rust" />語言</span><span><i className="frontier" />Pareto frontier</span><span><i className="owner" />我的演進箭頭</span><span><i className="memory" />點大小＝peak memory</span></div>
                <dl className="lab-accessible-table">
                  <div><dt>Rust · Pareto</dt><dd>100 pts · 8.0k cost · 1.0 MiB</dd></div>
                  <div><dt>Attempt #19</dt><dd>98 pts · 9.0k cost · 2.0 MiB</dd></div>
                </dl>
              </figure>

              <aside className="lab-contract">
                <span>BOUNDED CONTRACT</span>
                <div><strong>100</strong><p>global best-per-user points；依 dominance-compatible 次序取樣後，在有界集合精確標記 Pareto。</p></div>
                <div><strong>200</strong><p>最近個人 attempts，保留全歷史序號；截斷由 <code>myEvolutionTruncated</code> 明示。</p></div>
                <div><strong>3</strong><p><code>baseline → efficient → optimal</code> 固定順序，選點後才讀 policy summary。</p></div>
                <div><strong>0</strong><p>新增 queue、cache、projection table 或 telemetry service。</p></div>
              </aside>
            </div>

            <div className="lab-policy-flow" aria-label="Performance Lab 資料與授權流程">
              <article><span>01 · CONTEXT</span><h3>Exact managed version</h3><p>Practice 綁 official head；contest 必須是 pinned version。無權限、未發布或錯誤 context 一律 404。</p></article>
              <article><span>02 · FREEZE</span><h3>Server-side projection</h3><p>非 Organizer 在 freeze 期間只看 freeze 前的 global frontier；自己的 evolution 不截斷，UI 顯示明確封榜狀態。</p></article>
              <article><span>03 · SELECT</span><h3>Policy ladder</h3><p>只有可讀且完成的 submission 能取得 summary；錯誤 attempt 仍保留事件列，不偽造成零分座標。</p></article>
            </div>

            <div className="lab-evidence">
              <div><strong>FAIL-CLOSED CLIENT</strong><p>response 使用 exact-key parser；problem、contest、language、UUID、ISO timestamp、上限、canonical policy order 與 accepted-output invariants 全部驗證。</p></div>
              <Evidence items={["worker/performance.ts", "worker/product.ts", "src/features/judge/model/performance-contract.test.ts", "src/features/judge/components/performance-lab.test.ts"]} />
            </div>
          </div>
        </section>

        <section className="section cutover-section" id="cutover">
          <div className="section-label"><span>09</span><p>CUTOVER SAFETY</p></div>
          <div className="section-content">
            <p className="kicker">IMPLEMENTED, NOT YET EXECUTED</p>
            <h2>正式切換是一個受保護的狀態機，不是一串可隨意重跑的 SQL。</h2>
            <div className="cutover-layout">
              <ol className="timeline">
                {[
                  ["Maintenance gate", "mutation API 回 503；本機 practice 繼續可用。"],
                  ["Drain", "停止 catalog／submission／rejudge／erasure，等待最大 timeout + margin。"],
                  ["Inventory + tombstone", "盤點舊 D1/R2，先覆寫舊 source keys，阻擋 late writer。"],
                  ["Guarded reset", "reset token、inventory、receipt、drained precondition 缺一即拒絕。"],
                  ["Deploy v2", "Worker、Submission Container、Submission Workflow、Catalog Workflow。"],
                  ["Atomic release", "immutable manifest → environment pointer 由 expected-current D1 batch 一次完成。"],
                  ["Re-seed catalog", "由 exact commit validate → publish → activate。"],
                  ["Smoke", "全域 gate 保持關閉；授權 maintenance-only token lane 以 constant-time token 驗證後，執行 text、checker、interactive、rejudge、contest、account erasure。"],
                  ["Reopen", "全部 smoke 成功才 resume，並刪除／輪替 smoke token。"],
                  ["24h cleanup", "依精確 inventory/prefix 刪 legacy objects，永不 bucket-wide delete。"],
                ].map(([title, body], index) => <li key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{title}</strong><p>{body}</p></div></li>)}
              </ol>
              <aside className="cutover-status">
                <span>CURRENT STATUS</span>
                <strong>READY FOR<br />MAINTENANCE</strong>
                <dl>
                  <div><dt>Reset migration</dt><dd>implemented</dd></div>
                  <div><dt>Protected workflows</dt><dd>implemented</dd></div>
                  <div><dt>Atomic activation</dt><dd>tested</dd></div>
                  <div><dt>Production mutation</dt><dd>not started</dd></div>
                  <div><dt>24h fence</dt><dd>not started</dd></div>
                </dl>
                <p>正式資料會重置；identity、auth、profile、roles、GitHub authority 與 erasure tombstones 依計畫保留。</p>
                <Evidence items={["migrations/core/0017_architecture_reset.sql", "scripts/architecture-reset-r2.mjs", "scripts/production-migrations.mjs", ".github/workflows/cloudflare-architecture-v2-cutover.yml", ".github/workflows/cloudflare-architecture-v2-cleanup.yml"]} />
              </aside>
            </div>
          </div>
        </section>

        <section className="section p2-section" id="p2">
          <div className="section-label"><span>10</span><p>FURTHER OPTIMIZATION</p></div>
          <div className="section-content">
            <p className="kicker">P2 · NON-BLOCKING</p>
            <h2>現在停止加元件；先量測，再決定下一個瓶頸。</h2>
            <p className="section-intro">這些是進一步最佳化，不屬於本次上線必要修改。沒有 production 證據時，不導入新的 queue、cache service、projection store 或 runtime pool。</p>
            <div className="p2-grid">
              {p2.map(([title, body], index) => <article key={title}><span>O-{String(index + 1).padStart(2, '0')}</span><h3>{title}</h3><p>{body}</p><small>P2 · 量測後決定</small></article>)}
            </div>
          </div>
        </section>
      </div>

      <footer>
        <div><b>WASM-OJ</b><span>ARCHITECTURE v2</span></div>
        <p>Chief Architect implementation report · 2026.08.12</p>
        <a href="#top">回到頂端 ↑</a>
      </footer>
    </main>
  );
}
