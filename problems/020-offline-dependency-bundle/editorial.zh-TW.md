# 解題說明

## 直覺解

對每個 package 線性搜尋所有 payload，並對 payload 再掃描 required，最壞 `O(NM)`；同 digest 的重複與優先序也容易漏判。

## 最佳解

把 lock records 與 payload records 分別依 digest 排序。相同 digest 連續：lock group 可檢查 size 是否一致並壓成唯一 required record；payload group 可檢查 duplicate。

必須按規格優先序完成整個類別後才進下一類：先找所有 lock conflict 的第一個，再找 payload duplicate；之後可用 binary search 或 two pointers 依序找第一個 missing、extra、size mismatch。若皆無，排序過程同時累加 package total 與 unique required total，即可輸出統計。

## 正確性證明

排序使同 digest 的所有紀錄相鄰，因此每組比較能且只能偵測該 digest 的 lock conflict/duplicate，從左至右第一個即同類字典序最小者。壓縮後 required 與 payload 各是一個按 digest 排序的集合；membership 比較精確判定 missing 與 extra，兩集合相同後同 key 的 size 比較精確判定 SIZE。演算法僅在前一類完全不存在時檢查下一類，故錯誤優先序正確。無錯誤時每個 required digest 恰一 payload 且 size 相同；unique sum 與 package sum 的差正是內容去重節省，VALID 統計正確。

## 複雜度

排序時間 `O((N+M)log(N+M))`，後續掃描（或 binary search）不超過同一界；空間 `O(N+M)`。在比較模型下任意 digest 的 canonical 排序需要此量級。

## 常見錯誤

- 看到 missing 就立刻輸出，卻漏掉優先級更高的 duplicate payload。
- 相同 digest 重複計入 deduplicatedBytes。
- 用 package name 而非 digest 做集合比較。
- 64-bit 加總前先用 32-bit 暫存。
