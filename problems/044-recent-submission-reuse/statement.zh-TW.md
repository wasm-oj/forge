# 最近重複的 Submission

在設計 WASM OJ 的短期編譯快取時，我們不希望相同程式碼在短時間內被反覆編譯。每份 submission 都有一個 fingerprint；如果最近才處理過完全相同的 fingerprint，就可以重用先前的結果。然而快取只保留有限的近期歷史，太久以前的 submission 不再能命中。

系統依時間順序收到 `N` 筆 submissions。第 `i` 筆有一個小寫十六進位 fingerprint。只有前 `K` 筆 submission 還算近期，因此若完全相同的 fingerprint 曾出現在以下 index 區間，第 `i` 筆就是一次 **reuse hit**：

```text
[max(1, i - K), i - 1]
```

Fingerprint 是精確 token，而非十六進位數值，因此 `0` 與 `00` 不同。當 `K = 0` 時區間為空，每筆 submission 都是 miss。某次 hit 仍然會成為後續 submission 的近期紀錄。

請計算 reuse hit 總數。

## 輸入

第一行包含 `N K`。

其餘輸入依時間順序包含 `N` 個以空白分隔的 fingerprint。

## 輸出

輸出一行 reuse hit 總數。

## 限制

- `1 ≤ N ≤ 200000`
- `0 ≤ K ≤ N`
- 每個 fingerprint 長度介於 `1` 到 `32`。
- 每個字元皆為 `0`–`9` 或 `a`–`f`。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
7 3
a b c a d b a
```

輸出：

```text
2
```

### 範例二

輸入：

```text
4 0
aa aa aa aa
```

輸出：

```text
0
```

### 範例三

輸入：

```text
5 1
aa aa aa bb aa
```

輸出：

```text
2
```

<!-- END GENERATED SAMPLES -->
