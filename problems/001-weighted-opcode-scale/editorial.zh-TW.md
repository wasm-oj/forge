# 解題說明

## 直覺解法

令 `T` 為展開後指令數。最直覺的方法對每個 budget 從第一條指令開始模擬，時間為 `O(QT)`；即使不展開 run、逐 run 扣除，也仍是 `O(QR)`，會被 `R,Q=200000` 排除。

## 最佳解法：run 前綴和

先建立 `weight[1..K]`，預設為 `1000`。對第 `i` 個 run 計算：

- `prefixCost[i]`：前 `i` 個完整 run 的成本；
- `prefixCount[i]`：前 `i` 個完整 run 的指令數。

兩個陣列都從索引 `0` 的零開始。對 budget `B`，以 `upper_bound(prefixCost, B)-1` 找到能完整執行的最後 run 數 `i`。若 `i<R`，剩餘 budget 為 `B-prefixCost[i]`，下一 run 還可執行

```text
take = min(nextCount, remaining / nextWeight)
```

條。答案便是相應前綴值加上 `take`。

## 正確性證明

`prefixCost` 因所有權重與次數皆為正而嚴格遞增，所以二分搜尋得到的 `i` 恰為成本不超過 `B` 的最大完整 run 前綴。任何更長前綴若仍停在下一 run，只能再取相同權重的指令；整數除法 `remaining/nextWeight` 正好是可支付的最大條數，再由 `min` 限制不越過 run。若企圖多取一條，成本必超過剩餘 budget；因此演算法輸出的是唯一最長合法指令前綴，回報成本也由同一前綴直接計算，命題成立。

## 複雜度

建表與前綴和為 `O(K+R)`；每個查詢二分搜尋為 `O(log R)`，總時間
`O(K+R+Q log R)`，核心資料結構的輔助空間為 `O(K+R)`。C、C++、Go reference
會串流讀寫；Rust、Python reference 會緩衝完整輸入與輸出，JavaScript、TypeScript
則以單一輸入字串搭配固定大小輸出分塊。因此依實際 resident allocations 計算，七語言
reference 的共同最壞空間上界為 `O(K+R+Q)`。

## 常見錯誤

- 忘記未列出的操作碼權重是 `1000`。
- 用浮點數或 JavaScript `number` 儲存成本；必須使用 64-bit integer／`bigint`。
- 把「剛好等於 budget」誤判為不可執行。
- 二分後只計完整 run，漏掉下一 run 可執行的部分。
