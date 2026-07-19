package main

import (
	"bufio"
	"fmt"
	"os"
)

type B struct {
	d    string
	x, y int64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, r int
	fmt.Fscan(in, &n, &r)
	a := make([]B, n)
	q := make([]string, r)
	for i := range a {
		fmt.Fscan(in, &a[i].d, &a[i].x, &a[i].y)
	}
	for i := range q {
		fmt.Fscan(in, &q[i])
	}
	for i := 1; i < n; i++ {
		if a[i].d <= a[i-1].d {
			fmt.Fprintln(out, "INVALID BLOB_ORDER", i+1)
			return
		}
	}
	for i, x := range a {
		if x.x != x.y {
			fmt.Fprintln(out, "INVALID LENGTH", i+1)
			return
		}
	}
	for i := 1; i < r; i++ {
		if q[i] <= q[i-1] {
			fmt.Fprintln(out, "INVALID REF_ORDER", i+1)
			return
		}
	}
	j := 0
	for i, d := range q {
		for j < n && a[j].d < d {
			j++
		}
		if j == n || a[j].d != d {
			fmt.Fprintln(out, "INVALID MISSING", i+1)
			return
		}
		j++
	}
	j = 0
	var total int64
	for _, d := range q {
		for a[j].d < d {
			j++
		}
		total += a[j].y
		j++
	}
	fmt.Fprintln(out, "VALID", total)
}
