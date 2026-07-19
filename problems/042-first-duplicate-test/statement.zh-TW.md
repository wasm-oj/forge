# 第一份重複測資

在設計 WASM OJ 的題庫匯入流程時，我們需要避免同一份 test case 被重複加入。每份測資在進入儲存系統前都已計算出 fingerprint，因此不必再次比較完整檔案內容；但為了讓錯誤訊息可重現，我們不只想知道是否有重複，還要找出最早發生重複的位置及其原始來源。

系統依抵達順序收到 `N` 個 test case fingerprints。每個 fingerprint 都是非空的小寫十六進位 token。Fingerprint 必須按照 token 字串精確比較，而不是當成十六進位數值；例如 `0` 與 `00` 是不同的 fingerprint。

請找出最早與先前資料重複的一筆。更精確地說，找出最小的 index `i`，使得存在 `j < i` 且兩者 fingerprint 相同，並同時輸出這個 fingerprint 最早出現的 index `j`。所有 index 從 `1` 開始。

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
