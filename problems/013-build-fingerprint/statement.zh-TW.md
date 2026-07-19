# Build Fingerprint

在 WASM OJ 中，相同的原始碼與編譯設定應該命中同一份 build cache，而任何會改變產物的輸入都必須產生不同的識別。若 fingerprint 取決於檔案被列舉的順序，同一個專案只因輸入順序不同就會重複編譯；因此，我們需要先定義唯一的 canonical preimage。

真正的 build digest 會對這份 canonical preimage 做雜湊。本題不要求實作 SHA-256，也不把雜湊函式本身當成門檻；你要輸出的是 canonical preimage 的 token 表示。

專案有 `N` 個檔案，每個檔案都有唯一 path 與已算好的 digest。每次 build 會提供 compiler、target、optimization、dependency digest，以及一組順序任意的檔案編號。

canonical 表示保留上述四個 metadata 欄位的輸入順序，檔案部分則依 path 的 ASCII 字典序排列。請根據這項規格產生可供後續雜湊的唯一 token 序列。

## 輸入

第一行 `N Q`。接著 `N` 行為 `path digest`。再接著 `Q` 行：

```text
compiler target optimization dependencyDigest K fileId_1 ... fileId_K
```

## 輸出

每個 build 輸出一行：

```text
compiler target optimization dependencyDigest K path_1 digest_1 ... path_K digest_K
```

其中檔案依 path 嚴格遞增。`K=0` 時該行在 `0` 後結束。空集合不另加 sentinel。

## 限制

- `1 <= N,Q <= 200000`，所有 build 的 `K` 總和不超過 400000。
- path 是長度 1 到 100 的 canonical relative path，只含小寫字母、數字、`. _ - /`，不得有空 segment、`.` 或 `..`；所有 path 唯一。
- digest 是長度 8 到 64 的 lowercase hexadecimal token；metadata token 只含小寫字母、數字、`.`、`_`、`-`。
- 每個 build 內的 file ID 互異且介於 1 到 `N`。
- 全部文字總長度不超過 4 MB；比較順序按 ASCII bytes，與 locale 無關。

逐一把元素插入已排序陣列的二次方解法無法通過完整測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 1
src/z.c aaaaaaaa
src/a.c bbbbbbbb
inc/x.h cccccccc
clang wasm32 o2 deadbeef 3 1 3 2
```

輸出：

```text
clang wasm32 o2 deadbeef 3 inc/x.h cccccccc src/a.c bbbbbbbb src/z.c aaaaaaaa
```

### 範例二

輸入：

```text
1 1
main.c 01234567
gcc wasi o0 abcdef12 0
```

輸出：

```text
gcc wasi o0 abcdef12 0
```

### 範例三

輸入：

```text
2 2
b.c 11111111
a.c 22222222
cc x o3 aaaaaaaa 2 1 2
cc y o1 bbbbbbbb 1 1
```

輸出：

```text
cc x o3 aaaaaaaa 2 a.c 22222222 b.c 11111111
cc y o1 bbbbbbbb 1 b.c 11111111
```

<!-- END GENERATED SAMPLES -->
