# Graph Blob LRU

Build graph 的多個節點可引用相同 output digest；cache 只為該 blob 付一次空間。容量不足時按 blob 的 LRU 淘汰，並立即讓所有引用該 digest 的節點失效。

有 `N` 個節點、`D` 個 digest。操作：

- `P u d`：節點 `u` 發布 digest `d`。先移除 `u` 的舊引用。若 `size[d] > C`，新引用不成立且 LRU 不變；否則把 blob 載入（若已存在則不重複計空間）、讓 `u` 引用它並把它移到 MRU。若超容量，反覆淘汰 LRU blob。
- `G u`：若 `u` 的引用仍有效，輸出 `HIT d` 並把 blob 移到 MRU；否則輸出 `MISS`。

沒有節點引用的 cached blob 仍留在 cache 並參與 LRU，直到被淘汰。對同一 `(u,d)` 再做 `P` 也依完整規則先 detach、再 attach/touch。

## 輸入

第一行 `N D Q C`。第二行有 `D` 個 blob size。接著 `Q` 行為 `P u d` 或 `G u`。所有 ID 為 1-based；初始沒有 blob 或引用。

## 輸出

依序為每個 `G` 輸出一行 `HIT d` 或 `MISS`，不輸出 `P` 的結果。

## 限制

- `1 <= N,D,Q <= 200000`，至少有一個 `G`。
- `0 <= C,size[d] <= 9*10^18`，所有 size 總和不超過 `9*10^18`。
- 任一時刻的 cache occupancy 以 unsigned 64-bit 表示。
- 若一次淘汰使很多節點失效，這些引用都源自先前的 `P`；完整測資要求利用此 amortized 性質。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 3 7 5
3 2 4
P 1 1
P 2 2
G 1
P 3 3
G 2
G 3
G 1
```

輸出：

```text
HIT 1
MISS
HIT 3
MISS
```

### 範例二

輸入：

```text
3 1 5 2
2
P 1 1
P 2 1
G 1
P 1 1
G 2
```

輸出：

```text
HIT 1
HIT 1
```

### 範例三

輸入：

```text
1 2 6 3
4 3
P 1 1
G 1
P 1 2
G 1
P 1 1
G 1
```

輸出：

```text
MISS
HIT 2
MISS
```

<!-- END GENERATED SAMPLES -->
