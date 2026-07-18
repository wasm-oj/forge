import type { ConformanceCase } from "./matrix.ts";

export const DEFAULT_CONFORMANCE_CASES: readonly ConformanceCase[] = deepFreeze([
  {
    id: "c-wasip1",
    label: "C / wasip1",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: { "src/main.c": "#include <stdio.h>\nint main(void){ long long a,b; if(scanf(\"%lld%lld\",&a,&b)!=2)return 2; printf(\"%lld\\n\",a+b); }\n" },
    },
    run: { stdin: "7 35\n" },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "c-wasip1-filesystem-metadata",
    label: "C / wasip1 / filesystem metadata",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "#include <stdint.h>",
          "#include <stdio.h>",
          "#include <string.h>",
          "__attribute__((import_module(\"wasi_snapshot_preview1\"), import_name(\"path_filestat_get\")))",
          "extern int wasi_path_filestat_get(int, int, const char *, unsigned, void *);",
          "int main(void){",
          "  FILE *file=fopen(\"/forge-meta\",\"wb\"); if(!file)return 2;",
          "  if(fputs(\"x\",file)<0 || fclose(file))return 3;",
          "  unsigned char stat[64]={0};",
          "  if(wasi_path_filestat_get(3,0,\"forge-meta\",10,stat))return 4;",
          "  uint64_t atime,mtime,ctime;",
          "  memcpy(&atime,stat+40,8); memcpy(&mtime,stat+48,8); memcpy(&ctime,stat+56,8);",
          "  printf(\"%llu %llu %llu\\n\",(unsigned long long)atime,(unsigned long long)mtime,(unsigned long long)ctime);",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    expect: {
      code: 0,
      stdout: "946684800000000000 946684800000000000 946684800000000000\n",
      stderr: "",
      termination: "exited",
    },
  },
  {
    id: "c-wasip1-file-io",
    label: "C / wasip1 / multi-file IO",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "#include <stdio.h>",
          "int main(void){",
          "  FILE *left=fopen(\"/input/left.txt\",\"r\");",
          "  FILE *right=fopen(\"/input/right.txt\",\"r\");",
          "  if(!left||!right)return 2;",
          "  long long a,b; if(fscanf(left,\"%lld\",&a)!=1||fscanf(right,\"%lld\",&b)!=1)return 3;",
          "  fclose(left); fclose(right);",
          "  FILE *output=fopen(\"/output/answer.txt\",\"w\"); if(!output)return 4;",
          "  if(fprintf(output,\"%lld\\n\",a+b)<0||fclose(output))return 5;",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    run: {
      files: {
        "/input/left.txt": "19\n",
        "/input/right.txt": "23\n",
      },
      outputPaths: ["/output/answer.txt"],
    },
    expect: {
      code: 0,
      stdout: "",
      stderr: "",
      files: { "/output/answer.txt": "42\n" },
      termination: "exited",
    },
  },
  {
    id: "c-wasip1-filesystem-limit",
    label: "C / wasip1 / filesystem write limit",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "#include <stdio.h>",
          "int main(void){",
          "  const unsigned char bytes[8]={1,2,3,4,5,6,7,8};",
          "  FILE *file=fopen(\"/output/exhausted.bin\",\"wb\"); if(!file)return 2;",
          "  (void)fwrite(bytes,1,sizeof(bytes),file);",
          "  (void)fclose(file);",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    run: {
      outputPaths: ["/output/exhausted.bin"],
      resources: {
        filesystemWriteLimitBytes: 4,
        filesystemEntryLimit: 1,
      },
    },
    expect: {
      code: 137,
      stdout: "",
      stderr: "",
      files: { "/output/exhausted.bin": "" },
      termination: "filesystem-limit",
    },
  },
  {
    id: "c-wasix",
    label: "C / WASIX",
    input: {
      language: "c",
      target: "wasix",
      entry: "src/main.c",
      files: { "src/main.c": "#include <stdio.h>\nint main(void){ puts(\"c-wasix\"); }\n" },
    },
    expect: { code: 0, stdout: "c-wasix\n", stderr: "", termination: "exited" },
  },
  {
    id: "c-wasix-denied-thread-spawn",
    label: "C / WASIX / denied thread_spawn",
    input: {
      language: "c",
      target: "wasix",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "__attribute__((import_module(\"wasix_32v1\"), import_name(\"thread_spawn\")))",
          "extern int thread_spawn(int start_ptr, int user_data);",
          "int main(void){ return thread_spawn(0, 0); }",
          "",
        ].join("\n"),
      },
    },
    expect: {
      code: 1,
      stdout: "",
      stderr: "",
      termination: "trap",
      trapMessageIncludes: "Forge denied nondeterministic capability wasix_32v1.thread_spawn",
    },
  },
  {
    id: "cpp-wasip1",
    label: "C++ / wasip1",
    input: {
      language: "cpp",
      target: "wasip1",
      entry: "src/main.cpp",
      files: { "src/main.cpp": "extern \"C\" int puts(const char*);\ntemplate<unsigned N> constexpr int sum(const int (&v)[N]){ int s=0; for(unsigned i=0;i<N;++i)s+=v[i]; return s; }\nconstexpr int values[]{10,20,12};\nstatic_assert(sum(values)==42);\nint main(){ return puts(\"42\") < 0; }\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "cpp-wasix",
    label: "C++ / WASIX",
    input: {
      language: "cpp",
      target: "wasix",
      entry: "src/main.cpp",
      files: { "src/main.cpp": "extern \"C\" int puts(const char*);\ntemplate<unsigned N> constexpr int sum(const int (&v)[N]){ int s=0; for(unsigned i=0;i<N;++i)s+=v[i]; return s; }\nconstexpr int values[]{10,20,12};\nstatic_assert(sum(values)==42);\nint main(){ return puts(\"42\") < 0; }\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "rust-wasip1",
    label: "Rust / wasip1",
    input: {
      language: "rust",
      target: "wasip1",
      entry: "src/main.rs",
      files: { "src/main.rs": "fn main(){ let values=vec![10,20,12]; println!(\"{}\", values.iter().sum::<i32>()); }\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "python-wasip1",
    label: "Python / wasip1",
    input: {
      language: "python",
      target: "wasip1",
      entry: "src/main.py",
      files: { "src/main.py": "values = [10, 20, 12]\nprint(sum(values))\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "javascript-wasip1",
    label: "JavaScript / wasip1",
    input: {
      language: "javascript",
      target: "wasip1",
      entry: "src/main.js",
      files: { "src/main.js": "import * as std from 'std';\nstd.out.puts(String([10,20,12].reduce((a,b)=>a+b,0))+'\\n');\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "typescript-wasip1",
    label: "TypeScript / wasip1",
    input: {
      language: "typescript",
      target: "wasip1",
      entry: "src/main.ts",
      files: { "src/main.ts": "import * as std from 'std';\nconst values: number[]=[10,20,12];\nstd.out.puts(String(values.reduce((a,b)=>a+b,0))+'\\n');\n" },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "go-wasip1",
    label: "Go / wasip1",
    input: {
      language: "go",
      target: "wasip1",
      entry: "src/main.go",
      files: {
        "src/main.go": "package main\nimport \"fmt\"\nfunc main(){ values:=[]int{10,20,12}; total:=0; for _,v:=range values { total+=v }; fmt.Println(total) }\n",
      },
    },
    expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
  },
  {
    id: "c-wasip1-virtual-clock",
    label: "C / wasip1 / virtual clock",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "#include <stdint.h>",
          "#include <stdio.h>",
          "#include <string.h>",
          "__attribute__((import_module(\"wasi_snapshot_preview1\"), import_name(\"clock_time_get\")))",
          "extern unsigned wasi_clock_time_get(unsigned, uint64_t, uint64_t *);",
          "__attribute__((import_module(\"wasi_snapshot_preview1\"), import_name(\"poll_oneoff\")))",
          "extern unsigned wasi_poll_oneoff(const void *, void *, unsigned, unsigned *);",
          "static void put32(unsigned char *p,uint32_t v){ memcpy(p,&v,4); }",
          "static void put64(unsigned char *p,uint64_t v){ memcpy(p,&v,8); }",
          "int main(void){",
          "  unsigned char subscriptions[96]={0},events[64]={0}; unsigned count=0; uint64_t before,after,realtime;",
          "  if(wasi_clock_time_get(1,0,&before))return 2;",
          "  put64(subscriptions,7); subscriptions[8]=0; put32(subscriptions+16,1);",
          "  put64(subscriptions+24,5000000000ULL); put64(subscriptions+32,1);",
          "  if(wasi_poll_oneoff(subscriptions,events,1,&count)||count!=1)return 3;",
          "  if(wasi_clock_time_get(1,0,&after))return 4;",
          "  memset(subscriptions,0,sizeof(subscriptions)); memset(events,0,sizeof(events));",
          "  put64(subscriptions,8); subscriptions[8]=0; put32(subscriptions+16,0);",
          "  put64(subscriptions+24,946684810000000000ULL); put64(subscriptions+32,1); put32(subscriptions+40,1);",
          "  if(wasi_poll_oneoff(subscriptions,events,1,&count)||count!=1)return 5;",
          "  if(wasi_clock_time_get(0,0,&realtime))return 6;",
          "  memset(subscriptions,0,sizeof(subscriptions)); memset(events,0,sizeof(events));",
          "  put64(subscriptions,9); subscriptions[8]=2; put32(subscriptions+16,1);",
          "  put64(subscriptions+48,10); subscriptions[56]=0; put32(subscriptions+64,1);",
          "  put64(subscriptions+72,5000000000ULL); put64(subscriptions+80,1);",
          "  if(wasi_poll_oneoff(subscriptions,events,2,&count)||count<1)return 7;",
          "  printf(\"%llu %llu %llu\\n\",(unsigned long long)before,(unsigned long long)after,(unsigned long long)realtime);",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      },
    },
    expect: {
      code: 0,
      stdout: "0 5001000000 946684810000000000\n",
      stderr: "",
      termination: "exited",
      logicalTimeNs: 10_001_000_000,
    },
  },
  {
    id: "c-wasip1-logical-time-limit",
    label: "C / wasip1 / logical time limit",
    input: {
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: {
        "src/main.c": [
          "#include <stdint.h>",
          "#include <string.h>",
          "__attribute__((import_module(\"wasi_snapshot_preview1\"), import_name(\"poll_oneoff\")))",
          "extern unsigned wasi_poll_oneoff(const void *, void *, unsigned, unsigned *);",
          "int main(void){",
          "  unsigned char subscription[48]={0},event[32]={0}; unsigned count=0;",
          "  uint64_t userdata=1,timeout=11000000,precision=1; uint32_t clock=1;",
          "  memcpy(subscription,&userdata,8); subscription[8]=0; memcpy(subscription+16,&clock,4);",
          "  memcpy(subscription+24,&timeout,8); memcpy(subscription+32,&precision,8);",
          "  return (int)wasi_poll_oneoff(subscription,event,1,&count);",
          "}",
          "",
        ].join("\n"),
      },
    },
    run: { resources: { logicalTimeLimitMs: 10 } },
    expect: {
      code: 137,
      stdout: "",
      stderr: "",
      termination: "logical-time-limit",
      logicalTimeNs: 10_000_000,
    },
  },
  {
    id: "cpp-wasip1-virtual-sleep",
    label: "C++ / wasip1 / virtual sleep",
    input: {
      language: "cpp",
      target: "wasip1",
      entry: "src/main.cpp",
      files: {
        "src/main.cpp": [
          "#include <cstdio>",
          "#include <ctime>",
          "static unsigned long long ns(const timespec& value){ return (unsigned long long)value.tv_sec*1000000000ULL+(unsigned long long)value.tv_nsec; }",
          "int main(){ timespec before{},after{},delay{5,0}; if(clock_gettime(CLOCK_MONOTONIC,&before))return 2; if(nanosleep(&delay,nullptr))return 3; if(clock_gettime(CLOCK_MONOTONIC,&after))return 4; std::printf(\"%llu\\n\",ns(after)-ns(before)); }",
          "",
        ].join("\n"),
      },
    },
    expect: { code: 0, stdout: "5001000000\n", stderr: "", termination: "exited", logicalTimeNs: 5_002_000_000 },
  },
  {
    id: "rust-wasip1-virtual-sleep",
    label: "Rust / wasip1 / virtual sleep",
    input: {
      language: "rust",
      target: "wasip1",
      entry: "src/main.rs",
      files: {
        "src/main.rs": "use std::time::{Duration,Instant};\nfn main(){ let before=Instant::now(); std::thread::sleep(Duration::from_secs(5)); println!(\"{}\",before.elapsed().as_nanos()); }\n",
      },
    },
    expect: { code: 0, stdout: "5001000000\n", stderr: "", termination: "exited", logicalTimeNs: 5_002_000_000 },
  },
  {
    id: "python-wasip1-virtual-sleep",
    label: "Python / wasip1 / virtual sleep",
    input: {
      language: "python",
      target: "wasip1",
      entry: "src/main.py",
      files: {
        "src/main.py": "import time\nbefore = time.monotonic_ns()\ntime.sleep(5)\nprint(time.monotonic_ns() - before)\n",
      },
    },
    expect: { code: 0, stdout: "5001000000\n", stderr: "", termination: "exited", logicalTimeNs: 5_008_000_000 },
  },
  {
    id: "javascript-wasip1-virtual-clock",
    label: "JavaScript / wasip1 / virtual clock",
    input: {
      language: "javascript",
      target: "wasip1",
      entry: "src/main.js",
      files: {
        "src/main.js": "import * as std from 'std';\nconst before=Date.now(); while(Date.now()<before+5000){} std.out.puts(String(Date.now()-before)+'\\n');\n",
      },
    },
    expect: { code: 0, stdout: "5001\n", stderr: "", termination: "exited", logicalTimeNs: 5_004_000_000 },
  },
  {
    id: "typescript-wasip1-virtual-clock",
    label: "TypeScript / wasip1 / virtual clock",
    input: {
      language: "typescript",
      target: "wasip1",
      entry: "src/main.ts",
      files: {
        "src/main.ts": "import * as std from 'std';\nconst before: number=Date.now(); while(Date.now()<before+5000){} std.out.puts(String(Date.now()-before)+'\\n');\n",
      },
    },
    expect: { code: 0, stdout: "5001\n", stderr: "", termination: "exited", logicalTimeNs: 5_004_000_000 },
  },
  {
    id: "go-wasip1-virtual-sleep",
    label: "Go / wasip1 / virtual sleep",
    input: {
      language: "go",
      target: "wasip1",
      entry: "src/main.go",
      files: {
        "src/main.go": "package main\nimport (\"fmt\"; \"time\")\nfunc main(){ before:=time.Now(); time.Sleep(5*time.Second); fmt.Println(time.Since(before).Nanoseconds()) }\n",
      },
    },
    expect: { code: 0, stdout: "5004000000\n", stderr: "", termination: "exited", logicalTimeNs: 5_016_000_000 },
  },
] as const);

/**
 * Slower header-heavy case that verifies the bundled libc++ headers and libraries.
 * It is opt-in because parsing libc++ inside the WebAssembly Clang frontend is a
 * materially different efficiency benchmark from basic language conformance.
 */
export const CPP_STDLIB_CONFORMANCE_CASE: ConformanceCase = deepFreeze({
  id: "cpp-stdlib-wasip1",
  label: "C++ stdlib / wasip1",
  input: {
    language: "cpp",
    target: "wasip1",
    entry: "src/main.cpp",
    files: {
      "src/forge.pch.hpp": "#include <array>\n#include <cstdio>\n",
      "src/main.cpp": "int main(){ constexpr std::array<int,3> v{10,20,12}; int s=0; for(int x:v)s+=x; std::printf(\"%d\\n\",s); }\n",
    },
  },
  expect: { code: 0, stdout: "42\n", stderr: "", termination: "exited" },
});

export const FULL_CONFORMANCE_CASES: readonly ConformanceCase[] = deepFreeze([
  ...DEFAULT_CONFORMANCE_CASES,
  CPP_STDLIB_CONFORMANCE_CASE,
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
