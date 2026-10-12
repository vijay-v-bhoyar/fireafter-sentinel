"use client";

import Link from "next/link";
import { useState } from "react";
import { FEATURE_GRAPH_EDGES, FEATURE_GRAPH_NODES, FEATURE_STAGES } from "@/lib/feature-graph";
import styles from "./feature-graph.module.css";

const repositoryUrl = "https://github.com/vijay-v-bhoyar/FireAfter/blob/main/";

export function FeatureGraph({ incidentId }: { incidentId?: string } = {}) {
  const [selectedId, setSelectedId] = useState(FEATURE_GRAPH_NODES[0].id);
  const selectedIndex = FEATURE_GRAPH_NODES.findIndex((node) => node.id === selectedId);
  const selected = FEATURE_GRAPH_NODES[selectedIndex];
  const stage = FEATURE_STAGES.find((item) => item.id === selected.stage)!;
  const stageNodes = FEATURE_GRAPH_NODES.filter((node) => node.stage === stage.id);
  const relationships = FEATURE_GRAPH_EDGES.filter((edge) => edge.from === selectedId || edge.to === selectedId);
  const incidentQuery = incidentId ? `?incidentId=${encodeURIComponent(incidentId)}` : "";

  return (
    <div className={styles.workspace}>
      <div className={styles.guide}>
        <header className={styles.header}>
          <div>
            <Link href={`/${incidentQuery}`} prefetch={false} className={styles.brand}>FireAfter</Link>
            <p className={styles.eyebrow}>From public evidence to accountable review</p>
            <h1>Product feature graph</h1>
            <p className={styles.intro}>One clear walkthrough. Follow six stages, or open any feature to see what it does, where to find it, and what its evidence can support.</p>
          </div>
          <Link href={`/${incidentQuery}`} prefetch={false} className={styles.returnLink}>Return to the live app <span aria-hidden="true">-&gt;</span></Link>
        </header>

        <div className={styles.contextNote}>
          <p><strong>{FEATURE_STAGES.length} stages / {FEATURE_GRAPH_NODES.length} capabilities</strong> A reading order, not a required operating sequence. Access checks and disclosure controls apply throughout.</p>
          <p>Implementation guide, not live system status. Source-dependent and operator-configured features are labeled.</p>
        </div>

        <nav aria-label="Feature walkthrough stages" className={styles.stageNav}>
          <ol>
            {FEATURE_STAGES.map((item) => {
              const nodes = FEATURE_GRAPH_NODES.filter((node) => node.stage === item.id);
              return (
                <li key={item.id}>
                  <button type="button" aria-label={`Step ${item.number}: ${item.title}`}
                    aria-pressed={stage.id === item.id}
                    onClick={() => setSelectedId(nodes[0].id)}>
                    <span className={styles.stepNumber}>{String(item.number).padStart(2, "0")}</span>
                    <span className={styles.stepTitle}>{item.title}</span>
                    <span className={styles.stepCount}>{nodes.length} features</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section className={styles.explorer} aria-label="Interactive product feature graph">
          <div className={styles.featureColumn}>
            <div className={styles.stageHeading}>
              <p className={styles.eyebrow}>Step {stage.number} of {FEATURE_STAGES.length}</p>
              <h2>{stage.title}</h2>
              <p>{stage.summary}</p>
            </div>
            <ul className={styles.featureList} aria-label={`Features in ${stage.title}`}>
              {stageNodes.map((node, index) => (
                <li key={node.id}>
                  <button type="button" aria-label={`${node.title}. ${node.summary}`}
                    aria-pressed={node.id === selectedId} aria-controls="feature-detail"
                    onClick={() => setSelectedId(node.id)}>
                    <span className={styles.featureNumber}>{stage.number}.{index + 1}</span>
                    <span className={styles.cardContent}>
                      <span className={styles.cardTitle}>{node.title}</span>
                      <span className={styles.cardSummary}>{node.summary}</span>
                      <span className={styles.availability} data-kind={node.availability}>{node.availability}</span>
                    </span>
                    <span className={styles.cardArrow} aria-hidden="true">-&gt;</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className={styles.outcome}><strong>Stage outcome</strong>{stage.outcome}</p>
          </div>

          <div className={styles.detailColumn}>
            <nav className={styles.pager} aria-label="Feature sequence">
              <button type="button" disabled={selectedIndex === 0} onClick={() => setSelectedId(FEATURE_GRAPH_NODES[selectedIndex - 1].id)}>Previous feature</button>
              <span>{selectedIndex + 1} / {FEATURE_GRAPH_NODES.length}</span>
              <button type="button" disabled={selectedIndex === FEATURE_GRAPH_NODES.length - 1} onClick={() => setSelectedId(FEATURE_GRAPH_NODES[selectedIndex + 1].id)}>Next feature</button>
            </nav>
            <article id="feature-detail" className={styles.detail} aria-labelledby="feature-title">
              <div aria-live="polite" aria-atomic="true">
                <p className={styles.eyebrow}>Feature {stage.number}.{stageNodes.indexOf(selected) + 1}</p>
                <h2 id="feature-title">{selected.title}</h2>
                <span className={styles.availability} data-kind={selected.availability}>{selected.availability}</span>
                <p className={styles.description}>{selected.summary}</p>
              </div>
              <DetailList title="Where to see it" items={selected.where.map(({ label, href }) => ({ label, href: `${href}${incidentQuery}` }))} />
              <DetailList title="Evidence sources" items={selected.sources.map((label) => ({ label }))} />
              <section className={styles.boundary}>
                <h3>What this does not establish</h3>
                <p>{selected.limits}</p>
              </section>
              <details key={selectedId} className={styles.technical}>
                <summary>Implementation, APIs, and tests</summary>
                <DetailList title="Implementation" items={selected.implementation.map((label) => ({ label, href: `${repositoryUrl}${label}` }))} external />
                <DetailList title="Interfaces" items={selected.apis.map((label) => ({ label }))} />
                <DetailList title="Relevant tests" items={selected.tests.map((label) => ({ label, href: `${repositoryUrl}${label}` }))} external />
                <p className={styles.referenceNote}>Repository links describe the checked-in implementation. Listed tests are coverage references, not proof of a current deployment or field validation.</p>
              </details>
              <section className={styles.relationships} aria-label="Related features">
                <h3>How it connects</h3>
                <ul>
                  {relationships.map((edge) => {
                    const outgoing = edge.from === selectedId;
                    const other = FEATURE_GRAPH_NODES.find((node) => node.id === (outgoing ? edge.to : edge.from))!;
                    return <li key={`${edge.from}-${edge.to}`}>
                      {outgoing ? <><span>This feature {edge.label} </span><button type="button" onClick={() => setSelectedId(other.id)} aria-label={`Open ${other.title}`}>{other.title}</button></>
                        : <><button type="button" onClick={() => setSelectedId(other.id)} aria-label={`Open ${other.title}`}>{other.title}</button><span> {edge.label} this feature.</span></>}
                    </li>;
                  })}
                </ul>
              </section>
            </article>
          </div>
        </section>

        <details className={styles.fullIndex}>
          <summary>Full feature index ({FEATURE_GRAPH_NODES.length})</summary>
          <div className={styles.indexGrid}>
            {FEATURE_STAGES.map((item) => <section key={item.id}>
              <h2>{item.number}. {item.title}</h2>
              <ul>{FEATURE_GRAPH_NODES.filter((node) => node.stage === item.id).map((node) => <li key={node.id}>
                <a href="#feature-detail" onClick={() => setSelectedId(node.id)}>{node.title}</a>
              </li>)}</ul>
            </section>)}
          </div>
        </details>

        <footer className={styles.footer}>
          <p>Decision support for qualified human review. Not an emergency directive or readiness certification.</p>
          <div>
            <a href="/code-graph.html">Explore the implementation code graph</a>
            <a href={`${repositoryUrl}docs/features.md`} target="_blank" rel="noopener noreferrer">Read the judge feature guide</a>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DetailList({ title, items, external = false }: { title: string; items: { label: string; href?: string }[]; external?: boolean }) {
  return (
    <section className={styles.detailList}>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={`${title}-${item.label}`}>
            {item.href
              ? external
                ? <a href={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>
                : <Link href={item.href} prefetch={false}>{item.label}</Link>
              : <code>{item.label}</code>}
          </li>
        ))}
      </ul>
    </section>
  );
}
