# 交易式 VFS 配額

一個虛擬檔案系統有 `P` 個可能的 canonical guest path，ID `x` 代表 `/file/x`。初始時全部不存在。系統同時限制檔案總 logical bytes 不超過 `B`，存在的檔案數（inode 數）不超過 `I`。

請依序執行 `N` 個操作：

- `CREATE x`：建立大小為零的檔案。
- `WRITE x offset length`：在檔案寫入 `length` bytes。若 `length>0`，新 logical size 為 `max(oldSize,offset+length)`；若 `length=0`，size 不變。
- `TRUNCATE x size`：把 logical size 精確改成 `size`，可增長或縮小。
- `UNLINK x`：刪除檔案並釋放其全部 bytes 與一個 inode。

每個操作都是交易。失敗時，存在狀態、size、用量與 peak 全都不得改變。錯誤依下列順序決定：

- `CREATE`：已存在先回 `EXISTS`；否則若 inode 將超限，回 `INODES`。
- `WRITE`／`TRUNCATE`：不存在先回 `NOENT`；否則若 bytes 將超限，回 `BYTES`。
- `UNLINK`：不存在回 `NOENT`。

成功輸出 `OK`，失敗輸出 `ERR code`。任何一次 `BYTES` 或 `INODES` 錯誤會把 sticky quota failure 設為 `1`，之後永不清除；`EXISTS` 與 `NOENT` 不影響它。

所有操作後，再輸出目前用量、執行期間成功狀態的 peak 用量及 sticky bit。

## 輸入

第一行 `P N B I`，接著 `N` 行為上述操作。ID 為 1-based。

## 輸出

每個操作一行結果，最後一行：

```text
SUMMARY usedBytes usedInodes peakBytes peakInodes sticky
```

bytes peak 與 inode peak 分別取各自曾出現的最大值，不要求在同一時刻發生；初始零狀態也計入。

## 限制

- `1 ≤ P,N ≤ 200000`
- `0 ≤ B ≤ 9×10^18`
- `0 ≤ I ≤ P`
- `1 ≤ x ≤ P`
- `0 ≤ offset,length,size ≤ 9×10^18`
- 每個 `WRITE` 都保證 `offset+length ≤ 9×10^18`

logical hole 也佔配額；例如空檔案執行 `WRITE x 10 5` 後大小為 `15`。完整限制排除每次掃描所有 path 重算用量。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 8 10 2
CREATE 1
WRITE 1 0 6
CREATE 2
WRITE 2 0 5
CREATE 3
TRUNCATE 1 4
UNLINK 2
CREATE 3
```

輸出：

```text
OK
OK
OK
ERR BYTES
ERR INODES
OK
OK
OK
SUMMARY 4 2 6 2 1
```

### 範例二

輸入：

```text
2 7 0 1
WRITE 1 0 1
CREATE 1
CREATE 1
TRUNCATE 1 1
UNLINK 2
UNLINK 1
CREATE 2
```

輸出：

```text
ERR NOENT
OK
ERR EXISTS
ERR BYTES
ERR NOENT
OK
OK
SUMMARY 0 1 0 1 1
```

### 範例三

輸入：

```text
2 8 20 2
CREATE 1
WRITE 1 10 5
TRUNCATE 1 4
WRITE 1 18 2
CREATE 2
TRUNCATE 2 1
UNLINK 1
TRUNCATE 2 20
```

輸出：

```text
OK
OK
OK
OK
OK
ERR BYTES
OK
OK
SUMMARY 20 1 20 2 1
```

<!-- END GENERATED SAMPLES -->
