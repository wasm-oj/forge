# 解題說明

## 直覺解

枚舉所有套件子集合，檢查是否碰到每條 edge，時間指數級。較好的 Kuhn 演算法從每個左點各找一條增廣路，最壞 `O(LM)`，仍會被大型分層圖排除。

## 最佳解

這是二分圖 minimum vertex cover。Kőnig 定理指出：二分圖最小點覆蓋大小等於最大 matching 大小，所以只需求 maximum matching。

Hopcroft–Karp 每一 phase 先從所有未匹配左點 BFS，建立「左點層級」並找最短增廣路長；再只沿 `dist[nextU]=dist[u]+1` 的 edge 找一組 vertex-disjoint augmenting paths。實作使用每個左點的 edge cursor，失敗即把 dist 設為無效，避免同一 phase 重掃。為避免深圖造成 call stack overflow，reference solutions 以顯式 `stackU/stackV` 還原增廣路。

## 正確性證明

BFS 的 dist 使 DFS/顯式堆疊只走交錯圖中的最短增廣路；每次抵達未匹配右點，沿堆疊翻轉 matched/unmatched edges，matching 大小增加一且仍是 matching。cursor 與失敗剪枝不會刪除任何符合分層條件的尚未檢查 edge，所以一個 phase 結束時不存在該最短長度的增廣路。Hopcroft–Karp 定理保證反覆 phase 直到 BFS 找不到增廣路時 matching 為最大。最後由 Kőnig 定理，其大小等於最小點覆蓋大小，正是題目答案。

## 複雜度

Hopcroft–Karp 有 `O(sqrt(L+R))` 個 phase。Reference implementations 每個 phase
會掃過全部左點並走訪各 edge，另需初始化右點 matching，因此保守且與實際
迴圈一致的總時間為 `O((L+R+M) sqrt(L+R))`，空間為 `O(L+R+M)`。不能省略
vertex 項：當圖同時有大量孤立左點與需要多個 phase 的非平凡 component 時，
每個 phase 仍會掃過那些孤立點。

## 常見錯誤

- 在一般圖套用「matching=vertex cover」；此等式只保證於二分圖。
- BFS 後仍走任意 edge，失去分層複雜度。
- 每次 DFS 重設所有 edge cursor，造成同 phase 重掃。
- 遞迴增廣在長交錯路上 stack overflow。
