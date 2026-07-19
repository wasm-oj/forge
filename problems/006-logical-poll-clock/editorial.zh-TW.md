# 解題說明

## 直覺解法

用表保存 active timer；每次 POLL 掃描全部 timer，先找最小 deadline，再掃一次找出到期者。交錯加入與 poll 時會達到 `O(N^2)`。

## 最佳解法

將 `(deadline,id)` 放入最小堆，另以 `active[id]` 記錄是否仍有效。取消時只把 active 設為 false；當失效項目來到堆頂才丟棄，這是 lazy deletion。

POLL 先清掉堆頂已取消項目。若 `ready=0` 且堆非空，clock 更新為 `max(clock,minDeadline)`。之後反覆彈出 `deadline≤clock` 的項目：取消者忽略，active 者輸出並標為不 active。因堆比較鍵正是規定的 `(deadline,id)`，彈出順序就是輸出順序。

## 正確性證明

忽略 `active=false` 的項目後，堆包含每個 active timer 的原始鍵，所以清理後堆頂是最小 active `(deadline,id)`。在無 ready 事件時，若最小 deadline 在未來，將 clock 快轉至它；若已到期則 `max` 保持 clock，恰符合規則。所有且僅有鍵的 deadline 不大於 clock 的 active 項目會在 while 中被彈出，而堆序保證其 `(deadline,id)` 遞增。取消項目永不輸出。故每次 POLL 的 clock 與觸發集合、順序都正確；移除後不會再次觸發。

## 複雜度

每個 timer 入堆一次、出堆至多一次，每次 `O(log N)`；其他命令 `O(1)`，總時間 `O(N log N)`、空間 `O(N)`。

## 常見錯誤

- 有 ready fd 時仍快轉 clock。
- 取消時在線性堆中搜尋刪除，退化成平方時間。
- 新加入的 deadline 可能小於目前 clock，下一次 poll 應立即觸發但 clock 不倒退。
- 只按 deadline 排序，漏掉相同 deadline 的 ID tie-break。
