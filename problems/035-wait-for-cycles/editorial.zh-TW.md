# 解題說明

## 直覺解

從每個 process 做一次圖搜尋，建立 mutual reachability matrix 再分組，時間 `O(N(N+M))`；Floyd–Warshall 更達 `O(N^3)`。

## 最佳解

用 iterative Kosaraju：第一趟在原圖以 `(node,next-edge-index)` stack 得到 finish order；第二趟依逆 finish order在反圖 flood fill，標出 SCC ID。這避免長鏈上的遞迴 stack overflow。

統計每個 SCC 的 members；size>1 或含 self-loop 就輸出為等待環群組。對每條跨 SCC edge `cu->cv`，標記 `indegree[cv]>0`。Condensation graph 是 DAG；要讓 release 從 wake seeds 覆蓋所有 components，恰需在每個 indegree=0 的 source SCC 放一個 seed，所以 `W` 是 source SCC 數。

## 正確性證明

Kosaraju 定理保證兩趟搜尋得到且只得到 maximal mutual-reachability sets，即 SCC。SCC size>1 時任兩點間路徑組成 cycle；singleton 只有 self-loop 才含 cycle，因此群組判定精確，排序只決定唯一輸出順序。

縮點後為 DAG。每個 source SCC 沒有其他 component 能沿 release edge到達它，所以任何方案至少要在每個 source SCC 內 wake 一點。反之，在每個 source SCC wake 一點後，SCC 內全被釋放；DAG 中每個 component 都可由某 source 沿 edge 到達，故所有 process 都會釋放。上下界相等，所以 `W` 正確。

## 複雜度

兩趟 DFS 與縮點統計皆為 `O(N+M)`。Reference solutions 再依 ID 由小到大把節點放入所屬 component，並於同一次 ID 掃描輸出 component 的最小 ID，因此不需要額外排序。總時間 `O(N+M)`，空間 `O(N+M)`。

## 常見錯誤

- 把所有 singleton SCC 都當成等待環，忽略 self-loop 條件。
- 計算 condensation 的 sink 數；release 沿 `u->v` 正向傳播，所以需要 source。
- 對跨 SCC 的平行 condensation edge重複計 indegree 不影響零/非零，但不應拿它當精確 indegree用途。
- 遞迴 DFS 在 `N=200000` 長鏈爆 stack。
