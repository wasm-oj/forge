# 精確依賴快取

編譯器記錄每個 translation unit（TU）實際讀過哪些 header。每輪修改若包含 TU 讀過的至少一個 header，該 TU 就 cache miss；否則 hit。每輪結束後所有 miss 都已重編，因此下一輪重新從乾淨 baseline 開始。

給定固定的精確依賴關係與多輪 header 修改集合，輸出每輪 cache miss 的 TU 數量。

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
