package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func radixSort(values []string) {
	scratch := make([]string, len(values))
	for pos := 29; pos >= 0; pos-- {
		var next [257]int
		for _, value := range values {
			key := 0
			if pos < len(value) {
				key = int(value[pos]) + 1
			}
			next[key]++
		}
		offset := 0
		for key, count := range next {
			next[key] = offset
			offset += count
		}
		for _, value := range values {
			key := 0
			if pos < len(value) {
				key = int(value[pos]) + 1
			}
			scratch[next[key]] = value
			next[key]++
		}
		copy(values, scratch)
	}
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var Q int
	fmt.Fscan(in, &Q)
	for ; Q > 0; Q-- {
		var k string
		var n, m int
		var eps int64
		fmt.Fscan(in, &k, &n, &m)
		if k == "FLOAT" {
			fmt.Fscan(in, &eps)
		}
		a := make([]string, n)
		b := make([]string, m)
		for i := range a {
			fmt.Fscan(in, &a[i])
		}
		for i := range b {
			fmt.Fscan(in, &b[i])
		}
		ok := false
		if k == "EXACT" {
			ok = strings.Join(a, "") == strings.Join(b, "")
		} else if k == "LINES" {
			for len(a) > 0 && a[len(a)-1] == "#" {
				a = a[:len(a)-1]
			}
			for len(b) > 0 && b[len(b)-1] == "#" {
				b = b[:len(b)-1]
			}
			ok = equal(a, b)
		} else if k == "TOKENS" {
			ok = equal(a, b)
		} else if k == "FLOAT" {
			ok = n == m
			for i := 0; i < n && ok; i++ {
				x, _ := strconv.ParseInt(a[i], 10, 64)
				y, _ := strconv.ParseInt(b[i], 10, 64)
				var d uint64
				if x >= y {
					d = uint64(x) - uint64(y)
				} else {
					d = uint64(y) - uint64(x)
				}
				ok = d <= uint64(eps)
			}
		} else {
			radixSort(a)
			radixSort(b)
			if k == "SET" {
				a = dedup(a)
				b = dedup(b)
			}
			ok = equal(a, b)
		}
		if ok {
			fmt.Fprintln(out, "ACCEPT")
		} else {
			fmt.Fprintln(out, "WRONG")
		}
	}
}
func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func dedup(a []string) []string {
	z := a[:0]
	for i, x := range a {
		if i == 0 || x != a[i-1] {
			z = append(z, x)
		}
	}
	return z
}
