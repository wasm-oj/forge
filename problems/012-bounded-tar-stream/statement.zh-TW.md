# 512-byte 封存檔

WASM OJ 需要接收題目或程式的依賴封存檔，但不能先完整展開未知內容，再判斷它是否安全。為了在配置解壓空間以前拒絕損壞或不受支援的結構，底層解析器已把封存檔轉成 header 事件；現在要在**不展開 payload** 的前提下完成最後一道檢查。

每筆事件占一個 512-byte header，之後緊接 `size` bytes payload，再補零到 512 的倍數。因此下一筆事件的 offset 為：

`offset + 512 + ceil(size / 512) * 512`。

事件種類及其語意如下：

- `F`：一般檔案；計入檔案數與解壓 bytes。
- `D`：目錄；`size` 必須為 0。
- `G`、`P`：GNU long-path 或 PAX path metadata。`name` 是下一筆 `F/D` 的覆寫路徑，且 `size` 必須等於 `name` 的 ASCII byte 長度加一。尚有 metadata 等待使用時不得再出現 metadata。
- 其他大寫字母：不支援。

每筆事件另給 stored checksum 與 calculated checksum，兩者必須相等。有效路徑必須非空、相對且 canonical：不得以 `/` 開頭或結尾；每個 segment 只含小寫字母、數字、`.`、`_`、`-`，且不得為 `.` 或 `..`。

若有 metadata 等待使用，下一筆 `F/D` 的有效路徑採用 metadata 的 `name`，並忽略該 header 自己的 `name`。請依這些規則驗證事件串流，而不讀取或展開任何 payload。

## 輸入

第一行為 `N maxFiles maxBytes`。接著 `N` 行：

```text
offset type name size storedChecksum calculatedChecksum
```

- `1 <= N <= 200000`；`0 <= maxFiles <= N`；`0 <= maxBytes <= 9*10^18`。
- 所有數值均為不超過 `9*10^18` 的非負整數。
- `type` 是一個大寫英文字母，`name` 是長度 1 到 200 的可見 ASCII token。
- 依所有 `size` 計算的 layout 結尾保證不超過 `9*10^18`。

## 輸出

逐筆處理，遇到第一個錯誤立即輸出 `REJECT i CODE`。同一筆依下列順序只回報第一項：

1. `OFFSET`：offset 不是預期值（第一筆預期 0）。
2. `CHECKSUM`：兩個 checksum 不同。
3. `TYPE`：種類不是 `F/D/G/P`。
4. `STATE`：已有待使用 metadata，卻又讀到 `G/P`。
5. `META_SIZE`：metadata size 不等於路徑長度加一。
6. `PATH`：metadata 路徑，或 `F/D` 的有效路徑不合法。
7. `ENTRY_SIZE`：`D` 的 size 不為 0。
8. `LIMIT`：加入 `F` 後，檔案數超過 `maxFiles` 或累計 bytes 超過 `maxBytes`。

全部事件讀完仍有 metadata 未使用，輸出 `REJECT N+1 STATE`。否則輸出：

```text
ACCEPT fileCount extractedBytes endOffset
```

所有編號為 1-based。限制檢查失敗的那筆不算進輸出統計。

## 限制

`size` 可遠大於可配置記憶體；完整解不得建立 payload 或長度為 archive size 的陣列。

輸入列數、數值範圍、name 長度與 layout 上限均如輸入段落所列；所有 name 是可見 ASCII，故 path byte 長度等於字元數。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 3 1000
0 F a.txt 5 10 10
1024 D dir 0 11 11
1536 F dir/b 600 12 12
```

輸出：

```text
ACCEPT 2 605 3072
```

### 範例二

輸入：

```text
2 1 10
0 G very/long/path 15 7 7
1024 F short 3 8 8
```

輸出：

```text
ACCEPT 1 3 2048
```

### 範例三

輸入：

```text
2 1 10
0 G a 2 1 1
1024 P b 2 2 2
```

輸出：

```text
REJECT 2 STATE
```

<!-- END GENERATED SAMPLES -->
