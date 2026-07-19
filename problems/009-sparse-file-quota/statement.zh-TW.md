# 稀疏檔案不是免費的

替 WASM OJ 實作 VFS byte quota 時，只計算實際寫入的 payload 並不安全。程式可以先把 cursor 移到很遠的位置，再寫入少量資料，形成很大的 sparse hole。即使中間沒有真正寫入，這段範圍仍會擴張檔案的 logical size，因此必須占用相同的 quota。

VFS 中有 `F` 個已存在的空檔案。每個檔案都有 logical size 與 cursor，兩者初始皆為 `0`；所有檔案的 logical size 總和不得超過 byte quota `B`。請依序執行 `N` 個操作：

- `SEEK x position`：將檔案 `x` 的 cursor 設為絕對位置；可超過 EOF，且不改變 size。
- `WRITE x length`：若 `length>0`，候選新 size 是 `max(oldSize,cursor+length)`；若 `length=0`，size 與 cursor 都不變。非零 write 成功後 cursor 增加 `length`。
- `TRUNCATE x size`：候選新 size 精確等於 `size`；cursor 不變，即使它落在新 EOF 之後。

`SEEK` 永遠成功。`WRITE` 或 `TRUNCATE` 必須先以候選狀態檢查全體檔案的 logical size 總和；若總和超過 `B`，輸出 quota error，且該操作對 size、cursor 與 peak 都完全沒有影響。只有通過配額檢查時，所有變更才一次提交。

## 輸入

第一行 `F N B`，接下來 `N` 行為操作。檔案 ID 為 1-based。

## 輸出

每個操作輸出一行。成功時：

```text
OK fileSize cursor usedBytes
```

quota 失敗時：

```text
ERR QUOTA fileSize cursor usedBytes
```

各欄位皆是該操作結束後的狀態。最後輸出 `SUMMARY usedBytes peakBytes`。peak 只看成功提交後的全域 usedBytes，初始零也計入。

## 限制

- `1 ≤ F,N ≤ 200000`
- `0 ≤ B ≤ 9×10^18`
- `1 ≤ x ≤ F`
- `0 ≤ position,length,size ≤ 9×10^18`
- 執行序列中每個 `cursor+length` 都保證不超過 `9×10^18`

令 `E` 為最大曾觸及 offset；它可達 `9×10^18`，所以不可 materialize hole。完整限制也排除每次重算所有檔案 size。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
2 6 10
SEEK 1 7
WRITE 1 3
SEEK 2 5
WRITE 2 1
TRUNCATE 1 4
WRITE 2 1
```

輸出：

```text
OK 0 7 0
OK 10 10 10
OK 0 5 10
ERR QUOTA 0 5 10
OK 4 10 4
OK 6 6 10
SUMMARY 10 10
```

### 範例二

輸入：

```text
1 5 0
SEEK 1 100
WRITE 1 0
TRUNCATE 1 0
WRITE 1 1
SEEK 1 0
```

輸出：

```text
OK 0 100 0
OK 0 100 0
OK 0 100 0
ERR QUOTA 0 100 0
OK 0 0 0
SUMMARY 0 0
```

### 範例三

輸入：

```text
1 7 20
TRUNCATE 1 12
SEEK 1 3
WRITE 1 4
SEEK 1 18
WRITE 1 2
TRUNCATE 1 5
WRITE 1 1
```

輸出：

```text
OK 12 0 12
OK 12 3 12
OK 12 7 12
OK 12 18 12
OK 20 20 20
OK 5 20 5
ERR QUOTA 5 20 5
SUMMARY 5 20
```

<!-- END GENERATED SAMPLES -->
