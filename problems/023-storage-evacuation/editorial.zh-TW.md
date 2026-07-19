# 解題說明

## 直覺解

每次在尚未刪除項目中線性尋找政策順序最小者，最壞 O(N²)。背包或依 size 選擇都是錯的，因為題目明定唯一政策順序。

## 最佳解

先計算 `T` 與 need。若 need>T 輸出 IMPOSSIBLE；否則依 `(priority,lastUsed,participant,key)` 排序，從頭累加 size，到第一次達到 need 為止。

## 正確性證明

排序後第 i 個元素恰是政策在刪除前 i-1 個項目後指定的下一項。故演算法產生的序列與政策逐步選擇完全相同。停止前釋放量小於 need，停止後不少於 need，因此它也恰在政策規定的第一次滿足時停止。

## 複雜度

排序 O(N log N)，掃描 O(N)，空間 O(N)。在只能比較任意 participant/key 的模型中，輸出完整政策次序可歸約排序，為漸近最佳。

## 常見錯誤

- 只取 `T-C` 而漏掉瀏覽器 reserve 缺口。
- 把 priority 大者先淘汰。
- 對字串使用 locale 排序；本題是 ASCII byte order。
- 最後一個項目超過 need 時嘗試部分刪除。
