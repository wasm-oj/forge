# 最划算的 Conformance Suite

Runtime 有 `F` 個待驗證 feature，編號 `1..F`。候選測試 `i` 有執行成本 `cost_i`，並覆蓋一個 feature 集合；只要至少選到一個覆蓋某 feature 的測試，該 feature 就算被驗證一次。

在總成本 budget `B` 內選擇任意測試子集合，使被覆蓋的不同 feature 數量最大。測試不可重複，空集合合法。只輸出最大覆蓋數，不需輸出集合；重複覆蓋沒有額外收益。

## 輸入

第一行 `F N B`。接下來 `N` 行各為：

```text
cost k feature1 ... featurek
```

同一測試內的 feature ID 互不相同，`k=0` 合法。

## 輸出

一行最大可覆蓋 feature 數。

## 限制

- `1 ≤ F ≤ 20`
- `1 ≤ N ≤ 25`
- `0 ≤ B ≤ 10^12`
- `0 ≤ cost_i ≤ 10^9`
- `0 ≤ k ≤ F`，`1 ≤ feature_j ≤ F`

所有成本加總不超過 `2.5×10^10`，可安全存於精確整數。完整限制排除列舉最多 `2^25` 個測試子集合。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 3 5
3 2 1 2
2 2 2 3
4 1 4
```

輸出：

```text
3
```

### 範例二

輸入：

```text
3 3 0
0 1 2
0 2 1 3
1 3 1 2 3
```

輸出：

```text
3
```

### 範例三

輸入：

```text
5 5 6
2 2 1 2
2 2 1 2
3 2 3 4
3 1 5
7 5 1 2 3 4 5
```

輸出：

```text
4
```

<!-- END GENERATED SAMPLES -->
