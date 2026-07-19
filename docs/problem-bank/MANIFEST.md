# Catalog、manifest 與計分契約

## GitHub API discovery

Repository consumer 必須從根目錄的 `catalog.json` 開始，不得列出 `problems/`
後猜測目錄名稱。Catalog 依題號排序，並為每題提供 manifest 的 repository-relative
POSIX path：

```json
{
  "schema": "wasm-oj-catalog-v2",
  "problemSchema": "wasm-oj-problem-v3",
  "localization": {
    "defaultLocale": "zh-TW",
    "supportedLocales": ["zh-TW", "en"]
  },
  "problems": [
    {
      "id": 1,
      "slug": "weighted-opcode-scale",
      "manifest": "problems/001-weighted-opcode-scale/problem.json"
    }
  ]
}
```

取得 `problem.json` 後，所有內容檔都由 `files` 明確列出。路徑相對於該
`problem.json` 所在目錄，而不是 process cwd 或 repository root。Consumer 不得自行
拼接 `statement.zh-TW.md`、`solutions/<language>/main.*` 或 `tests/*.in`：

```json
{
  "title": {
    "zh-TW": "操作碼秤重站",
    "en": "Weighted Opcode Scale"
  },
  "files": {
    "statements": {
      "zh-TW": "statement.zh-TW.md",
      "en": "statement.en.md"
    },
    "editorials": {
      "zh-TW": "editorial.zh-TW.md",
      "en": "editorial.en.md"
    },
    "validator": "validator.py",
    "generator": "generator.py",
    "oracle": "oracle.py",
    "solutions": {
      "c": "solutions/c/main.c",
      "cpp": "solutions/cpp/main.cpp",
      "rust": "solutions/rust/main.rs",
      "go": "solutions/go/main.go",
      "python": "solutions/python/main.py",
      "javascript": "solutions/javascript/main.js",
      "typescript": "solutions/typescript/main.ts"
    },
    "tests": [
      {
        "id": "sample-01",
        "kind": "sample",
        "input": "tests/sample-01.in",
        "output": "tests/sample-01.out"
      }
    ]
  }
}
```

`catalog.localization.supportedLocales` 是 locale discovery 的唯一來源，順序同時是 UI
建議顯示順序。`defaultLocale` 必須是其中一員。每份 manifest 的 `title`、policy
`title`、complexity `name`、`files.statements` 與 `files.editorials` 都必須完整覆蓋同一組
locale；consumer 不得在缺檔時靜默退回其他語言。若使用者指定不支援的 locale，應先由
catalog contract 拒絕，而不是猜測最接近的語言。

所有 manifest path 都必須是 case-sensitive、normalized POSIX relative path；禁止
absolute path、反斜線、NUL、空 segment、`.`、`..` 與重複 `/`。GitHub Contents API、
Git Trees API 或 raw-content client 都可以把 manifest 所在目錄與此 path 做 URL path
resolution，不需要模擬 host filesystem。

## Cost-first cumulative policies

`scoring.mode` 固定為 `per-case-cumulative-policies`，`scoring.caseSet` 固定為
`all-manifest-tests`。計分 case set 就是 `files.tests` 依 manifest 順序列出的所有 cases；
所有 policy 使用完全相同的 case set，judge 不為不同分數層級準備不同測資。

`scoring.costContract` 固定為 `wasm-oj-forge-v1`。這個 ID 綁定 Forge contract 1 的
compiler／runner、weighted opcode table、meter placement、artifact cost-profile validation
與 empty-program baseline normalization；不能只看 `costModel=weighted` 後自行選另一套
weights。權威契約固定引用校準證據所記錄的 Forge commit
`baac61a2d3734b8689bc19e6871fef1c4f63ce8d` 的
[verdict and metrics contract](https://github.com/wasm-oj/forge/blob/baac61a2d3734b8689bc19e6871fef1c4f63ce8d/docs/library-contract.md#verdict-and-metrics-contract)
、[weighted instruction metering](https://github.com/wasm-oj/forge/blob/baac61a2d3734b8689bc19e6871fef1c4f63ce8d/docs/architecture.md#weighted-instruction-metering)
及 [versioning policy](https://github.com/wasm-oj/forge/blob/baac61a2d3734b8689bc19e6871fef1c4f63ce8d/docs/versioning.md)。Judge
遇到不同 Forge contract、artifact profile 不符、缺少 calibration 或 metric 不可用時必須
fail closed，不得猜測或換算。

每個 case 只需在最寬鬆 policy 的 hard limits 下執行一次。若答案正確且正常完成，judge
把該次執行的 metrics 同時套用到每個 policy：

- `instructionBudget` 比對 Forge `RunResult.metrics.cost` 回報的 baseline-normalized net
  weighted cost；
- `memoryLimitBytes` 比對 guest peak linear memory，不是 browser／Node process RSS；
- `logicalTimeLimitMs` 若存在，才比對 deterministic virtual elapsed time。

各限制都是 inclusive upper bound：metric 小於或等於對應 limit 才通過；未宣告
`logicalTimeLimitMs` 的 policy 不限制 logical time。換言之，policy pass 當且僅當答案
正確、execution 正常完成，而且該 policy 宣告的每個 metric 都 `metric <= limit`。
`logicalTimeLimitMs` 以整數方式比對
`RunResult.metrics.logicalTimeNs <= logicalTimeLimitMs × 1,000,000`，不做浮點換算或四捨五入。

答案錯誤、runtime failure，或超過最寬鬆 policy 時，該 case 的所有 policy 都不通過。
Policies 必須由寬到嚴排列，而且每一層至少收緊一個資源；因此通過較嚴格 policy 必然也
通過其前面的寬鬆 policies。
本 catalog 的有序 policy ID 固定為 `baseline`、`efficient`、`optimal`；缺少、重複或
重新排序任何一層都不符合 calibration contract。

Forge contract 1 會在所有函式及 start section 注入 weighted meter。Runner 依 submission
artifact 的 exact contract、language、target、optimization、compiler/runtime content 與
meter model 找到已校準的 empty-program baseline，並套用：

```text
raw instruction budget = baseline + manifest instructionBudget
reported metrics.cost  = max(0, observed rawCost - baseline)
```

Baseline 只扣除該 runtime profile 的固定啟動成本；載入／解析 user module、imports、
stdin／arguments／environment、deterministic API 初始化、I/O、allocation 與 user code 仍然
計費。Host 端在進入 guest 前的 compilation、package extraction 與 preparation 不屬於此
instruction metric。

Reference scorer 會要求成功 execution 同時提供整數 `metrics.rawCost`、
`metrics.baselineCost`、非空 `metrics.costProfile`，並重新驗證上式；只提供 `metrics.cost`
不足以計分。缺少 manifest calibration、Forge cost profile 或任何必要 metric 是 judge
configuration/error，整份 score 不成立；不得靜默把它當成 contestant 的 0 分 case。

Execution identity 另須提供 submission `language`。Scorer 會要求
`metrics.costProfile === scoring.calibration.profiles[language]`；只要 language 未校準、profile
為空，或 toolchain/runtime profile 與本次校準不完全相同，就 fail closed。Profile 不是由
contestant 自行宣告；judge 必須從 Forge 驗證過的 artifact 與 run result 傳入。

假設共有 `C` 個 cases，policy `p` 的增量分數為 `points[p]`，在其中 `passed[p]` 個
cases 通過，總分以精確有理數計算：

```text
scoreNumerator   = Σ points[p] × passed[p]
scoreDenominator = C
score            = scoreNumerator / scoreDenominator
```

所有 policy 的 `points` 合計必須等於 `maximumPoints=100`。這讓同一 case 可以依序貢獻
20、50 或 100 分層級的比例，而不重跑或複製測資。上述 fraction 是 canonical score；
UI 如何顯示或四捨五入不屬於 judging contract，且不得回頭影響 pass/fail 或 numerator。

`safetyLimits.wallTimeLimitMs` 是停止失控 engine 的 host safety boundary，不參與 policy
分數，也不得用來比較不同機器上的演算法效率。計算量的主要且可攜式限制永遠是
`instructionBudget`。

## Measured multi-language policies

45 題使用三層 measured policy：

| Policy | Incremental points | Instruction budget | Memory budget |
| --- | ---: | ---: | ---: |
| `baseline` | 20 | 七語言 worst-case 的最大值 + 5% | declared-max review ceiling |
| `efficient` | 30 | C/C++/Rust/Go worst-case 的最大值 + 5% | declared-max review ceiling |
| `optimal` | 50 | C/C++/Rust/Go worst-case 的算術平均 + 5% | declared-max review ceiling |

校準固定 Forge binary、library、toolchain、`release/wasip1` target 與 deterministic
configuration，逐一執行每題 `all-manifest-tests` 中的全部 case。對題目 `p` 與語言 `l`：

```text
languageWorst[p,l] = max(cost[p,l,case])
compiled[p]        = [languageWorst[p,C], languageWorst[p,C++],
                      languageWorst[p,Rust], languageWorst[p,Go]]
rawOptimal[p]      = ceil(sum(compiled[p]) × 105 / (4 × 100))
rawEfficient[p]    = ceil(max(compiled[p]) × 105 / 100)
rawBaseline[p]     = ceil(max(languageWorst[p,*]) × 105 / 100)
quantum(x)         = 5 × 10^(decimalDigits(x) - 2)  when decimalDigits(x) >= 3
quantum(x)         = 1                               otherwise
budget(x)          = ceil(x / quantum(x)) × quantum(x)
optimal[p]         = budget(rawOptimal[p])
efficient[p]       = budget(rawEfficient[p])
baseline[p]        = budget(rawBaseline[p])
```

因此 `optimal` 不由單一最快語言決定，而是由四種編譯式 reference 的 worst-case cost
算術平均決定；`efficient` 保證 C、C++、Rust、Go 四種官方最佳解至少取得 50 分，
`baseline` 則保證七種官方最佳解至少取得 20 分。這同時避免單一 runtime 特性壟斷
滿分門檻，並維持 `baseline >= efficient >= optimal` 的 relaxed-to-strict 順序。
5% 是同一 cost contract 下容納等價實作差異的唯一 headroom；
之後只做單向向上取整，讓第三位起全部為 `0`，且使用 5 倍 decimal quantum，例：
`28,995 → 30,000`、`10,170,535 → 15,000,000`。取整絕不降低安全下限。
因 cost 在固定 deterministic profile 下可重現，不加入 wall-time variance。Memory ceiling
沿用各題 declared-max review，不參與 instruction budget 推導。

Manifest 以

```json
"calibration": {
  "status": "measured",
  "method": "forge-v1-compiled-average-optimal-rounded-v1",
  "profiles": {
    "c": "wasm-oj-forge-cost:contract-1:c:wasip1:release:content-...:weighted",
    "cpp": "wasm-oj-forge-cost:contract-1:cpp:wasip1:release:content-...:weighted"
  }
}
```

實際 manifest 的 `profiles` 必須完整明列七種語言；上例為節省篇幅只展示兩個 key。

原始逐案 metrics、source/test digest 與 runtime content digest 位於
`calibration/forge-v1/reference-costs.json`；機器推導結果位於
`calibration/forge-v1/derived-policies.json`。`node tools/derive_cost_policies.mjs` 會重新
雜湊所有 solution 與 test、要求完整 45 × 7 records、重算三層 multi-language derivation，並
核對 45 份 manifest。任何輸入或證據改變都 fail closed；要套用經人工審閱的新證據，使用
`node tools/derive_cost_policies.mjs --write`。

## Validation

- `tools/catalog.schema.json` 定義 localized root catalog v2。
- `tools/problem.schema.json` 定義 localized problem manifest v3。
- `tools/verify.py` 從 `catalog.json` discovery，並只依 manifest path 讀取內容、編譯
  solutions、執行 validator／oracle／generator 與 stored tests。
- `tools/scoring.py` 是 cumulative policy 計分的 executable specification；
  `python3 -m unittest tools.test_scoring` 驗證 inclusive boundaries、partial points、
  logical time、wall-safety 分離，以及缺少或不相容 metrics 時 fail closed。
- Verifier 也檢查 path normalization、檔案存在性、test inventory、policy points、
  64 KiB memory page alignment，以及 policy limits 的 relaxed-to-strict 單調性。
