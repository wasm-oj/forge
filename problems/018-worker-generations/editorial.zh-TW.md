# 解題說明

## 直覺解

保存全部 assignment，處理第 `i` 筆前從頭重播，推回 active generation、family 與 used stages。這正確但總時間 `O(N^2)`。

## 最佳解

只需四個狀態：目前 generation ID、目前 family、目前 used、reject count。先處理 `stages=0`，再處理兩個 reject 條件；兩者都不得改狀態。有效 miss 若不符合目前 Worker，就遞增 ID、替換 family 並把 used 歸零，最後累加 stages。

這同時是 greedy：規格要求只能用 active generation；符合時沿用不會增加 Worker 數，不符合時建立新 generation 是唯一可行動作。

## 正確性證明

以 build 前綴歸納。初始沒有 Worker，狀態正確。cache/reject 分支依定義輸出且不改狀態。對有效 miss，若 active Worker 同 family 且容量足，規格要求可且應使用它；演算法如此做並正確增加 used。否則沒有合法 active Worker，唯一合法選擇是新 generation；演算法建立下一個連續 ID 並配置該 build。故每一步輸出與後繼狀態皆唯一正確，最終兩個計數也正確。

## 複雜度

每筆常數工作，時間 `O(N)`；除輸出緩衝外額外空間 `O(1)`（目前 family 字串長度至多 20）。

## 常見錯誤

- cache hit 切換了 active family。
- rejected build 消耗容量或建立 generation。
- family 切回舊值時回用了舊 Worker。
- 先判 `stages>B`，卻讓 `stages=0` 在某些特例改變狀態。
