# 七種答案比對器

每個 query 提供 expected 與 actual 兩個 token 陣列，並指定 matcher。`n`、`m` 可為 0；其資料行此時是空行。

- `EXACT`：將各自所有 token **不加分隔符**串接後比較。
- `LINES`：token `#` 表示空行；先刪除陣列尾端所有 `#`，再逐項比較。
- `TOKENS`：逐項完全相等。
- `FLOAT`：兩陣列長度須相等；token 是帶號整數，且每對值的絕對差須不超過同一行給定的 `eps`。
- `SET`：忽略順序與重複次數，比較不同 token 的集合。
- `MULTISET`：忽略順序但保留重複次數。
- `FILESET`：每個 token 形如 `path@digest`；`path` 是長度 1..20 的小寫英數字串，`digest` 恰為 8 個小寫十六進位字元，因此完整 entry 長度為 10..29 bytes。每一側 path 唯一。忽略檔案順序，完整 entry 必須相同。

除 FLOAT 與 FILESET 的額外限制外，一般 token 是長度 1..30 bytes 的 `[A-Za-z0-9_#@.-]` ASCII 字串。所有比較都是 byte-exact、無 locale 規則。

## 輸入

第一行 query 數 Q。每個 query 有三行：header `type n m`（FLOAT 為 `FLOAT n m eps`）、expected token 行、actual token 行。

- `1 ≤ Q ≤ 20000`
- 全部 query 的 `n+m` 不超過 200000，token 總長不超過 4000000
- FLOAT 值在 `[-10^18,10^18]`，`0≤eps≤10^18`
- FILESET 的 path 長度為 1..20，只含小寫英數字；digest 恰為 8 個小寫十六進位字元，完整 entry 長度為 10..29 bytes

## 輸出

每個 query 輸出 `ACCEPT` 或 `WRONG`。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
7
EXACT 2 2
ab c
a bc
LINES 3 1
x # #
x
TOKENS 2 2
a b
b a
FLOAT 3 3 2
10 -5 7
12 -6 4
SET 3 2
a a b
b a
MULTISET 3 2
a a b
a b
FILESET 2 2
a@00000001 b@00000002
b@00000002 a@00000001
```

輸出：

```text
ACCEPT
ACCEPT
WRONG
WRONG
ACCEPT
WRONG
ACCEPT
```

### 範例二

輸入：

```text
3
EXACT 0 0


LINES 2 3
# #
# # #
FLOAT 2 2 0
-1 0
-1 0
```

輸出：

```text
ACCEPT
ACCEPT
ACCEPT
```

### 範例三

輸入：

```text
3
SET 0 1

x
MULTISET 3 3
z z a
z a z
FILESET 1 1
x@deadbeef
x@deadc0de
```

輸出：

```text
WRONG
ACCEPT
WRONG
```

<!-- END GENERATED SAMPLES -->
