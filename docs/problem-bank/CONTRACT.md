# 題庫契約

## 範圍

本 repository 固定收錄 45 題。題號、slug 與目錄一經建立即為穩定識別；
題意可以修正，但不得以隱藏 fallback 或相容分支保留錯誤契約。

根目錄 `catalog.json` 是唯一 discovery entry point，依序明列 45 份 `problem.json`。
Consumer 不得先列出目錄再猜 manifest path。

每題必須具備以下檔案：

```text
problems/NNN-slug/
├── problem.json
├── statement.zh-TW.md
├── statement.en.md
├── editorial.zh-TW.md
├── editorial.en.md
├── validator.py
├── generator.py
├── oracle.py
├── tests/
│   ├── sample-01.in
│   ├── sample-01.out
│   └── ...
└── solutions/
    ├── c/main.c
    ├── cpp/main.cpp
    ├── rust/main.rs
    ├── go/main.go
    ├── python/main.py
    ├── javascript/main.js
    └── typescript/main.ts
```

上圖是目前 repository layout，不是 consumer contract。`problem.json.files` 必須明列
各 locale 的 statement／editorial、validator、generator、oracle、七語言 solution，
以及每個 test 的 input/output path。所有 path 均相對於 manifest 目錄，且必須是
normalized POSIX relative path。

## 題目設計

1. 輸入與輸出必須是 deterministic UTF-8 text，不依賴 host locale、clock、
   filesystem 或 network。
2. `statement.zh-TW.md` 與 `statement.en.md` 必須定義完全相同的 tie-break、錯誤狀態、
   整數範圍、indexing 與空集合行為；sample 不得替代規格。
3. 每題至少要存在兩種有實質複雜度差異的解法。完整限制必須排除直覺解，
   而最佳解必須有可證明的漸進複雜度。
4. `editorial.zh-TW.md` 與 `editorial.en.md` 都至少包含：直覺解、最佳解、正確性證明、
   時間複雜度、空間複雜度、常見錯誤，且兩個 locale 的演算法宣稱必須一致。
5. 不把 SHA-256 實作本身當成無關門檻。題意中的 digest 是已計算完成、
   不碰撞的 lowercase hexadecimal token，除非該題明確是在考 encoding。
6. 所有容量、成本及 timestamp 都必須能以帶號或無號 64-bit integer 表示。
   若乘加可能超出，題目必須定義更寬範圍或保證不溢位。

## Reference solutions

- C：C17。
- C++：C++20。
- Rust：edition 2024，可使用標準函式庫。
- Go：Go 1.26。
- Python：Python 3.14。
- JavaScript／TypeScript：Forge `std` 輸入輸出介面；整數超過
  `Number.MAX_SAFE_INTEGER` 時必須使用 `bigint`。
- 七份 solution 必須實作同一個最佳演算法，不得以較寬鬆的語言 timeout
  偷渡次佳解法。
- Solution 只輸出題目要求的內容，不得包含提示、debug log 或 fallback。

## Tests and independent review

- `validator.py` 對任意輸入 fail closed。
- `oracle.py` 是與最佳解結構不同的直接解，只供小型測資 differential test。
- `generator.py SEED INDEX` 必須在 stdout 產生**恰好一個**完整測試輸入；
  同一組參數必須 byte-identical，`INDEX` 用來選擇不同形狀／規模。generator
  的輸出必須落在 oracle 可承受的範圍。
- 每個 sample output 由 oracle 產生或再次核對。
- 每個 reference solution 都必須通過 samples、固定 adversarial cases 與 seeded
  oracle differential tests。
- 獨立 reviewer 僅讀 statement，先自行推導解法，再檢查 editorial、solutions
  與 constraints 是否一致，並確認宣稱的時間／空間複雜度為可達最佳解。

## Resource policies and scoring

- 計算量的主要限制是 Forge baseline-normalized weighted `instructionBudget`，不是
  host wall time。
- `scoring.costContract` 固定為 `wasm-oj-forge-v1`；judge 必須使用該 contract 驗證過的
  artifact cost profile 與 `RunResult.metrics.cost`，遇到 contract/profile/calibration
  mismatch 時 fail closed。
- `scoring.calibration.profiles` 明列七語言的 exact Forge cost profile；execution 必須帶
  submission language，且 metrics profile 必須與該語言校準值 byte-identical。
- 本 catalog 固定使用依 relaxed-to-strict 排列的 `baseline`、`efficient`、`optimal`
  三個 cumulative policies；每層至少收緊 instruction cost、memory 或 deterministic
  logical time 之一。缺少、重複或重新排序任何 policy 都是無效 manifest。
- `scoring.caseSet=all-manifest-tests`：所有 policies 都使用 `files.tests` 明列的完整
  case set。每個 case 在最寬鬆 hard limits 下執行一次，再以同一份正確性結果及
  metrics 判斷通過哪些 policies。
- Policy `points` 是增量分數且合計 100；總分採 equal-case average。答案錯誤或
  runtime failure 的 case 不通過任何 policy。
- `memoryLimitBytes` 指 guest peak linear memory。`logicalTimeLimitMs` 若存在才是
  deterministic policy metric。
- `safetyLimits.wallTimeLimitMs` 只負責終止失控 host execution，不參與計分，也不得
  作為跨 host 的演算法效率指標。
- `calibration.status=measured` 必須能由固定 Forge contract/toolchain、完整 tests 與
  `calibration/forge-v1/` 下的證據重算；solution、test 或 runtime identity 改變時必須
  fail closed 並重新量測，不得沿用舊 budget。

## Metadata

`catalog.json` 必須符合 `tools/catalog.schema.json`，並宣告唯一 default locale 與有序的
supported locale 清單；目前固定為 `zh-TW`、`en`。`problem.json` 必須符合
`tools/problem.schema.json`，所有 localized title/name 與 statement/editorial map 必須完整
覆蓋 catalog locales。`complexities` 記錄 editorial 所分析的主要路徑，最後一筆必須是
reference solutions 使用的最佳解。完整 API discovery、path resolution 與計分公式見
`docs/MANIFEST.md`。
