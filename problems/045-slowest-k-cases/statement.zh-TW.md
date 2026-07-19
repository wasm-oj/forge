# 持續追蹤第 K 慢測試

一個 submission 的 test case 依序完成。第 `i` 個 case 完成時，系統收到它的 instruction cost `cost_i`，而 case index 就是 `i`。

在每個 `i >= K` 的時間點，請只考慮前 `i` 個 case，輸出其中排名第 `K` 慢的 case。成本越高排名越前；成本相同時，index 越小排名越前。每個前綴的答案在後續 case 完成前就已確定，之後收到的 cost 不屬於先前的前綴。

## 輸入

第一行包含 `N K`。第二行包含依完成順序排列的 `N` 個 case cost。

## 輸出

對每個 `i = K, K+1, ..., N` 輸出一行，包含前 `i` 個 case 中排名第 `K` 慢者的 `index cost`。

## 限制

- `1 <= N <= 200000`
- `1 <= K <= min(N, 5000)`
- `0 <= cost_i <= 10^12`

完整限制要求處理所有前綴，排除為每個前綴重新排序全部既有 case 的作法。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
5 3
10 30 30 5 20
```

輸出：

```text
1 10
1 10
5 20
```

### 範例二

輸入：

```text
4 4
7 7 7 7
```

輸出：

```text
4 7
```

### 範例三

輸入：

```text
6 1
1 9 3 9 2 8
```

輸出：

```text
1 1
2 9
2 9
2 9
2 9
2 9
```

<!-- END GENERATED SAMPLES -->
