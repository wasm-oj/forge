# 雙限制輸出蒐集

一次 submission 產生 `N` 個可選的輸出 bundle。bundle `i` 會消耗 `bytes_i` 的共享輸出空間及 `entries_i` 個 VFS entries，並帶來 `value_i` 的診斷重要度。bundle 不可拆分、不可重複。

系統最多允許 `B` bytes 與 `I` entries。請選擇任意子集合，在兩種 quota 都不超限時最大化總重要度。空集合合法，只輸出最大重要度，不需輸出集合。

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
