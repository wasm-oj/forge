package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

func pathLess(a, b []uint32) bool {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	for i := 0; i < limit; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	var mountedCount, outputCount int
	var byteQuota, inodeQuota uint64
	if _, err := fmt.Fscan(in, &mountedCount, &outputCount, &byteQuota, &inodeQuota); err != nil {
		return
	}

	pathCount := mountedCount + outputCount
	paths := make([][]uint32, pathCount)
	var baselineBytes uint64
	for i := 0; i < pathCount; i++ {
		var length int
		fmt.Fscan(in, &length)
		paths[i] = make([]uint32, length)
		for j := range paths[i] {
			fmt.Fscan(in, &paths[i][j])
		}
		if i < mountedCount {
			var size uint64
			fmt.Fscan(in, &size)
			baselineBytes += size
		}
	}

	sort.Slice(paths, func(i, j int) bool { return pathLess(paths[i], paths[j]) })
	directoryCount := uint64(1)
	for i, path := range paths {
		parentLength := len(path) - 1
		alreadyPresent := 0
		if i > 0 {
			limit := len(paths[i-1])
			if len(path) < limit {
				limit = len(path)
			}
			for alreadyPresent < limit && paths[i-1][alreadyPresent] == path[alreadyPresent] {
				alreadyPresent++
			}
			if alreadyPresent > parentLength {
				alreadyPresent = parentLength
			}
		}
		directoryCount += uint64(parentLength - alreadyPresent)
	}

	baselineInodes := directoryCount + uint64(pathCount)
	if baselineBytes <= byteQuota && baselineInodes <= inodeQuota {
		fmt.Fprintln(out, "ACCEPT", baselineBytes, baselineInodes,
			byteQuota-baselineBytes, inodeQuota-baselineInodes)
	} else {
		var missingBytes, missingInodes uint64
		if baselineBytes > byteQuota {
			missingBytes = baselineBytes - byteQuota
		}
		if baselineInodes > inodeQuota {
			missingInodes = baselineInodes - inodeQuota
		}
		fmt.Fprintln(out, "REJECT", baselineBytes, baselineInodes, missingBytes, missingInodes)
	}
}
