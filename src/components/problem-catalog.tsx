"use client";

import { BookOpen, Filter, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useProduct } from "./app-shell";
import { copy, useCatalog } from "./education-model";
import { ProblemRow } from "./learning-dashboard";

export function ProblemCatalog() {
  const { locale } = useProduct();
  const text = copy[locale];
  const { collections, loading, error } = useCatalog();
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState("all");
  const [topic, setTopic] = useState("all");
  const [status, setStatus] = useState("all");
  const topics = useMemo(() => [...new Set(collections.flatMap((collection) => collection.problems.flatMap((problem) => problem.tags)))].sort(), [collections]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCollections = collections.map((collection) => ({
    collection,
    problems: collection.problems.filter((problem) => {
      const haystack = [problem.number, problem.slug, ...Object.values(problem.title), ...problem.tags].join(" ").toLocaleLowerCase();
      return (!normalizedQuery || haystack.includes(normalizedQuery))
        && (difficulty === "all" || problem.difficulty === difficulty)
        && (topic === "all" || problem.tags.includes(topic))
        && (status === "all" || (status === "solved") === problem.solved);
    }),
  })).filter(({ problems }) => problems.length > 0);

  return <main className="product-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><BookOpen size={14} /> Learn</span><h1>{text.catalog}</h1><p>{text.catalogIntro}</p></header>
    <div className="catalog-toolbar">
      <label className="catalog-search"><Search size={16} /><input value={query} placeholder={text.search} onChange={(event) => setQuery(event.target.value)} /></label>
      <label><Filter size={15} /><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="all">{text.difficulty}</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
      <label><select value={topic} onChange={(event) => setTopic(event.target.value)}><option value="all">{text.topic}</option>{topics.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{text.status}</option><option value="solved">Solved</option><option value="unsolved">{text.unsolved}</option></select></label>
    </div>
    {loading && <div className="product-empty large">Loading problems…</div>}
    {error && <div className="product-error">{error}</div>}
    {visibleCollections.map(({ collection, problems }) => {
      return <section className="catalog-collection" key={collection.snapshotId}>
        <div className="collection-heading"><div><span>{collection.official ? "Official" : "Published collection"}</span><h2>{collection.repository.name}</h2><p>{collection.repository.owner} · {problems.length} problems</p></div>{collection.official && <strong className="official-badge"><Sparkles size={13} /> Official</strong>}</div>
        <div className="problem-list"><div className="problem-list-head"><span /><span>#</span><span>Problem</span><span>Difficulty</span><span>Topics</span><span>Score</span><span /></div>{problems.map((problem) => <ProblemRow key={problem.id} problem={problem} collection={collection} locale={locale} />)}</div>
      </section>;
    })}
    {!loading && visibleCollections.length === 0 && <div className="product-empty large">{text.empty}</div>}
  </main>;
}
