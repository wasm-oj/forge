# 解題說明

## 直覺解

重複掃描所有未輸出 package，找 indegree=0 且名稱最小者；每次輸出後更新下游。即使更新邊只做一次，找最小者仍為 `O(N^2)`。

## 最佳解

先把 `(name, ID)` 依 name 排序；讀 edge 時以 binary search 找 ID，並記錄第一條未知端點。若有 dangling 立即依規格輸出。對合法 edge `a depends b` 建立方向 `b -> a`，並增加 `indegree[a]`。這條 comparison-based lookup 路徑在所有 reference language 都具有 deterministic worst-case bound，不依賴 hash table 的 expected-time 假設。

把所有 indegree 0 的 ID 放進按 package name 排序的 min-heap。反覆 pop、輸出，並遞減其下游 indegree；變成 0 時 push。若最後輸出少於 `N`，剩下節點必位於 cycle 或受 cycle 阻擋，輸出 cycle error。

## 正確性證明

若回報 dangling，所選 edge 是讀取時最小索引，符合第一優先錯誤。以下假設無 dangling。Kahn invariant：heap 恰含所有尚未輸出且 indegree=0 的節點；初始化成立，pop 後只移除該節點的 outgoing edges，恰在下游最後一個未完成依賴消失時將它加入，故維持。每一步 heap minimum 正是規格要求的字典序最小 ready package，因此成功時整個 ORDER 唯一正確。若無法輸出全部節點，Kahn 定理保證剩餘有 directed cycle；反之 DAG 必能持續找到 indegree 0，故 cycle 判定亦正確。

## 複雜度

排序 name table 為 `O(N log N)`；每個 edge 做兩次 `O(log N)` binary search，每個節點至多一次 heap push/pop，因此總時間 `O((N+M) log N)`，空間 `O(N+M)`。

## 常見錯誤

- 把 `a depends b` 建成 `a -> b`。
- 用 FIFO queue，結果雖是拓撲序卻不符合 deterministic tie-break。
- 有 dangling 時仍先回報 cycle。
- 依 ID 而不是 package name 比較 heap 元素。
