# 64 KiB 記憶體閘門

一個模組依索引 `1..N` 宣告多個 linear memory，每頁恰為 `65536` bytes。Judge 的政策上限為每個 memory 至多 `C` 頁，且不支援 Memory64。

每個宣告有 `kind initial maximum`：`kind` 是 `32` 或 `64`；`maximum=-1` 表示未宣告 maximum，否則是宣告頁數。單一宣告在下列任一情形違規：

1. `kind=64`；
2. 有 maximum 且 `maximum < initial`；
3. `initial > C`。

合法宣告的重寫後 maximum 為：未宣告時取 `C`，有宣告時取 `min(maximum,C)`。

每個查詢給區間 `[l,r]`。若區間含違規宣告，輸出 `REJECT i`，其中 `i` 必須是區間內最小的違規索引。否則輸出 `ACCEPT initialBytes maximumBytes`，兩者分別是區間內 initial 與重寫後 maximum 的總頁數乘以 `65536`。

## 輸入

第一行 `N Q C`；接下來 `N` 行為宣告；最後 `Q` 行各為 `l r`。

## 輸出

依上述規則每個查詢輸出一行。所有查詢互相獨立，索引為 1-based，且 `l≤r`。

## 限制

- `1 ≤ N,Q ≤ 200000`
- `1 ≤ C ≤ 10^12`
- `kind ∈ {32,64}`
- `0 ≤ initial ≤ 10^12`
- `maximum=-1` 或 `0 ≤ maximum ≤ 10^12`
- 所有合法宣告的重寫後 maximum 總頁數不超過 `137329101562500`，因此任何輸出 byte 數不超過 `9×10^18`

完整限制排除每次掃描整段區間。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 5 10
32 2 -1
32 4 8
64 1 2
32 11 -1
32 3 2
1 2
2 2
1 3
3 5
4 5
```

輸出：

```text
ACCEPT 393216 1179648
ACCEPT 262144 524288
REJECT 3
REJECT 3
REJECT 4
```

### 範例二

輸入：

```text
3 3 5
32 0 0
32 5 -1
32 2 100
1 1
1 3
2 3
```

輸出：

```text
ACCEPT 0 0
ACCEPT 458752 655360
ACCEPT 458752 655360
```

### 範例三

輸入：

```text
4 4 7
32 3 3
32 6 5
32 8 20
64 0 -1
1 1
1 2
2 4
3 4
```

輸出：

```text
ACCEPT 196608 196608
REJECT 2
REJECT 2
REJECT 3
```

<!-- END GENERATED SAMPLES -->
