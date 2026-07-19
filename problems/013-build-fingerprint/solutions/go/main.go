package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type F struct{ p, d string }

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, q int
	fmt.Fscan(in, &n, &q)
	f := make([]F, n)
	for i := range f {
		fmt.Fscan(in, &f[i].p, &f[i].d)
	}
	for ; q > 0; q-- {
		var a, b, c, d string
		var k int
		fmt.Fscan(in, &a, &b, &c, &d, &k)
		v := make([]int, k)
		for i := range v {
			fmt.Fscan(in, &v[i])
			v[i]--
		}
		sort.Slice(v, func(i, j int) bool { return f[v[i]].p < f[v[j]].p })
		fmt.Fprint(out, a, " ", b, " ", c, " ", d, " ", k)
		for _, x := range v {
			fmt.Fprint(out, " ", f[x].p, " ", f[x].d)
		}
		fmt.Fprintln(out)
	}
}
