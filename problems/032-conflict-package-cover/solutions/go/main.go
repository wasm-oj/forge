package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var L, R, M int
	fmt.Fscan(in, &L, &R, &M)
	g := make([][]int, L)
	for ; M > 0; M-- {
		var u, v int
		fmt.Fscan(in, &u, &v)
		g[u-1] = append(g[u-1], v-1)
	}
	pu := make([]int, L)
	pv := make([]int, R)
	dist := make([]int, L)
	for i := range pu {
		pu[i] = -1
	}
	for i := range pv {
		pv[i] = -1
	}
	matching := 0
	for {
		q := []int{}
		for u := 0; u < L; u++ {
			if pu[u] < 0 {
				dist[u] = 0
				q = append(q, u)
			} else {
				dist[u] = -1
			}
		}
		terminal := -1
		for h := 0; h < len(q); h++ {
			u := q[h]
			if terminal >= 0 && dist[u] >= terminal {
				continue
			}
			for _, v := range g[u] {
				w := pv[v]
				if w < 0 {
					terminal = dist[u]
				} else if dist[w] < 0 {
					dist[w] = dist[u] + 1
					q = append(q, w)
				}
			}
		}
		if terminal < 0 {
			break
		}
		cur := make([]int, L)
		for root := 0; root < L; root++ {
			if pu[root] >= 0 {
				continue
			}
			su, sv := []int{root}, []int{}
			ok := false
			for len(su) > 0 && !ok {
				u := su[len(su)-1]
				down := false
				for cur[u] < len(g[u]) {
					v := g[u][cur[u]]
					cur[u]++
					w := pv[v]
					if w < 0 && dist[u] == terminal {
						pu[u] = v
						pv[v] = u
						for i := len(sv) - 1; i >= 0; i-- {
							pu[su[i]] = sv[i]
							pv[sv[i]] = su[i]
						}
						ok = true
						break
					}
					if w >= 0 && dist[u] < terminal && dist[w] == dist[u]+1 {
						sv = append(sv, v)
						su = append(su, w)
						down = true
						break
					}
				}
				if !ok && !down {
					dist[u] = -1
					su = su[:len(su)-1]
					if len(sv) > 0 {
						sv = sv[:len(sv)-1]
					}
				}
			}
			if ok {
				matching++
			}
		}
	}
	fmt.Println(matching)
}
