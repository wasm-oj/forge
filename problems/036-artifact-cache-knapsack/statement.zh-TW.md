# Artifact Cache 的取捨

有 `N` 個彼此獨立的編譯 artifact。第 `i` 個需要 `size_i` 單位 cache，若保留可在下一次 build 節省 `value_i` 單位時間。每個 artifact 最多保留一次，cache 總容量為 `C`。

請選擇一個子集合，使總 size 不超過 `C`，並最大化總節省時間。只輸出最大值，不需輸出集合；空集合永遠合法。

## 輸入

第一行 `N C`，接下來 `N` 行各為 `size_i value_i`。

## 輸出

一行最大總節省時間。

## 限制

- `1 ≤ N ≤ 200`
- `0 ≤ C ≤ 100000`
- `1 ≤ size_i ≤ 100000`
- `0 ≤ value_i ≤ 10^12`
- 所有 value 總和不超過 `9×10^18`

artifact 不可切割；size 大於 `C` 的 artifact 永遠不能選。完整限制與 64 MiB memory limit 排除子集合列舉及 `O(NC)` 儲存空間。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 7
6 13
4 8
3 6
5 12
```

輸出：

```text
14
```

### 範例二

輸入：

```text
3 0
1 100
2 200
3 300
```

輸出：

```text
0
```

### 範例三

輸入：

```text
5 10
2 4
2 5
6 12
5 11
4 8
```

輸出：

```text
21
```

<!-- END GENERATED SAMPLES -->
