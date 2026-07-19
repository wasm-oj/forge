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
	var n, d, q int
	var cap uint64
	fmt.Fscan(in, &n, &d, &q, &cap)
	sz := make([]uint64, d)
	for i := range sz {
		fmt.Fscan(in, &sz[i])
	}
	lp := make([]int, d)
	ln := make([]int, d)
	rh := make([]int, d)
	node := make([]int, n)
	rp := make([]int, n)
	rn := make([]int, n)
	for _, a := range [][]int{lp, ln, rh, node, rp, rn} {
		for i := range a {
			a[i] = -1
		}
	}
	cached := make([]bool, d)
	head, tail := -1, -1
	var used uint64
	remove := func(x int) {
		if lp[x] >= 0 {
			ln[lp[x]] = ln[x]
		} else {
			head = ln[x]
		}
		if ln[x] >= 0 {
			lp[ln[x]] = lp[x]
		} else {
			tail = lp[x]
		}
		lp[x], ln[x] = -1, -1
	}
	touch := func(x int) {
		if cached[x] {
			remove(x)
		}
		cached[x] = true
		lp[x] = tail
		if tail >= 0 {
			ln[tail] = x
		} else {
			head = x
		}
		tail = x
	}
	detach := func(u int) {
		x := node[u]
		if x < 0 {
			return
		}
		if rp[u] >= 0 {
			rn[rp[u]] = rn[u]
		} else {
			rh[x] = rn[u]
		}
		if rn[u] >= 0 {
			rp[rn[u]] = rp[u]
		}
		node[u], rp[u], rn[u] = -1, -1, -1
	}
	attach := func(u, x int) {
		node[u] = x
		rn[u] = rh[x]
		if rh[x] >= 0 {
			rp[rh[x]] = u
		}
		rh[x] = u
		rp[u] = -1
	}
	for ; q > 0; q-- {
		var op string
		var u int
		fmt.Fscan(in, &op, &u)
		u--
		if op == "G" {
			if node[u] < 0 {
				fmt.Fprintln(out, "MISS")
			} else {
				x := node[u]
				touch(x)
				fmt.Fprintln(out, "HIT", x+1)
			}
			continue
		}
		var x int
		fmt.Fscan(in, &x)
		x--
		detach(u)
		if sz[x] > cap {
			continue
		}
		if !cached[x] {
			used += sz[x]
		}
		touch(x)
		attach(u, x)
		for used > cap {
			dead := head
			remove(dead)
			cached[dead] = false
			used -= sz[dead]
			for v := rh[dead]; v >= 0; {
				z := rn[v]
				node[v], rp[v], rn[v] = -1, -1, -1
				v = z
			}
			rh[dead] = -1
		}
	}
}
