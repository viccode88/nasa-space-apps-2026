// Workers static assets ignore the Range header and always send the whole
// file. DuckDB reads the hotspot Parquet files with range requests (and
// hasParquet() probes the first 4 bytes), so this Worker runs first for
// /data/*.parquet and answers ranges itself. Everything else is served by the
// assets layer directly.

const RANGE = /^bytes=(\d*)-(\d*)$/;

export default {
  async fetch(request, env) {
    const range = request.headers.get('Range');
    const asset = await env.ASSETS.fetch(request.url, { method: request.method === 'HEAD' ? 'HEAD' : 'GET' });
    if (!asset.ok) return asset;

    const headers = new Headers(asset.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.delete('Content-Encoding');
    const m = range && RANGE.exec(range.trim());

    if (request.method === 'HEAD' || !m || (m[1] === '' && m[2] === '')) {
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });
    }

    const body = await asset.arrayBuffer();
    const size = body.byteLength;
    let start;
    let end;
    if (m[1] === '') {
      // Suffix range: the last N bytes.
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.delete('Content-Length');
      return new Response(null, { status: 416, headers });
    }

    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};
