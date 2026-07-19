# 判決區間計數

一場 contest 依 case index 記錄 `N` 個判題結果。每個字元是 `A`（Accepted）、`W`（Wrong Answer）、`R`（Runtime Error）或 `T`（Time Limit）。

你要回答 `Q` 個靜態區間查詢。查詢 `L R V` 要求閉區間 `[L, R]` 內 verdict `V` 的出現次數。索引從 `1` 開始，紀錄在所有查詢期間不會改變。

## 輸入

第一行包含 `N Q`。第二行是一個長度為 `N` 的 verdict 字串。接下來 `Q` 行各包含 `L R V`。

## 輸出

對每個查詢輸出一行計數。

## 限制

- `1 <= N, Q <= 200000`
- verdict 字串及查詢字元只包含 `A`、`W`、`R`、`T`。
- `1 <= L <= R <= N`

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
8 4
AAWRTWAA
1 8 A
3 6 W
4 7 R
5 5 T
```

輸出：

```text
4
2
1
1
```

### 範例二

輸入：

```text
5 3
WWWWW
1 5 A
2 4 W
3 3 W
```

輸出：

```text
0
3
1
```

### 範例三

輸入：

```text
4 4
ARTW
1 1 A
1 4 T
2 3 W
2 2 R
```

輸出：

```text
1
1
0
1
```

<!-- END GENERATED SAMPLES -->
