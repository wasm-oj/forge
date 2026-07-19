# 唯一的 Replay Bundle

一次 WASM OJ 執行若要能在其他環境 replay，就需要把它依賴的 blobs 與 manifest references 封裝成可攜、可驗證的文字資料。如果相同內容可以用不同排列或重複表示，兩台 host 即使保存相同資訊，也可能產生不同的 bundle bytes，讓重現與內容定址變得不可靠。

因此 bundle 必須採用唯一的 canonical 表示。一個文字化 replay bundle 先包含 `B` 筆 blob records，再包含 `R` 個 manifest references。blob 行為 `digest declared actual`；reference 行只有 digest。digest 是已計算完成且不碰撞的 8 位 lowercase hexadecimal token，本題不要求實作雜湊。

Canonical bundle 必須同時滿足：

1. blob digest 嚴格遞增；
2. 每筆 declared length 等於 actual length；
3. reference digest 嚴格遞增；
4. 每個 reference 都能在 blobs 中找到。

驗證器必須提供 deterministic 診斷。若 bundle 無效，依上述 phase 順序只輸出第一種錯誤；同一 phase 取最小 1-indexed record 位置。錯誤格式為 `INVALID BLOB_ORDER i`、`INVALID LENGTH i`、`INVALID REF_ORDER i` 或 `INVALID MISSING i`。順序錯誤的位置 `i` 指第一個不大於前一筆的 record（所以 `i≥2`）。

若有效，輸出 `VALID total`，其中 `total` 是所有被 reference 的 blob actual length 總和；未引用 blob 不計。

## 輸入

第一行 `B R`，接著 B 行 blobs，再接 R 行 references。

- `0≤B,R≤200000`，`B+R≥1`
- length 在 `[0,10^18]`，合法 bundle 的 total 不超過 `9×10^18`

## 輸出

依上述規格輸出一行。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 2
00000001 5 5
00000002 7 7
0000000a 9 9
00000001
0000000a
```

輸出：

```text
VALID 14
```

### 範例二

輸入：

```text
2 1
00000002 1 2
00000001 5 5
ffffffff
```

輸出：

```text
INVALID BLOB_ORDER 2
```

### 範例三

輸入：

```text
2 2
00000001 3 3
00000002 4 4
00000001
00000003
```

輸出：

```text
INVALID MISSING 2
```

<!-- END GENERATED SAMPLES -->
