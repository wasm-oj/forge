package main

import (
	"bufio"
	"fmt"
	"math/bits"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, h, m, q int
	fmt.Fscan(in, &n, &h, &m, &q)
	w := (n + 63) / 64
	b := make([]uint64, h*w)
	for ; m > 0; m-- {
		var s, x int
		fmt.Fscan(in, &s, &x)
		s--
		x--
		b[x*w+s/64] |= uint64(1) << uint(s%64)
	}
	for ; q > 0; q-- {
		v := make([]uint64, w)
		var k int
		fmt.Fscan(in, &k)
		for ; k > 0; k-- {
			var x int
			fmt.Fscan(in, &x)
			x--
			for j := 0; j < w; j++ {
				v[j] |= b[x*w+j]
			}
		}
		ans := 0
		for _, x := range v {
			ans += bits.OnesCount64(x)
		}
		fmt.Fprintln(out, ans)
	}
}
