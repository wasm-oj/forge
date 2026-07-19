# 解題說明

## 直覺解

逐筆插入 path 已排序的陣列，再串接所有欄位；排序最壞 `O(N^2)`，且反覆串接 immutable string 還可能造成額外二次方複製。

## 最佳解

先以標準比較排序按 path 排好。用固定寬度 big-endian helper 輸出 u32/u64；path 與 `T` payload 的每個 ASCII byte輸出兩位 hex，`B` payload 已是 canonical hex，可直接輸出。type、path length、payload length 都在內容之前，因此 decoder 能唯一決定每個欄位邊界。

實作可將 hex 片段收在陣列最後 join，或直接串流寫出；不可依 host endian 直接 dump 整數記憶體。

## 正確性證明

排序後 record 順序依唯一 path 唯一決定。每個整數 helper 依定義產生固定寬度 big-endian bytes；ASCII 與 binary token 的轉換各自逐 byte 保留內容。故演算法輸出的每一段都與格式定義相同。另一方面，decoder 先讀固定 magic/count，再由 type 與兩個長度精確切出 path、payload，能唯一前進到下一 record；因此不同 type、長度、path 或 payload 至少有一個編碼 byte 不同，整體不可混淆。

## 複雜度

令 `B` 為輸入檔名與 payload byte 數，時間 `O(N log N+B)`，保存 records 與輸出時空間 `O(N+B_out)`；若串流輸出，除排序資料外可降為 `O(N)`。

## 常見錯誤

- 忘記 binary token 的長度是 hex 字元數除以二。
- 使用 little-endian 或漏補前導零。
- 依輸入順序編碼。
- 把空 payload 的 `-` 當成內容 byte。
