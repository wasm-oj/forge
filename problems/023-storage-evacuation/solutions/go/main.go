package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type I struct {
	z, u int64
	p    int
	a, k string
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	var C, A, R, total int64
	fmt.Fscan(in, &n, &C, &A, &R)
	v := make([]I, n)
	for i := range v {
		fmt.Fscan(in, &v[i].z, &v[i].p, &v[i].u, &v[i].a, &v[i].k)
		total += v[i].z
	}
	need := total - C
	if need < 0 {
		need = 0
	}
	if R-A > need {
		need = R - A
	}
	if need > total {
		fmt.Fprintln(out, "IMPOSSIBLE")
		return
	}
	sort.Slice(v, func(i, j int) bool {
		x, y := v[i], v[j]
		if x.p != y.p {
			return x.p < y.p
		}
		if x.u != y.u {
			return x.u < y.u
		}
		if x.a != y.a {
			return x.a < y.a
		}
		return x.k < y.k
	})
	var freed int64
	k := 0
	for freed < need {
		freed += v[k].z
		k++
	}
	fmt.Fprintln(out, k, freed)
	for _, x := range v[:k] {
		fmt.Fprintln(out, x.a, x.k)
	}
}
