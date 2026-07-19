package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()

	var n, q int
	fmt.Fscan(in, &n, &q)
	costs := make([]uint64, n)
	for index := range costs {
		fmt.Fscan(in, &costs[index])
	}

	completed := 0
	var spent uint64
	for query := 0; query < q; query++ {
		var budget uint64
		fmt.Fscan(in, &budget)
		for completed < n && costs[completed] <= budget-spent {
			spent += costs[completed]
			completed++
		}
		fmt.Fprintln(out, completed)
	}
}
