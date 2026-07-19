package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	var n, k int
	if _, err := fmt.Fscan(in, &n, &k); err != nil {
		return
	}
	lastIndex := make(map[string]int, n)
	hits := 0
	for index := 1; index <= n; index++ {
		var fingerprint string
		fmt.Fscan(in, &fingerprint)
		if previous, found := lastIndex[fingerprint]; found && index-previous <= k {
			hits++
		}
		lastIndex[fingerprint] = index
	}
	fmt.Fprintln(out, hits)
}
