# 解題說明

## 直覺解

維護傳統 PRNG，從位置 0 逐 byte 產生到每個區塊尾端。總消耗 P 可達 9×10^18，O(P) 不可能完成。

## 最佳解

公式把第 `floor(x/8)` 個 word 寫成 seed 與 counter 的純函式，因此任意 byte 可 O(1) 隨機存取。維護已消耗位置 `pos`；長度 k 的兩端是 `pos` 與 `pos+k-1`，各呼叫一次 byte 函式，再令 `pos+=k`。

所有中間乘法須保留低 64 bits。C/C++/Rust/Go 用 unsigned 64-bit wrapping；Python 每步 `& (2^64-1)`；JS/TS 用 bigint 並遮罩。

## 正確性證明

byte 函式逐式實作題目對單一 stream offset 的定義；全域轉換又依 `p<S` 唯一選擇 startup 或 user stream。第 i 次呼叫在先前長度總和位置開始並在加 k_i-1 處結束，演算法查詢的恰是這兩個位置。更新後位置等於新的累積長度，歸納可得全部輸出正確。

## 複雜度

每次呼叫固定兩次混合，時間 O(Q)，核心演算法的輔助空間 O(1)。C、C++、Go
reference 會串流讀寫；目前 Rust、Python、JavaScript、TypeScript reference 會緩衝完整
輸入與輸出，因此依實際配置計算的峰值空間是 O(Q)。輸出本身即有 Θ(Q) 大小；若執行環境
允許輸入與輸出皆串流，則可把輸入／輸出緩衝以外的空間維持在 O(1)。

## 常見錯誤

- user stream 沒有在全域位置 S 重新從 offset 0 開始。
- 使用 signed shift，或忘記乘法的 64-bit wraparound。
- 把 word byte order 寫成 big-endian。
- 區塊尾端誤用 `pos+k`。
