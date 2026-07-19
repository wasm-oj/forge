# 精確依賴快取

WASM OJ 的瀏覽器內編譯快取，首先要避免「只要一個 header 改變，就重新編譯所有 translation unit（TU）」的情況。這種保守作法雖然安全，卻會浪費大量 instruction cost，也會讓只改動一個小檔案的使用者等待完整重建。

因此，編譯器會記錄每個 TU 在編譯時**實際讀過**哪些 header。當一輪修改包含某個 TU 讀過的至少一個 header 時，該 TU 才會 cache miss；如果修改集合與它的精確依賴完全沒有交集，就能沿用原本的編譯結果。

為了評估一系列獨立的編輯情境，每輪結束後都視為所有 miss 已完成重編，所以下一輪重新從乾淨 baseline 開始，而不是累積前幾輪的修改狀態。

給定固定的 TU 與 header 依賴關係，以及多輪 changed-header 集合，請輸出每一輪會 cache miss 的 TU 數量。

## 輸入

第一行 `N H M Q`：TU 數、header 數、依賴邊數、輪數。接著 `M` 行 `s h`，表示 TU `s` 實際讀過 header `h`。再接 `Q` 行，每行為 `K h_1 ... h_K`。

TU 與 header 各自使用 1-based ID。一輪內 header ID 互異；`K=0` 時該行只有 `0`。

## 輸出

輸出 `Q` 行，第 `i` 行是一個十進位整數：第 `i` 輪至少依賴一個 changed header 的 TU 數。沒有 miss 時輸出 `0`。

## 限制

- `1 <= N,H <= 6000`，`0 <= M <= 200000`，`1 <= Q <= 20000`。
- 依賴邊不重複；所有 query 的 `K` 總和不超過 50000。
- word-RAM 的 machine word 至少 32 bits。
- 測資包含高 degree header 被反覆修改；逐 adjacency list 標記的最壞情況不能通過。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 3 4 2
1 1
2 1
2 2
3 2
2 1 2
1 3
```

輸出：

```text
3
0
```

### 範例二

輸入：

```text
2 2 2 2
1 1
2 2
0
1 2
```

輸出：

```text
0
1
```

### 範例三

輸入：

```text
3 1 3 3
1 1
2 1
3 1
1 1
1 1
0
```

輸出：

```text
3
3
0
```

<!-- END GENERATED SAMPLES -->
