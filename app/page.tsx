"use client";

import dynamic from "next/dynamic";

const JudgeStudioLoader = dynamic(
  () => import("@/src/components/judge-studio").then((module) => module.JudgeStudioLoader),
  { ssr: false },
);

export default function Home() {
  return <JudgeStudioLoader />;
}
