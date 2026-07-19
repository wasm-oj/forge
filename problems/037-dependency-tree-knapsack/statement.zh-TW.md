# 有依賴的快取背包

有 `N` 個 cache artifact，形成一座 dependency forest。節點 `i` 的 `parent_i` 是它的直接 prerequisite；`parent_i=0` 表示沒有 prerequisite。若保留節點 `i`，就必須同時保留 parent 以及一路到 root 的所有 ancestors，否則 dependency closure 不完整、該選擇不合法。

每個節點有 cache size 與收益。請在容量 `C` 內選擇一個 dependency-closed 子集合，使總收益最大。空集合合法，只輸出最大收益。

## 輸入

第一行 `N C`。接下來依 ID `1..N` 各一行 `parent_i size_i value_i`。

輸入保證 `0 ≤ parent_i < i`，因此結構必為 forest，且不存在 cycle。ID 順序不保證是 DFS 順序；同一 parent 的 children 以 ID 遞增視為固定順序，但答案不受此順序影響。

## 輸出

一行最大總收益。

## 限制

- `1 ≤ N ≤ 200`
- `0 ≤ C ≤ 10000`
- `1 ≤ size_i ≤ 10000`
- `0 ≤ value_i ≤ 10^12`
- 所有 value 總和不超過 `9×10^18`

完整限制排除子集合列舉；預期解也不做每個 child 的 `O(C^2)` 容量卷積。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 7
0 2 3
1 3 5
1 4 8
2 2 4
```

輸出：

```text
12
```

### 範例二

輸入：

```text
3 0
0 1 10
1 1 20
0 1 30
```

輸出：

```text
0
```

### 範例三

輸入：

```text
3 3
0 5 5
1 1 100
0 2 10
```

輸出：

```text
10
```

<!-- END GENERATED SAMPLES -->
