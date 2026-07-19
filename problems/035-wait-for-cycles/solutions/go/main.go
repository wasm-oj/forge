package main

import (
	"bufio"
	"fmt"
	"os"
)

type E struct{ u, v int }

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, m int
	fmt.Fscan(in, &n, &m)
	g := make([][]int, n)
	rg := make([][]int, n)
	edges := make([]E, 0, m)
	self := make([]bool, n)
	for ; m > 0; m-- {
		var u, v int
		fmt.Fscan(in, &u, &v)
		u--
		v--
		g[u] = append(g[u], v)
		rg[v] = append(rg[v], u)
		edges = append(edges, E{u, v})
		self[u] = self[u] || u == v
	}
	seen := make([]bool, n)
	cur := make([]int, n)
	order := []int{}
	for root := 0; root < n; root++ {
		if seen[root] {
			continue
		}
		seen[root] = true
		st := []int{root}
		for len(st) > 0 {
			u := st[len(st)-1]
			if cur[u] < len(g[u]) {
				v := g[u][cur[u]]
				cur[u]++
				if !seen[v] {
					seen[v] = true
					st = append(st, v)
				}
			} else {
				order = append(order, u)
				st = st[:len(st)-1]
			}
		}
	}
	comp := make([]int, n)
	for i := range comp {
		comp[i] = -1
	}
	cc := 0
	for oi := n - 1; oi >= 0; oi-- {
		root := order[oi]
		if comp[root] >= 0 {
			continue
		}
		comp[root] = cc
		st := []int{root}
		for len(st) > 0 {
			u := st[len(st)-1]
			st = st[:len(st)-1]
			for _, v := range rg[u] {
				if comp[v] < 0 {
					comp[v] = cc
					st = append(st, v)
				}
			}
		}
		cc++
	}
	mem := make([][]int, cc)
	for i, c := range comp {
		mem[c] = append(mem[c], i)
	}
	indeg := make([]bool, cc)
	for _, e := range edges {
		if comp[e.u] != comp[e.v] {
			indeg[comp[e.v]] = true
		}
	}
	wake := 0
	for _, x := range indeg {
		if !x {
			wake++
		}
	}
	cyc := []int{}
	for i := 0; i < n; i++ {
		c := comp[i]
		if mem[c][0] == i && (len(mem[c]) > 1 || self[i]) {
			cyc = append(cyc, c)
		}
	}
	fmt.Fprintln(out, len(cyc), wake)
	for _, c := range cyc {
		fmt.Fprint(out, len(mem[c]))
		for _, v := range mem[c] {
			fmt.Fprint(out, " ", v+1)
		}
		fmt.Fprintln(out)
	}
}
