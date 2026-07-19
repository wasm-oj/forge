# 解題說明

## 直覺解法

以陣列保存每個 path，但在每次可能改變 size 或 inode 前，掃描 `P` 個 path 重算目前用量。這很容易確認交易是否合法，卻需 `O(PN)` 時間。

## 最佳解法：增量帳本

維護 `exists[x]`、`size[x]`、`usedBytes`、`usedInodes`。CREATE／UNLINK 對 inode 加減一；size 從 `old` 改為 `new` 時，只需考慮差值：增長 `delta=new-old` 前檢查 `delta≤B-usedBytes`，縮小則直接釋放 `old-new`。這種寫法也避免計算 `usedBytes+delta` 時溢位。

所有檢查先完成，通過後才一次提交相關欄位。提交後分別更新兩個 peak。quota 錯誤時設定 sticky，但不改動檔案帳本。

## 正確性證明

以已處理操作數歸納。初始陣列與兩個用量皆為零，正確。假設操作前帳本等於 VFS 狀態。對 CREATE／UNLINK，演算法按規定的優先序檢查存在性及 inode quota，成功時恰加入或移除該檔案及其 size。對 WRITE／TRUNCATE，計算的 `new` 正是題目定義；差值等於總 logical bytes 的唯一變化，quota 檢查因此充要。失敗分支不提交任何欄位，成功分支提交全部欄位，故交易語意成立。peak 只在成功後與真實用量取最大，sticky 恰在兩種 quota 錯誤出現後保持為一。歸納得所有逐步輸出與 SUMMARY 正確。

## 複雜度

初始化陣列 `O(P)`，每個操作 `O(1)`，總時間 `O(P+N)`，檔案狀態的核心輔助空間為 `O(P)`。C、C++、Go reference 串流讀寫；Rust、Python 會保留完整輸入與輸出，JavaScript、TypeScript 保留單一 Forge 輸入字串並以固定 64 KiB 分塊輸出。每筆操作與答案的文字長度皆為常數，因此依實際 resident allocations 計算，七語言 reference 的共同最壞空間上界為 `O(P+N)`；初始化與讀取操作也給出 `Ω(P+N)` 時間下界。

## 常見錯誤

- quota 失敗後仍先改了 size，破壞原子性。
- sparse write 只加 `length`，漏算 `offset` 形成的 hole。
- 零長度 write 錯誤地把檔案延伸到 offset。
- unlink 忘記同時釋放 bytes 與 inode。
- EXISTS／NOENT 也設 sticky，或縮小後清除 sticky。
