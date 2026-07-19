# Calibration 實驗排程

有 `G` 個 calibration profile。profile `g` 提供 `K_g` 種互斥測量方案，每個方案有執行時間與可信度收益。同一 profile 最多選一種方案，也可以完全跳過；不同 profile 的選擇互不排斥。

在總時間上限 `C` 內，最大化可信度總和。方案不可切割或重複，只輸出最大值，空排程合法。

## 輸入

第一行 `G C`。接下來每個 profile 一行：

```text
K time1 value1 time2 value2 ... timeK valueK
```

## 輸出

一行最大可信度總和。

## 限制

- `1 ≤ G ≤ 100`
- `0 ≤ C ≤ 100000`
- `1 ≤ K_g`，且 `ΣK_g ≤ 200`
- `0 ≤ time ≤ 100000`
- `0 ≤ value ≤ 10^12`
- 所有 value 加總不超過 `9×10^18`

即使兩個方案的 time/value 相同，它們仍只是同一組中的替代品，不能同時選。完整限制與 64 MiB memory limit 排除組合列舉及完整 `O(GC)` table。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 7
2 2 4 4 8
2 3 7 5 10
1 2 5
```

輸出：

```text
16
```

### 範例二

輸入：

```text
2 0
3 0 5 0 7 1 100
2 0 4 0 3
```

輸出：

```text
11
```

### 範例三

輸入：

```text
3 5
1 6 100
1 5 9
2 2 3 3 4
```

輸出：

```text
9
```

<!-- END GENERATED SAMPLES -->
