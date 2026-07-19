package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
)

type R struct{ p, l string }

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	var e string
	fmt.Fscan(in, &n, &e)
	in.ReadString('\n')
	a := make([]R, 0, n)
	for ; n > 0; n-- {
		line, _ := in.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		p := strings.Fields(line)[1]
		if p == e || strings.HasPrefix(p, e+"/") {
			continue
		}
		a = append(a, R{p, line})
	}
	sort.Slice(a, func(i, j int) bool { return a[i].p < a[j].p })
	fmt.Fprintln(out, len(a))
	for _, x := range a {
		fmt.Fprintln(out, x.l)
	}
}
