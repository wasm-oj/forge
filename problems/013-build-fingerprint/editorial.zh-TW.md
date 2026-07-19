# 解題說明

## 直覺解

對每個 build 建立空陣列，再把每個 file ID 依 path 插入正確位置。第 `K` 筆 build 最壞需 `O(K^2)` 次比較與搬移；大 build 會逾時。

## 最佳解

讀入檔案表後，對每個 build 收集其 file ID，使用比較排序，key 為對應的 path。輸出四個 metadata、`K`，再依排序結果輸出 `(path,digest)`。path 都是 ASCII，所以各語言的 byte/一般字典序在此限制下相同。

不應真的把 token 串接後再拆解，也不需要計算 digest；直接串流輸出 token（或使用固定大小的 64 KiB chunk）可避免配置與總輸出等大的字串。

## 正確性證明

比較排序結束後，所有相鄰 path 非遞減；因 path 唯一，故嚴格遞增，且排序只是置換，所含檔案集合與輸入相同。演算法原樣輸出四個 metadata 與 `K`，再對每個排序後 ID 查回唯一的 path、digest。因此每行恰為題目定義的 canonical preimage。canonical 順序唯一，所以輸出正確。

## 複雜度

第 `i` 個 build 需 `O(K_i log K_i)` 次 path 比較與 `O(K_i)` 暫存空間；令 `S` 包含全部讀寫文字 bytes，總時間 `O(sum K_i log K_i + S)`，峰值額外空間 `O(K_max)`（檔案表與輸入另需 `O(N+S_input)`，streaming output 不另存 `S_output`）。

## 常見錯誤

- 依 file ID 或 digest 排序，而不是 path。
- 把 metadata 也排序。
- `K=0` 時多印占位 token。
- 使用 locale-aware collation，造成跨 host 不一致。
