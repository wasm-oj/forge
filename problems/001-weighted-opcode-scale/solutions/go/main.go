package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var k, wn, r, q int
	if _, e := fmt.Fscan(in, &k, &wn, &r, &q); e != nil {
		return
	}
	w := make([]uint64, k+1)
	for i := range w {
		w[i] = 1000
	}
	for i := 0; i < wn; i++ {
		var id int
		var x uint64
		fmt.Fscan(in, &id, &x)
		w[id] = x
	}
	pc := make([]uint64, r+1)
	pn := make([]uint64, r+1)
	rw := make([]uint64, r)
	rc := make([]uint64, r)
	for i := 0; i < r; i++ {
		var id int
		fmt.Fscan(in, &id, &rc[i])
		rw[i] = w[id]
		pc[i+1] = pc[i] + rw[i]*rc[i]
		pn[i+1] = pn[i] + rc[i]
	}
	for ; q > 0; q-- {
		var b uint64
		fmt.Fscan(in, &b)
		i := sort.Search(len(pc), func(j int) bool { return pc[j] > b }) - 1
		done, cost := pn[i], pc[i]
		if i < r {
			take := (b - cost) / rw[i]
			if take > rc[i] {
				take = rc[i]
			}
			done += take
			cost += take * rw[i]
		}
		fmt.Fprintln(out, done, cost)
	}
}
