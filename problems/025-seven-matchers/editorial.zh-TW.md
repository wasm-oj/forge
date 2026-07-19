# 解題說明

## 直覺解

SET、MULTISET、FILESET 可對每個 expected token 線性搜尋 actual，再標記使用；最壞 O(K²)，無法通過總長 200000 的測資。

## 次佳解

把無序 matcher 的兩側各自以 comparison sort 排序，再線性比較。這是 deterministic 的，也很容易實作，但比較次數為 O(K log K)；即使 token 很短，最壞時間仍是 O(K log K+L)，沒有利用題目給定的字串長度與 byte alphabet 上限。

## 最佳解

EXACT 串接、LINES 刪尾、TOKENS 與 FLOAT 都線性處理。

一般 token 最長 30 bytes，FILESET entry 最長 29 bytes。對三種無序 matcher，可用 30 趟 stable LSD byte counting sort 建立 canonical order：從位置 29 到 0，該位置不存在時令 key 為 0，存在時令 key 為 `byte+1`。每趟以大小 257 的 counting table 做穩定排序。missing sentinel 小於所有真實 byte，所以 prefix 較短的字串會排在前面；最終順序就是 byte lexicographic order。

SET 在排序後線性去重，再比較兩側；MULTISET/FILESET 直接比較排序結果。這個方法沒有 hash collision 或語言特定 hash 行為，也不依賴 comparison sort。

FLOAT 的差值最大 2×10^18，仍在題目指定的 signed 64-bit 安全範圍；JS/TS 應使用 bigint。

## 正確性證明

EXACT、LINES、TOKENS 直接實作題目定義的正規化與逐項比較。FLOAT 逐位置驗證定義中的必要且充分條件。

考慮 radix sort。處理位置 `p` 前，歸納假設序列已依 suffix `p+1..29` 排好。位置 `p` 的 counting pass 先依該位置 key 分組，且 stable 性保留同 key 元素原有的 suffix 順序，因此 pass 後序列依 `p..29` 排好。從位置 29 開始反覆套用，可知最後序列依完整 30-position key 排好。missing sentinel 為 0、真實 byte key 為 `byte+1`，所以此順序恰為 byte lexicographic order。

Radix sort 只重排元素，不改變元素或重數。於是 MULTISET 的兩個排序序列相等，當且僅當兩側多重集合相等；SET 排序後刪除相鄰重複值，所得序列相等，當且僅當兩側集合相等。FILESET 每側 path 唯一，故完整 entry 的多重集合比較等價於檔案映射相等。綜合以上，每種 matcher 的輸出皆正確。

## 複雜度

令 `K` 為全部 query 兩側 token 總數、`L` 為其字元總長，單一 query 的對應量為 `K_q,L_q`，最大 token 長度 `B=30`、alphabet 大小 `A=257`。單次 radix canonicalization 為 `O(BK_q+AB+L_q)`；`B,A` 是題目常數，且 token 非空，所以是 `O(1+K_q+L_q)`。把 `Q` 個 header、空 query 與每題一行輸出也計入後，全部 matcher 的總時間為 `O(Q+K+L)`。

演算法逐 query 所需 auxiliary space 為 `O(K_max+L_max)`，radix scratch 另為 `O(K_max+A)`。C、C++、Go 可逐 query 讀寫；Rust、Python、JavaScript、TypeScript reference 會保留完整輸入並緩衝 `Q` 行輸出，因此這四語言的實際 buffered I/O resident space 為 `O(Q+K+L)`。

## 常見錯誤

- EXACT 在 token 間自行加入空白。
- LINES 刪除中間的空行。
- SET 忘記去重或 MULTISET 錯誤去重。
- FLOAT 使用浮點數或在相減時溢位。
- 使用一般 comparison sort，得到 O(K log K+L) 而非 deterministic O(K+L)。
