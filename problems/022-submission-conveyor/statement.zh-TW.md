# Submission 輸送帶

WASM OJ 的 submission 排程器若只有一個 execution slot，同一時間就最多執行一份 submission，其餘工作依加入順序等待。除了正常完成以外，使用者也可能取消正在執行或仍在排隊的 submission，因此 scheduler 必須在每個事件後維持明確的 active 狀態與等待數量。

所有事件已排成確定的全序。submission 一旦正常完成或被取消，就進入 terminal 狀態，不會再次執行。處理以下事件：

- `A id`：加入從未出現過的 submission。若當下沒有 active submission，它立刻成為 active；否則排到隊尾。
- `C id`：取消該 id。若它正在等待或執行，狀態變成 terminal；否則不做事。若 active 被取消，立即啟動仍在等待者中最早加入的一份。
- `E`：active submission 正常結束並成為 terminal；若沒有 active 則不做事。之後同樣啟動最早等待者。

若 active submission 離開系統，scheduler 必須立即啟動仍在等待者中最早加入的一份。取消等待者不改變其他等待者的相對順序；對尚未加入或已 terminal 的 id 取消則不影響任何狀態。

## 輸入

第一行是 `N`，接著 `N` 行事件。

- `1 ≤ N ≤ 200000`
- `1 ≤ id ≤ 10^9`
- 每個 `A id` 的 id 互不相同；`C` 可以指向尚未加入或已 terminal 的 id

## 輸出

每處理一個事件，輸出 `active waiting`。沒有 active 時輸出 `0`；`waiting` 是仍有效、且不含 active 的等待數量。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
7
A 10
A 20
A 30
C 20
E
C 10
E
```

輸出：

```text
10 0
10 1
10 2
10 1
30 0
30 0
0 0
```

### 範例二

輸入：

```text
6
A 1
C 1
E
A 2
A 3
C 2
```

輸出：

```text
1 0
0 0
0 0
2 0
2 1
3 0
```

### 範例三

輸入：

```text
6
A 5
A 6
C 6
A 7
C 5
E
```

輸出：

```text
5 0
5 1
5 0
5 1
7 0
0 0
```

<!-- END GENERATED SAMPLES -->

## 限制

所有數量、字串格式與整數範圍均列於「輸入」段落；完整限制適用於每一筆正式測資。
