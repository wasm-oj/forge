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
	var n, c int
	if _, e := fmt.Fscan(in, &n, &c); e != nil {
		return
	}
	dp := make([]uint64, c+1)
	for ; n > 0; n-- {
		var w int
		var v uint64
		fmt.Fscan(in, &w, &v)
		for x := c; x >= w; x-- {
			if q := dp[x-w] + v; q > dp[x] {
				dp[x] = q
			}
		}
	}
	fmt.Fprintln(out, dp[c])
}
