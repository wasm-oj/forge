# 解題說明

## 直覺解

先做三個局部 phase，再對每個 reference 從頭掃描所有 blobs；最壞 O(BR)。

## 最佳解

前三 phase 各線性掃描並嚴格依規定優先序提早輸出。通過後兩個 digest 陣列都嚴格排序；用雙指標：blob digest 小於 reference 就前進 blob，相等就前進兩者，大於或 blob 用盡代表該 reference 缺少。第一趟只驗證所有 reference 都存在；全部存在後才以第二趟 merge 累加 actual length。這避免最後才發現 missing 的無效輸入，先以不受合法 total 上限保證的 prefix 令 64-bit 累加溢位。

## 正確性證明

前三次掃描各找到其 phase 的最小違規位置，且只有前一 phase 完全合法才進入下一 phase，所以錯誤優先序正確。merge 時，當 blob 小於目前 reference，它不可能匹配目前或任何更早 reference，可安全丟棄；相等是唯一匹配；blob 大於 reference 時，排序性保證後方更大，故 reference 必缺。第一趟通過後 bundle 已合法，第二趟依相同唯一匹配累加的恰為全部引用 record 長度，且題目與 validator 此時保證 total 可用 64-bit 表示。

## 複雜度

每個指標只前進，總時間 O(B+R)，空間 O(B+R)（保存輸入；可串流降至 O(B)）。

## 常見錯誤

- 先回報 length 而忽略更高優先的 blob order。
- 只檢查 digest 不相等，卻接受降序。
- missing 時回報 blob 位置而非 reference 位置。
- 把未引用 blob 也加入 total。
- 在確認沒有 missing 前就累加，讓無效輸入的超大已命中 prefix 溢位。
