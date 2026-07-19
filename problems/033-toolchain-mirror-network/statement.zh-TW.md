# Toolchain 鏡像網路

Host 1 已持有 toolchain。每條無向 link `u v cost` 可把 toolchain 在兩 host 間傳送一次；只要其中一端已取得，便能沿選定 link 讓另一端取得。請選一組 link，使所有 host 最終都取得 toolchain且總成本最小。

選定連線後可依任一從 host 1 出發的順序傳送；因此要求等價於選一個涵蓋全部 host 的 connected subgraph。

## 輸入

第一行 `N M`。接著 `M` 行 `u v cost`，host ID 為 1-based，link 無向。

## 輸出

若不可能連通所有 host，輸出 `IMPOSSIBLE`；否則輸出 `COST x`，其中 `x` 是最小總成本。`N=1` 時答案為 `COST 0`，不論是否有 link。

## 限制

- `1 <= N <= 200000`，`0 <= M <= 400000`。
- `u != v`；平行 link 允許；`0 <= cost <= 10^12`。
- 任一 spanning tree 的成本總和保證不超過 `9*10^18`。
- 完整測資要求次線性 amortized DSU 操作；枚舉或 adjacency matrix Prim 無法通過。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 5
1 2 4
2 3 1
3 4 2
1 4 10
1 3 3
```

輸出：

```text
COST 6
```

### 範例二

輸入：

```text
4 2
1 2 1
3 4 1
```

輸出：

```text
IMPOSSIBLE
```

### 範例三

輸入：

```text
3 4
1 2 9
1 2 0
2 3 4
1 3 8
```

輸出：

```text
COST 4
```

<!-- END GENERATED SAMPLES -->
