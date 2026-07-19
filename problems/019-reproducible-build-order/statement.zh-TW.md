# 可重現的套件建置順序

一套可離線使用的 WASM OJ toolchain，必須先按照 dependency graph 建置其中的套件。同一張 graph 往往有多個合法順序；如果每台 host 任意選擇下一個可建置套件，產生的 artifact 與建置紀錄就可能無法逐位元重現。

因此我們制定一條 deterministic 規則：任何時刻若有多個套件的 dependencies 都已完成，必須選 package name 依 ASCII 字典序最小者。套件 `a` 依賴 `b` 時，`b` 必須先於 `a` 建置。

lockfile 本身也可能損壞。若 dependency edge 的任一端不在已知 package 清單中，該 edge 是 dangling；如果所有端點都有效，但相依關係無法完成全部套件，則 graph 含有 cycle。請依題目指定的錯誤優先順序驗證資料，或產生唯一的建置順序。

## 輸入

第一行 `N M`。接著 `N` 行是互異的已知 package name。再接著 `M` 行 `a b`，表示 package `a` **依賴** package `b`，所以 `b` 必須先建置。Edge 中可以出現不在已知清單的名稱，用來表示損壞的 lockfile。

## 輸出

錯誤優先於建置：

1. 若存在 dangling edge，輸出 `INVALID DANGLING i`，其中 `i` 是輸入順序第一條任一端未知的 edge（1-based）。此時不再檢查 cycle。
2. 沒有 dangling、但 graph 有 cycle 時，輸出 `INVALID CYCLE`。
3. 否則輸出 `ORDER p_1 ... p_N`，依規則得到唯一順序。

## 限制

- `1 <= N <= 200000`，`0 <= M <= 400000`。
- package name 長 1 到 30，只含小寫字母、數字、`-`；已知名稱互異，edge pair 互異且無 self-loop。
- 字典序比較 ASCII bytes，不使用 locale。
- 完整測資排除每次線性掃描全部 remaining packages 的作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 2
app
core
util
app core
app util
```

輸出：

```text
ORDER core util app
```

### 範例二

輸入：

```text
2 1
app
core
app ghost
```

輸出：

```text
INVALID DANGLING 1
```

### 範例三

輸入：

```text
2 2
a
b
a b
b a
```

輸出：

```text
INVALID CYCLE
```

<!-- END GENERATED SAMPLES -->
