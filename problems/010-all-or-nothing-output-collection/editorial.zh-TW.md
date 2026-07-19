# 解題說明

## 直覺解法

令 `L` 為所有 path 的 byte 長度總和，`Z` 為實際輸出的 byte 數。每個查詢都複製並以字串比較排序檔案，再依序模擬，最壞需 `O(QL log N+Z)`。排序只做一次仍可能因每個 budget 從頭掃描而達 `O(L log N+NQ+Z)`。前綴和加二分可做到 `O(L log N+Q log N+Z)`。

## 最佳解法

先按 path 排序，計算 metadata length 前綴和 `prefix`，並記住第一個 mismatch 索引 `m`（不存在令 `m=N`）。因 budget 非遞減，可維護 `k`：在容量 `budget-U` 下，前綴和不超過容量的最大檔案數。每次查詢只需 while 向右推進 `k`，所有查詢合計至多前進 `N` 次。

若 `U>budget` 先輸出特殊 quota。否則依序判斷：

- `k<m`：索引 `k` 的正常檔案已是第一個裝不下者，輸出其 QUOTA；
- `m<N`：所有 mismatch 前的檔案都裝得下，處理到 `m` 時因規定先比長度，輸出 MISMATCH；
- `k<N`：沒有 mismatch，但索引 `k` 裝不下；
- 否則全部成功，最終用量固定為 `U+prefix[N]`。

## 正確性證明

prefix 非遞減；單調 budget 使最大可容納前綴長度也非遞減，所以 while 後 `k` 恰是忽略 mismatch 時能完整容納的最大前綴。若 `k<m`，前 `k` 個正常檔均可加入且第 `k` 個超限，它是最早錯誤。若 `k≥m` 且 mismatch 存在，所有更早的正常檔都可加入；到 `m` 時規格先檢查長度，因此即使該檔本身超 quota，也必回 MISMATCH。沒有 mismatch 時，`k<N` 恰表示第一個 quota failure，`k=N` 則全部成功。四種情形互斥且完備，故答案正確。

## 複雜度

comparison sort 會做 `O(N log N)` 次字串比較；把共同前綴的 byte 比較成本計入，portable worst-case 上界為 `O(L log N)`。前處理 `O(N)`，跨全部查詢的指標前進 `O(N)`，因此包含輸出的總時間為 `O(L log N+Q+Z)`。儲存 path、前綴和及 buffered I/O 的共同最壞上界是 `O(L+N+Z)` 空間：C、C++、Go 串流讀寫；Rust、Python 保留完整輸入與輸出；JavaScript、TypeScript 保留單一輸入字串，平時使用約 64 KiB 的累積輸出 buffer，單筆含長 path 的輸出行則暫存 `O(maxPathLength)` bytes。因每個 query 至少產生常數長度輸出，`Z=Ω(Q)`，所以此上界也涵蓋輸入中的 Q 個 budget；單筆長行也由 `O(L)` 涵蓋。題目的 `Q × maxPathLength` 限制把 `Z` 控制在可執行範圍。

comparison model 中 canonical ordering 需要 `Ω(N log N)` 次比較，而讀取 path、回答查詢與寫出答案分別需要 `Ω(L)`、`Ω(Q)`、`Ω(Z)`；排序後的單調指標已把 query 部分降到最佳的線性總成本。

## 常見錯誤

- 以輸入順序而非 path byte order 蒐集。
- 在同一檔案先判 quota，違反 mismatch 優先序。
- 把失敗前已讀檔案當成部分成功輸出。
- 忘記 stdout/stderr 的 `U` 已佔 budget，或 `U>budget` 時仍回報某個 path。
- budget 相同時重複把指標狀態當成已提交交易；指標只代表靜態可容納前綴，不是檔案副作用。
- 只寫 `O(N log N)` 而漏算 variable-length path comparison 的 byte 成本。
