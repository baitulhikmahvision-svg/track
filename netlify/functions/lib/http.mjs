export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
