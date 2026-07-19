# 解題說明

## 直覺解法

列舉子集合後檢查每個被選節點的 ancestors，需 `O(2^N N)`。一般 tree knapsack 把各 child 的容量表逐一卷積，最壞 `O(NC^2)`。

## 最佳解法：preorder 跳過子樹

加入一個永遠已選、size/value 皆為零的 virtual root 0，把 forest roots 接在其下。對真實節點做 DFS preorder，得到陣列 `order[0..N-1]`；另記 `after[i]`，即 `order[i]` 整個 subtree 結束後的第一個 preorder 索引。

定義 `dp[i][c]`：已確定 `order[i]` 的 parent 被選時，從 preorder 位置 `i` 之後且容量為 `c` 的最大收益。兩種選擇：

- 不選此節點：其 descendants 都不可能選，直接到 `dp[after[i]][c]`；
- 選此節點：支付 size、取得 value，下一位置 `i+1` 可繼續決定。

```text
dp[i][c] = max(dp[after[i]][c], value[u] + dp[i+1][c-size[u]])
```

第二項只在容量足夠時存在。由 `i=N-1..0` 計算；答案為 `dp[0][C]`。

## 正確性證明

考慮狀態中的目前節點 `u`，其 parent 已選。任何合法解對 `u` 恰有兩類：若不選 `u`，closure 規則禁止選它的任何 descendant，preorder 中必跳到 `after[i]`；若選 `u`，closure 在 `u` 處滿足，扣除它後可從下一 preorder 節點繼續，所有 ancestors 的選擇前提仍成立。兩類互斥且涵蓋全部合法解，轉移各取其最佳再取最大。因此由倒序歸納，所有 `dp` 正確。virtual root 讓每棵樹 root 都可獨立選或不選，所以 `dp[0][C]` 即整座 forest 的最優值。

## 複雜度

DFS `O(N)`；共有 `N(C+1)` 個常數時間狀態，時間與空間皆 `O(NC)`，優於容量卷積的 `O(NC^2)`。

## 常見錯誤

- 把 edge 方向反過來，誤成選 parent 必須選所有 children。
- 不選節點後只前進 `i+1`，讓 descendant 在缺 prerequisite 時被選。
- 假設輸入 ID 已是 DFS preorder。
- 忘記 forest 需要 virtual root 語意；實作不必真的把 root 放進 DP。
