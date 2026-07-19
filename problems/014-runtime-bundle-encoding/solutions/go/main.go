package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type R struct{ t, p, v string }

func ascii(out *bufio.Writer, s string) {
	for i := 0; i < len(s); i++ {
		fmt.Fprintf(out, "%02x", s[i])
	}
}
func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	fmt.Fscan(in, &n)
	a := make([]R, n)
	for i := range a {
		fmt.Fscan(in, &a[i].t, &a[i].p, &a[i].v)
	}
	sort.Slice(a, func(i, j int) bool { return a[i].p < a[j].p })
	fmt.Fprintf(out, "574f424a%08x", n)
	for _, x := range a {
		z := 0
		if x.v != "-" {
			z = len(x.v)
			if x.t == "B" {
				z /= 2
			}
		}
		if x.t == "T" {
			fmt.Fprint(out, "01")
		} else {
			fmt.Fprint(out, "02")
		}
		fmt.Fprintf(out, "%08x", len(x.p))
		ascii(out, x.p)
		fmt.Fprintf(out, "%016x", z)
		if z > 0 {
			if x.t == "T" {
				ascii(out, x.v)
			} else {
				fmt.Fprint(out, x.v)
			}
		}
	}
	fmt.Fprintln(out)
}
