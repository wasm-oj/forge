# Guest Path 防火牆

WASM OJ 允許使用者程式存取受隔離的 guest 檔案系統，但它提供的 path 不能直接交給主機處理。重複分隔符、`.` 與 `..` 可能讓表面不同的字串指向同一位置，甚至嘗試越過 guest root。為了在任何實際檔案存取前得到一致結果，我們先做純 lexical normalization。

你會收到 `N` 個不可信的 absolute guest path。對每個 path，由左到右依序處理 segment，套用以下 POSIX 式規則：

- 空 segment（重複 `/` 或開頭、結尾的 `/`）忽略；
- segment `.` 忽略；
- segment `..` 移除前一個尚未移除的普通 segment；
- 若遇到 `..` 時沒有普通 segment 可移除，path 曾嘗試穿越 guest root，結果為 `INVALID`。一旦發生，即使後面又回到 root 也仍為無效。
- 其他 segment（包含 `...`）都是普通 segment，大小寫不做轉換。

對合法 path，輸出唯一的 canonical absolute path：segment 之間只使用單一 `/`，不含 `.`、`..` 或尾斜線；若沒有普通 segment，輸出 `/`。

這個結果只由輸入字串決定，不需要也不得查詢主機檔案系統。

## 輸入

第一行 `N`，接下來 `N` 行各有一個 path token。每個 path 都以 `/` 開頭且不含空白。

## 輸出

每個 path 一行：合法時輸出 canonical path，否則輸出 `INVALID`。

## 限制

- `1 ≤ N ≤ 200000`
- 每個 path 長度 `1..200000`
- 所有 path 長度總和 `L ≤ 2000000`
- path 只含 ASCII 小寫字母、數字、`_`、`-`、`.`、`/`
- 普通 segment 不另設長度限制

這是純 lexical 處理，不查詢 host filesystem、不解析 symlink，也不做 percent decoding。完整限制排除反覆修改整條字串的平方作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
6
/a/b
/a/./b//c/
/a/b/../../c
/../secret
/a/.../b
////
```

輸出：

```text
/a/b
/a/b/c
/c
INVALID
/a/.../b
/
```

### 範例二

輸入：

```text
4
/
/././
/x/../
/x/../../x
```

輸出：

```text
/
/
/
INVALID
```

### 範例三

輸入：

```text
5
/a//b///c
/a-b/c_d/9
/.../../z
/a/..hidden/..
/a/../..x
```

輸出：

```text
/a/b/c
/a-b/c_d/9
/z
/a
/..x
```

<!-- END GENERATED SAMPLES -->
