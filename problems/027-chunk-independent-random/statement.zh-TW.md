# 分塊無關的確定性亂數

`random_get` 若直接依賴 host 的亂數來源，同一份 WASM OJ submission 就可能無法 deterministic replay。我們也不能讓結果取決於 runtime 如何把讀取拆成 chunks：無論一次要求多少 bytes，每個全域位置都必須對應到唯一且可直接計算的值。

系統把概念上的亂數序列分成兩段。前 `S` bytes 來自 startup stream；之後改用 user stream，並從該 stream 的 offset 0 開始。`Q` 次 `random_get` 依序消耗 `k_i` bytes，前一次呼叫結束的位置就是下一次的起點。

為了檢查分塊後的端點，請輸出每次呼叫所得區塊的第一個與最後一個 byte。區塊可能非常長，因此題目只要求這兩個位置，而不要求產生中間的全部內容。

對 seed `s` 的 stream，offset x 的 byte 定義如下（所有算術先模 `2^64`）：

```
z = s + 0x9e3779b97f4a7c15 * (floor(x/8) + 1)
z = (z xor (z >> 30)) * 0xbf58476d1ce4e5b9
z = (z xor (z >> 27)) * 0x94d049bb133111eb
w = z xor (z >> 31)
byte(x) = (w >> (8 * (x mod 8))) & 255
```

位移為 unsigned logical shift；word 內採 little-endian byte 順序。全域位置 `p` 若 `p<S`，使用 startup seed 與 offset `p`；否則使用 user seed 與 offset `p-S`。

## 輸入

第一行 `startupSeed userSeed S Q`，第二行有 Q 個正整數 `k_i`。

- seed 在 `[0,2^64-1]`
- `0≤S≤9×10^18`，`1≤Q≤200000`，`1≤k_i`，且其總和不超過 `9×10^18`

## 輸出

每次呼叫輸出 `first last`（十進位 0..255）。若區塊跨越 S，兩端各自按所在 stream 計算。

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
0 1 10 4
1 7 5 9
```

輸出：

```text
175 175
205 226
244 2
137 101
```

### 範例二

輸入：

```text
18446744073709551615 0 0 3
8 1 16
```

輸出：

```text
175 226
244 244
101 236
```

### 範例三

輸入：

```text
42 99 17 3
16 2 15
```

輸出：

```text
149 40
82 227
107 8
```

<!-- END GENERATED SAMPLES -->
