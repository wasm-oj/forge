# 解題說明

## 直覺解法

列舉每個 artifact 選或不選需 `O(2^N N)`。經典二維 DP `dp[i][c]` 可降為 `O(NC)` 時間，但需 `O(NC)` 空間，在完整限制下超過 memory limit。

## 最佳解法

令 `dp[c]` 為目前看過的 artifact 中、總 size 不超過 `c` 時的最大 value。對一個 `(w,v)`，令 `c` 從 `C` 遞減到 `w`：

```text
dp[c] = max(dp[c], dp[c-w] + v)
```

反向迭代保證右側仍是加入本 artifact 前的狀態，因此每件最多使用一次。答案為 `dp[C]`。

## 正確性證明

以處理 artifact 數歸納。初始只可選空集合，所有 `dp[c]=0` 正確。加入 `(w,v)` 後，容量 `c` 的最優解要嘛不選它，值為舊 `dp[c]`；要嘛選它，其餘 artifact 佔用至多 `c-w`，最佳值為舊 `dp[c-w]+v`。轉移取兩者最大，涵蓋且只涵蓋合法解。反向更新確保「舊」狀態未含當前 artifact。故最後 `dp[C]` 為全體最優值。

## 複雜度

時間 `O(NC)`，空間 `O(C)`。這是標準 pseudo-polynomial 0/1 knapsack 最佳化；一般二進位編碼版本為 NP-hard。

## 常見錯誤

- 容量正向更新，讓同一 artifact 被重複選成 unbounded knapsack。
- 以 value/size 比值貪心；0/1 背包不具該貪心性質。
- 忘記 `C=0` 或 value 為零。
- 用 32-bit 儲存累積 value。
