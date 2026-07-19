package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
)

type F struct{ p, v string }
type C struct {
	id string
	t  uint64
	f  []F
}
type H struct {
	name string
	c    []C
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	fmt.Fscan(in, &n)
	h := make([]H, n)
	for z := range h {
		var k int
		fmt.Fscan(in, &h[z].name, &k)
		h[z].c = make([]C, k)
		for i := range h[z].c {
			var p int
			fmt.Fscan(in, &h[z].c[i].id, &h[z].c[i].t, &p)
			h[z].c[i].f = make([]F, p)
			for j := range h[z].c[i].f {
				fmt.Fscan(in, &h[z].c[i].f[j].p, &h[z].c[i].f[j].v)
			}
		}
	}
	all := true
	for z := 1; z < n; z++ {
		order := len(h[z].c) != len(h[0].c)
		for i := 0; !order && i < len(h[0].c); i++ {
			order = h[z].c[i].id != h[0].c[i].id
		}
		if order {
			fmt.Fprintln(out, "HOST", h[z].name, "CASE_ORDER")
			all = false
			continue
		}
		d := []string{}
		for i, a := range h[0].c {
			b := h[z].c[i]
			x, y := 0, 0
			for x < len(a.f) || y < len(b.f) {
				if y == len(b.f) || (x < len(a.f) && a.f[x].p < b.f[y].p) {
					d = append(d, a.id+"."+a.f[x].p)
					x++
				} else if x == len(a.f) || a.f[x].p > b.f[y].p {
					d = append(d, a.id+"."+b.f[y].p)
					y++
				} else {
					if a.f[x].v != b.f[y].v {
						d = append(d, a.id+"."+a.f[x].p)
					}
					x++
					y++
				}
			}
		}
		if len(d) == 0 {
			fmt.Fprintln(out, "HOST", h[z].name, "OK")
		} else {
			all = false
			fmt.Fprintln(out, "HOST", h[z].name, len(d), strings.Join(d, " "))
		}
	}
	if all {
		for i, c := range h[0].c {
			v := make([]uint64, n)
			for z := range h {
				v[z] = h[z].c[i].t
			}
			sort.Slice(v, func(a, b int) bool { return v[a] < v[b] })
			fmt.Fprintln(out, "MEDIAN", c.id, v[(n-1)/2])
		}
	}
}
