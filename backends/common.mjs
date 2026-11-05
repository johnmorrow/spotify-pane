import fs from 'node:fs';

export class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px system-ui;background:#121212;color:#eee;display:grid;place-items:center;height:100vh;margin:0}</style>
<p>${escapeHtml(message)}</p>`;
}

// A Spotify URI the players accept, e.g. spotify:album:4RflOKVvzEFCxDlHlT0ZFJ
export const SPOTIFY_URI = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{22}$/;

export function checkUri(uri) {
  if (!SPOTIFY_URI.test(uri || '')) throw new ApiError(400, `not a Spotify URI: ${uri}`);
  return uri;
}
