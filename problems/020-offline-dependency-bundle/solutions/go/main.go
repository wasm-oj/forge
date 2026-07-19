package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type R struct {
	d string
	z uint64
}

func find(a []R, d string) int {
	i := sort.Search(len(a), func(i int) bool { return a[i].d >= d })
	if i < len(a) && a[i].d == d {
		return i
	}
	return -1
}
func main() {
	in := bufio.NewReader(os.Stdin)
	var n, m int
	fmt.Fscan(in, &n, &m)
	l := make([]R, n)
	p := make([]R, m)
	var total uint64
	for i := range l {
		var name string
		fmt.Fscan(in, &name, &l[i].d, &l[i].z)
		total += l[i].z
	}
	for i := range p {
		fmt.Fscan(in, &p[i].d, &p[i].z)
	}
	sort.Slice(l, func(i, j int) bool { return l[i].d < l[j].d })
	sort.Slice(p, func(i, j int) bool { return p[i].d < p[j].d })
	req := []R{}
	for i := 0; i < n; {
		j := i + 1
		for j < n && l[j].d == l[i].d {
			if l[j].z != l[i].z {
				fmt.Println("LOCK_CONFLICT", l[i].d)
				return
			}
			j++
		}
		req = append(req, l[i])
		i = j
	}
	for i := 1; i < m; i++ {
		if p[i].d == p[i-1].d {
			fmt.Println("DUPLICATE_PAYLOAD", p[i].d)
			return
		}
	}
	for _, x := range req {
		if find(p, x.d) < 0 {
			fmt.Println("MISSING", x.d)
			return
		}
	}
	for _, x := range p {
		if find(req, x.d) < 0 {
			fmt.Println("EXTRA", x.d)
			return
		}
	}
	var unique uint64
	for _, x := range req {
		if p[find(p, x.d)].z != x.z {
			fmt.Println("SIZE", x.d)
			return
		}
		unique += x.z
	}
	fmt.Println("VALID", len(req), unique, total-unique)
}
