# 原始碼樹證據

可重現的 WASM OJ 建置紀錄，需要用 provenance manifest 說明編譯實際看見的 source tree。manifest 必須涵蓋一般檔案、symbolic link 與已刪除項目的 tombstone，並且不受檔案被掃描到的先後順序影響。

不過 provenance evidence 本身也會寫回 tree。如果把 evidence 目錄再次收入自己的 manifest，內容就會遞迴依賴自身，每次產生證據都可能改變下一份證據。因此，產生 canonical manifest 時必須完整排除指定的 evidence subtree。

第一行給定 evidence 根路徑 E。record 有三種：

- `F path executable length digest`：檔案；
- `L path target`：symbolic link；
- `D path`：已刪除項目的 tombstone。

digest 是已完成的 8 位小寫十六進位 token。所有 path 已 normalized、互不相同。若 record 的 path 恰等於 `E`，或以 `E/` 開頭，就排除；例如 `E=proof` 時 `proof/a` 被排除，但 `proof2/a` 不會。

其餘 record 依 path 的 UTF-8 bytes 嚴格遞增輸出，形成唯一順序。輸入字元限制在 ASCII，所以等價於 ASCII 字典序。輸出 record 的其他欄位完全保持不變。

## 輸入

第一行 `N E`，接著 N 行 records。

- `1≤N≤200000`
- path 長 1..120，由小寫英數、`_-.` 與 `/` 組成；不得以 `/` 開頭或結尾，不得有空、`.` 或 `..` segment
- E 也符合 path 規則；target 是長 1..120 的同字元集非空 token
- executable 為 0 或 1；`0≤length≤10^18`

## 輸出

第一行輸出保留 record 數 M，再依 canonical 順序原樣輸出 M 行。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 .evidence
F src/main.c 1 12 deadbeef
D old.c
F .evidence/report 0 3 00000001
L link src/main.c
F .evidence2/x 0 4 00000002
```

輸出：

```text
4
F .evidence2/x 0 4 00000002
L link src/main.c
D old.c
F src/main.c 1 12 deadbeef
```

### 範例二

輸入：

```text
3 proof
F proof 0 1 00000000
F proof/a 0 2 00000001
D proof/old
```

輸出：

```text
0
```

### 範例三

輸入：

```text
4 out
F out2/a 1 9 abcdef01
L z a
D a
F out/x 0 2 12345678
```

輸出：

```text
3
D a
F out2/a 1 9 abcdef01
L z a
```

<!-- END GENERATED SAMPLES -->
