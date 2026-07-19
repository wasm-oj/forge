# 不等待的虛擬時鐘

在設計 WASM OJ 的確定性執行環境時，poll 不能真的依賴主機經過了多少時間。同一份程式若因電腦速度或系統負載不同而看到不同的 timer 結果，判題便無法重現。因此，我們使用 logical clock，並在沒有立即可處理的事件時直接推進到下一個 deadline。

logical clock 初始為 `0`。系統不會實際等待，而是依序處理 `N` 個命令：

- `T id deadline`：加入絕對 deadline 的 timer。每個 `id` 在整份輸入只加入一次。
- `C id`：取消目前仍 active 的 timer。
- `P ready`：執行一次 poll；`ready` 是當下已 ready 的 fd 事件數。

每次 poll 必須遵守以下規則：

1. 若 `ready>0`，clock 不前進。
2. 若 `ready=0`、沒有 deadline 不大於目前 clock 的 active timer、但仍有 active timer，clock 立刻快轉到最小 active deadline。
3. 接著觸發並移除所有 `deadline≤clock` 的 active timer。
4. 若 `ready=0` 且沒有 active timer，clock 不變。clock 永不倒退。

請模擬這套規則，讓 timer 的觸發只由命令與 logical clock 決定，而不依賴任何實際等待時間。

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
