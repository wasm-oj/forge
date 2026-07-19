package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	var n, m, c int
	fmt.Fscan(in, &n, &m, &c)
	g := make([][]int, n)
	for ; m > 0; m-- {
		var u, v int
		fmt.Fscan(in, &u, &v)
		g[u-1] = append(g[u-1], v-1)
	}
	d := make([]bool, n)
	q := make([]int, 0, n)
	for ; c > 0; c-- {
		var x int
		fmt.Fscan(in, &x)
		x--
		if !d[x] {
			d[x] = true
			q = append(q, x)
		}
	}
	for p := 0; p < len(q); p++ {
		for _, v := range g[q[p]] {
			if !d[v] {
				d[v] = true
				q = append(q, v)
			}
		}
	}
	ans := []string{}
	for i, x := range d {
		if x {
			ans = append(ans, strconv.Itoa(i+1))
		}
	}
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	fmt.Fprintln(out, len(ans))
	fmt.Fprintln(out, strings.Join(ans, " "))
}
