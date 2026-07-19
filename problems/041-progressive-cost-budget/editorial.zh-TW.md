# 解題說明

## 直覺解法：每次重新掃描

對每個 budget 都從第一個 stage 開始累加，直到下一個 stage 會超出 budget。單一查詢最多檢查 `N` 個 stage，總時間為 `O(NQ)`；由於讀完 cost 後才會讀到 budget，必須保留 `N` 個成本，空間為 `O(N)`。這個方法直接反映題意，但在 `N,Q=200000` 時無法完成。

## 進階解法：前綴和與二分搜尋

建立前綴和陣列：

```text
prefix[0] = 0
prefix[k] = cost_1 + cost_2 + ... + cost_k
```

因為成本皆非負，`prefix` 不遞減。對 budget `B`，在 `prefix` 中尋找最後一個 `<= B` 的位置，其索引就是答案。必須使用 upper bound（第一個 `> B` 的位置），而不是只找任意一個等於 `B` 的元素，否則零成本 stage 造成的重複前綴和會讓答案太小。

建表花費 `O(N)`，每個查詢二分搜尋花費 `O(log N)`，總時間為 `O(N+Q log N)`，輔助空間為 `O(N)`。

## 最佳解法：利用單調 budget 的雙指標

budget 已保證不遞減，因此前一個答案不可能在下一次查詢時縮短。維護：

- `completed`：目前已完成的 stage 數量；
- `spent`：這些 stage 的總成本。

處理 budget `B` 時，只要還有下一個 stage，且 `cost[completed] <= B - spent`，就完成該 stage 並更新兩個狀態。使用減法形式的比較，可以避免先計算 `spent + cost` 所可能造成的整數溢位。當迴圈停止時輸出 `completed`。

## 正確性證明

在處理每個 budget 前，維持以下不變量：`completed` 是先前 budget 可完成的最大 stage 數，且 `spent` 正好是這段前綴的成本。

目前 budget 不小於先前 budget，所以既有前綴仍合法。迴圈每次只在下一個 stage 的成本仍可支付時將它加入，因此加入後的前綴合法；這也包含成本為零的 stage。迴圈停止只可能是全部 stage 都已完成，或下一個 stage 會使成本超過目前 budget。由於 stage 不可跳過，後一種情況下任何更長前綴都不合法。因此輸出的 `completed` 正是目前 budget 的最大合法答案，不變量也對下一次查詢成立。依數學歸納法，所有答案皆正確。

## 複雜度

每個 budget 處理一次，而 `completed` 在整個演算法中只會從 `0` 增加到 `N`，所以總時間為 `O(N+Q)`。儲存 stage 成本需要 `O(N)` 輔助空間。部分 reference 為了減少輸出呼叫會額外緩衝 `Q` 個答案，因此這些實作的 resident 空間為 `O(N+Q)`。

## 常見錯誤

- 對每個 budget 都把 stage 指標重設為零，退化成 `O(NQ)`。
- 遇到成本為零的 stage 時沒有繼續前進。
- 二分搜尋使用 lower bound，漏掉具有相同前綴和的後續 stage。
- 假設 budget 嚴格遞增；相等的相鄰 budget 也是合法輸入。
- 使用 32-bit 整數，或在 JavaScript／TypeScript 使用不精確的 `number`。
