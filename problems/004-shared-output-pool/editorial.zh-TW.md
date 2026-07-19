# 解題說明

## 直覺解法

每個 budget 都從事件一開始扣除並分流計數，最壞 `O(NQ)`。建立總量與三流前綴和後，可對每個 budget 二分第一個超出的前綴，降至 `O(N+Q log N)`。

## 最佳解法：單調雙指標

budget 非遞減，因此「能完整保留的 event 數」也不會減少。維護指標 `i`、前 `i` 個完整 event 的總量 `used`，以及三流完整保留量。處理 budget `B` 時，不斷完整納入滿足 `used+bytes[i]≤B` 的下一 event；每個 event 全程至多被納入一次。

若最後 `i=N`，輸出 failure `0`。否則第 `i+1` 個 event 失敗，並在它所屬流的暫時答案上加 `B-used`；這個部分值不可寫回共同狀態，因為 event 尚未被完整納入。

## 正確性證明

處理一個 budget 後，while 條件保證前 `i` 個 event 全可完整保留，而若仍有下一 event，`used+size>B`，所以 `i+1` 正是第一次失敗。剩餘容量 `B-used` 非負且小於該 event 大小，依規格恰好全部部分保留到其流。budget 單調使先前完整納入的 event 對後續查詢仍完整合法，故不需回退；未完成 event 的部分量未改動狀態，也不會污染下個查詢。依查詢順序歸納，所有答案正確。

## 複雜度

事件指標總共前進 `N` 次，每個查詢做 `O(1)` 額外工作，總時間 `O(N+Q)`。事件先於 budget 輸入，必須保留 stream 與 byte 數供後續掃描，所以核心輔助空間為 `O(N)`。C、C++、Go reference 串流讀寫；Rust、Python 保留完整輸入與輸出，JavaScript、TypeScript 保留單一 Forge 輸入字串並以固定 64 KiB 分塊輸出。每筆事件、budget 與答案皆只有常數個定長 token，故依實際 resident allocations 計算，七語言 reference 的共同最壞空間上界為 `O(N+Q)`；讀寫量亦給出 `Ω(N+Q)` 時間下界。

## 常見錯誤

- 把 write 當成不可分割，漏掉失敗 event 的部分內容。
- budget 剛好等於 event 結尾時，錯誤地回報該 event 失敗；此時應繼續看下一個。
- 將部分保留量寫入持久計數，導致重複 budget 答案變大。
- 忽略三個流共用同一 budget。
