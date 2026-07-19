# 解題說明

## 直覺解

逐筆把 record 插入目前已排序 manifest 的正確位置，需要搬移後綴，逆序輸入時 O(N²)。

## 最佳解

先用「path==E 或 path startsWith E+'/'」判斷排除項目，注意 segment 邊界。把其餘 record 連同原始輸出文字保存，以 path 使用 byte-order comparison sort，最後輸出。

## 正確性證明

filter 條件逐字等同題目對 evidence subtree 的定義，因此保留集合正確。所有 path 唯一，comparison sort 產生且只產生唯一的嚴格遞增排列；輸出保存的原 record，故除順序與指定排除外沒有欄位被改動。因此 manifest 正確且 canonical。

## 複雜度

令 L 為輸入總字元數。filter O(L)，排序 O(N log N) 次比較，空間 O(N+L)。任意不同 ASCII path 的 comparison model 中，canonical 排序有 Ω(N log N) 下界。

## 常見錯誤

- 用單純 `startsWith(E)`，錯刪 `proof2`。
- 依 record 類型而非 path 排序。
- 使用 locale collation。
- 重建輸出時遺失 executable 或 symlink target。
