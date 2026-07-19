# 解題說明

## 直覺解法

列舉所有 bundle 子集合需 `O(2^N N)`。三維 `dp[item][bytes][entries]` 可在 `O(NBI)` 時間解出，但空間 `O(NBI)` 在完整限制下超過 64 MiB。

## 最佳解法

令 `dp[e][b]` 為目前看過的 bundle 中，在 entries 不超過 `e`、bytes 不超過 `b` 時的最大 value。處理 `(w,k,v)` 時，令 `e` 從 `I` 遞減至 `k`，並令 `b` 從 `B` 遞減至 `w`：

```text
dp[e][b] = max(dp[e][b], dp[e-k][b-w] + v)
```

兩個維度都反向，右側必是加入本 bundle 前的狀態，所以每個 bundle 最多使用一次。答案為 `dp[I][B]`。當 B/I 很大但可達狀態稀疏時可維護 Pareto frontier；在本題明確的容量上限下，dense DP 有更好的確定性 worst-case bound。

## 正確性證明

以已處理 bundle 數歸納。新 bundle 的任何合法最優解要嘛不含它，保留舊 `dp[e][b]`；要嘛含它，移除後剩餘解必符合 `(e-k,b-w)`，最佳值為舊狀態加 `v`。轉移取兩類最大，涵蓋全部且不含非法解。反向迭代使同一輪的本 bundle 不會出現在來源狀態，因此保持 0/1 限制。最終狀態即兩 quota 內最大重要度。

## 複雜度

時間 `O(NBI)`，空間 `O(BI)`。

## 常見錯誤

- 只按 bytes 做一維背包，忽略 entries quota。
- 讓 entries 維正向更新，尤其遇到 `bytes=0` 時會從本輪剛更新的狀態再次取用
  同一 bundle。兩維都反向是最直接且不易出錯的寫法。
- bytes 為零時跳過 item；它仍可能有價值並消耗 entries。
- 分別求兩個 quota 下的最佳集合再取交集；這不保證全域最優。
