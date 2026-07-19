# Problems 041–045 independent review

- 審查日期：2026-07-20（Asia/Taipei）
- 範圍：`problems/041-*` 至 `problems/045-*`
- 最終 disposition：**PASS**。五題目前沒有未解的 statement ambiguity、sample、
  correctness、complexity、integer-range、validator、generator、oracle、resource-policy
  或七語 reference blocker。

## Blind protocol

審查分成兩個不可逆的階段。

第一階段只讀 `catalog.json`、五份 `problem.json` 中的 identity／statement／validator／
test paths、雙語 statements、validators 與 stored tests；刻意略過 complexities、scoring、
editorials、官方 solutions、oracles 與 generators。Reviewer 從題意自行推導直覺、進階與
最佳解，並在 repository 外的
`/tmp/forge-blind-review-041-045.VkVSWE/` 寫五份 C++20 solver 及一份獨立 Python brute
cross-checker。五份 solver 先通過四個 stored cases，再各跑 1,000 組固定 seed 的隨機
小 case；expected output 由直接定義計算，不使用 repo oracle 或 reference consensus。

第二階段才讀 `AGENTS.md`、完整 `docs/CONTRACT.md`、雙語 editorials、35 份官方
solutions、oracles、generators、完整 manifests 與 calibration evidence。這一階段逐一比對
實際 loops、allocations、整數範圍、tie-break、oracle 結構及 metadata，並編譯／執行七語
references。

Blind solver SHA-256：

```text
041 cd31cae2c02bb72962790076fa4b88caba6f89ceb7da61ce879d15d035c2ade3
042 4e87e670c9b1a4465384696dcb3b5a8f08aa2f682812a42807d67043beb2222f
043 2168ff9b350a1697b120bf164a2a07141115347e41d28b73e6f396436d520120
044 2f123e5a069364179b9a6d717b03ed6832bd72839891cfea95373e17e5510f51
045 6df122c0d3e2f6732852cc7b5534bc3c81525b12efde3c861641f9bd0d9319d6
random_crosscheck.py 978fce56a8ad2cdedc7d39d61fbca46773c08933f240b38680be57886aeadd49
```

## Blind finding that changed problem 045

最初的 045 是離線輸出全體 top `K`。它把 fixed-size heap 的 `O(N log K)` 稱為
optimal，但離線 comparison model 可先用 selection 找到 top-`K` 集合，再只排序輸出，
達到 `O(N + K log K)`；所以原宣稱不是漸近最佳。Reviewer 在尚未讀官方內容前回報此
問題，沒有把「reference 答對 samples」誤當成演算法已最佳。

題目因此重設為目前的「持續追蹤第 K 慢測試」：每個 prefix `i >= K` 都必須輸出當時
第 `K` 名。Reviewer 對新版重新執行第一階段，重寫 045 solver 與 brute expected，並再次
通過 stored cases及 1,000 組隨機 prefix cases，之後才打開新版 editorial/reference。
在 comparison-based online prefix model 中，每次會進入 top `K` 的新元素要求更新目前
第 `K` 名，fixed-size heap 是正確的 `O(log K)` update 結構；adversarial case 又令每個
後續元素都觸發 replacement，避免把 heap repair 當成偶發支出。

## Independent derivations and final per-problem audit

### 041 — progressive-cost-budget

Blind derivation：

1. 每個 budget 從 stage 1 重掃，`O(NQ)` time、`O(N)` cost storage。
2. 建立非遞減 prefix sums，對每個 budget 做 `upper_bound`，
   `O(N + Q log N)` time、`O(N)` algorithmic space。
3. 利用 budgets 不遞減，保存 `completed` 與 `spent`，stage pointer 全程只前進，
   `O(N+Q)` time。因 input/output buffering 的七語共同 resident bound 為 `O(N+Q)`。

零成本 stage 使 prefix sums 可重複，故二分必須找第一個 `> budget`；雙指標則必須在
`cost=0` 時繼續前進。`spent <= current budget` 由 budget 單調性維持，因此 unsigned
比較 `cost <= budget-spent` 不會 underflow。總成本與 budget 都不超過 `9e18`，C-family
`uint64` 安全；JavaScript／TypeScript 正確使用 `bigint`。

官方 editorial 與此推導一致。Oracle 使用 prefix sums + binary search，與 reference 的
monotone two pointers 結構不同。Adversarial case 有 `N=Q=200000`、前 10001 個成本為
`999999999999`、其後 189999 個為零、所有 budgets 等於總成本；直覺解會做
`40,000,000,000` 次 stage inspections，binary-search 上界約 360 萬次比較，雙指標只前進
20 萬次，並同時覆蓋相等 budgets、零成本尾段及 64-bit 累計。

結論：**PASS**。`O(N+Q)` 亦由讀入 `N+Q` values 及輸出 `Q` 行給出 matching lower
bound。

### 042 — first-duplicate-test

令 `L` 為最長 token、`S` 為所有 token 長度總和。

1. 將第 `i` 個 token 與所有前項精確比較，`O(N^2 L)` time、`O(S)` space。
2. 排序 `(fingerprint,index)` 後掃 equal groups，`O(N log N * L)` time、`O(S)` space。
3. 由左至右以 first-occurrence map 保存首次 index，第一次 map hit 就是最小 duplicate
   index，map value 是最早 matching index；expected `O(S)` time、`O(S)` resident space。

Hash 只選 bucket，七語 equality 都會比較完整 token；沒有把 `0` 與 `00` 當成數值相同。
若要求 deterministic worst-case，也可用固定 16 字母 alphabet 的 trie 達 `O(S)`，所以
線性漸近界本身可達；manifest/editorial 清楚把目前 hash reference 的時間標成 expected。

Oracle 先排序所有 `(token,index)` 並從 equal groups 找最小 second index，結構不同於
reference 的 early-exit hash scan。Adversarial case 前 199999 個 token 不同，第 200000
個重複 index 123457，直覺解約做 `19,999,823,458` 次精確比較，並驗證回報的是首次位置
而非最近位置。

結論：**PASS**。

### 043 — verdict-range-counts

1. 每次掃 `[L,R]`，worst-case `O(NQ)` time。
2. 每種 verdict 保存 sorted positions，兩次 binary search，
   `O(N + Q log N)` time、`O(N)` core space。
3. 建四組 prefix counts，答案為 `pref[V][R]-pref[V][L-1]`，
   `O(N+Q)` time、七語 resident `O(N+Q)`。

固定四字母 alphabet 使每位置建表與每查詢都是常數工作；讀 input 並輸出 Q 行又給出
`Omega(N+Q)` lower bound。所有 prefix counters 最大 200000，`uint32` 安全。

Oracle 保存四份位置表並用 `bisect_left/right`，與 prefix-table reference 不同。
Adversarial case `N=100000,Q=80000`，直接掃描需檢查 `2,018,835,761` 個 verdict characters，
而 prefix 解只需線性建表及查詢。閉區間、單點、缺席 verdict 與四種字元亦由 samples／
random cases 覆蓋。

結論：**PASS**。

### 044 — recent-submission-reuse

令 `U` 為 distinct tokens 數量。

1. 每筆向前掃至多 K 筆，`O(N K L)` time、queue 為 `O(KL)` space。
2. Balanced tree 保存每種 token 最近位置，`O(N log N * L)` time、`O(UL)` core space。
3. Hash map 只保存 `last[f]`；`i-last[f] <= K` 時 count hit，之後更新 last。Expected
   `O(S)` time；core map 為 `O(UL)`，七語 input buffering／按 N reserve 的共同 resident
   bound 為 `O(S)`。

只需最近位置，因最近者若已早於 window，所有更早位置也必然過期。`K=0` 時所有正 index
差都大於 K，不需危險特判。Oracle 將 `(token,index)` 排序，在每個 equal group 檢查相鄰
index gaps；每個 occurrence 是否 hit 只取決於它的最近相同前項，因此與 hash reference
不同但等價。

Adversarial case 為 50000 個 distinct hex tokens 循環四輪、`N=200000,K=50000`；naive
window scan 約做 `8,749,975,000` 次 token comparisons，每個後三輪 hit 又恰在 window
左邊界，能抓 `<K`／`<=K` off-by-one。

結論：**PASS**。

### 045 — slowest-k-cases / Running K-th Slowest Case

最終新版 blind derivation：

1. 每個 prefix 重排，總 time `O(N^2 log N)`、space `O(N)`。
2. 維護完整 order-statistic set，`O(N log N)` time、`O(N)` space。
3. 只保留目前排名前 K 的 records；heap root 定義為入選者中最差者。未滿就 push，
   已滿時只以更好的 candidate replace root；每個 `i>=K` 更新後輸出 root。
   `O(N log K)` update time，加上必要的 `O(N-K+1)` output，heap core `O(K)`、七語共同
   resident `O(N+K)`。

Tie-break 是 `(cost descending,index ascending)`，因此「更差」是成本較低，或同成本時
index 較大。Blind proof 與 editorial 都以同一 invariant 歸納：每個 prefix 後 heap 恰含
其最佳 `min(i,K)` 筆，root 是其中最後一名。

Oracle 先對全體建立最終 rank，再用 Fenwick tree 依 arrival 啟用 records，對每個 prefix
找 active ranks 的第 K 個；它是 `O(N log N)` 的 offline order-statistic 解，與 fixed heap
結構不同。Adversarial case `N=200000,K=5000` 且 costs 嚴格遞增；從第 5001 筆起每筆都
比 root 好，迫使約 195000 次完整 heap replacement／repair，同時輸出 195001 行，能排除
只算最後 prefix 或假設 replacements 很少的實作。

結論：**PASS**。原離線版本的非 optimal finding 已由題目重設根治，不是以放寬 budget
掩蓋。

## Official execution evidence

每題最終執行：

```text
python3 tools/verify.py --problem NNN --fuzz 100
```

每題 7 programs、728 executions：四個 stored cases加 100 個 generated cases，全部由
C17、C++20、Rust 2024、Go、Python、JavaScript、TypeScript exact-output 通過。

| Problem | Programs | Executions | Result |
|---:|---:|---:|---|
| 041 | 7 | 728 | PASS |
| 042 | 7 | 728 | PASS |
| 043 | 7 | 728 | PASS |
| 044 | 7 | 728 | PASS |
| 045 | 7 | 728 | PASS |

合計 35 programs、3,640 executions。Blind harness 另有五題各 1,000 cases，合計 5,000
組，與 official generator/oracle 路徑獨立。

三組 sample output 逐題重新由 oracle 產生並 byte-compare，全部一致。所有
`generator.py 0 999999` 都能 byte-exact 重建 manifest adversarial input；一般 generator
另以 `(0,0)`、`(1,1)`、`(123456789,17)`、`(-7,999)` 各執行兩次，結果 byte-identical 且
validator 接受。

## Validator, generator, and oracle audit

- 041–044 各測 8 組、045 測 9 組 targeted invalid inputs，涵蓋 empty/truncated、leading
  zero、out-of-range、decreasing budgets、bad alphabet/verdict、`L>R`、`K>N`、extra token
  與 malformed UTF-8，全部 nonzero exit；合法 sample 全部 zero exit。
- Validators 先 UTF-8 decode、驗 token grammar／數量，再驗 cross-field constraints，沒有
  permissive fallback；`validator.py` 對任意 participant input 是唯一 fail-closed gate。
- Generators 嚴格要求兩個 arguments，同 `(SEED,INDEX)` deterministic，輸出恰一個完整且
  validator-accepted case。五個 `INDEX=999999` branches 是 stored adversarial 的明確
  reproduction recipe。
- Oracles 位於 validator 後方，依 repository contract 只接合法 generated/stored input，
  不重複扮演 participant-input validator。五份 oracle 都與最佳 reference 結構不同：
  binary search、sort groups、positions + binary search、sort adjacent gaps、global rank +
  Fenwick；沒有 reference consensus fallback。

## Resource-policy recomputation

執行 `node tools/derive_cost_policies.mjs` 得到：

```text
cost policy derivation and all 45 manifests are current
```

Reviewer 另以獨立 Python 程式重新 hash 35 份 source、140 組 stored input/output bindings，
驗證每筆 `cost = rawCost - baselineCost`、artifact/profile exact match，並從 raw evidence 重新
計算：

```text
optimal   = pretty(ceil((worst[C]+worst[C++]+worst[Rust]+worst[Go]) * 105 / 400))
efficient = pretty(ceil(max(worst[C],worst[C++],worst[Rust],worst[Go]) * 105 / 100))
baseline  = pretty(ceil(max(worst[all seven languages]) * 105 / 100))
```

`pretty` 只安全向上取整到 `5 * 10^(digits-2)` quantum。獨立重算結果：

| Problem | C/C++/Rust/Go worst costs | All-language max | optimal | efficient | baseline | Max measured memory |
|---:|---|---:|---:|---:|---:|---:|
| 041 | 1,196,875,261 / 25,360,713,531 / 1,801,887,493 / 27,174,679,021 | 27,174,679,021 | 15,000,000,000 | 30,000,000,000 | 30,000,000,000 | 51,838,976 |
| 042 | 333,427,292 / 3,444,036,654 / 487,436,842 / 7,086,523,868 | 15,597,707,571 | 3,000,000,000 | 7,500,000,000 | 20,000,000,000 | 46,006,272 |
| 043 | 489,062,936 / 7,503,512,402 / 615,950,036 / 9,388,420,980 | 24,511,720,153 | 5,000,000,000 | 10,000,000,000 | 30,000,000,000 | 41,943,040 |
| 044 | 321,896,784 / 3,188,541,104 / 530,896,017 / 6,799,168,221 | 14,791,697,052 | 3,000,000,000 | 7,500,000,000 | 20,000,000,000 | 41,943,040 |
| 045 | 1,522,930,993 / 18,158,141,489 / 1,187,965,236 / 21,435,819,413 | 146,744,584,040 | 15,000,000,000 | 25,000,000,000 | 200,000,000,000 | 49,938,432 |

五題所有 language/case 的 measured peak guest memory 都低於 strict 64 MiB policy；memory
tiers仍依 128/96/64 MiB 收緊。041 的 baseline 與 efficient instruction budget 相同，但
memory 仍由 128 MiB 收緊到 96 MiB，符合每層至少收緊一種 deterministic resource 的
契約。所有 instruction budgets 都符合「只有前兩位可非零」的漂亮數字要求，且沒有一次
向下 round。

## Findings and closure

1. **原 045 heap 非離線 optimal**：已重設為 running prefix 題並重新 blind review、七語
   verify、adversarial、calibration；closed。
2. **041／042／044 adversarial 原無 explicit generator reproduction branch**：均新增
   `INDEX=999999`，與 stored input byte-identical；043／045 亦同樣可重建；closed。
3. **041／043／044／045 final space metadata 原只寫 algorithmic core，低於部分七語
   actual resident allocations**：現分別改為 `O(N+Q)`、`O(N+Q)`、`O(S)`、`O(N+K)`，
   editorials 同時保留 core/resident 的區別；closed。

最終 metadata validation、sample embedding check、35-program fuzz100、raw calibration
derivation與獨立 hash/formula recomputation 全部通過。
