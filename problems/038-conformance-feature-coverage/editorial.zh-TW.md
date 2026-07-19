# 解題說明

## 直覺解法

列舉每個測試選或不選，再合併 coverage，需 `O(2^N(N+F))`。依「新覆蓋數／成本」貪心也不正確，因集合重疊會改變後續邊際收益。

## 最佳解法：bitmask 最小成本

因 `F≤20`，以 `F` bits 表示 coverage。令 `dp[mask]` 為目前測試中，恰能得到 union `mask` 的最小成本；不可達為無限大，初始只有 `dp[0]=0`。

處理測試 `(cost,testMask)` 時先複製 `next=dp`（不選），再對每個可達 `mask` 更新：

```text
next[mask | testMask] = min(next[mask | testMask], dp[mask] + cost)
```

完成後，在 `dp[mask]≤B` 的 mask 中取 popcount 最大者。

## 正確性證明

以處理測試數歸納。初始空集合唯一，狀態正確。加入一個測試後，任何子集合要嘛不含它，其最小成本由舊 `dp` 保留；要嘛含它，移除該測試後有某舊 union `mask`，新 union 正是 `mask|testMask`，成本多 `cost`。轉移枚舉兩類所有可能並取最小，所以 `next` 對每個 union 仍正確。最後 cost 不超過 budget 的狀態恰為所有合法選擇，最大 popcount 即答案。

## 複雜度

共有 `2^F` 個 mask，每個測試掃描一次，時間 `O(N2^F)`、空間 `O(2^F)`。

## 常見錯誤

- 把重複覆蓋也累加，答案超過 `F`。
- 把「不可達」設成 `sum(cost)+1` 後又只用 `dp[mask]≤B` 判斷；若
  `B>sum(cost)`，這個 sentinel 本身會被誤認為可行。應使用真正大於 budget
  與所有可達成本的值，並在轉移時排除 sentinel。
- 以測試數 `N` 做 bitmask，回到 `2^N` 的暴力。
- 忽略 cost 為零或 coverage 為空的測試。
