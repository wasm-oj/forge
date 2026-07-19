package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, C int
	if _, e := fmt.Fscan(in, &n, &C); e != nil {
		return
	}
	ch := make([][]int, n+1)
	size := make([]int, n+1)
	value := make([]uint64, n+1)
	for i := 1; i <= n; i++ {
		var p int
		fmt.Fscan(in, &p, &size[i], &value[i])
		ch[p] = append(ch[p], i)
	}
	order := []int{}
	after := []int{}
	var dfs func(int)
	dfs = func(u int) {
		pos := len(order)
		order = append(order, u)
		after = append(after, 0)
		for _, v := range ch[u] {
			dfs(v)
		}
		after[pos] = len(order)
	}
	for _, u := range ch[0] {
		dfs(u)
	}
	dp := make([][]uint64, n+1)
	for i := range dp {
		dp[i] = make([]uint64, C+1)
	}
	for i := n - 1; i >= 0; i-- {
		u := order[i]
		for c := 0; c <= C; c++ {
			dp[i][c] = dp[after[i]][c]
			if c >= size[u] {
				q := value[u] + dp[i+1][c-size[u]]
				if q > dp[i][c] {
					dp[i][c] = q
				}
			}
		}
	}
	fmt.Fprintln(out, dp[0][C])
}
