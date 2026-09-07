import type { ConformanceCase } from "./matrix.ts";

const programs = [
  {
    language: "c",
    entry: "main.c",
    source:
      '#include <stdio.h>\nint main(){int c;while((c=getchar())!=EOF)printf("%02x",(unsigned)c);puts("");return 0;}',
  },
  {
    language: "cpp",
    entry: "main.cpp",
    source:
      '#include <iostream>\n#include <cstdio>\nint main(){char c;while(std::cin.get(c))printf("%02x",(unsigned char)c);puts("");}',
  },
  {
    language: "python",
    entry: "main.py",
    source: "import sys\nprint(sys.stdin.buffer.read().hex())\n",
  },
  {
    language: "rust",
    entry: "main.rs",
    source:
      'use std::io::{self,Read};fn main(){let mut b=Vec::new();io::stdin().read_to_end(&mut b).unwrap();for x in b{print!("{:02x}",x);}println!();}',
  },
  {
    language: "go",
    entry: "main.go",
    source:
      'package main\nimport("fmt";"io";"os")\nfunc main(){b,_:=io.ReadAll(os.Stdin);fmt.Printf("%x\\n",b)}',
  },
  {
    language: "java",
    entry: "Main.java",
    source:
      'import java.io.*;public class Main{public static void main(String[]args)throws Exception{BufferedReader r=new BufferedReader(new InputStreamReader(System.in));String s;while((s=r.readLine())!=null)System.out.println("["+s+"]");System.out.println("EOF");}}',
  },
  {
    language: "javascript",
    entry: "main.js",
    source:
      'import * as std from "std";const s=std.in.readAsString();console.log(Array.from(unescape(encodeURIComponent(s)),c=>c.charCodeAt(0).toString(16).padStart(2,"0")).join(""));if(std.in.readAsString()!=="")throw Error("Repeated stdin");',
  },
  {
    language: "typescript",
    entry: "main.ts",
    source:
      'import * as std from "std";const s=std.in.readAsString();console.log(Array.from(unescape(encodeURIComponent(s)),c=>c.charCodeAt(0).toString(16).padStart(2,"0")).join(""));if(std.in.readAsString()!=="")throw Error("Repeated stdin");',
  },
] as const;

const inputs = [
  {
    id: "empty",
    stdin: "",
  },
  {
    id: "lf",
    stdin: "\n",
  },
  {
    id: "one-byte",
    stdin: "x",
  },
  {
    id: "no-final-lf",
    stdin: "abc",
  },
  {
    id: "final-lf",
    stdin: "abc\n",
  },
  {
    id: "multiple-lf",
    stdin: "abc\n\n",
  },
  {
    id: "crlf",
    stdin: "abc\r\nx\r\n",
  },
  {
    id: "bare-cr",
    stdin: "abc\rx",
  },
  {
    id: "spaces",
    stdin: "  abc \t\n x  ",
  },
  {
    id: "unicode",
    stdin: "中文🙂\n終",
  },
  {
    id: "bom",
    stdin: "﻿abc\n",
  },
  {
    id: "nul",
    stdin: "a\u0000b\n",
  },
  {
    id: "long-line",
    stdin: "x".repeat(8193),
  },
  {
    id: "last-line",
    stdin: "first\nlast",
  },
];

export const STDIO_CONFORMANCE_CASES: readonly ConformanceCase[] =
  programs.flatMap((program) =>
    inputs.map(({ id, stdin }) => {
      const lines = stdin === "" ? [] : stdin.split(/\r\n|\r|\n/);
      if (/[\r\n]$/.test(stdin)) lines.pop();
      return {
        id: `${program.language}-wasip1-stdio-${id}`,
        label: `${program.language} / wasip1 / stdin ${id}`,
        input: {
          language: program.language,
          target: "wasip1" as const,
          entry: program.entry,
          files: { [program.entry]: program.source },
        },
        run: { stdin },
        expect: {
          code: 0,
          stdout:
            program.language === "java"
              ? `${lines.map((line) => `[${line}]\n`).join("")}EOF\n`
              : `${Array.from(new TextEncoder().encode(stdin), (byte) => byte.toString(16).padStart(2, "0")).join("")}\n`,
          stderr: "",
          termination: "exited" as const,
        },
      };
    }),
  );
