package main

import (
	"bufio"
	"fmt"
	"os"
)

func at(s, x uint64) uint64 {
	z := s + 0x9e3779b97f4a7c15*(x/8+1)
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	z ^= z >> 31
	return (z >> (8 * (x % 8))) & 255
}
func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var a, b, S uint64
	var q int
	fmt.Fscan(in, &a, &b, &S, &q)
	var p uint64
	get := func(x uint64) uint64 {
		if x < S {
			return at(a, x)
		}
		return at(b, x-S)
	}
	for ; q > 0; q-- {
		var k uint64
		fmt.Fscan(in, &k)
		fmt.Fprintln(out, get(p), get(p+k-1))
		p += k
	}
}
