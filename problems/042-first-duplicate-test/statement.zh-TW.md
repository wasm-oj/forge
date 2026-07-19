# 第一份重複測資

Judge 依抵達順序收到 `N` 個 test case fingerprint。每個 fingerprint 都是非空的小寫十六進位 token。只有 token 字串完全相同才算同一個 fingerprint；例如 `0` 與 `00` 是不同的 fingerprint。

請找出最早與先前資料重複的一筆。更精確地說，找出最小的 index `i`，使得某個 `j < i` 與它有相同 fingerprint，並同時輸出這個 fingerprint 最早出現的 index `j`。index 從一開始。

若所有 fingerprint 都互不相同，請輸出 `NONE`。

## 輸入

第一行包含整數 `N`。

其餘輸入依抵達順序包含 `N` 個以空白分隔的 fingerprint。

## 輸出

若存在重複，輸出 `i j`，其中 `i` 是最小的重複 index，`j` 是相同 token 第一次出現的 index。

否則輸出 `NONE`。

## 限制

- `1 ≤ N ≤ 200000`
- 每個 fingerprint 長度介於 `1` 到 `32`。
- 每個字元皆為 `0`–`9` 或 `a`–`f`。
- 必須精確比較 token；fingerprint 不是數字。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5
aa bb cc bb aa
```

輸出：

```text
4 2
```

### 範例二

輸入：

```text
4
0 a 00 f0
```

輸出：

```text
NONE
```

### 範例三

輸入：

```text
6
0 a 00 a ff 0
```

輸出：

```text
4 2
```

<!-- END GENERATED SAMPLES -->
