# 八階段編譯器

瀏覽器內編譯若每次 build 都重新啟動 toolchain，會為 WASM OJ 帶來不必要的成本，因此我們希望重複使用 Worker；但 Worker 也不能無限期承接工作，否則累積的狀態與資源用量會變得難以控制。為此，coordinator 以 generation 管理 Worker，並為每一代設定 lifetime budget。

系統支援的 build 最多包含八個 output-ready stage。每個成功完成的 stage 消耗一單位 budget；同一 generation 最多可消耗 `B` 單位，而且只能服務一個 toolchain family。build 必須依到達順序按以下規則分派：

- `stages=0` 表示完整 cache hit，輸出 `CACHE`，不建立、切換或消耗目前 Worker。
- `stages>8`，或 `stages>B`，輸出 `REJECT`；拒絕不改變目前 Worker。
- 其他 build 必須交給**目前** generation。若目前不存在、family 不同、或剩餘 budget 不足，就建立下一個 generation，再把 build 指派給它。

Generation ID 從 1 連續遞增。coordinator 同一時間只保留一個 active Worker，因此一旦切離舊 generation，就不再回用，即使它仍有剩餘 budget。

## 輸入

第一行 `N B`。接著 `N` 行 `family stages`。

## 輸出

對每個 build 輸出一行 `CACHE`、`REJECT` 或 `WORKER g`。最後輸出：

```text
SUMMARY workerCount rejectedCount
```

Cache hit 不計 worker，也不計 rejected。

## 限制

- `1 <= N <= 300000`，`1 <= B <= 9*10^18`。
- `0 <= stages <= 12`；family 長 1 到 20，只含小寫字母、數字、`-`。
- 所有計數可放入 unsigned 64-bit；JS/TS 必須正確處理大於 safe integer 的 `B`。
- 完整限制排除每筆重播全部歷史來恢復 current generation 的方法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
6 5
a 3
a 2
a 1
b 0
b 4
b 2
```

輸出：

```text
WORKER 1
WORKER 1
WORKER 2
CACHE
WORKER 3
WORKER 4
SUMMARY 4 0
```

### 範例二

輸入：

```text
4 4
x 5
y 9
x 0
x 4
```

輸出：

```text
REJECT
REJECT
CACHE
WORKER 1
SUMMARY 1 2
```

### 範例三

輸入：

```text
5 8
a 4
b 0
a 4
b 1
a 1
```

輸出：

```text
WORKER 1
CACHE
WORKER 1
WORKER 2
WORKER 3
SUMMARY 3 0
```

<!-- END GENERATED SAMPLES -->
