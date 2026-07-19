# 最少隔離的衝突套件

在設計 WASM OJ 的 runtime package 環境時，我們需要同時組合 JavaScript 生態的 npm packages 與底層的 native packages。某些跨生態的套件組合會爭用相同符號、提供不相容的 ABI，或要求彼此衝突的 runtime capability，因此不能同時開放給同一個執行環境。

逐一移除 conflict 並不足以解決問題，因為隔離一個套件會同時消除所有涉及它的衝突。我們希望找出影響最小的隔離方案，讓其餘套件仍能一起使用。

將 npm packages 視為左側的 `L` 個節點，native packages 視為右側的 `R` 個節點。每條 conflict edge 連接一個左側套件與一個右側套件，表示兩端不能同時保留；隔離任一端都會消除這條 conflict，而隔離一個套件會消除所有與它相連的 conflict。

請計算至少要隔離多少個套件，才能消除全部 conflict。只需輸出最小數量；最佳集合可能不唯一，因此不輸出集合本身。

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
