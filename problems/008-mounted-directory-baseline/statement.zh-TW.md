# 目錄樹的掛載基線

Judge 啟動前要掛載 `M` 個唯讀輸入檔，並預先建立 `O` 個大小為零的輸出檔。為了避免字串解析干擾，canonical absolute path 以正整數 segment 表示：`k s1 ... sk` 代表 `/s1/.../sk`，最後一個 segment 是檔名，前面都是父目錄。

所有必要父目錄都要自動建立且只計一次；guest root `/` 永遠存在並消耗一個 inode。每個檔案也各消耗一個 inode。baseline bytes 只包含唯讀輸入檔的 logical size，預建輸出檔大小為零。

系統準備以 byte quota `B` 與 inode quota `I` 封存這個基線。請計算 baseline，並判斷能否封存。

## 輸入

第一行 `M O B I`。

接下來 `M` 行各為 `k s1 ... sk size`；再接下來 `O` 行各為 `k s1 ... sk`。

所有檔案 path 互不相同，且任一檔案 path 都不是另一檔案 path 的嚴格 prefix，因此不會發生 file/directory 種類衝突。

## 輸出

若兩種 baseline 都不超過 quota，輸出：

```text
ACCEPT baselineBytes baselineInodes remainingBytes remainingInodes
```

否則輸出：

```text
REJECT baselineBytes baselineInodes missingBytes missingInodes
```

其中 missing 分別是 `max(0,baseline-quota)`；即使只缺一種，另一種仍輸出 `0`。

## 限制

- `0 ≤ M,O ≤ 200000`，`1 ≤ M+O ≤ 200000`
- 每條 path 的 `1 ≤ k`；所有 path 的 segment 出現總數 `S ≤ 200000`
- `1 ≤ si ≤ 10^9`
- `0 ≤ size ≤ 9×10^18`，所有輸入檔 size 總和不超過 `9×10^18`
- `0 ≤ B,I ≤ 9×10^18`

完整限制排除把每個新目錄 prefix 與既有清單逐一比較的平方作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
2 2 100 10
3 1 2 3 40
2 1 4 20
3 1 2 5
1 6
```

輸出：

```text
ACCEPT 60 7 40 3
```

### 範例二

輸入：

```text
1 1 4 2
2 9 1 5
2 9 2
```

輸出：

```text
REJECT 5 4 1 2
```

### 範例三

輸入：

```text
3 2 30 8
4 1 2 3 10 7
4 1 2 3 11 8
3 1 2 12 9
3 1 5 13
1 14
```

輸出：

```text
REJECT 24 10 0 2
```

<!-- END GENERATED SAMPLES -->
