# 最少隔離的衝突套件

Runtime 內有兩類套件：左側 npm packages 與右側 native packages。每條 conflict edge 表示其兩端不能同時保留。隔離一個套件會消除所有與它相連的 conflict。

請計算至少要隔離多少套件，才能消除全部 conflict。只需輸出最小數量；最佳集合可能不唯一，因此不輸出集合本身。

## 輸入

第一行 `L R M`。接著 `M` 行 `u v`，其中 `u` 是 1-based 左側 ID，`v` 是 1-based 右側 ID。

## 輸出

輸出一個整數：覆蓋所有 conflict edges 所需的最少頂點數。`M=0` 時輸出 `0`。

## 限制

- `1 <= L,R <= 200000`，`0 <= M <= 400000`。
- 沒有重複 edge。
- 完整測資包含讓逐一增廣達到 `Theta(LM)` 的圖，必須使用分層增廣。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 3 3
1 1
2 2
3 3
```

輸出：

```text
3
```

### 範例二

輸入：

```text
1 4 4
1 1
1 2
1 3
1 4
```

輸出：

```text
1
```

### 範例三

輸入：

```text
4 5 0
```

輸出：

```text
0
```

<!-- END GENERATED SAMPLES -->
