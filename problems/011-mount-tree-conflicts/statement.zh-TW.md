# 掛載樹衝突檢查

WASM OJ 在建立隔離檔案系統時，會把輸入檔、工具與工作目錄掛進同一棵虛擬檔案樹。掛載設定可能來自不同部分；如果兩筆設定占用同一路徑，或把一般檔案放在另一個項目的祖先位置，實際建立檔案樹時就會產生無法解釋的結構。

系統依序收到一批目錄（`D`）與一般檔案（`F`）紀錄。以下任一情況稱為一對衝突：

1. 兩筆紀錄的路徑完全相同（種類是否相同不影響）；
2. 一筆是一般檔案，且它的路徑是另一筆路徑的**嚴格祖先**。

祖先關係以完整 path segment 判斷。例如 `/a` 是 `/a/b` 的祖先，卻不是 `/ab` 的祖先。根路徑 `/` 是所有其他路徑的祖先。

設定檢查要回報依輸入順序最早能確定的衝突。對衝突紀錄編號 `i < j`，先最小化 `j`；若仍有多組，再最小化 `i`。若沒有任何衝突，輸出 `VALID`。

## 輸入

第一行為整數 `N`。接著 `N` 行各為 `kind path`。

- `1 <= N <= 200000`。
- `kind` 為 `F` 或 `D`。
- 路徑是 canonical absolute path：根路徑為 `/`；其他路徑以 `/` 開頭、不以 `/` 結尾，每個 segment 只含小寫英文字母、數字、`.`、`_`、`-`，且 segment 不得為 `.` 或 `..`。
- 每條路徑長度至多 200；所有路徑長度總和 `S <= 2000000`。
- 紀錄採 1-based 編號。

## 輸出

沒有衝突時輸出：

```text
VALID
```

否則輸出：

```text
CONFLICT i j
```

其中 `(i,j)` 遵守上述 tie-break。

## 限制

逐對檢查會超出所有資源政策。把路徑依樹序排序的 `O(S log N)` 解法可取得較寬鬆政策的分數；最嚴格的 instruction-cost 政策要求 deterministic `O(S)` 解法。

注意：不能把雜湊表的 expected `O(S)` 當成 deterministic worst-case `O(S)`。由於合法路徑字元的 alphabet 大小固定，可以用 first-child/next-sibling 字元 trie，在每個節點至多檢查固定數量的兄弟節點。

所有數值與 indexing 如上所列；輸入保證為 UTF-8，而 path 限制使實際比較內容皆為 ASCII。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4
D /src
F /src/main.c
D /include
F /include/a.h
```

輸出：

```text
VALID
```

### 範例二

輸入：

```text
3
D /a
F /a/b
D /a/b/c
```

輸出：

```text
CONFLICT 2 3
```

### 範例三

輸入：

```text
4
D /x
F /x/a
D /x/b
F /x
```

輸出：

```text
CONFLICT 1 4
```

<!-- END GENERATED SAMPLES -->
