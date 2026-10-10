import test from 'node:test';
import assert from 'node:assert/strict';

import { listIdentity, parseListAddress, parseListId, parseListName } from '../list-identity.js';

test('reads List-Id and its display name', () => {
  const headers = {
    'list-id': ['ThunderSub Test Group <thundersub-test.googlegroups.com>'],
    'list-post': ['<mailto:thundersub-test@googlegroups.com>']
  };
  assert.equal(parseListId(headers), 'thundersub-test.googlegroups.com');
  assert.equal(parseListName(headers), 'ThunderSub Test Group');
  assert.deepEqual(listIdentity(headers), {
    key: 'thundersub-test.googlegroups.com',
    id: 'thundersub-test.googlegroups.com',
    name: 'ThunderSub Test Group',
    postAddress: 'thundersub-test@googlegroups.com',
    source: 'list-id'
  });
});

test('normalizes List-Id case and accepts a bare value', () => {
  assert.equal(parseListId({ 'list-id': ['<Linux-Kernel.VGER.Kernel.org>'] }), 'linux-kernel.vger.kernel.org');
  assert.equal(parseListId({ 'list-id': ['  bare.example.org '] }), 'bare.example.org');
  assert.equal(parseListName({ 'list-id': ['<no-name.example.org>'] }), '');
});

test('decodes RFC 2047 list names', () => {
  assert.equal(parseListName({ 'list-id': ['=?UTF-8?B?R3J1cHBlIMOcYmVy?= <gruppe.example.org>'] }), 'Gruppe Über');
  assert.equal(parseListName({ 'list-id': ['"=?iso-8859-1?Q?Caf=E9_list?=" <cafe.example.org>'] }), 'Café list');
});

test('parses posting addresses', () => {
  assert.equal(parseListAddress('<mailto:dev@lists.example.org>'), 'dev@lists.example.org');
  assert.equal(parseListAddress('<mailto:dev@lists.example.org?subject=hi>'), 'dev@lists.example.org');
  assert.equal(parseListAddress('NO (posting not allowed)'), '');
  assert.equal(parseListAddress('list users@ezmlm.example.org; contact users-help@ezmlm.example.org'), 'users@ezmlm.example.org');
});

test('falls back to list-manager headers without List-Id', () => {
  assert.deepEqual(listIdentity({ 'x-beenthere': ['Mailman-Users@Python.org'] }), {
    key: 'mailman-users@python.org',
    id: '',
    name: '',
    postAddress: 'mailman-users@python.org',
    source: 'x-beenthere'
  });
  assert.equal(listIdentity({ 'list-post': ['<mailto:a@lists.example.org>'], 'x-beenthere': ['b@lists.example.org'] }).key,
    'a@lists.example.org');
});

test('returns null for ordinary mail', () => {
  assert.equal(listIdentity({ from: ['someone@example.com'] }), null);
  assert.equal(listIdentity({ 'list-post': ['NO'] }), null);
});
