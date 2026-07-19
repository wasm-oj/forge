package main

import (
	"bufio"
	"fmt"
	"os"
)

type E struct {
	to, rev int
	cap     uint64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	var n, m, sn, tn int
	fmt.Fscan(in, &n, &m, &sn, &tn)
	c := make([]uint64, n)
	var sum uint64
	for i := range c {
		fmt.Fscan(in, &c[i])
		sum += c[i]
	}
	en := make([]int, sn)
	dn := make([]int, tn)
	for i := range en {
		fmt.Fscan(in, &en[i])
		en[i]--
	}
	for i := range dn {
		fmt.Fscan(in, &dn[i])
		dn[i]--
	}
	V, S, T := 2*n+2, 2*n, 2*n+1
	g := make([][]E, V)
	add := func(u, v int, z uint64) {
		g[u] = append(g[u], E{v, len(g[v]), z})
		g[v] = append(g[v], E{u, len(g[u]) - 1, 0})
	}
	inf := sum + 1
	for i, z := range c {
		add(2*i, 2*i+1, z)
	}
	for ; m > 0; m-- {
		var u, v int
		fmt.Fscan(in, &u, &v)
		add(2*(u-1)+1, 2*(v-1), inf)
	}
	for _, u := range en {
		add(S, 2*u, inf)
	}
	for _, u := range dn {
		add(2*u+1, T, inf)
	}
	level := make([]int, V)
	it := make([]int, V)
	var dfs func(int, uint64) uint64
	dfs = func(u int, f uint64) uint64 {
		if u == T {
			return f
		}
		for it[u] < len(g[u]) {
			i := it[u]
			e := g[u][i]
			if e.cap > 0 && level[e.to] == level[u]+1 {
				z := dfs(e.to, min(f, e.cap))
				if z > 0 {
					g[u][i].cap -= z
					g[e.to][e.rev].cap += z
					return z
				}
			}
			it[u]++
		}
		return 0
	}
	var flow uint64
	for {
		for i := range level {
			level[i] = -1
		}
		level[S] = 0
		q := []int{S}
		for h := 0; h < len(q); h++ {
			u := q[h]
			for _, e := range g[u] {
				if e.cap > 0 && level[e.to] < 0 {
					level[e.to] = level[u] + 1
					q = append(q, e.to)
				}
			}
		}
		if level[T] < 0 {
			break
		}
		for i := range it {
			it[i] = 0
		}
		for {
			z := dfs(S, inf)
			if z == 0 {
				break
			}
			flow += z
		}
	}
	fmt.Println("COST", flow)
}
