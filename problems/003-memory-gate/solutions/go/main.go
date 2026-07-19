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
	var n, q int
	var c uint64
	if _, e := fmt.Fscan(in, &n, &q, &c); e != nil {
		return
	}
	pi := make([]uint64, n+1)
	pm := make([]uint64, n+1)
	bad := make([]bool, n+2)
	nxt := make([]int, n+2)
	for i := 1; i <= n; i++ {
		var k int
		var x uint64
		var m int64
		fmt.Fscan(in, &k, &x, &m)
		bad[i] = k == 64 || x > c || (m >= 0 && uint64(m) < x)
		pi[i] = pi[i-1]
		pm[i] = pm[i-1]
		if !bad[i] {
			pi[i] += x
			if m < 0 {
				pm[i] += c
			} else if uint64(m) < c {
				pm[i] += uint64(m)
			} else {
				pm[i] += c
			}
		}
	}
	nxt[n+1] = n + 1
	for i := n; i >= 1; i-- {
		if bad[i] {
			nxt[i] = i
		} else {
			nxt[i] = nxt[i+1]
		}
	}
	for ; q > 0; q-- {
		var l, r int
		fmt.Fscan(in, &l, &r)
		if nxt[l] <= r {
			fmt.Fprintln(out, "REJECT", nxt[l])
		} else {
			fmt.Fprintln(out, "ACCEPT", (pi[r]-pi[l-1])*65536, (pm[r]-pm[l-1])*65536)
		}
	}
}
