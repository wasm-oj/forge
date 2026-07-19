# 三流共用輸出池

在設計 WASM OJ 的輸出限制時，我們發現 stdout、stderr 與輸出檔案不能各自擁有互不相關的額度。否則程式可以同時使用三個流，把總輸出量放大到單一限制的數倍。因此，三種輸出必須依實際發生順序，共用同一個 byte budget。

一次執行會按時間順序產生 `N` 次 write event。每個事件寫入 `O`（stdout）、`E`（stderr）或 `F`（輸出檔案集合）之一。為了分析不同限制的效果，系統會以多個 budget 獨立重播相同事件；每次查詢的輸出池都從空狀態開始。

一次 write 可以只保留前半段。若池中只剩 `x` bytes，就保留該 event 的前 `x` bytes、將池填滿，並把這個 event 記為第一次失敗。輸出池一旦填滿，就不再處理任何後續事件。

輸入保證查詢 budget 非遞減。對每個 budget，請輸出第一次無法完整保留的事件，以及三個流實際保留的 byte 數。

## 輸入

第一行 `N Q`。接下來 `N` 行各為 `stream bytes`，其中 `stream` 為 `O`、`E` 或 `F`。最後 `Q` 行各有一個 `budget`，且依序非遞減。

## 輸出

每個查詢輸出：

```text
failure stdoutBytes stderrBytes fileBytes
```

`failure` 是第一個無法完整保留的 1-based event 索引。若所有 event 都完整保留，`failure=0`。budget 為零時，第一個正長度 event 立即失敗且三個計數皆為零。重複 budget 合法且答案相同。

## 限制

- `1 ≤ N,Q ≤ 200000`
- `1 ≤ bytes ≤ 10^12`
- `0 ≤ budget ≤ 9×10^18`
- 全部 event 的 byte 總和不超過 `9×10^18`
- budget 序列非遞減

完整限制排除對每個 budget 重播事件的作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 6
O 5
E 3
F 10
O 4
0
5
7
8
20
30
```

輸出：

```text
1 0 0 0
2 5 0 0
2 5 2 0
3 5 3 0
4 7 3 10
0 9 3 10
```

### 範例二

輸入：

```text
1 3
F 7
6
7
8
```

輸出：

```text
1 0 0 6
0 0 0 7
0 0 0 7
```

### 範例三

輸入：

```text
3 5
E 2
E 2
O 1
1
1
3
4
5
```

輸出：

```text
1 0 1 0
1 0 1 0
2 0 3 0
3 0 4 0
0 1 4 0
```

<!-- END GENERATED SAMPLES -->
