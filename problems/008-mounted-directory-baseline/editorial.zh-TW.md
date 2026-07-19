# 解題說明

## 直覺解法

對每條 path 列出所有父目錄 prefix，再與已知目錄陣列逐一比較。若有 `Θ(S)` 個不同目錄，每次搜尋也線性，最壞 `O(S^2)`；建立完整 prefix tuple 也可能重複複製長前綴。

## 進階解法：segment trie

root 是 trie 節點 0，目錄數初始為 1。對每條檔案 path，只插入前 `k-1` 個 segment：目前節點與 segment label 共同決定唯一 child；不存在就建立並把目錄數加一。最後一個 segment 是檔名，不插入目錄 trie。baseline inode 等於目錄節點數加 `M+O`，bytes 則在讀取 mounted file 時直接加總。

child 可用每節點 map，或以 `(node,label)` 為 key 的全域 hash map；兩者是同一棵 segment trie。雜湊表平均很快，但若 hash seed 與 table layout 可由測資預測，合法 segment 仍可能全部落在同一 bucket，無法提供 worst-case 保證。

## 最佳解法：排序與最長共同前綴

把全部 `P=M+O` 條 segment 序列依字典序排序。root 先計一次。依序處理每條 path 時，它的前 `k-1` 個 segment 是父目錄；令它與前一條 path 的最長共同前綴長度為 `lcp`，則本條新增的目錄數為

```text
(k-1) - min(k-1, lcp)
```

第一條 path 視為 `lcp=0`。這個作法不依賴可被攻擊的 hash table，且所有七份 reference solution 都使用同一策略。

## 正確性證明

root 唯一對應 `/`。字典序中，具有同一 prefix 的 path 必形成連續區間。因此處理目前 path 時，某個父目錄 prefix 若先前出現過，具有該 prefix 的最後一條先前 path 就是目前 path 的字典序前驅；反之，前驅與目前 path 共同的前綴都已出現。故 `min(k-1,lcp)` 恰是已計數的父目錄數，其餘父目錄各新增一次。歸納處理全部 path 後，root 加上各次新增數正好是不同目錄數。

每個檔案另外各占一個 inode，mounted size 直接加總，所以 baseline 正確；ACCEPT、remaining 與 missing 再依定義計算。

## 複雜度

令 `P=M+O`。comparison sort 至多進行 `O(P log P)` 次 path 比較；把共同前綴的 segment 比較成本計入後，時間上界為 `O(S log P)`。排序後的相鄰 LCP 掃描合計 `O(S)`，讀入與儲存 path 使用 `O(S+P)` 空間。這是 portable comparison model 下的 deterministic bound；hash trie 則為 `O(S) expected`，但不具同等 worst-case 保證。

## 常見錯誤

- 忘記 root 本身也佔一個 inode。
- 把檔名 segment 插成目錄，或漏掉預建輸出檔 inode。
- 將相同父目錄重複計數。
- 只寫固定 seed 的線性探測或 deterministic hash，讓對抗測資造成平方 probing。
- REJECT 時直接做無號 `quota-baseline` 而 underflow。
