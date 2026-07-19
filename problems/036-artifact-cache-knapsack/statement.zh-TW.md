# Artifact Cache 的取捨

在設計 WASM OJ 的增量編譯快取時，我們發現「把所有編譯產物都留下來」並不是可行策略。瀏覽器提供的持久化空間有限，而不同 artifact 的大小與重建成本差異很大：有些檔案占用大量 cache，下一次 build 卻只節省很少時間；另一些小型 artifact 則非常值得保留。

為了決定一次清理後應該留下哪些內容，我們替每個 artifact 記錄它占用的 cache size，以及下次 build 重用它能節省的時間。這一題先考慮彼此獨立的 artifact，因此保留其中一個不會要求同時保留其他項目。

共有 `N` 個編譯 artifact。第 `i` 個占用 `size_i` 單位 cache，若保留則能在下一次 build 節省 `value_i` 單位時間。每個 artifact 最多保留一次，cache 總容量為 `C`。

請選擇一個子集合，使總 size 不超過 `C`，並最大化總節省時間。只需輸出最大值，不需輸出集合；空集合永遠合法。

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
