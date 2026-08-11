"use client";

import { ArrowRight, Code2, GitBranch } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useProduct } from "./app-shell";
import { copy } from "./education-model";

const JudgeStudioLoader = dynamic(() => import("./judge-studio").then((module) => module.JudgeStudioLoader), { ssr: false });

export function CustomCollections() {
  const { locale } = useProduct();
  const [open, setOpen] = useState(false);
  const text = copy[locale];
  if (open) return <div className="custom-workspace"><JudgeStudioLoader /></div>;
  return <div className="product-page narrow-page"><header className="product-page-header"><span className="product-eyebrow"><Code2 size={14} /> Advanced</span><h1>{text.custom}</h1><p>{text.customIntro}</p></header><section className="custom-collection-intro"><GitBranch size={28} /><h2>Public GitHub collection</h2><p>Collection metadata and bundles are verified in your browser. Credentials are never sent to third-party hosts.</p><button className="primary-action" type="button" onClick={() => setOpen(true)}>{text.openCustom}<ArrowRight size={16} /></button></section></div>;
}
