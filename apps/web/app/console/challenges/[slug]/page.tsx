"use client";
import { useEffect, useState, use } from "react";
import Markdown from "react-markdown";
import { api } from "../../../../lib/api";
import Playground from "../../../../components/Playground";
export default function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params),
    [challenge, setChallenge] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api(`/v1/challenges/${slug}`)
      .then(setChallenge)
      .catch((e) => setError(e.message));
  }, [slug]);
  if (error) return <p className="error">{error}</p>;
  if (!challenge) return <p className="muted">Loading challenge…</p>;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{challenge.title}</h1>
          <p>{challenge.difficulty} · Original CodeArena challenge</p>
        </div>
      </div>
      <article className="panel markdown" style={{ marginBottom: 24 }}>
        <Markdown>{challenge.description}</Markdown>
        {challenge.samples.map((s: any, i: number) => (
          <div key={i} className="two-col">
            <div>
              <p>Sample input</p>
              <pre>{s.stdin}</pre>
            </div>
            <div>
              <p>Expected output</p>
              <pre>{s.expected}</pre>
            </div>
          </div>
        ))}
      </article>
      <Playground challengeId={challenge.id} />
    </>
  );
}
