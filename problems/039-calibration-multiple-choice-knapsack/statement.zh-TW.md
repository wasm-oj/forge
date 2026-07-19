# Calibration 實驗排程

在設計 WASM OJ 的 instruction cost calibration 時，我們需要定期測量不同語言與 toolchain profile。對同一個 profile，可以選擇快速但證據較少的測量方案，也可以投入更多時間執行較完整的 benchmark；這些方案代表同一次 calibration 的替代做法，不能同時採用。

發布前可用的校準時間有限，因此我們可能跳過某些 profile，也可能為不同 profile 選擇不同深度的測量。不同 profile 之間互不排斥，但所有實驗的執行時間必須共享同一個總上限。

共有 `G` 個 calibration profiles。Profile `g` 提供 `K_g` 種互斥測量方案，每個方案都有執行時間與可信度收益。同一個 profile 最多選擇一種方案，也可以完全跳過。

請在總時間上限 `C` 內，最大化所選方案的可信度總和。方案不可切割或重複，空排程合法；只需輸出最大值。

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
