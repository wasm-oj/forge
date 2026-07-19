# 解題說明

令 `L` 為 fingerprint 最大長度，`S` 為所有 fingerprint 長度總和。

## 直覺解法

保存所有看過的 fingerprint。處理抵達位置 `i` 時，依序與位置 `1` 到 `i - 1` 的完整 token 比較，第一個相同者就是所需的 `j`。這直接實作定義，但所有 token 皆不同時會執行 `O(N^2)` 次比較。時間為 `O(N^2 L)`，空間為 `O(S)`。

## 進階解法：排序

保存 `(fingerprint, index)` 並依 fingerprint、index 排序。相同 fingerprint 會形成連續群組；每個重複群組最小的兩個 index 分別是第一次出現與第一次重複。最後選擇第二個 index 最小的群組。

在字串長度有上限的比較模型下，時間為 `O(N log N * L)`，空間為 `O(S)`。此法有確定性的界線，但抵達順序其實已足以判斷答案，排序做了不必要的額外工作。

## 最佳解法：首次位置 Hash Map

由左至右掃描，以 hash map 保存每個完整 token 第一次出現的 index。

- 當前 token 尚未出現時，記錄目前 index。
- 已出現時，所有更早位置都已檢查完畢，因此目前 index 必是最小的重複 index；map 中的值則是最早的相同位置。輸出後即可停止。

Hash 可以用來選擇 bucket，但相等判斷仍必須比較完整 token。絕對不能把 fingerprint 解析成十六進位整數。

## 正確性證明

處理 index `i` 之前，map 恰好包含位置 `1..i-1` 中每種不同 fingerprint，且值為它的最早位置。空前綴時性質成立。若第 `i` 個 fingerprint 尚未出現，插入 `i` 後性質仍成立；若已出現，依不變量，map 中的 `j` 正是最早的相同位置。所有小於 `i` 的位置都已處理且未回報重複，因此不存在更小的答案 index。故演算法輸出的 `(i,j)` 完全符合題意。若掃描結束仍未回報，代表每個位置都沒有相同的前項，輸出 `NONE` 正確。

## 複雜度

在 hash table 操作期望為常數時間時，時間 `O(S)`，空間 `O(S)`。Hash collision 必須以完整 token 比較解決，所以 collision 只影響效能、不影響正確性。

## 常見錯誤

- 將 token 解析成數字，錯誤地認為 `0` 與 `00` 相同。
- token 再次出現時覆寫 map，導致回報最近位置而非最早位置。
- 排序後回傳字典序最小的重複 fingerprint，而非 duplicate index 最小者。
- 只比較 hash 值而未比較完整 fingerprint。
- 輸出零起算 index。
