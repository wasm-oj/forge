# 逐步放寬的 Cost Budget

一個工作流程依序包含 `N` 個 stage，第 `i` 個 stage 需要 `cost_i` 點 instruction cost。執行時不能跳過 stage：若要完成第 `k` 個 stage，就必須先完成前 `k-1` 個 stage。

現在有 `Q` 個逐步放寬的 budget `budget_1, budget_2, ..., budget_Q`，保證它們不遞減。每個 budget 都是對同一份工作流程的獨立評估。對每個 budget，請輸出最多能完整執行多少個開頭連續的 stage；也就是找出最大的 `k`，使得：

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
