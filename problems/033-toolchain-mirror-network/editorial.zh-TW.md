# 解題說明

## 直覺解

枚舉 link 子集合並檢查連通，再取最低成本，時間指數級。即使只枚舉 `N-1` 條也仍不可行。

## 最佳解

任一可行 connected subgraph 若含 cycle，因成本非負，可刪除 cycle 上一條 edge 而不變差；所以存在最佳 spanning tree，題目即 minimum spanning tree。

Kruskal 將 edges 依 cost 非遞減排序。DSU 判斷兩端是否已在同一 component；不同才選取並 union。選到 `N-1` 條即完成。若掃完仍不足，圖不連通。相同 cost 的處理順序不影響最小總成本，因此不需要 tie-break 或輸出 edge 集合。

## 正確性證明

在每一步，Kruskal 選的是連接兩個目前 components 的全域最輕 edge。依 cut property，對分隔這兩 components 的 cut，存在一棵 MST 含此最輕 edge；所以可在不提高最佳成本下接受它。歸納所有接受 edges 都能擴充成 MST。成功選 `N-1` 條時它們無 cycle 且連通，故是 spanning tree 且成本最小。若不足 `N-1`，原圖 components 之間沒有任何 edge，任何 spanning tree 都不存在。

## 複雜度

排序 `O(M log M)`；DSU 總計 `O(M alpha(N))`，空間 `O(N+M)`。

## 常見錯誤

- 把 toolchain 傳送誤解成每個 host 都必須直接連 host 1。
- 平行 edge 只保留輸入第一條，而非最低成本選擇。
- 使用 32-bit 累加 MST cost。
- 忘記 `N=1` 即使 `M=0` 也已完成。
