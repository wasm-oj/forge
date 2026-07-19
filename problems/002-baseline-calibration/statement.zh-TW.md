# 空程式基線校正

Judge 對 `P` 個編譯 profile 測量空程式成本。每個 profile 預期恰有 seed `1..S` 的 `S` 筆觀測；只有所有 seed 都有觀測，且這些成本完全相同，該 profile 才能發布 baseline。

輸入只會讓同一組 `(profile, seed)` 出現至多一次，但觀測順序任意。對每個 raw cost 查詢：若 profile 沒有可發布的 baseline，輸出 `INVALID`；否則輸出 baseline 與扣除基線後的 net cost。net cost 不得為負，因此定義為 `max(0, raw-baseline)`。

## 輸入

第一行為 `P S N Q`。接下來 `N` 行為 `profile seed cost`，最後 `Q` 行為 `profile raw`。

## 輸出

每個查詢一行。有效時輸出 `baseline net`，無效時只輸出 `INVALID`。查詢不會改變校正資料。

## 限制

- `1 ≤ P,S,Q ≤ 200000`
- `0 ≤ N ≤ 200000`
- `1 ≤ profile ≤ P`，`1 ≤ seed ≤ S`
- 所有 `(profile,seed)` 互不相同
- `0 ≤ cost,raw ≤ 9×10^18`

`count=S` 在上述 seed 範圍與唯一性保證下等價於該 profile 沒有缺 seed。完整限制排除每次查詢重掃全部觀測的作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 2 5 5
1 1 10
2 2 8
3 2 4
1 2 10
2 1 7
1 6
1 15
2 99
3 4
1 10
```

輸出：

```text
10 0
10 5
INVALID
INVALID
10 0
```

### 範例二

輸入：

```text
4 1 3 4
3 1 9
1 1 0
4 1 20
1 5
2 5
3 8
4 25
```

輸出：

```text
0 5
INVALID
9 0
20 5
```

### 範例三

輸入：

```text
2 3 6 3
2 3 5
1 2 0
2 1 5
1 1 0
2 2 5
1 3 0
1 0
1 12
2 4
```

輸出：

```text
0 0
0 12
5 0
```

<!-- END GENERATED SAMPLES -->
