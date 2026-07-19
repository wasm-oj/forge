# 解題說明

## 直覺解法

若以 byte array 表示檔案，SEEK 到巨大 offset 後的一次 write 就要配置整個 hole，時間／空間 `O(E)`，而 `E` 可達 `9×10^18`。即使只存 size，若每次 quota 檢查都掃描 `F` 個檔案，也會是 `O(FN)`。

## 最佳解法

每個檔案只需 `size[x]` 與 `cursor[x]`，全域維護 `used=sum(size)`。求出候選 `newSize` 後：若增長量 `delta=newSize-oldSize` 大於 `B-used` 就失敗；否則以差值更新 used 與 size。縮小直接釋放差值。使用 `delta>B-used` 而非 `used+delta>B` 可避免無號加法溢位。

WRITE 的 cursor 僅在非零且成功時前進；零長度 write 與失敗交易都不動。TRUNCATE 永不改 cursor。成功後更新 peak。

## 正確性證明

歸納假設操作前 `used` 等於所有 size 總和。SEEK 只改指定 cursor，總和不變。WRITE 的候選 size 依定義為舊 EOF 與寫入結尾較大者，TRUNCATE 的候選即指定值；兩者只有該檔案 size 可能改變，所以全域總和的唯一差值就是 `new-old`。演算法的 quota 判斷因此充要。成功時同時提交正確 size、used 與規定的 cursor，失敗時不提交，維持歸納不變量。peak 只在正確成功狀態取最大，故逐行狀態與 SUMMARY 全部正確。

## 複雜度

初始化 `O(F)`，每個操作 `O(1)`，總時間 `O(F+N)`，核心狀態的輔助空間為
`O(F)`，且不依賴最大 offset。C、C++、Go reference 串流讀寫；Rust、Python
會保留完整輸入與輸出，JavaScript、TypeScript 保留單一輸入字串並以固定大小分塊輸出，
因此依實際 resident allocations 計算的共同最壞空間上界為 `O(F+N)`。

## 常見錯誤

- sparse write 只增加 `length`，漏算 cursor 前的 hole。
- truncate 縮小時把 cursor 一併截到 EOF；本題明定不改。
- quota 失敗後仍前進 WRITE cursor。
- 零長度 WRITE 延伸到 cursor，或錯誤地前進 cursor。
