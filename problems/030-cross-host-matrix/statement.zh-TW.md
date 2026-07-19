# 跨 Host 一致性矩陣

同一組 WASM OJ calibration cases 在不同 host 上執行時，必須產生相同的 deterministic transcript，否則量測結果不能直接比較。執行時間可以因裝置而異，因此只用來彙整效能；case 的順序、欄位集合與欄位值則必須與基準環境一致。

輸入中的第一個 host 是 baseline。每個 host 記錄一個**有序** case 序列；每個 case 有 id、runtime，以及按 dotted path 嚴格遞增的 transcript fields。runtime 不屬於 deterministic transcript。

對每個非 baseline host，依輸入順序進行以下比較：

1. 若 case id 序列（包含長度）與 baseline 不完全相同，輸出 `HOST name CASE_ORDER`，且不比較 fields。
2. 否則找出每個 case 中所有不同 dotted path：path 只存在一側，或兩側 value 不同，都算一次。依 baseline case 順序、再依 path ASCII 字典序輸出。
3. 無差異輸出 `HOST name OK`；有差異輸出 `HOST name k p1 ... pk`，其中輸出 path 為 `caseId.fieldPath`。

只有當所有非 baseline host 都為 `OK`，效能資料才可視為來自同一份 deterministic 工作。此時再為每個 baseline case 輸出所有 `H` 個 runtime 的 lower median：排序後取 index `floor((H-1)/2)`，格式為 `MEDIAN caseId value`。若任一 host 不一致，不輸出任何 median。

## 輸入

第一行 H。每個 host 先有 `name K`，接著 K 個 case。case header 為 `caseId runtime P`，後接 P 行 `path value`。

- `2≤H≤200`
- 所有 host 名稱唯一；每個 host 內 caseId 唯一
- 每個 case 內 path 嚴格遞增
- name/caseId/value 是 1..20 小寫英數字；path 是長度 1..120、以 `.` 分隔的小寫英數 segment
- `0≤runtime≤10^18`
- 所有 K 總和及所有 P 總和各不超過 200000
- 令 D 為所有 case id 序列正確的非 baseline host 實際輸出的差異 path
  總數（也就是各 `HOST name k ...` 的 k 總和）；`D≤200000`。輸出
  `CASE_ORDER` 的 host 不計入 D

## 輸出

依上述格式；非 baseline host 行按輸入順序，median 按 baseline case 順序。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3
h0 2
c1 10 2
a 1
b 2
c2 30 1
x 9
h1 2
c1 20 2
a 1
b 2
c2 40 1
x 9
h2 2
c1 50 2
a 1
b 3
c2 60 1
x 9
```

輸出：

```text
HOST h1 OK
HOST h2 1 c1.b
```

### 範例二

輸入：

```text
2
a 1
x 8 1
ok yes
b 1
x 2 1
ok yes
```

輸出：

```text
HOST b OK
MEDIAN x 2
```

### 範例三

輸入：

```text
2
a 2
x 1 0
y 2 0
b 2
y 3 0
x 4 0
```

輸出：

```text
HOST b CASE_ORDER
```

<!-- END GENERATED SAMPLES -->
