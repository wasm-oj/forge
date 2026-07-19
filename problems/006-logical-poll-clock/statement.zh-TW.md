# 不等待的虛擬時鐘

確定性 runtime 的 logical clock 初始為 `0`，不能真的等待。請依序處理 `N` 個命令：

- `T id deadline`：加入絕對 deadline 的 timer。每個 `id` 在整份輸入只加入一次。
- `C id`：取消目前仍 active 的 timer。
- `P ready`：執行一次 poll；`ready` 是當下已 ready 的 fd 事件數。

POLL 規則如下：

1. 若 `ready>0`，clock 不前進。
2. 若 `ready=0`、沒有 deadline 不大於目前 clock 的 active timer、但仍有 active timer，clock 立刻快轉到最小 active deadline。
3. 接著觸發並移除所有 `deadline≤clock` 的 active timer。
4. 若 `ready=0` 且沒有 active timer，clock 不變。clock 永不倒退。

## 輸入

第一行 `N`，接著 `N` 行命令。輸入保證 `C` 指向目前 active 的 timer，且至少有一個 `P` 命令。

## 輸出

每個 `P` 輸出一行：

```text
clock ready fired id1 id2 ...
```

前三個欄位必定存在；若 `fired=0`，行在 `fired` 後結束。觸發 ID 依 `(deadline,id)` 遞增排列，兩者皆以數值比較。這也定義了相同 deadline 的 tie-break。

## 限制

- `1 ≤ N ≤ 200000`
- `1 ≤ id ≤ N`
- `0 ≤ deadline ≤ 9×10^18`
- `0 ≤ ready ≤ 10^9`

完整限制排除每次 POLL 掃描全部 active timer。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
8
T 1 5
T 2 3
P 0
P 2
T 3 1
P 1
C 1
P 0
```

輸出：

```text
3 0 1 2
3 2 0
3 1 1 3
3 0 0
```

### 範例二

輸入：

```text
5
T 3 10
T 1 10
T 2 10
P 0
P 0
```

輸出：

```text
10 0 3 1 2 3
10 0 0
```

### 範例三

輸入：

```text
9
T 1 8
T 2 4
C 2
P 0
T 4 8
T 3 7
P 5
P 0
P 0
```

輸出：

```text
8 0 1 1
8 5 2 3 4
8 0 0
8 0 0
```

<!-- END GENERATED SAMPLES -->
