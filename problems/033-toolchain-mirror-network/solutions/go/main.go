package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type E struct {
	u, v int
	w    uint64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	var n, m int
	fmt.Fscan(in, &n, &m)
	e := make([]E, m)
	for i := range e {
		fmt.Fscan(in, &e[i].u, &e[i].v, &e[i].w)
		e[i].u--
		e[i].v--
	}
	sort.Slice(e, func(i, j int) bool { return e[i].w < e[j].w })
	p := make([]int, n)
	sz := make([]int, n)
	for i := range p {
		p[i] = i
		sz[i] = 1
	}
	find := func(x int) int { return 0 }
	find = func(x int) int {
		r := x
		for p[r] != r {
			r = p[r]
		}
		for p[x] != x {
			y := p[x]
			p[x] = r
			x = y
		}
		return r
	}
	var cost uint64
	take := 0
	for _, x := range e {
		u, v := find(x.u), find(x.v)
		if u == v {
			continue
		}
		if sz[u] < sz[v] {
			u, v = v, u
		}
		p[v] = u
		sz[u] += sz[v]
		cost += x.w
		take++
		if take == n-1 {
			break
		}
	}
	if take == n-1 {
		fmt.Println("COST", cost)
	} else {
		fmt.Println("IMPOSSIBLE")
	}
}
