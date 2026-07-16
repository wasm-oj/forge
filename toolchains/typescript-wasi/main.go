package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/execute"
	"github.com/microsoft/typescript-go/internal/execute/tsc"
	"github.com/microsoft/typescript-go/internal/vfs"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

type compileRequest struct {
	Files      map[string]string `json:"files"`
	JavaScript bool              `json:"javascript"`
	Sources    []string          `json:"sources"`
	Outputs    []string          `json:"outputs"`
}

type compileResponse struct {
	Status      int               `json:"status"`
	Diagnostics string            `json:"diagnostics"`
	Files       map[string]string `json:"files"`
}

type memorySystem struct {
	fs     vfs.FS
	output strings.Builder
	start  time.Time
}

var _ tsc.System = (*memorySystem)(nil)

func (s *memorySystem) DefaultLibraryPath() string              { return bundled.LibPath() }
func (s *memorySystem) FS() vfs.FS                              { return s.fs }
func (s *memorySystem) GetCurrentDirectory() string             { return "/project" }
func (s *memorySystem) GetEnvironmentVariable(string) string    { return "" }
func (s *memorySystem) GetWidthOfTerminal() int                 { return 120 }
func (s *memorySystem) Now() time.Time                          { return time.Now() }
func (s *memorySystem) SinceStart() time.Duration               { return time.Since(s.start) }
func (s *memorySystem) WriteOutputIsTTY() bool                  { return false }
func (s *memorySystem) Writer() io.Writer                       { return &s.output }

func main() {
	var request compileRequest
	if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
		writeResponse(compileResponse{Status: int(tsc.ExitStatusInvalidProject_OutputsSkipped), Diagnostics: err.Error()})
		return
	}

	sys := &memorySystem{
		fs:    bundled.WrapFS(vfstest.FromMap(request.Files, true)),
		start: time.Now(),
	}
	args := []string{
		"--pretty", "false",
		"--target", "es2020",
		"--module", "commonjs",
		"--strict",
		"--outDir", "/project/build",
		"--rootDir", "/project",
	}
	if request.JavaScript {
		args = append(args, "--allowJs", "--checkJs")
	}
	args = append(args, request.Sources...)
	result := execute.CommandLine(context.Background(), sys, args, nil)

	files := make(map[string]string, len(request.Outputs))
	for _, path := range request.Outputs {
		if contents, ok := sys.fs.ReadFile(path); ok {
			files[path] = contents
		}
	}
	writeResponse(compileResponse{
		Status:      int(result.Status),
		Diagnostics: sys.output.String(),
		Files:       files,
	})
}

func writeResponse(response compileResponse) {
	if response.Files == nil {
		response.Files = map[string]string{}
	}
	_ = json.NewEncoder(os.Stdout).Encode(response)
}
