# 不可混淆的 Runtime Bundle

WASM OJ 需要把文字原始碼與二進位資源一起交給隔離 runtime。若只串接 path 與 payload，不同的欄位切法可能產生完全相同的 byte stream；若檔案列舉順序不固定，同一組內容也可能得到不同 bundle。為了可靠地儲存、傳輸與比對，我們要定義唯一且 prefix-free 的格式。

給定一組文字與二進位檔案，先依 path 的 ASCII 字典序排列，再依下列順序輸出 bytes：

1. magic ASCII `WOBJ`；
2. 檔案數的 unsigned 32-bit big-endian；
3. 每個檔案依序編碼：一 byte type tag（`T=01`、`B=02`）、path byte 長度的 u32 big-endian、path ASCII bytes、payload byte 長度的 u64 big-endian、payload bytes。

type tag 區分文字與二進位 payload；每個可變長欄位前的固定寬度長度前綴則界定其終點。因此，不同檔案或欄位切法不能混淆成同一份有效編碼。

請輸出依此規格產生的完整 runtime bundle。

## 輸入

第一行為 `N`，接著 `N` 行為 `type path payloadToken`。

- `T` 的非空 payloadToken 直接視為可見 ASCII bytes。
- `B` 的非空 payloadToken 是 lowercase hexadecimal，每兩個字元代表一 byte。
- 兩種 type 都以單一 token `-` 表示空 payload；因此本題不表示內容恰為單一 `-` 的文字檔。

## 輸出

輸出一行：完整 bundle bytes 的連續 lowercase hexadecimal，不含空白或 `0x`。

## 限制

- `1 <= N <= 50000`，path 唯一且為長度 1 到 100 的 canonical relative ASCII path。
- path segment 只含小寫字母、數字、`.`、`_`、`-`，不得為空、`.`、`..`。
- `T` payloadToken 除 `-` 外由 ASCII 33..126 組成，長度至多 200000。
- `B` payloadToken 除 `-` 外為長度為正偶數的 `[0-9a-f]` 字串。
- 所有 path 與解碼後 payload 的 bytes 總和 `B <= 200000`。
- 長度欄位保證可放入其指定的 unsigned 整數型別。

完整測資排除 `O(N^2)` 的排序。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
2
T b x
B a ff00
```

輸出：

```text
574f424a000000020200000001610000000000000002ff00010000000162000000000000000178
```

### 範例二

輸入：

```text
1
T empty -
```

輸出：

```text
574f424a000000010100000005656d7074790000000000000000
```

### 範例三

輸入：

```text
2
T x hi
B y 6869
```

輸出：

```text
574f424a000000020100000001780000000000000002686902000000017900000000000000026869
```

<!-- END GENERATED SAMPLES -->
