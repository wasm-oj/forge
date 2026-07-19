# 瀏覽器儲存疏散令

WASM OJ 在瀏覽器中保存編譯 artifact 與測試資料時，同時受到兩種限制：cache 自己設定的邏輯容量，以及瀏覽器還需要為其他功能保留的可用空間。當任一限制被突破，storage manager 就必須從 cache 中疏散項目。

目前 cache 保存 `N` 個不可分割的項目，邏輯上限為 `C` bytes。瀏覽器目前可用空間為 `A` bytes，而系統要求疏散後至少保留 `R` bytes 可用空間。若所有項目的總大小為 `T`，必須釋放至少

`need = max(0, T - C, R - A)`

bytes。若 `need` 大於 `T`，即使刪除全部 cache 內容也無法達成要求，因此疏散不可能完成。

為了讓相同狀態在不同裝置上得到可重現的結果，淘汰不是任意選擇能湊足空間的組合。每個項目有 `size priority lastUsed participant key`，固定順序為：

1. `priority` 較小者先；
2. 同 priority 時，`lastUsed` 較小（較舊）者先；
3. 再依 participant 的 ASCII 字典序；
4. 最後依 key 的 ASCII 字典序。

依此順序刪除完整項目，直到已釋放量第一次不少於 `need`。這個規則是 storage policy，不得另選「剛好湊滿」的組合。

## 輸入

第一行 `N C A R`，接著 N 行項目。

- `1 ≤ N ≤ 200000`
- `0 ≤ C,A,R,size,lastUsed ≤ 10^18`，`1 ≤ size`，所有 size 總和不超過 `9×10^18`
- `0 ≤ priority ≤ 10^9`
- participant、key 為長度 1..20 的小寫英數字；`(participant,key)` 唯一

## 輸出

不可能時輸出 `IMPOSSIBLE`。否則第一行輸出 `k freed`，接著依淘汰順序輸出 k 行 `participant key`。不需刪除時輸出 `0 0` 且沒有後續行。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
4 100 30 50
40 2 10 alpha a
30 1 20 beta b
50 1 5 alpha c
10 1 5 alpha b
```

輸出：

```text
2 60
alpha b
alpha c
```

### 範例二

輸入：

```text
2 100 100 20
10 0 1 p a
20 1 2 p b
```

輸出：

```text
0 0
```

### 範例三

輸入：

```text
2 100 0 1000
10 0 1 p a
20 1 2 p b
```

輸出：

```text
IMPOSSIBLE
```

<!-- END GENERATED SAMPLES -->
