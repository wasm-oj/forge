# 離線依賴行李箱

Lockfile 的多個 package 可以指向相同內容 digest；離線 bundle 必須為每個**唯一 required digest** 恰好提供一份 payload，不能缺少或多帶，size 也必須相符。相同 digest 的 package 宣告不同 size 代表 lockfile 自相矛盾。

## 輸入

第一行 `N M`。接著 `N` 行：

```text
packageName digest declaredSize
```

再接 `M` 行：

```text
digest payloadSize
```

package name 唯一；digest 是已計算完成且視為不碰撞的 lowercase hexadecimal token。

## 輸出

只輸出下列第一個適用類別；同類別有多個 digest 時選 ASCII 字典序最小者：

1. `LOCK_CONFLICT digest`：required 同 digest 有不同 declaredSize。
2. `DUPLICATE_PAYLOAD digest`：bundle 同 digest 出現超過一次。
3. `MISSING digest`：required digest 沒有 payload。
4. `EXTRA digest`：payload digest 不在 required set。
5. `SIZE digest`：required 與 payload size 不同。

全部通過則輸出：

```text
VALID uniqueDigestCount deduplicatedBytes savedBytes
```

`deduplicatedBytes` 是每個唯一 digest 的 size 加總；`savedBytes` 是所有 package declaredSize 加總減去 deduplicatedBytes。即使 size 為 0 也照常是一個 digest。

## 限制

- `1 <= N,M <= 200000`。
- packageName 符合 `[a-z0-9-]{1,30}` 且互異。
- digest 符合 `[0-9a-f]{8,64}`。
- size 介於 0 與 `9*10^18`；所有 package declaredSize 加總不超過 `9*10^18`。
- 完整測資排除 required 與 payload 逐對線性搜尋。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 2
a aaaaaaaa 5
b bbbbbbbb 7
c aaaaaaaa 5
aaaaaaaa 5
bbbbbbbb 7
```

輸出：

```text
VALID 2 12 5
```

### 範例二

輸入：

```text
2 1
a aaaaaaaa 5
b aaaaaaaa 6
aaaaaaaa 5
```

輸出：

```text
LOCK_CONFLICT aaaaaaaa
```

### 範例三

輸入：

```text
1 2
a aaaaaaaa 5
aaaaaaaa 5
aaaaaaaa 5
```

輸出：

```text
DUPLICATE_PAYLOAD aaaaaaaa
```

<!-- END GENERATED SAMPLES -->
