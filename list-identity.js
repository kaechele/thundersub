/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mailing list identification. Messages that carry a list identity are
// grouped by list instead of by sender, so every poster to one list ends up
// in a single subscription. List-Id (RFC 2919) is preferred; List-Post
// (RFC 2369) and list-manager headers cover lists that omit it.
//
// Header maps follow messages.getFull(): lowercase names, array values.

const FALLBACK_ADDRESS_HEADERS = ['list-post', 'x-mailing-list', 'mailing-list', 'x-beenthere'];
const ADDRESS_REGEX = /[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+\.[^\s<>,;:"()[\]]+/;

function firstHeader(headers, name) {
  const value = headers?.[name];
  return String((Array.isArray(value) ? value[0] : value) || '');
}

function decodeEncodedWords(text) {
  return text.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (match, charset, encoding, data) => {
    try {
      let bytes;
      if (encoding.toLowerCase() === 'b') {
        bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      } else {
        const binary = data.replace(/_/g, ' ')
          .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      }
      return new TextDecoder(charset).decode(bytes);
    } catch (e) {
      return match;
    }
  });
}

export function parseListId(headers = {}) {
  const raw = firstHeader(headers, 'list-id');
  if (!raw) return '';
  const bracketed = raw.match(/<([^<>]+)>/);
  return String(bracketed ? bracketed[1] : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// The optional phrase before <list-id>, e.g. "ThunderSub Test Group".
export function parseListName(headers = {}) {
  const raw = firstHeader(headers, 'list-id');
  const bracket = raw.indexOf('<');
  if (bracket <= 0) return '';
  return decodeEncodedWords(raw.slice(0, bracket))
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\s+/g, ' ');
}

// List-Post is "<mailto:list@example.org>" or "NO" for announce-only lists.
// The list-manager headers carry a bare address, sometimes with a comment.
export function parseListAddress(raw) {
  const value = String(raw || '');
  const mailto = value.match(/<\s*mailto:([^?>\s]+)/i);
  const candidate = mailto ? decodeURIComponent(mailto[1]) : value;
  const address = candidate.match(ADDRESS_REGEX);
  return address ? address[0].toLowerCase() : '';
}

// Returns null for mail that isn't from a list.
export function listIdentity(headers = {}) {
  const postAddress = parseListAddress(firstHeader(headers, 'list-post'));
  const id = parseListId(headers);
  if (id) {
    return { key: id, id, name: parseListName(headers), postAddress, source: 'list-id' };
  }
  for (const header of FALLBACK_ADDRESS_HEADERS) {
    const address = parseListAddress(firstHeader(headers, header));
    if (address) {
      return { key: address, id: '', name: '', postAddress: postAddress || address, source: header };
    }
  }
  return null;
}
