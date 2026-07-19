package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var p, s, n, q int
	if _, e := fmt.Fscan(in, &p, &s, &n, &q); e != nil {
		return
	}
	c := make([]int, p+1)
	lo := make([]uint64, p+1)
	hi := make([]uint64, p+1)
	for i := range lo {
		lo[i] = math.MaxUint64
	}
	for i := 0; i < n; i++ {
		var x, seed int
		var v uint64
		fmt.Fscan(in, &x, &seed, &v)
		c[x]++
		if v < lo[x] {
			lo[x] = v
		}
		if v > hi[x] {
			hi[x] = v
		}
	}
	for ; q > 0; q-- {
		var x int
		var raw uint64
		fmt.Fscan(in, &x, &raw)
		if c[x] != s || lo[x] != hi[x] {
			fmt.Fprintln(out, "INVALID")
		} else {
			var net uint64
			if raw > lo[x] {
				net = raw - lo[x]
			}
			fmt.Fprintln(out, lo[x], net)
		}
	}
}
