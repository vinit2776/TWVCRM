/**
 * Drop-in replacement for fetch() on /api/dashboard/* GET routes.
 *
 * Widgets on the dashboard mount together and each used to fire its own
 * request — ~20 serverless invocations and ~20 session lookups per page load.
 * Calls made in the same tick are coalesced into one POST to
 * /api/dashboard/batch, which streams each result back as soon as it's ready,
 * so every widget still renders independently. Each caller gets back an
 * ordinary Response, so widget code keeps its existing res.ok / res.json().
 *
 * If the batch request fails, the calls it didn't answer fall back to plain
 * individual fetches.
 */

interface Pending {
  url: string;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

let queue: Pending[] = [];
let scheduled = false;

export function dashboardFetch(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  });
}

function fetchDirect(p: Pending) {
  fetch(p.url).then(p.resolve, p.reject);
}

async function flush() {
  const batch = queue;
  queue = [];
  scheduled = false;

  if (batch.length === 1) {
    fetchDirect(batch[0]);
    return;
  }

  const answered = new Set<number>();
  try {
    const res = await fetch("/api/dashboard/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: batch.map((p) => p.url) }),
    });
    if (!res.ok || !res.body) throw new Error(`batch failed: ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const { i, status, body } = JSON.parse(line) as { i: number; status: number; body: unknown };
        if (!batch[i] || answered.has(i)) continue;
        answered.add(i);
        batch[i].resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    }
  } catch (err) {
    console.warn("[dashboardFetch] batch failed, falling back to individual requests:", err);
  }

  batch.forEach((p, i) => {
    if (!answered.has(i)) fetchDirect(p);
  });
}
