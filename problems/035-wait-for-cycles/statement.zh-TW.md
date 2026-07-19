# 互動程式的等待環

有 `N` 個尚未釋放的 process。Directed release edge `u v` 表示：`u` 一旦被釋放，就能送出事件釋放 `v`；釋放會沿 edge 反覆傳播。你也能對任意 process 注入 external wake event。

兩個 process 若彼此可達，就在同一個互相等待群。含 directed cycle 的 SCC 稱為**等待環群組**：size 大於 1 的 SCC 一定是；size=1 時只有存在 self-loop 才是。

請列出全部等待環群組，並計算讓所有 process 最終都被釋放所需的最少 external wake 數。一次 wake 可選任一 process；同一 SCC 內會互相傳播，且之後沿 condensation edges 傳到下游。

## 輸入

第一行 `N M`，接著 `M` 行 directed edge `u v`。ID 為 1-based。

## 輸出

第一行 `G W`：等待環群組數與最少 external wake 數。接著 `G` 行各為：

```text
k id_1 ... id_k
```

群內 ID 嚴格遞增；群組依各自最小 ID 嚴格遞增。`G=0` 時只有第一行。孤立 process 自成非循環 SCC，並且是 condensation source，故仍需要一次 wake。

## 限制

- `1 <= N <= 200000`，`0 <= M <= 400000`。
- edge 不重複；self-loop 允許。
- 完整測資含長鏈，遞迴 DFS 可能 stack overflow；reference solutions 使用顯式 stack。
- 逐對檢查 mutual reachability 無法通過。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 4
1 2
2 1
2 3
4 4
```

輸出：

```text
2 3
2 1 2
1 4
```

### 範例二

輸入：

```text
3 2
1 2
2 3
```

輸出：

```text
0 1
```

### 範例三

輸入：

```text
3 3
1 2
2 3
3 1
```

輸出：

```text
1 1
3 1 2 3
```

<!-- END GENERATED SAMPLES -->
