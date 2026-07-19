# 雙限制輸出蒐集

在設計 WASM OJ 的失敗診斷功能時，我們希望保存 stdout、錯誤紀錄、coverage 資料與其他輸出，協助使用者理解 submission 為什麼失敗。然而瀏覽器內的輸出空間同時受到兩種限制：檔案內容不能超過共享 byte quota，虛擬檔案系統中的 entry 數量也不能無限制增加。

一次 submission 可能產生多個可選的診斷 bundles。每個 bundle 都有自己的空間需求、entry 數量與診斷重要度，而且必須完整保留才有意義，不能只保存其中一部分。

共有 `N` 個可選 bundle。Bundle `i` 會消耗 `bytes_i` bytes 的共享輸出空間及 `entries_i` 個 VFS entries，並帶來 `value_i` 的診斷重要度。每個 bundle 不可拆分，也不可重複選擇。

系統最多允許 `B` bytes 與 `I` entries。請選擇任意子集合，在兩種 quota 都不超限時最大化總重要度。空集合合法；只需輸出最大重要度，不需輸出集合。

## 輸入

第一行 `N B I`。接下來 `N` 行各為 `bytes_i entries_i value_i`。

## 輸出

一行最大重要度總和。

## 限制

- `1 ≤ N ≤ 100`
- `0 ≤ B ≤ 3000`
- `0 ≤ I ≤ 30`
- `0 ≤ bytes_i ≤ 3000`
- `1 ≤ entries_i ≤ 30`
- `0 ≤ value_i ≤ 10^12`
- 所有 value 總和不超過 `9×10^18`

bytes 為零的空 bundle 仍消耗至少一個 entry。完整限制與 64 MiB memory limit 排除子集合列舉與保留 item 維度的完整三維 table。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 7 3
4 1 8
3 2 7
2 1 5
5 3 20
```

輸出：

```text
20
```

### 範例二

輸入：

```text
4 0 2
0 1 5
0 1 7
0 2 9
1 1 100
```

輸出：

```text
12
```

### 範例三

輸入：

```text
5 10 4
6 2 12
4 2 9
5 1 10
3 3 8
10 4 25
```

輸出：

```text
25
```

<!-- END GENERATED SAMPLES -->
