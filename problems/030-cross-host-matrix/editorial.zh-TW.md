# 解題說明

## 直覺解

對 baseline 每個 path，在另一側 field list 線性搜尋，反向再做一次以找 missing。單一大 case 可達 O(T²)。

## 最佳解

先比較 case id vector。相同時，對每對對應 case 的兩個已排序 field list 使用雙指標 merge：較小 path 只存在一側；相等時比較 value；較大則反向 missing。依 case 順序處理，自然得到規定的差異順序。

若完全一致，對每個 case 收集 H 個 runtime、排序並取 `(H-1)/2`。

## 正確性證明

case vector 直接比較恰判斷第一層契約。對 fields，merge 的循環不變量是：兩指標以前的所有 path 已恰好分類，且未處理部分的最小 path 位於兩指標之一；取較小者或共同者後分類必然正確且不重複。故輸出正是差異 path 聯集並具指定順序。全體 transcript 一致時，每 case 排序 runtime 後指定 index 正是 lower median。

## 複雜度

令 T 為輸入 fields 與 case records 總量、D 為輸出差異數、C 為 baseline case 數。共同 field 的掃描由 T 支付，只存在 baseline 一側而被各 host 重複掃描的 field 會各自成為一筆差異、由 D 支付，因此比較為 O(T+D)；median 排序 O(CH log H)。目前 reference solutions 保存全部輸入，部分語言也緩衝輸出，故真實空間為 O(T+D+H)。題目保證 D≤200000，避免合法輸出相對輸入放大到不可執行的規模。

## 常見錯誤

- 把 case 當集合，忽略順序。
- 只找 value 不同，漏掉只存在一側的 path。
- transcript 不一致時仍輸出 median。
- 偶數 host 取 upper median。
