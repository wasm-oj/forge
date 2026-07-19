# 唯一的 Replay Bundle

一個文字化 replay bundle 包含 B 筆 blob record 與 R 個 manifest reference。blob 行為 `digest declared actual`；reference 行只有 digest。digest 是已計算完成且不碰撞的 8 位 lowercase hexadecimal token，本題不要求實作雜湊。

Canonical bundle 必須同時滿足：

1. blob digest 嚴格遞增；
2. 每筆 declared length 等於 actual length；
3. reference digest 嚴格遞增；
4. 每個 reference 都能在 blobs 中找到。

若無效，依上述 phase 順序只輸出第一種錯誤；同一 phase 取最小 1-indexed record 位置。錯誤格式為 `INVALID BLOB_ORDER i`、`INVALID LENGTH i`、`INVALID REF_ORDER i` 或 `INVALID MISSING i`。順序錯誤的位置 i 指第一個不大於前一筆的 record（所以 i≥2）。

若有效，輸出 `VALID total`，其中 total 是所有被 reference 的 blob actual length 總和；未引用 blob 不計。

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
