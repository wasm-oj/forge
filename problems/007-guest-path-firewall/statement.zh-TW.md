# Guest Path 防火牆

你收到 `N` 個不可信的 absolute guest path。對每個 path 依從左到右的順序套用 POSIX 式 lexical normalization：

- 空 segment（重複 `/` 或開頭、結尾的 `/`）忽略；
- segment `.` 忽略；
- segment `..` 移除前一個尚未移除的普通 segment；
- 若遇到 `..` 時沒有普通 segment 可移除，path 曾嘗試穿越 guest root，結果為 `INVALID`。一旦發生，即使後面又回到 root 也仍為無效。
- 其他 segment（包含 `...`）都是普通 segment，大小寫不做轉換。

合法時輸出唯一 canonical absolute path：只使用單一 `/` 分隔，不含 `.`、`..` 或尾斜線；沒有普通 segment 時輸出 `/`。

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
