/** Forward mobile sandbox traffic to Rust without publishing its internal endpoints. */
import { createServer, request as forward } from 'node:http';

const [host, value] = process.argv.slice(2);
const port = Number(value);
if (!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d+(?:\.\d+){0,2}$/.test(host ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Private IPv4 and port required');

const server = createServer((request, response) => {
  const path = request.url ?? '';
  // The first route segment is a literal public API route. Reject ambiguous
  // separators and escaped path components before forwarding to Axum.
  const resource = path.split('?',1)[0];
  if (!/^\/v1\/[a-z][a-z0-9-]*(?:\/|$)/.test(resource) || /^\/v1\/admin(?:\/|$)/.test(resource) ||
      /[%\\]|(?:^|\/)\.{1,2}(?:\/|$)/.test(resource)) {
    response.writeHead(404).end();
    return;
  }
  const upstream = forward({host:'127.0.0.1',port,path,method:request.method,
    headers:{...request.headers,host:'127.0.0.1:'+port}}, reply=>{
    response.writeHead(reply.statusCode ?? 502,reply.headers);
    reply.on('error',()=>response.destroy());
    reply.pipe(response);
  });
  upstream.on('error',()=>{
    if (response.headersSent) response.destroy();
    else response.writeHead(502).end();
  });
  request.on('aborted',()=>upstream.destroy());
  response.on('close',()=>{ if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
});
server.listen(port,host);
