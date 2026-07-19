# 解題說明

## 直覺解

從每個 changed node 各自做一次 DFS，最後聯集結果。若每次都清空 visited，最壞時間 `O(C(N+M))`，大量共同下游會被反覆走訪。

## 最佳解

建立題目給定方向的 adjacency list。把所有 changed nodes 一起標記並放進同一個 queue；每次取出 `u`，只把尚未 dirty 的 `v` 標記並入列。最後依 ID 掃描 boolean array 即可得到排序輸出。這是 multi-source BFS；DFS 使用共享 visited 也有相同複雜度。

## 正確性證明

所有 changed nodes 初始化為 dirty，符合零條邊的可達性。每次從 dirty `u` 沿邊到 `v`，代表 `v` 直接依賴 dirty 產物，所以標記 `v` 正確。反之，任一應 dirty 節點 `x` 都存在某 changed node 到 `x` 的路徑；沿路徑長度歸納，前一節點出列時必會標記下一節點，故 `x` 最終必被標記。因此標記集合恰等於所有下游可達點，遞增掃描只改變輸出順序，不改變集合。

## 複雜度

每個節點最多入列一次、每條邊最多掃描一次，時間 `O(N+M)`，空間 `O(N+M)`。

## 常見錯誤

- 把邊反轉，找到依賴項而非使用者。
- 忘記 changed node 自己也是 dirty。
- 每個來源重設 visited，失去多源搜尋的效益。
- `C=0` 時少印第二個換行。
