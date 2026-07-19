# 雙向互動管線

互動題要求 WASM OJ 同時驅動使用者程式與 interactor。兩邊透過有容量限制的 pipe 交換資料；如果只檢查各自的動作，卻沒有精確模擬阻塞、關閉與排程順序，就可能在不同 host 上得到不同的 deadlock 或 failure 判定。

將兩個程序記為 A、B，它們透過 `A→B` 與 `B→A` 兩條容量同為 `C` 的 pipe 溝通。每個程序有一串動作：

- `W k`：原子寫入 outgoing pipe。只有剩餘容量至少 k 時才整個完成，否則阻塞。
- `R k`：原子讀取 incoming pipe。只有已有至少 k bytes 時才完成。若不足且 incoming 已關閉，立刻 FAILURE；否則阻塞。
- `C`：關閉自己的 outgoing pipe並完成。每個程序最多一個 C，C 後不會再有 W。

程序執行完最後一個動作時，其 outgoing pipe 也自動關閉。動作只影響 byte 數，byte 內容不重要。

## 確定性 scheduler

為了讓模擬結果可重現，scheduler 使用固定 round：先嘗試 A 的下一動作一次，再嘗試 B 的下一動作一次。已完成的程序略過。某動作阻塞時，該次嘗試不改變任何狀態；另一程序仍會被嘗試。若某個讀取確定 `FAILURE`，立刻停止，該 round 不再嘗試另一程序。

若兩程序都完成，結果為 `SUCCESS`；若一個完整 round 沒完成任何動作且沒有 `FAILURE`，結果為 `DEADLOCK`。兩條 pipe 初始皆為空；空動作序列在初始狀態就已完成，並關閉自己的 outgoing pipe。

## 輸入

第一行 `C NA NB`，接著 NA 行 A 的動作，再接 NB 行 B 的動作。

- `1≤C≤10^18`，`0≤NA,NB≤200000`，`1≤NA+NB≤200000`
- `1≤k≤C`

## 輸出

- `SUCCESS steps ab ba`
- `DEADLOCK steps ab ba`
- `FAIL A steps ab ba` 或 `FAIL B ...`

`steps` 是停止前完成的動作數；`ab`、`ba` 是兩條 pipe 最終 occupancy。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 3 3
W 3
R 2
C
R 3
W 2
C
```

輸出：

```text
SUCCESS 6 0 0
```

### 範例二

輸入：

```text
3 2 2
R 1
C
R 1
C
```

輸出：

```text
DEADLOCK 0 0 0
```

### 範例三

輸入：

```text
4 2 1
C
R 1
C
```

輸出：

```text
FAIL A 2 0 0
```

<!-- END GENERATED SAMPLES -->
