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

	var n int
	if _, err := fmt.Fscan(in, &n); err != nil {
		return
	}
	firstIndex := make(map[string]int, n)
	for index := 1; index <= n; index++ {
		var fingerprint string
		fmt.Fscan(in, &fingerprint)
		if earliest, found := firstIndex[fingerprint]; found {
			fmt.Fprintln(out, index, earliest)
			return
		}
		firstIndex[fingerprint] = index
	}
	fmt.Fprintln(out, "NONE")
}
