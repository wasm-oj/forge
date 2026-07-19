package main

import (
	"bufio"
	"fmt"
	"os"
)

type option struct {
	w int
	v uint64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var g, C int
	if _, e := fmt.Fscan(in, &g, &C); e != nil {
		return
	}
	dp := make([]uint64, C+1)
	for ; g > 0; g-- {
		var k int
		fmt.Fscan(in, &k)
		a := make([]option, k)
		for i := range a {
			fmt.Fscan(in, &a[i].w, &a[i].v)
		}
		next := append([]uint64(nil), dp...)
		for _, q := range a {
			for c := q.w; c <= C; c++ {
				if v := dp[c-q.w] + q.v; v > next[c] {
					next[c] = v
				}
			}
		}
		dp = next
	}
	fmt.Fprintln(out, dp[C])
}
