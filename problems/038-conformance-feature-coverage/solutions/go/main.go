package main

import (
	"bufio"
	"fmt"
	"math"
	"math/bits"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var f, n int
	var b uint64
	if _, e := fmt.Fscan(in, &f, &n, &b); e != nil {
		return
	}
	S := 1 << f
	inf := uint64(math.MaxUint64 / 4)
	dp := make([]uint64, S)
	for i := range dp {
		dp[i] = inf
	}
	dp[0] = 0
	for ; n > 0; n-- {
		var cost uint64
		var k int
		fmt.Fscan(in, &cost, &k)
		m := 0
		for ; k > 0; k-- {
			var x int
			fmt.Fscan(in, &x)
			m |= 1 << (x - 1)
		}
		next := append([]uint64(nil), dp...)
		for s, v := range dp {
			if v != inf && v+cost < next[s|m] {
				next[s|m] = v + cost
			}
		}
		dp = next
	}
	ans := 0
	for s, v := range dp {
		if v <= b && bits.OnesCount(uint(s)) > ans {
			ans = bits.OnesCount(uint(s))
		}
	}
	fmt.Fprintln(out, ans)
}
