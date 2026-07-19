# 解題說明

## 直覺解

依輸入順序加入紀錄，對第 `j` 筆逐一檢查前 `j-1` 筆：路徑相等，或其中的 `F` 路徑是另一條路徑的 segment 前綴，即為衝突。這自然得到正確 tie-break，但把所有 path byte 納入後，時間為 `O(NS)`、空間為 `O(S)`。

## 次佳解：排序與祖先堆疊

把 `(path, kind, index)` 依 **tree order** 排序，將相同 path 組成一組。tree order 比較 path byte 時，把 separator `/` 視為小於任何合法 segment 字元，其餘 byte 維持原順序。於是某個 path 會排在全部嚴格後代之前，而且整棵 prefix 子樹必為連續區間。

不能直接使用一般 ASCII 字典序：合法的 `-`（45）與 `.`（46）都小於 `/`（47），例如 `/a-` 會插在 `/a` 與 `/a/b` 之間，破壞 prefix 子樹連續性。

- 同組至少兩筆時，原編號最小的兩筆形成該路徑能產生的最佳重複衝突。
- 字典序掃描不同路徑。維護仍為目前路徑嚴格祖先、且該組含 `F` 的堆疊。離開一個 prefix 子樹時將它彈出。
- 堆疊項目另存「到此為止所有祖先 `F` 的最小原編號」。目前組只需與此最小編號、以及目前組的最小編號配對。
- 若目前組含 `F`，掃描完後把它壓入，供後代使用。

每當得到候選 `(a,b)`，先排成 `i=min(a,b), j=max(a,b)`，以 `(j,i)` 比較即可實作題目的 tie-break。

comparison sort 會做 `O(N log N)` 次比較。把 variable-length path 的 byte 比較也納入後，這個解法的時間為 `O(S log N)`、空間為 `O(N+S)`；它適合較寬鬆的資源政策，但不是最嚴格政策要求的最佳解。

## 最佳解：依輸入順序維護字元 trie

依 `j=1,2,...,N` 的原順序處理。如此只要第 `j` 筆能和先前紀錄衝突，就已經找到最小的 `j`；我們只需在所有先前候選中取最小的 `i`，然後立刻輸出。

trie 的每個節點代表一個字元前綴，並維護：

- `exactMin`：恰好在這個 path 結束的最小先前編號；
- `fileMin`：恰好在這個 path 結束、且種類為 `F` 的最小先前編號；
- `descMin`：以這個節點所代表的 canonical path 為**嚴格祖先**之先前紀錄最小編號；
- `firstChild`、`nextSibling` 與該節點的字元。

對目前的 `(kind,path)` 從根走到終點：

1. 每到一個嚴格 canonical-path 前綴，就用該節點的 `fileMin` 更新候選。一般路徑的 boundary 是「下一個字元為 `/`」；根路徑 `/` 則是特例，它是所有非根路徑的祖先。
2. 到達終點後，用 `exactMin` 更新候選。
3. 若目前種類為 `F`，再用終點的 `descMin` 更新候選，涵蓋「目前檔案是先前路徑祖先」的情況。
4. 若有候選，最小的 `i` 與目前 `j` 就是答案。否則才把第 `j` 筆寫入 trie：更新終點的 `exactMin`、必要時更新 `fileMin`，並在 path 的每個嚴格 canonical 祖先節點更新 `descMin`。

`descMin` 不能更新在所有字元前綴。例如插入 `/ab` 時，不可更新 `/a` 節點，否則會把 `/a` 錯當成 `/ab` 的祖先；只有根 `/`，以及下一個字元為 `/` 的 segment boundary 才能更新。

不使用 hash map 尋找 child。合法 child 字元只有 `/`、小寫字母、數字、`.`、`_`、`-`，總數是固定常數。以 first-child/next-sibling 掃描某節點的 children，單次轉移至多檢查這個固定 alphabet 的數量，因此是 worst-case `O(1)`，不是 expected-only 的雜湊複雜度。

## 正確性證明

**引理一：** 處理第 `j` 筆前，終點的 `exactMin` 恰為所有相同先前 path 的最小編號。每筆無衝突紀錄插入時都在其唯一終點取最小值，因此不變量成立；查詢它正好涵蓋 duplicate 衝突。

**引理二：** 沿第 `j` 筆 path 經過 canonical 嚴格祖先節點時，其 `fileMin` 恰為該祖先 path 中最小的先前 `F` 編號。因此取這些值的最小值，恰涵蓋所有「先前 `F` 是目前 path 嚴格祖先」的衝突。

**引理三：** 任一節點的 `descMin` 恰為其 canonical path 的所有先前嚴格後代中最小的編號。插入 path 時只更新根 `/` 與下一個字元為 `/` 的嚴格前綴，這些且僅這些前綴是其 canonical path 祖先。因此目前種類為 `F` 時，終點的 `descMin` 恰涵蓋所有「目前 path 是先前紀錄嚴格祖先」的衝突。

三個引理涵蓋題目定義的所有衝突，而且沒有納入其他 pair。依輸入順序處理使第一個有候選的 `j` 最小；該次取所有候選編號的最小值使 `i` 最小。因此輸出符合 `(j,i)` tie-break。

## 複雜度

trie 至多建立 `S+1` 個節點。每個 path byte 只走常數次，而每次 first-child/next-sibling 搜尋至多檢查固定 alphabet 的所有字元，因此 worst-case 時間為 `O(S)`。trie 與輸入所需空間為 `O(S)`。

## 常見錯誤

- 用字串 `startsWith` 便把 `/a` 誤認為 `/ab` 的祖先。
- 在所有字元前綴更新 `descMin`，同樣會把 `/a` 與 `/ab` 誤判。
- 直接用 ASCII path 排序，忽略 `-`、`.` 會排在 separator `/` 之前。
- 把目錄祖先也判為衝突。
- 找到第一個祖先就停止，沒有在固定的 `j` 中取最小 `i`。
- 忘記根路徑 `/` 的特殊 prefix 規則。
