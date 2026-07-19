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
	var n, B, I int
	if _, e := fmt.Fscan(in, &n, &B, &I); e != nil {
		return
	}
	dp := make([][]uint64, I+1)
	for i := range dp {
		dp[i] = make([]uint64, B+1)
	}
	for ; n > 0; n-- {
		var b, e int
		var v uint64
		fmt.Fscan(in, &b, &e, &v)
		for x := I; x >= e; x-- {
			for y := B; y >= b; y-- {
				if q := dp[x-e][y-b] + v; q > dp[x][y] {
					dp[x][y] = q
				}
			}
		}
	}
	fmt.Fprintln(out, dp[I][B])
}
