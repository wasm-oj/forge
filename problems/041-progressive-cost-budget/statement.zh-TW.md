# 逐步放寬的 Cost Budget

在設計 WASM OJ 時，我們需要限制使用者程式可以消耗的計算資源。單純使用實際執行時間並不理想：同一份程式在不同瀏覽器、裝置或系統負載下，可能得到差異很大的結果。因此，我們選擇記錄 WebAssembly 執行過程中的 instruction cost，讓資源限制更穩定，也更容易重現。

一次完整的判題流程可以拆成 `N` 個依序執行的 stage。第 `i` 個 stage 需要 `cost_i` 點 instruction cost。後面的 stage 依賴前面的執行結果，因此不能跳過中間步驟；若要完成第 `k` 個 stage，就必須先完成前 `k-1` 個 stage。

在決定正式使用哪個 cost limit 前，我們準備了 `Q` 個逐步放寬的候選 budget `budget_1, budget_2, ..., budget_Q`，並保證它們不遞減。每個 budget 都會從第一個 stage 開始，獨立評估同一份工作流程。

對每個 `budget_j`，請輸出最多能完整執行多少個開頭連續的 stage；也就是找出最大的 `k`，使得：

```text
cost_1 + cost_2 + ... + cost_k <= budget_j
```

`k=0` 永遠合法。成本為零的 stage 仍然是可完成的 stage，因此也必須計入答案。

## 輸入

第一行包含兩個整數 `N Q`。

第二行包含 `N` 個整數 `cost_1, cost_2, ..., cost_N`。

第三行包含 `Q` 個不遞減的整數 `budget_1, budget_2, ..., budget_Q`。

## 輸出

對每個 budget 依序輸出一行，內容是可完整執行的最大 stage 數量。

## 限制

- `1 <= N,Q <= 200000`
- `0 <= cost_i <= 10^12`
- `0 <= budget_j <= 9 * 10^18`
- `budget_1 <= budget_2 <= ... <= budget_Q`
- 所有 stage 的成本總和不超過 `9 * 10^18`
- 所有官方測資都符合完整限制
- JavaScript 與 TypeScript 必須使用 `bigint` 儲存成本、budget 與累計值

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 4
4 2 7 1 3
0 6 10 17
```

輸出：

```text
0
2
2
5
```

### 範例二

輸入：

```text
4 5
0 5 0 2
0 4 5 6 7
```

輸出：

```text
1
1
3
3
4
```

### 範例三

輸入：

```text
1 3
9
8 9 100
```

輸出：

```text
0
1
1
```

<!-- END GENERATED SAMPLES -->
