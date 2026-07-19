# 解題說明

## 直覺解法

可反覆在字串中搜尋 `//`、`/./` 與 `name/..` 再建立新字串。每次重寫可能搬動 `Θ(L)` 字元，而 `/a/a/.../../..` 類輸入可觸發線性次重寫，最壞 `O(L^2)`。

## 最佳解法

以 `/` 切出 segment，維護普通 segment stack。空字串與 `.` 不動作；普通 segment push；`..` 在 stack 非空時 pop，否則立刻標記 INVALID。最後用 `/` 串接 stack；空 stack 輸出 root。

實作可儲存 segment 本身，或只記錄原字串中的起點與長度。後者仍是同一演算法且避免複製中間字串。

## 正確性證明

從左到右歸納：處理任意前綴後，stack 依序等於該前綴 lexical normalization 後仍存在的普通 segments。空 segment 與 `.` 不改變路徑；普通 segment 應追加，對應 push；`..` 應移除最近的普通 segment，對應 pop。若 stack 空，規格定義為穿越 root，演算法正確回報 INVALID。全部處理後，stack 因而恰是 canonical path 的 segments，以單一斜線串接即得唯一答案。

## 複雜度

每個字元被掃描常數次，每個 segment push、pop 至多一次；所有輸入總時間 `O(L)`、額外空間 `O(L)`（逐 path 重用時為最大單一路徑長度）。讀取與輸出已有 `Ω(L)` 下界。

## 常見錯誤

- 將 `...`、`.config` 或 `..hidden` 誤認為特殊 segment。
- 把 root 上的 `..` 靜默忽略；本題必須 INVALID。
- 在發生穿越後繼續處理並讓後續 segment「補回來」。
- 輸出 root 為空字串或保留尾斜線。
