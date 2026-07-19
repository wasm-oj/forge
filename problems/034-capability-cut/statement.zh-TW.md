# 切斷危險 Capability

函式呼叫圖是一張 directed graph。若從任一公開 entry function 能沿呼叫邊到達任一 dangerous function，sandbox 就可能觸及 network/thread/process capability。

你可以封鎖函式 `i`，代價為 `cost[i]`；封鎖會移除該函式及所有 incident call edges。Entry 與 dangerous function 也允許封鎖。求讓所有 entry 到 dangerous 的路徑都消失所需的最小總代價。

## 輸入

第一行 `N M S T`。第二行有 `N` 個 cost。第三行有 `S` 個互異 entry IDs；第四行有 `T` 個互異 dangerous IDs。接著 `M` 行 directed edge `u v`，表示 `u` 可直接呼叫 `v`。

集合使用 1-based ID；entry 與 dangerous 集合可以重疊。重疊節點形成長度 0 的危險路徑，除非該節點被封鎖。

## 輸出

輸出 `COST x`。若原本就沒有任何危險路徑，`x=0`。最佳封鎖集合可能不唯一，不輸出集合。

## 限制

- `1 <= N <= 500`，`0 <= M <= 5000`，`1 <= S,T <= N`。
- edge 無 self-loop、無重複；`0 <= cost[i] <= 10^12`，cost 總和不超過 `8*10^18`。
- 所有 flow/cut 值可用 unsigned 64-bit 表示。
- 完整測資排除函式子集合枚舉；必須把 node cost 轉成 cut capacity。

## 範例

<!-- BEGIN GENERATED SAMPLES -->

### 範例一

輸入：

```text
3 2 1 1
5 2 7
1
3
1 2
2 3
```

輸出：

```text
COST 2
```

### 範例二

輸入：

```text
4 4 1 1
10 2 3 10
1
4
1 2
2 4
1 3
3 4
```

輸出：

```text
COST 5
```

### 範例三

輸入：

```text
4 2 1 1
1 1 1 1
1
4
1 2
3 4
```

輸出：

```text
COST 0
```

<!-- END GENERATED SAMPLES -->
