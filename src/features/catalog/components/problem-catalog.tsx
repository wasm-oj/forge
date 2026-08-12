"use client";

import { BookOpen, Filter, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { FilterField } from "../../../components/ui/filter-field";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";
import { hasMatchingLocalSamplesPassed, readLocalSamplesPassed, type LocalSamplesPassedRecord } from "../../../judge/local-practice-progress";
import { copy, useCatalog } from "../model/education-model";
import { ProblemRow } from "./learning-dashboard";
import type { CatalogProblem } from "../model/education-model";

function hasCurrentLocalSamplesPassed(records: ReadonlyMap<string, LocalSamplesPassedRecord>, problem: CatalogProblem): boolean {
  return hasMatchingLocalSamplesPassed(records, problem.id, problem.contentDigest);
}

export function ProblemCatalog() {
  const { locale } = useProduct();
  const text = copy[locale];
  const { collections, loading, error } = useCatalog();
  const [query, setQuery] = useState("");
  const [collectionId, setCollectionId] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [topic, setTopic] = useState("all");
  const [status, setStatus] = useState("all");
  const [localSamplesPassed] = useState<ReadonlyMap<string, LocalSamplesPassedRecord>>(() => typeof window === "undefined" ? new Map() : readLocalSamplesPassed(window.localStorage));
  usePageTitle(locale === "zh-TW" ? "題庫" : "Problems");
  const topics = useMemo(() => [...new Set(collections.flatMap((collection) => collection.problems.flatMap((problem) => problem.tags)))].sort(), [collections]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCollections = collections.filter((collection) => collectionId === "all" || collection.publicationId === collectionId).map((collection) => ({
    collection,
    problems: collection.problems.filter((problem) => {
      const haystack = [problem.number, problem.slug, ...Object.values(problem.title), ...problem.tags].join(" ").toLocaleLowerCase();
      return (!normalizedQuery || haystack.includes(normalizedQuery))
        && (difficulty === "all" || problem.difficulty === difficulty)
        && (topic === "all" || problem.tags.includes(topic))
        && (status === "all"
          || (status === "solved" && problem.solved)
          || (status === "unsolved" && !problem.solved)
          || (status === "local" && hasCurrentLocalSamplesPassed(localSamplesPassed, problem)));
    }),
  })).filter(({ problems }) => problems.length > 0);

  const labels = locale === "zh-TW" ? {
    search: "搜尋", collection: "題庫", allCollections: "所有題庫", difficulty: "難度", topic: "主題", status: "解題狀態",
    solved: "正式解題", local: "本機範例通過", retry: "重新載入題庫", loading: "正在載入題庫…",
  } : {
    search: "Search", collection: "Collection", allCollections: "All collections", difficulty: "Difficulty", topic: "Topic", status: "Progress",
    solved: "Verified solved", local: "Samples passed locally", retry: "Reload problems", loading: "Loading problems…",
  };

  return <main className="product-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><BookOpen size={14} /> Learn</span><h1>{text.catalog}</h1><p>{text.catalogIntro}</p></header>
    <div className="catalog-toolbar">
      <FilterField className="catalog-search" icon={<Search aria-hidden="true" size={16} />} label={labels.search}><input aria-label={labels.search} value={query} placeholder={text.search} onChange={(event) => setQuery(event.target.value)} /></FilterField>
      <FilterField label={labels.collection}><select aria-label={labels.collection} value={collectionId} onChange={(event) => setCollectionId(event.target.value)}><option value="all">{labels.allCollections}</option>{collections.map((collection) => <option key={collection.publicationId} value={collection.publicationId}>{collection.official ? `Official · ${collection.repository.name}` : `${collection.repository.owner}/${collection.repository.name}`}</option>)}</select></FilterField>
      <FilterField icon={<Filter aria-hidden="true" size={15} />} label={labels.difficulty}><select aria-label={labels.difficulty} value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="all">{text.difficulty}</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></FilterField>
      <FilterField label={labels.topic}><select aria-label={labels.topic} value={topic} onChange={(event) => setTopic(event.target.value)}><option value="all">{text.topic}</option>{topics.map((value) => <option key={value} value={value}>{value}</option>)}</select></FilterField>
      <FilterField label={labels.status}><select aria-label={labels.status} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{text.status}</option><option value="solved">{labels.solved}</option><option value="local">{labels.local}</option><option value="unsolved">{text.unsolved}</option></select></FilterField>
    </div>
    {loading && <div className="product-load-state" role="status"><span>{labels.loading}</span></div>}
    {error && <div className="product-error" role="alert"><span>{error}</span><button type="button" onClick={() => window.location.reload()}>{labels.retry}</button></div>}
    {visibleCollections.map(({ collection, problems }) => {
      return <section className="catalog-collection" key={collection.publicationId}>
        <div className="collection-heading"><div><span>{collection.official ? "Official" : "Published collection"}</span><h2>{collection.repository.name}</h2><p>{collection.repository.owner} · {problems.length} problems</p></div>{collection.official && <strong className="official-badge"><Sparkles size={13} /> Official</strong>}</div>
        <div className="problem-list"><div className="problem-list-head"><span /><span>#</span><span>Problem</span><span>Difficulty</span><span>Topics</span><span>Score</span><span /></div>{problems.map((problem) => <ProblemRow key={problem.id} problem={problem} collection={collection} locale={locale} localSamplesPassed={hasCurrentLocalSamplesPassed(localSamplesPassed, problem)} />)}</div>
      </section>;
    })}
    {!loading && !error && visibleCollections.length === 0 && <div className="product-empty large">{text.empty}</div>}
  </main>;
}
