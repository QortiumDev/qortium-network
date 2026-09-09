import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';
import { copyTextToClipboard } from './clipboard';
import { RESOURCE_READY_TIMEOUT_MS, RESOURCE_READY_POLL_MS } from './qdnResource';
import {
  APP_RESOURCE,
  DATABASE_INDEX_FILENAME,
  DATABASE_LATEST_FILENAME,
  DATABASE_DYNAMIC_FILE_PATTERNS,
  DATABASE_FIXED_FILES,
  DATABASE_RESOURCE,
  NETWORK_DISCOVERY_DEFAULTS,
  NETWORK_EDGE_KINDS,
  NETWORK_ENDPOINTS,
  NETWORK_HISTORY_LIMIT,
  NETWORK_QDN_IDENTIFIER,
  NETWORK_QDN_NAME,
  NETWORK_READ_ACTIONS,
  NETWORK_REFERENCE_EXAMPLES,
  NETWORK_SCHEMA,
  NETWORK_SNAPSHOT_ID_PATTERN,
  NETWORK_VIEWER_MAX_BYTES,
  SNAPSHOT_DYNAMIC_FILE_PATTERNS,
  SNAPSHOT_FIXED_FILES,
  SNAPSHOT_RESOURCE,
  type NetworkReferenceExample,
} from './networkContract';

type CodeExampleProps = {
  id: NetworkReferenceExample;
  label: string;
};

const REFERENCE_SECTION_IDS = [
  'reference-data-model',
  'reference-resources',
  'reference-authority',
  'reference-bridge',
  'reference-examples',
] as const;
const REFERENCE_SECTION_LABELS = ['Data model', 'Resources', 'Authority', 'Home bridge', 'Examples'] as const;

function scrollToReferenceSection(id: (typeof REFERENCE_SECTION_IDS)[number]) {
  const section = document.getElementById(id);
  const reference = section?.closest<HTMLElement>('.developer-reference');
  if (section && reference) {
    // scrollIntoView also scrolls Home's outer document on Android.
    reference.scrollTop += section.getBoundingClientRect().top - reference.getBoundingClientRect().top;
  }
}

function referenceSectionHref(id: (typeof REFERENCE_SECTION_IDS)[number]) {
  if (typeof window === 'undefined') {
    return `?view=developers#${id}`;
  }

  const url = new URL(window.location.href);

  url.hash = id;
  return `${url.pathname}${url.search}${url.hash}`;
}

function CodeExample({ id, label }: CodeExampleProps) {
  const [copyState, setCopyState] = useState<'copied' | 'idle' | 'unavailable'>('idle');
  const code = NETWORK_REFERENCE_EXAMPLES[id];

  async function copy() {
    setCopyState(await copyTextToClipboard(code) ? 'copied' : 'unavailable');
  }

  return (
    <div className="reference-code" id={`reference-example-${id}`}>
      <div className="reference-code__toolbar">
        <strong>{label}</strong>
        <button
          aria-label={`Copy ${label}`}
          className="reference-copy"
          onClick={() => void copy()}
          type="button"
        >
          {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span>{copyState === 'copied' ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      <span aria-live="polite" className="reference-copy-status">
        {copyState === 'copied'
          ? `${label} copied.`
          : copyState === 'unavailable'
            ? 'Clipboard access is unavailable. Select the code manually.'
            : ''}
      </span>
    </div>
  );
}

function ReferenceCard({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <article className="reference-card">
      <h3>{title}</h3>
      {children}
    </article>
  );
}

export function Reference() {
  useEffect(() => {
    const scrollFromHash = () => {
      const id = window.location.hash.slice(1);

      if (REFERENCE_SECTION_IDS.includes(id as (typeof REFERENCE_SECTION_IDS)[number])) {
        scrollToReferenceSection(id as (typeof REFERENCE_SECTION_IDS)[number]);
      }
    };

    scrollFromHash();
    window.addEventListener('hashchange', scrollFromHash);
    window.addEventListener('popstate', scrollFromHash);

    return () => {
      window.removeEventListener('hashchange', scrollFromHash);
      window.removeEventListener('popstate', scrollFromHash);
    };
  }, []);

  function handleTocClick(event: MouseEvent<HTMLAnchorElement>, id: (typeof REFERENCE_SECTION_IDS)[number]) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    const url = new URL(window.location.href);

    url.hash = id;

    if (window.location.hash !== url.hash) {
      window.history.pushState({}, '', url);
    }

    scrollToReferenceSection(id);
  }

  return (
    <article className="developer-reference" dir="ltr" lang="en">
      <header className="reference-hero">
        <h1>Network Developers reference</h1>
        <p>
          Network publishes an observational view of Qortium Previewnet topology. This page documents the{' '}
          <code>{NETWORK_SCHEMA}</code> contract, public QDN resource layout, and read-only Home bridge behavior.
        </p>
      </header>

      <nav aria-label="Developer reference sections" className="reference-toc">
        {REFERENCE_SECTION_IDS.map((id, index) => {
          return (
            <a href={referenceSectionHref(id)} key={id} onClick={(event) => handleTocClick(event, id)}>
              {REFERENCE_SECTION_LABELS[index]}
            </a>
          );
        })}
      </nav>

      <section className="reference-section" id="reference-data-model">
        <header>
          <p>Contract and data model</p>
          <h2>Observational topology schema</h2>
        </header>
        <div className="reference-grid">
          <ReferenceCard title="Schema marker">
            <p>
              The producer marks manifests with{' '}<code>{NETWORK_SCHEMA}</code>. The index and summary append{' '}
              <code>.index</code> and <code>.summary</code>. A snapshot payload itself is a structural observation with{' '}
              <code>generatedAt</code>, <code>nodes</code>, <code>errors</code>, and <code>topology</code>. The current{' '}
              viewer parser checks only that the envelope is a non-array object, that <code>topology.graphNodes</code>{' '}
              is truthy, and that <code>topology.edges</code> is an array. Independent clients should validate node and{' '}
              edge fields more deeply before using the graph.
            </p>
          </ReferenceCard>
          <ReferenceCard title="Snapshot envelope">
            <ul>
              <li><code>generatedAt</code>: optional ISO-8601 timestamp with an offset; producer timestamps are UTC.</li>
              <li><code>nodes</code>: operator and discovered observer records keyed by producer key.</li>
              <li><code>errors</code>: a map from operator key to collection error; an error does not prove the node is absent.</li>
              <li><code>peerExchange</code> and <code>discovery</code>: producer observations that may be empty or disabled.</li>
              <li><code>topology</code>: the normalized graph used by the viewer.</li>
            </ul>
          </ReferenceCard>
          <ReferenceCard title="Graph fields and enums">
            <p>
              Graph nodes carry{' '}<code>id</code>, <code>label</code>, <code>kind</code>, and optional role, host, version,
              country, counts, and observation links. Edges carry <code>source</code>, <code>target</code>,{' '}
              <code>kind</code>, <code>count</code>, and peer samples. Current edge kinds are{' '}
              {NETWORK_EDGE_KINDS.map((kind) => <code key={kind}>{kind} </code>)}.
            </p>
            <p>
              Peer arrays are observational Core responses. Unknown fields may be retained by the producer and must not
              be treated as stable application fields.
            </p>
          </ReferenceCard>
        </div>
        <CodeExample id="snapshot" label="Complete snapshot example" />
      </section>

      <section className="reference-section" id="reference-resources">
        <header>
          <p>Resource identity and discovery</p>
          <h2>APP, DATABASE, and SNAPSHOT resources</h2>
        </header>
        <div className="reference-card">
          <div className="reference-table">
            <table>
              <thead><tr><th>Resource</th><th>Tuple</th><th>Purpose</th></tr></thead>
              <tbody>
                <tr><td>Viewer</td><td><code>{APP_RESOURCE.service}/{APP_RESOURCE.name}/{APP_RESOURCE.identifier}</code></td><td>Static QDN app.</td></tr>
                <tr><td>Database</td><td><code>{DATABASE_RESOURCE.service}/{DATABASE_RESOURCE.name}/{DATABASE_RESOURCE.identifier}</code></td><td>Latest record, index, bounded history, and derived records.</td></tr>
                <tr><td>Snapshot</td><td><code>{SNAPSHOT_RESOURCE.service}/{SNAPSHOT_RESOURCE.name}/{SNAPSHOT_RESOURCE.identifier}</code></td><td>Complete point-in-time package for one producer run.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="reference-grid">
          <ReferenceCard title="DATABASE file layout">
            <p>Fixed files: {DATABASE_FIXED_FILES.map((file) => <code key={file}>{file} </code>)}.</p>
            <p>Dynamic files: {DATABASE_DYNAMIC_FILE_PATTERNS.map((file) => <code key={file}>{file} </code>)}.</p>
            <p>
              The viewer reads <code>{DATABASE_INDEX_FILENAME}</code> when history is available, then fetches{' '}
              <code>{DATABASE_LATEST_FILENAME}</code> or the selected historical snapshot.
            </p>
            <p>
              The index is newest first. The producer targets{' '}<code>{NETWORK_HISTORY_LIMIT.toLocaleString()} retained records</code>,
              but force-appends the current slug when it falls outside the retained slice, so a boundary run can contain{' '}
              <code>{NETWORK_HISTORY_LIMIT + 1} records</code>.
            </p>
          </ReferenceCard>
          <ReferenceCard title="SNAPSHOT file layout">
            <p>Fixed files: {SNAPSHOT_FIXED_FILES.map((file) => <code key={file}>{file} </code>)}.</p>
            <p>Per-node files: {SNAPSHOT_DYNAMIC_FILE_PATTERNS.map((file) => <code key={file}>{file} </code>)}.</p>
            <p>Both packages include a manifest relating APP, DATABASE, and SNAPSHOT identities.</p>
          </ReferenceCard>
          <ReferenceCard title="Ordering and identifiers">
            <p>
              <code>{DATABASE_INDEX_FILENAME}</code> records sort newest first by <code>generatedAt</code>, falling back to the snapshot
              id. Snapshot ids use the UTC form <code>YYYYMMDDTHHMMSSZ</code>; this viewer recognizes only{' '}
              <code>{NETWORK_SNAPSHOT_ID_PATTERN.source}</code>.
            </p>
            <p>Index metadata is a discovery aid. Fetch the referenced JSON and validate its graph shape before use.</p>
          </ReferenceCard>
        </div>
        <div className="reference-grid">
          <CodeExample id="manifest" label="Manifest example" />
          <CodeExample id="index" label="History index example" />
          <CodeExample id="summary" label="Summary record example" />
          <CodeExample id="topology" label="Topology record example" />
          <CodeExample id="errors" label="Errors record example" />
        </div>
      </section>

      <section className="reference-section" id="reference-authority">
        <header>
          <p>Authority and lifecycle</p>
          <h2>What this data can prove</h2>
        </header>
        <div className="reference-grid">
          <ReferenceCard title="Producer authority">
            <p>
              The collector is the source of the observation. It reads the voluntary public read-only endpoints{' '}
              {NETWORK_ENDPOINTS.map((endpoint) => <code key={endpoint}>{endpoint} </code>)} from configured seeds and
              public peers. It does not inspect private node state or make peer changes.
            </p>
            <p>
              A node or edge in the graph means it was observed by this run. It does not prove ownership, consent,
              liveness after collection, or a complete network view.
            </p>
            <p>
              Discovery defaults are <code>{NETWORK_DISCOVERY_DEFAULTS.maxHops} hops</code>,{' '}
              <code>{NETWORK_DISCOVERY_DEFAULTS.maxNodes} queried nodes</code>,{' '}
              <code>{NETWORK_DISCOVERY_DEFAULTS.probeWorkers} workers</code>, and{' '}
              <code>{NETWORK_DISCOVERY_DEFAULTS.maxExtraPeers} drawn extra peers</code>. These are collection limits,
              not claims about total network size.
            </p>
          </ReferenceCard>
          <ReferenceCard title="Errors, omissions, and fallback">
            <p>
              Endpoint failures are recorded under{' '}<code>errors</code> for the affected operator. I2P-only peers cannot
              be dialed through a clearnet API and may remain observed-only. Missing fields and empty arrays are not
              equivalent to a confirmed absence.
            </p>
            <p>
              Before reading the database, the viewer requests <code>GET_QDN_RESOURCE_STATUS</code> with{' '}
              <code>build: true</code> and waits for <code>READY</code>, checking every{' '}
              {RESOURCE_READY_POLL_MS / 1000} seconds for up to {RESOURCE_READY_TIMEOUT_MS / 1000} seconds.
              Download progress stays visible; switching workspaces or starting another load cancels the wait.
              A timeout offers Refresh or a different host node instead of treating partial data as ready.
            </p>
            <p>
              A failed <code>{DATABASE_INDEX_FILENAME}</code> lookup falls through to{' '}
              <code>{DATABASE_LATEST_FILENAME}</code>. If the initial latest or snapshot load also fails, the current{' '}
              viewer shows bundled sample data with an error notice. If a selected historical snapshot fails, the viewer{' '}
              keeps the previously displayed snapshot and reports the error. It does not substitute the SNAPSHOT resource{' '}
              for DATABASE; these are UI continuity behaviors with no authority over published topology.
            </p>
          </ReferenceCard>
          <ReferenceCard title="Publication lifecycle">
            <p>
              Collection writes local JSON/SVG and QDN payload directories. <code>npm run qdn:publish:data</code>{' '}
              publishes DATABASE and SNAPSHOT as separate QDN resources; the app publication is separate. These writes
              are not atomic, can be retried, and can leave one resource updated while the other is stale or absent.
            </p>
            <p>
              QDN data and its publication history are public and durable. Replacing or pruning a local history file
              does not imply physical erasure of already published data.
            </p>
          </ReferenceCard>
        </div>
      </section>

      <section className="reference-section" id="reference-bridge">
        <header>
          <p>Home bridge and runtime modes</p>
          <h2>Read capability detection</h2>
        </header>
        <div className="reference-grid">
          <ReferenceCard title="Exact read actions">
            <p>
              Current local browser fallback actions are {NETWORK_READ_ACTIONS.map((action) => <code key={action}>{action} </code>)}.
              A host may advertise a narrower or newer set, so call <code>SHOW_ACTIONS</code> and gate each operation by
              its exact action.
            </p>
            <p>
              Network uses{' '}<code>GET_QDN_RESOURCE_STATUS</code> for readiness and <code>FETCH_QDN_RESOURCE</code> for data, with{' '}<code>LIST_QDN_RESOURCES</code> available for
              discovery/status inspection and <code>FETCH_NODE_API</code>/<code>GET_NODE_STATUS</code> available only for
              read-only local development behavior. Each fetch forwards a{' '}
              <code>{NETWORK_VIEWER_MAX_BYTES.toLocaleString()}-byte</code> ceiling. Home enforces that limit externally;{' '}
              the plain-browser fallback reads the full response body before checking its UTF-8 byte length. It has no{' '}
              account, signing, payment, or publish bridge action.
            </p>
          </ReferenceCard>
          <ReferenceCard title="Runtime boundaries">
            <p>
              Inside Qortium Home, <code>window.qdnRequest</code> is the host bridge. In a plain browser, the app falls{' '}
              back to the configured local node URL (default{' '}<code>http://127.0.0.1:24891</code>) for read-only requests.
              A browser fallback does not establish QDN publication authority.
            </p>
            <p>
              Public-node status, selected account, and name ownership do not grant write authority. This app does not
              request those capabilities; independent clients should not infer them from a successful read.
            </p>
          </ReferenceCard>
        </div>
        <div className="reference-grid">
          <CodeExample id="capabilities" label="Detect read capabilities" />
          <CodeExample id="fetchLatest" label="Fetch and validate latest.json" />
          <CodeExample id="discoverHistory" label="Discover and fetch a history record" />
          <CodeExample id="verifyListing" label="Treat listing metadata as candidates" />
          <CodeExample id="verifyState" label="Inspect publication status" />
        </div>
      </section>

      <section className="reference-section" id="reference-examples">
        <header>
          <p>Producer operations</p>
          <h2>Generate and publish data</h2>
        </header>
        <div className="reference-card">
          <p>
            The producer is a repository tool rather than an app write path. It queries configured nodes with read-only
            APIs, builds the normalized topology, and writes both resource families. Use a trusted local Core and verify
            the resulting manifests and publication status independently.
          </p>
        </div>
        <div className="reference-grid">
          <CodeExample id="publishData" label="Generate and publish topology data" />
        </div>
      </section>
    </article>
  );
}

export default Reference;
