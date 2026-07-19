# 解題說明

## 直覺解

每輪對每個 TU 掃描其所有依賴，檢查是否在 changed set，時間 `O(QM)`。改用 header 的反向 adjacency list，逐 changed header 標記 TU，雖較好，若同一個高 degree header 在很多輪出現仍會反覆做 `O(N)` 個 scalar 操作。

## 最佳解

為每個 header 建立長度 `N` 的 bitset，第 `s` bit 表示 TU `s` 依賴它。處理一輪時，把所有 changed header 的 bitset 做 OR，最後 popcount。每輪使用新的全零 accumulator，對應「重編完成後回到乾淨 baseline」。

在 Python 可先用 mutable `bytearray` 逐邊設 bit，再一次轉成任意精度整數；若直接對 immutable 大整數逐邊做 `mask |= 1 << s`，每次都可能複製整個 bitset，使建表退化為 `O(M ceil(N/w))`。其他語言以 32/64-bit word 陣列實作。這些只是同一個 word-parallel 演算法。

## 正確性證明

header `h` 的 bitset 第 `s` bit 為 1，若且唯若輸入含依賴 `(s,h)`。OR 的某一 bit 為 1，若且唯若至少一個 changed header 的對應 bit 為 1，亦即 TU `s` 讀過至少一個本輪 changed header；這正是 cache miss 定義。popcount 計算集合元素數，因此每輪輸出正確。輪與輪使用獨立 accumulator，不會錯把上一輪修改帶入下一輪。

## 複雜度

令 `w` 為 machine word bits、`R=ceil(N/w)`、所有 query 的 changed header 總數為 `K`。配置並清零 `H` 列 bitset 需 `O(HR)`，逐邊設 bit 需 `O(M)`；query OR、清零 accumulator 與 popcount 總時間 `O((K+Q)R)`。總時間為 `O(HR+M+(K+Q)R)`，演算法的 auxiliary bitset 空間為 `O(HR)`。目前 Rust、Python、JavaScript、TypeScript reference 會保留完整輸入並緩衝輸出，因此實際 resident space 另含 `O(M+Q+K)` buffered I/O；這在 `N=H=1` 時不能被 `O(HR)` 吸收。

## 常見錯誤

- 對各 bitset 的 popcount 相加，沒有先 OR 去除重複 TU。
- 沿用上一輪 accumulator。
- JS 用 signed 32-bit 值計數時忘記 `>>> 0`。
- 配置 `N*H` bytes 而非 bits，造成不必要的八倍空間。
- 在 immutable big integer 上逐邊 OR，漏算每次複製整列 bitset 的成本。
