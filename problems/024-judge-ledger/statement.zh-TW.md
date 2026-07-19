# Judge 總帳區間查詢

一份 submission 的最終 verdict 不足以呈現所有診斷資訊，因此 WASM OJ 的判題結果介面也要讓使用者檢查某一段 test cases 的執行摘要。不同檢視模式可能跑完整區間，也可能在第一個失敗 case 立刻停止；兩者實際納入統計的範圍並不相同。

每個 case 依序記錄 `verdict cost time memory vfs`。verdict 以整數表示：`0=AC, 1=WA, 2=RE, 3=TLE`。四個 metric 若無法取得，以 `-1` 表示。現在需要回答多個區間查詢，重現介面在不同 fail-fast 設定下應顯示的摘要。

每個查詢 `l r f` 要聚合 1-indexed 閉區間 `[l,r]`：

- 若 `f=1`（fail-fast），只處理到區間中第一個 verdict 非 0 的 case（包含該 case）；若沒有失敗則處理到 r。
- 若 `f=0`，處理完整區間。
- 輸出 verdict 為實際處理範圍內第一個非 0 verdict，若無則 0。
- cost、time 取總和；memory、vfs 取最大值。
- 對每一個 metric 分別處理：只要實際範圍內任一值為 -1，該 aggregate 輸出 `null`。其他 metric 不受影響。

## 輸入

第一行 `N Q`。接著 N 行 case，再接著 Q 行查詢。

- `1 ≤ N,Q ≤ 200000`
- metric 為 `-1` 或 `[0,10^12]`；任一合法區間的 cost/time 總和不超過 `9×10^18`
- `1 ≤ l ≤ r ≤ N`，`f` 為 0 或 1

## 輸出

每個查詢一行：`processed verdict cost time memory vfs`。`processed` 是實際處理 case 數。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 4
0 10 5 100 3
1 20 7 120 4
0 -1 2 80 2
2 5 -1 200 -1
1 4 1
1 4 0
3 4 1
3 3 0
```

輸出：

```text
2 1 30 12 120 4
4 1 null null 200 null
2 2 null null 200 null
1 0 null 2 80 2
```

### 範例二

輸入：

```text
3 3
0 1 2 3 4
0 5 6 7 8
0 9 10 11 12
1 3 1
2 3 0
2 2 1
```

輸出：

```text
3 0 15 18 11 12
2 0 14 16 11 12
1 0 5 6 7 8
```

### 範例三

輸入：

```text
2 2
3 -1 -1 -1 -1
0 7 8 9 10
1 2 1
1 2 0
```

輸出：

```text
1 3 null null null null
2 3 null null null null
```

<!-- END GENERATED SAMPLES -->
