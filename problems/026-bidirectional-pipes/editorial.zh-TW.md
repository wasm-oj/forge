# 解題說明

## 直覺解

真的建立大小 C 的 byte queue，寫入／讀出 k 次。總 byte 動作量 B 可遠大於輸入長度，且 C 可達 10^18，因此時間 O(B)、空間 O(C) 不可行。

## 最佳解

只維護 `ab`、`ba` 兩個 occupancy、兩支 program counter 與 outgoing closed flags。W/R 的可執行條件只依 occupancy 和 C，成功時直接加減 k。每 round 依 A、B 固定順序呼叫一次 `tryStep`，記錄是否有進展；讀取不足且 peer outgoing closed 時回報 failure。program counter 到尾端時設 closed。

## 正確性證明

對每次嘗試歸納。occupancy 等於實際 pipe byte 數：成功 W 加 k、成功 R 減 k，其餘不變。因 byte 內容從不影響條件，計數器與真正 queue 對所有未來動作不可區分。closed flag 也恰在 C 或程序結束時設定。因此 tryStep 對成功、阻塞、failure 的判斷與規格一致；scheduler 又按指定順序呼叫，最終狀態與分類正確。

## 複雜度

每個成功動作只執行一次；有進展的 round 至少完成一個動作，最後最多再一個無進展 round。時間 O(NA+NB)，儲存動作的空間 O(NA+NB)。

## 常見錯誤

- 把 W/R 拆成可部分完成的操作。
- A 阻塞後不嘗試 B。
- 程序自然結束時忘記關閉 pipe。
- failure 後仍執行同 round 的另一程序。
