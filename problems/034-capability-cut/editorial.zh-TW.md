# 解題說明

## 直覺解

枚舉被封鎖的函式集合，刪除後從所有 entries 做 reachability 檢查。這需要 `O(2^N(N+M))`。

## 最佳解

把每個函式 `i` 拆成 `in(i)` 與 `out(i)`，加入 capacity=`cost[i]` 的 `in -> out` edge。原呼叫 `u -> v` 變成 `out(u) -> in(v)`，capacity 設為 `INF=sum(cost)+1`。加入 super source 到所有 `in(entry)` 的 INF edges，以及所有 `out(dangerous)` 到 super sink 的 INF edges。

任何 source-sink path 必跨過其經過函式的 `in->out` edge；切它等價於封鎖該函式。INF 大於封鎖全部函式的成本，所以 minimum cut 不會選 synthetic/call edge。用 Dinic 求 max flow，依 max-flow min-cut theorem 即得 minimum cut cost。

## 正確性證明

任一合法封鎖集合 `B` 對應切掉所有 `i in B` 的 `in(i)->out(i)` edges；它阻斷原圖所有危險路徑，故在 split graph 形成同成本 s-t cut。反之，minimum cut 不含 INF edge，因所有函式 edge 的總容量至多 `sum(cost)<INF`；其有限 edges 只可能是 `in->out`，把對應函式封鎖便阻斷每條原 entry-dangerous 路徑，且成本等於 cut。兩方向顯示最小封鎖成本等於 minimum cut capacity。Dinic 產生 maximum flow，而 max-flow min-cut theorem 保證其值等於該 minimum cut，所以輸出正確；entry=dangerous 時路徑仍跨該節點自己的 capacity edge，亦正確處理。

## 複雜度

split graph 有 `V'=2N+2`、`E'=N+M+S+T` 條正向 edge。Dinic 一般容量上界為時間 `O(V'^2 E')`、空間 `O(V'+E')`。

## 常見錯誤

- 把 node cost 直接放到 call edges，遇到多入/多出邊會重複計價。
- source 接到 `out(entry)` 或從 `in(dangerous)` 接 sink，導致不能封鎖端點。
- 未從限制證明固定 INF 嚴格大於所有合法 cut；直接使用 `sum(cost)+1` 最清楚。
- JS/TS 用 `number` 保存 capacity。
