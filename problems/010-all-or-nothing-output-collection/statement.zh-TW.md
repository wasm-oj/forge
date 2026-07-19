# 全有或全無的輸出蒐集

WASM OJ 在程式結束後會蒐集輸出檔，但蒐集期間檔案的 metadata 與實際內容可能已不一致。若先依 metadata 通過配額檢查，讀取時卻得到不同長度，就會產生 TOCTOU 問題。此外，輸出檔還必須與先前的 stdout、stderr 共用同一份 byte budget。

為了讓結果不受檔案列舉順序影響，`N` 個輸出檔必須按 path 的 UTF-8 byte lexicographic order 處理。所有 path 只含 ASCII，所以等同一般逐 byte 字典序；若較短字串是另一字串的 prefix，較短者在前。stdout 與 stderr 已共同使用 `U` bytes。

每個檔案記錄 `path metadataLength actualLength`。處理一個檔案時，必須先比較兩種長度：不相同代表 metadata 與實際讀取之間發生 TOCTOU mismatch；只有相同時，才嘗試把 `metadataLength` 加入共用 byte budget。

每個 budget 查詢都從「尚未蒐集任何檔案、但已使用 `U` bytes」的狀態獨立開始，並依 canonical 順序處理：

1. 若一開始 `U>budget`，立即 quota failure，尚未接觸任何 path。
2. 對目前檔案，先檢查 mismatch；若 mismatch，立即失敗。
3. 否則若加入該檔會使總量超過 budget，在該 path quota failure。
4. 否則完整加入並繼續。

蒐集採 all-or-nothing 語意：任何失敗都不回傳部分檔案。輸入保證 budget 查詢非遞減。

## 輸入

第一行 `N Q U`。接下來 `N` 行為檔案記錄，順序任意；最後 `Q` 行各為一個非遞減 `budget`。

## 輸出

成功時輸出 `OK N finalUsedBytes`。失敗時輸出 `ERR MISMATCH path` 或 `ERR QUOTA path`。初始 `U>budget` 的特殊 quota failure 以 `-` 取代 path：`ERR QUOTA -`。

在同一檔案上，MISMATCH 的優先序高於 QUOTA。path 皆互不相同。

## 限制

- `1 ≤ N,Q ≤ 200000`
- `0 ≤ U,budget ≤ 9×10^18`
- `0 ≤ metadataLength,actualLength ≤ 10^12`
- `U + Σ metadataLength ≤ 9×10^18`
- 每個 path 長度 `2..200000`，以 `/` 開頭，只含 ASCII 小寫字母、數字、`-`、`/`
- path 不含空 segment、不以 `/` 結尾；全部 path 長度總和不超過 `2000000`
- `Q ×（最長 path 的 byte 長度）≤ 2000000`，因此重複錯誤訊息的總 path 輸出量也有界
- budget 序列非遞減

完整限制排除每個查詢重新排序或掃描全部檔案。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 6 3
/z 4 4
/a 2 2
/m 5 7
/b 3 3
2
3
4
5
8
100
```

輸出：

```text
ERR QUOTA -
ERR QUOTA /a
ERR QUOTA /a
ERR QUOTA /b
ERR MISMATCH /m
ERR MISMATCH /m
```

### 範例二

輸入：

```text
2 3 0
/b 5 5
/a 0 0
0
5
10
```

輸出：

```text
ERR QUOTA /b
OK 2 5
OK 2 5
```

### 範例三

輸入：

```text
2 3 1
/z 1 1
/a 100 99
0
1
200
```

輸出：

```text
ERR QUOTA -
ERR MISMATCH /a
ERR MISMATCH /a
```

<!-- END GENERATED SAMPLES -->
