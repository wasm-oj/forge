# 三流共用輸出池

Judge 按時間順序收到 `N` 次 write event。每次寫入 `O`（stdout）、`E`（stderr）或 `F`（輸出檔案集合）之一，但三者共用同一個 byte budget。

對每個獨立查詢，輸出池從空狀態重播全部事件。一次 write 可以被部分保留：若池中只剩 `x` bytes，就保留該 event 的前 `x` bytes，將池填滿，並把這個 event 記為第一次失敗。池滿後不再處理後續事件。

查詢 budget 依輸入保證為非遞減。請輸出第一次無法完整保留的事件，以及三個流實際保留的 byte 數。

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
