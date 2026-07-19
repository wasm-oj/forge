# 解題說明

## 直覺解

每次查詢挑出該 profile 的觀測，再檢查 `S` 個 seed 與成本，需 `O(NQ)` 時間。也可先依 `(profile,seed)` 排序後分組，時間 `O(N log N+Q)`。

## 最佳解

因輸入保證 `(profile,seed)` 唯一，對每個 profile 只需維護三個量：觀測筆數 `count`、最小成本 `minCost`、最大成本 `maxCost`。讀一筆就更新。最後且僅當 `count=S` 且 `minCost=maxCost` 時有效；baseline 即該共同成本。

## 正確性證明

若 profile 被判有效，`count=S`；所有 seed 都落在大小恰為 `S` 的集合 `1..S`，又不重複，所以每個 seed 恰出現一次。`minCost=maxCost` 表示全部觀測成本相同，符合發布條件。反之，任何可發布 profile 必有 `S` 筆觀測且成本全同，因此必通過兩項檢查。有效查詢依定義輸出共同成本及 `max(0,raw-baseline)`，所以答案正確。

## 複雜度

初始化、彙總、回答分別為 `O(P)`、`O(N)`、`O(Q)`，總時間 `O(P+N+Q)`，核心資料結構的輔助空間為 `O(P)`。C、C++、Go reference 串流讀寫；Rust、Python 會保留完整輸入與輸出，JavaScript、TypeScript 保留 Forge `readAsString()` 提供的單一輸入字串，但以固定 64 KiB 分塊輸出。由於每筆觀測、查詢與答案都只有常數個定長整數 token，依實際 resident allocations 計算，七語言 reference 的共同最壞空間上界為 `O(P+N+Q)`。讀取全部資料本身已有 `Ω(P+N+Q)` 的最壞情況下界，因此時間為漸進最佳。

## 常見錯誤

- 只比較成本卻未檢查 seed 是否完整。
- 用總和除以筆數；平均相同不代表每筆相同。
- 將 `raw-baseline` 以無號整數直接相減而 underflow。
- 誤以為觀測按 profile 或 seed 排序。
