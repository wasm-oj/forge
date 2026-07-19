# 解題說明

## 直覺解

用陣列表示真正的等待佇列。取消時搜尋並刪除元素，啟動下一份時從陣首搬移所有元素。交錯加入與取消可造成 O(N²)。

## 最佳解

每個 id 只有 `queued`、`active`、`terminal`（或不存在）四種狀態。把每次加入的 id 追加到 deque；取消等待者時只把 hash map 中狀態改為 terminal，不從 deque 中間移除。需要啟動工作時，持續從隊首丟掉非 queued id，第一個 queued id 改為 active。每個 id 最多入隊、出隊各一次。

另維護 `waiting` 計數器：加入到已有 active 的系統時加一；取消 queued 時減一；queued 轉 active 時也減一。

## 正確性證明

deque 始終依加入時間保存所有尚未從隊首檢查過的 id。狀態為 queued 的元素恰為有效等待者；terminal 元素是可安全略過的墓碑。因此啟動函式略過墓碑後取到的第一個 queued 元素，正是題意要求的最早有效等待者。每種事件只做指定狀態轉移並於 active 消失時呼叫啟動函式，歸納可得輸出的 active 與 waiting 永遠正確。

## 複雜度

hash 操作預期 O(1)；所有 dequeue 總共 O(N)，故總時間 O(N)、空間 O(N)。

## 常見錯誤

- 將 active 也算進 waiting。
- 取消 queued 後忘記減計數。
- 把已取消 id 從 deque 中間刪除，導致平方時間。
- `E` 在空系統上誤啟動或產生錯誤。
