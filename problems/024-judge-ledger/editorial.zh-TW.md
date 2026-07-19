# 解題說明

## 直覺解

每個查詢逐 case 掃描、遇 fail-fast 停止，再累加與取最大。單次 O(N)，總計 O(NQ)。

## 最佳實用解：prefix 與 iterative segment tree

由右往左預計算 `nextBad[i]`，代表 i 之後（含 i）第一個非 AC 位置，沒有則為 N+1。這可 O(1) 決定實際右端點及 verdict。

對 cost/time 各建「已知值前綴和」和「-1 數量前綴和」；區間未知數為零才輸出區間和。memory/vfs 也有未知數前綴，已知時以 iterative segment tree 查區間最大值。

## 正確性證明

`nextBad[l]` 依定義就是 fail-fast 唯一可能的停止點，故選出的右端正確；第一失敗 verdict 也因此正確。前綴差精確涵蓋所選區間，未知計數非零恰等價於題意的 null 條件，否則前綴和值即所需總和。segment tree 將查詢區間分割為互斥節點，取這些節點最大值等於所有 case 的最大值。六個輸出欄位皆正確。

## 複雜度

建表 O(N)，每查詢兩次 range maximum 為 O(log N)，總時間 O(N+Q log N)。prefix 與 segment tree 的輔助空間是 O(N)；由於部分 reference implementations 也會保留完整輸入並暫存所有答案，實際總駐留空間是 O(N+Q)。這是七種語言共同採用、常數與實作風險均合理的 reference 路徑；若只追求理論漸近界，static RMQ 可再用 Cartesian tree 與線性預處理 RMQ 將全體降到 O(N+Q)，但那不是本題 reference solutions 宣稱實作的路徑。

## 常見錯誤

- fail-fast 忘了包含失敗 case。
- 一個 metric 未知就把所有 metric 都變 null。
- 最大值的 identity 用 0 以外值，或區間端點 off-by-one。
- 非 fail-fast 的 verdict 誤取最後一個失敗。
