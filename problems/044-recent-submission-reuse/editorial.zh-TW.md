# 解題說明

令 `L` 為 fingerprint 最大長度、`S` 為所有 fingerprint 長度總和、`U` 為不同 fingerprint 數量。

## 直覺解法

對每筆 submission `i`，向前比較至多 `K` 筆完整 token，找到第一個相同者就停止。若以 queue 保存近期 token，worst case 時間為 `O(N K L)`、輔助空間為 `O(K L)`。此法容易理解，但 `N` 與 `K` 都大時無法完成。

## 進階解法：平衡搜尋樹

以 ordered map 保存每個 fingerprint 最近一次的 index。查詢與更新需要 `O(log U)` 次有序字串比較，每次比較最多 `O(L)`。第 `i` 筆恰在保存的 index 不小於 `i-K` 時成為 hit。總時間 `O(N log N * L)`，空間 `O(U L)`。

## 最佳解法：最近位置 Hash Map

不必保存整個近期 window。對同一 fingerprint 而言，只有最近一次位置可能有用：若最近位置都早於 `i-K`，更早的相同位置也一定過期。

由左至右掃描，令 `last[f]` 為 fingerprint `f` 最近一次的 index：

1. 若 map 中已有 `f` 且 `i - last[f] <= K`，hit 數加一。
2. 無論本次為 hit 或 miss，都設定 `last[f] = i`。

當 `K = 0` 時，任何兩個不同 index 的距離都大於 `K`，同一規則自然得到零次 hit。

## 正確性證明

處理 index `i` 前，若 fingerprint `f` 曾出現，`last[f]` 是所有小於 `i` 的相同 fingerprint 中 index 最大者。第一筆前此不變量成立；處理完 `i` 後設定 `last[f]=i` 且不改其他 entry，因此不變量持續成立。

若 `i-last[f] <= K`，這個最近位置位於 `[max(1,i-K),i-1]`，所以第 `i` 筆是 hit。若最近位置不存在或距離大於 `K`，所有更早的相同位置距離只會更大，區間內不可能有相同 fingerprint，因此為 miss。每筆分類都符合定義，累加結果正確。

## 複雜度

在 hash table 操作期望為常數時間時，處理並 hash 全部 token 的期望時間為 `O(S)`。演算法核心只需保存 `U` 個不同 token 與最近位置，為 `O(U L)`；七語言 reference 的輸入緩衝或按 `N` 預留的 hash table 使共同 resident 上界為 `O(S)`。Hash collision 必須以完整 token 比較解決。

## 常見錯誤

- 把 window 寫成 `[i-K,i]`，讓 submission 與自己配對。
- 使用 `< K` 而非 `<= K`；恰好早 `K` 個位置仍在 window 內。
- 計算 window 中所有相同位置；每一筆 submission 最多只貢獻一次 hit。
- 先更新最近位置再判斷，造成每筆都與自己相同。
- 錯誤特判 `K=0`，或將 token 解析成數字。
